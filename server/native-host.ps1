param(
    [int]$Port = 3456,
    [switch]$LaunchApp
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
$PublicDir = Join-Path $RootDir "public"
$DataDir = Join-Path $RootDir "data"
$UploadsDir = Join-Path $DataDir "uploads"
$DbJsonPath = Join-Path $DataDir "concord.db.json"

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
if (-not (Test-Path $UploadsDir)) { New-Item -ItemType Directory -Path $UploadsDir -Force | Out-Null }

$CSharpSource = @"
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace ConcordNativeServer
{
    public class WsClient
    {
        public string Id;
        public string UserId;
        public TcpClient Tcp;
        public NetworkStream Stream;
        public bool Connected = true;
        public SemaphoreSlim SendLock = new SemaphoreSlim(1, 1);
    }

    public class HttpReq
    {
        public string Method;
        public string RawTarget;
        public string Path;
        public Dictionary<string, string> Query = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public byte[] Body = new byte[0];
    }

    public class ConcordHost
    {
        private TcpListener _listener;
        private volatile bool _running;
        private string _rootDir;
        private string _publicDir;
        private string _uploadsDir;
        private string _dbPath;
        private object _dbLock = new object();
        private Dictionary<string, object> _state;
        private ConcurrentDictionary<string, WsClient> _clients = new ConcurrentDictionary<string, WsClient>();
        private ConcurrentDictionary<string, Dictionary<string, object>> _voiceStates = new ConcurrentDictionary<string, Dictionary<string, object>>();
        private JavaScriptSerializer _json = new JavaScriptSerializer() { MaxJsonLength = int.MaxValue };

        public ConcordHost(string rootDir, string publicDir, string uploadsDir, string dbPath)
        {
            _rootDir = rootDir;
            _publicDir = publicDir;
            _uploadsDir = uploadsDir;
            _dbPath = dbPath;
            LoadOrInitDb();
        }

        private string NewId(string prefix)
        {
            byte[] b = new byte[8];
            using (var rng = RandomNumberGenerator.Create()) { rng.GetBytes(b); }
            return prefix + "_" + BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        }

        private string HashPassword(string password, string salt = null)
        {
            if (string.IsNullOrEmpty(salt))
            {
                byte[] sb = new byte[16];
                using (var rng = RandomNumberGenerator.Create()) { rng.GetBytes(sb); }
                salt = BitConverter.ToString(sb).Replace("-", "").ToLowerInvariant();
            }
            using (var pbkdf2 = new Rfc2898DeriveBytes(Encoding.UTF8.GetBytes(password ?? ""), Encoding.UTF8.GetBytes(salt), 10000))
            {
                byte[] hash = pbkdf2.GetBytes(32);
                return salt + ":" + BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        private bool VerifyPassword(string password, string stored)
        {
            if (string.IsNullOrEmpty(stored) || !stored.Contains(":")) return false;
            var parts = stored.Split(':');
            string computed = HashPassword(password, parts[0]);
            return string.Equals(computed, stored, StringComparison.OrdinalIgnoreCase);
        }

        private void LoadOrInitDb()
        {
            lock (_dbLock)
            {
                if (File.Exists(_dbPath))
                {
                    try
                    {
                        string raw = File.ReadAllText(_dbPath, Encoding.UTF8);
                        _state = _json.Deserialize<Dictionary<string, object>>(raw);
                        if (_state != null && _state.ContainsKey("users")) return;
                    }
                    catch { }
                }

                string now = DateTime.UtcNow.ToString("o");
                string sysId = "usr_concord_bot";
                string srvId = "srv_qg_amigos";

                _state = new Dictionary<string, object>
                {
                    { "meta", new Dictionary<string, object>
                        {
                            { "version", "1.0.0" },
                            { "createdAt", now },
                            { "masterInviteCode", "CONCORD-AMIGOS-2026" },
                            { "maxUploadBytes", 104857600 }
                        }
                    },
                    { "invites", new ArrayList
                        {
                            new Dictionary<string, object>
                            {
                                { "code", "CONCORD-AMIGOS-2026" },
                                { "serverId", srvId },
                                { "createdBy", sysId },
                                { "createdAt", now },
                                { "uses", 0 },
                                { "maxUses", 0 }
                            }
                        }
                    },
                    { "users", new ArrayList
                        {
                            new Dictionary<string, object>
                            {
                                { "id", sysId },
                                { "username", "concord" },
                                { "displayName", "Concord Aviador" },
                                { "discriminator", "0001" },
                                { "passwordHash", "" },
                                { "avatar", "/assets/logo-concord.png" },
                                { "bannerColor", "#5865F2" },
                                { "status", "online" },
                                { "customStatus", "Pronto para decolar a 1080p 60fps ✈️" },
                                { "bio", "Bot oficial do Concord." },
                                { "isAdmin", true },
                                { "isSystem", true },
                                { "createdAt", now }
                            }
                        }
                    },
                    { "sessions", new Dictionary<string, object>() },
                    { "servers", new ArrayList
                        {
                            new Dictionary<string, object>
                            {
                                { "id", srvId },
                                { "name", "QG dos Amigos" },
                                { "icon", "/assets/logo-concord.png" },
                                { "ownerId", sysId },
                                { "inviteCode", "QG-AMIGOS" },
                                { "createdAt", now },
                                { "categories", new ArrayList
                                    {
                                        new Dictionary<string, object> { { "id", "cat_texto" }, { "name", "CANAIS DE TEXTO" }, { "position", 0 } },
                                        new Dictionary<string, object> { { "id", "cat_voz" }, { "name", "CANAIS DE VOZ & TELA" }, { "position", 1 } }
                                    }
                                },
                                { "channels", new ArrayList
                                    {
                                        new Dictionary<string, object> { { "id", "chn_boas_vindas" }, { "serverId", srvId }, { "categoryId", "cat_texto" }, { "name", "boas-vindas" }, { "type", "text" }, { "topic", "Bem-vindos ao Concord!" }, { "position", 0 } },
                                        new Dictionary<string, object> { { "id", "chn_geral" }, { "serverId", srvId }, { "categoryId", "cat_texto" }, { "name", "geral" }, { "type", "text" }, { "topic", "Bate-papo geral da galera" }, { "position", 1 } },
                                        new Dictionary<string, object> { { "id", "chn_clips_memes" }, { "serverId", srvId }, { "categoryId", "cat_texto" }, { "name", "clips-e-memes" }, { "type", "text" }, { "topic", "Envie clipes e vídeos de até 100 MB" }, { "position", 2 } },
                                        new Dictionary<string, object> { { "id", "chn_links_jogos" }, { "serverId", srvId }, { "categoryId", "cat_texto" }, { "name", "links-e-jogos" }, { "type", "text" }, { "topic", "Links de partidas e jogos" }, { "position", 3 } },
                                        new Dictionary<string, object> { { "id", "chn_voz_geral" }, { "serverId", srvId }, { "categoryId", "cat_voz" }, { "name", "Call Geral" }, { "type", "voice" }, { "topic", "Voz, vídeo e tela P2P" }, { "position", 0 } },
                                        new Dictionary<string, object> { { "id", "chn_voz_ranked" }, { "serverId", srvId }, { "categoryId", "cat_voz" }, { "name", "Jogando Ranked" }, { "type", "voice" }, { "topic", "Gameplay com baixa latência" }, { "position", 1 } },
                                        new Dictionary<string, object> { { "id", "chn_voz_cinema" }, { "serverId", srvId }, { "categoryId", "cat_voz" }, { "name", "Cinema / Tela 60fps" }, { "type", "voice" }, { "topic", "Múltiplas telas 1080p 60fps" }, { "position", 2 } }
                                    }
                                },
                                { "memberIds", new ArrayList { sysId } }
                            }
                        }
                    },
                    { "friendships", new ArrayList() },
                    { "dmChannels", new ArrayList() },
                    { "messages", new Dictionary<string, object>
                        {
                            { "chn_boas_vindas", new ArrayList
                                {
                                    new Dictionary<string, object>
                                    {
                                        { "id", "msg_welcome_1" },
                                        { "channelId", "chn_boas_vindas" },
                                        { "authorId", sysId },
                                        { "content", "👋 **Bem-vindos ao Concord!**\n\nNosso aplicativo privado de comunicação com:\n- 🖥️ **Compartilhamento de Tela Múltiplo (1080p/1440p a 60 FPS)** com Áudio do Sistema e Modo Grade / Modo Palco\n- 🔊 **Controle de Volume Individual (0% a 200%)**\n- 📦 **Uploads de até 100 MB**\n- 🔑 **Código de Convite do Grupo:** `CONCORD-AMIGOS-2026`" },
                                        { "attachments", new ArrayList
                                            {
                                                new Dictionary<string, object>
                                                {
                                                    { "id", "att_logo" },
                                                    { "name", "concord.jpg" },
                                                    { "url", "/assets/splash-lockup.jpg" },
                                                    { "contentType", "image/jpeg" },
                                                    { "size", 778935 }
                                                }
                                            }
                                        },
                                        { "reactions", new Dictionary<string, object>() },
                                        { "replyToId", null },
                                        { "pinned", true },
                                        { "editedAt", null },
                                        { "createdAt", now }
                                    }
                                }
                            },
                            { "chn_geral", new ArrayList
                                {
                                    new Dictionary<string, object>
                                    {
                                        { "id", "msg_geral_1" },
                                        { "channelId", "chn_geral" },
                                        { "authorId", sysId },
                                        { "content", "Canal **#geral** pronto! Clique em **🔊 Call Geral** na barra lateral para conversar por voz, vídeo ou transmitir sua tela." },
                                        { "attachments", new ArrayList() },
                                        { "reactions", new Dictionary<string, object>() },
                                        { "replyToId", null },
                                        { "pinned", false },
                                        { "editedAt", null },
                                        { "createdAt", now }
                                    }
                                }
                            }
                        }
                    }
                };
                SaveDb();
            }
        }

        private void SaveDb()
        {
            lock (_dbLock)
            {
                string json = _json.Serialize(_state);
                File.WriteAllText(_dbPath, json, Encoding.UTF8);
            }
        }

        public void Start(int port)
        {
            _listener = new TcpListener(IPAddress.Any, port);
            _listener.Start();
            _running = true;
            Task.Run(() => AcceptLoop());
        }

        public void Stop()
        {
            _running = false;
            try { _listener.Stop(); } catch { }
            foreach (var kv in _clients)
            {
                try { kv.Value.Tcp.Close(); } catch { }
            }
        }

        private async Task AcceptLoop()
        {
            while (_running)
            {
                try
                {
                    var tcp = await _listener.AcceptTcpClientAsync();
                    var unused = Task.Run(() => HandleConnection(tcp));
                }
                catch
                {
                    if (!_running) break;
                }
            }
        }

        private HttpReq ParseHttpRequest(Stream stream)
        {
            using (var headerMs = new MemoryStream())
            {
                int matched = 0;
                while (headerMs.Length < 65536)
                {
                    int b = stream.ReadByte();
                    if (b == -1) return null;
                    headerMs.WriteByte((byte)b);
                    if ((matched == 0 && b == '\r') ||
                        (matched == 1 && b == '\n') ||
                        (matched == 2 && b == '\r') ||
                        (matched == 3 && b == '\n'))
                    {
                        matched++;
                        if (matched == 4) break;
                    }
                    else
                    {
                        matched = (b == '\r') ? 1 : 0;
                    }
                }

                string headerText = Encoding.ASCII.GetString(headerMs.ToArray());
                string[] lines = headerText.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                if (lines.Length == 0 || string.IsNullOrEmpty(lines[0])) return null;

                string[] firstParts = lines[0].Split(' ');
                if (firstParts.Length < 2) return null;

                var req = new HttpReq();
                req.Method = firstParts[0].Trim().ToUpperInvariant();
                req.RawTarget = firstParts[1].Trim();

                int qIdx = req.RawTarget.IndexOf('?');
                if (qIdx >= 0)
                {
                    req.Path = Uri.UnescapeDataString(req.RawTarget.Substring(0, qIdx));
                    string qs = req.RawTarget.Substring(qIdx + 1);
                    foreach (string pair in qs.Split('&'))
                    {
                        if (string.IsNullOrEmpty(pair)) continue;
                        int eq = pair.IndexOf('=');
                        if (eq >= 0)
                            req.Query[Uri.UnescapeDataString(pair.Substring(0, eq))] = Uri.UnescapeDataString(pair.Substring(eq + 1));
                        else
                            req.Query[Uri.UnescapeDataString(pair)] = "";
                    }
                }
                else
                {
                    req.Path = Uri.UnescapeDataString(req.RawTarget);
                }

                for (int i = 1; i < lines.Length; i++)
                {
                    string line = lines[i];
                    if (string.IsNullOrEmpty(line)) break;
                    int colon = line.IndexOf(':');
                    if (colon > 0)
                    {
                        string k = line.Substring(0, colon).Trim();
                        string v = line.Substring(colon + 1).Trim();
                        req.Headers[k] = v;
                    }
                }

                long contentLen = 0;
                if (req.Headers.ContainsKey("Content-Length"))
                {
                    long.TryParse(req.Headers["Content-Length"], out contentLen);
                }

                if (contentLen > 0)
                {
                    byte[] body = new byte[contentLen];
                    int offset = 0;
                    while (offset < contentLen)
                    {
                        int read = stream.Read(body, offset, (int)Math.Min(65536, contentLen - offset));
                        if (read <= 0) break;
                        offset += read;
                    }
                    req.Body = body;
                }

                return req;
            }
        }

        private string StatusText(int code)
        {
            if (code == 200) return "OK";
            if (code == 201) return "Created";
            if (code == 204) return "No Content";
            if (code == 400) return "Bad Request";
            if (code == 401) return "Unauthorized";
            if (code == 404) return "Not Found";
            return "OK";
        }

        private void SendRawResponse(Stream stream, int status, string contentType, byte[] body)
        {
            if (body == null) body = new byte[0];
            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(status).Append(" ").Append(StatusText(status)).Append("\r\n");
            sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
            sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            sb.Append("Access-Control-Allow-Origin: *\r\n");
            sb.Append("Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS\r\n");
            sb.Append("Access-Control-Allow-Headers: Content-Type, Authorization, X-File-Name, X-File-Type\r\n");
            sb.Append("Connection: close\r\n\r\n");
            byte[] headerBytes = Encoding.ASCII.GetBytes(sb.ToString());
            stream.Write(headerBytes, 0, headerBytes.Length);
            if (body.Length > 0)
            {
                stream.Write(body, 0, body.Length);
            }
            stream.Flush();
        }

        private void SendJson(Stream stream, int status, object obj)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(_json.Serialize(obj));
            SendRawResponse(stream, status, "application/json; charset=utf-8", bytes);
        }

        private void ServeStaticFile(Stream outStream, string filePath)
        {
            if (!File.Exists(filePath))
            {
                SendJson(outStream, 404, new Dictionary<string, object> { { "error", "Arquivo não encontrado." } });
                return;
            }
            string ext = Path.GetExtension(filePath).ToLowerInvariant();
            string mime = "application/octet-stream";
            if (ext == ".html") mime = "text/html; charset=utf-8";
            else if (ext == ".css") mime = "text/css; charset=utf-8";
            else if (ext == ".js") mime = "application/javascript; charset=utf-8";
            else if (ext == ".png") mime = "image/png";
            else if (ext == ".jpg" || ext == ".jpeg") mime = "image/jpeg";
            else if (ext == ".svg") mime = "image/svg+xml";
            else if (ext == ".mp4") mime = "video/mp4";
            else if (ext == ".webm") mime = "video/webm";
            else if (ext == ".mp3") mime = "audio/mpeg";

            byte[] bytes = File.ReadAllBytes(filePath);
            SendRawResponse(outStream, 200, mime, bytes);
        }

        private bool IsUserOnline(string userId)
        {
            if (userId == "usr_concord_bot") return true;
            foreach (var kv in _clients)
            {
                if (kv.Value.UserId == userId && kv.Value.Connected) return true;
            }
            return false;
        }

        private ArrayList GetPublicUsers()
        {
            var result = new ArrayList();
            lock (_dbLock)
            {
                var users = _state["users"] as ArrayList;
                foreach (Dictionary<string, object> u in users)
                {
                    var copy = new Dictionary<string, object>(u);
                    copy.Remove("passwordHash");
                    bool on = IsUserOnline(Convert.ToString(u["id"]));
                    copy["online"] = on;
                    copy["effectiveStatus"] = on ? (u.ContainsKey("status") ? u["status"] : "online") : "offline";
                    result.Add(copy);
                }
            }
            return result;
        }

        private Dictionary<string, object> GetUserByToken(string authHeader)
        {
            if (string.IsNullOrEmpty(authHeader)) return null;
            string token = authHeader.Replace("Bearer ", "").Replace("bearer ", "").Trim();
            lock (_dbLock)
            {
                var sessions = _state["sessions"] as Dictionary<string, object>;
                if (sessions == null || !sessions.ContainsKey(token)) return null;
                var sessionObj = sessions[token] as Dictionary<string, object>;
                string uid = Convert.ToString(sessionObj["userId"]);
                var users = _state["users"] as ArrayList;
                foreach (Dictionary<string, object> u in users)
                {
                    if (Convert.ToString(u["id"]) == uid) return u;
                }
            }
            return null;
        }

        private Dictionary<string, object> BuildBootstrap(Dictionary<string, object> user)
        {
            lock (_dbLock)
            {
                var safeMe = new Dictionary<string, object>(user);
                safeMe.Remove("passwordHash");
                var meta = _state["meta"] as Dictionary<string, object>;
                var vList = new ArrayList();
                foreach (var kv in _voiceStates) vList.Add(kv.Value);

                return new Dictionary<string, object>
                {
                    { "me", safeMe },
                    { "serverInfo", new Dictionary<string, object>
                        {
                            { "name", "Concord Private Server" },
                            { "version", "1.0.0" },
                            { "inviteCode", meta["masterInviteCode"] }
                        }
                    },
                    { "users", GetPublicUsers() },
                    { "servers", _state["servers"] },
                    { "dmChannels", _state["dmChannels"] },
                    { "friendships", _state["friendships"] },
                    { "voiceStates", vList },
                    { "invites", _state["invites"] }
                };
            }
        }

        private byte[] BuildWsFrame(byte opcode, byte[] payload)
        {
            if (payload == null) payload = new byte[0];
            using (var ms = new MemoryStream())
            {
                ms.WriteByte((byte)(0x80 | (opcode & 0x0F)));
                if (payload.Length <= 125)
                {
                    ms.WriteByte((byte)payload.Length);
                }
                else if (payload.Length <= 65535)
                {
                    ms.WriteByte(126);
                    ms.WriteByte((byte)((payload.Length >> 8) & 0xFF));
                    ms.WriteByte((byte)(payload.Length & 0xFF));
                }
                else
                {
                    ms.WriteByte(127);
                    ulong len = (ulong)payload.Length;
                    for (int i = 7; i >= 0; i--)
                    {
                        ms.WriteByte((byte)((len >> (i * 8)) & 0xFF));
                    }
                }
                if (payload.Length > 0)
                {
                    ms.Write(payload, 0, payload.Length);
                }
                return ms.ToArray();
            }
        }

        private async Task WsSend(WsClient client, string type, object data)
        {
            if (client == null || !client.Connected) return;
            string json = _json.Serialize(new Dictionary<string, object>
            {
                { "t", type },
                { "d", data },
                { "ts", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }
            });
            byte[] frame = BuildWsFrame(0x1, Encoding.UTF8.GetBytes(json));
            await client.SendLock.WaitAsync();
            try
            {
                if (client.Connected)
                {
                    await client.Stream.WriteAsync(frame, 0, frame.Length);
                    await client.Stream.FlushAsync();
                }
            }
            catch
            {
                client.Connected = false;
            }
            finally
            {
                client.SendLock.Release();
            }
        }

        private async Task WsBroadcast(string type, object data, string excludeClientId = null)
        {
            foreach (var kv in _clients)
            {
                if (kv.Key == excludeClientId) continue;
                await WsSend(kv.Value, type, data);
            }
        }

        private async Task WsSendToUser(string targetUserId, string type, object data)
        {
            foreach (var kv in _clients)
            {
                if (kv.Value.UserId == targetUserId)
                {
                    await WsSend(kv.Value, type, data);
                }
            }
        }

        private int ReadExact(NetworkStream stream, byte[] buffer, int count)
        {
            int offset = 0;
            while (offset < count)
            {
                int r = stream.Read(buffer, offset, count - offset);
                if (r <= 0) return offset;
                offset += r;
            }
            return offset;
        }

        private async Task HandleWebSocket(TcpClient tcp, NetworkStream stream, HttpReq req)
        {
            string secKey = req.Headers.ContainsKey("Sec-WebSocket-Key") ? req.Headers["Sec-WebSocket-Key"].Trim() : "";
            string acceptRaw = secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
            string acceptKey;
            using (var sha1 = SHA1.Create())
            {
                acceptKey = Convert.ToBase64String(sha1.ComputeHash(Encoding.ASCII.GetBytes(acceptRaw)));
            }

            string handshake =
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";
            byte[] hsBytes = Encoding.ASCII.GetBytes(handshake);
            stream.Write(hsBytes, 0, hsBytes.Length);
            stream.Flush();

            string token = req.Query.ContainsKey("token") ? req.Query["token"] : "";
            var user = GetUserByToken(token);

            var client = new WsClient
            {
                Id = NewId("ws"),
                UserId = user != null ? Convert.ToString(user["id"]) : null,
                Tcp = tcp,
                Stream = stream,
                Connected = true
            };
            _clients[client.Id] = client;

            if (user != null)
            {
                await WsSend(client, "READY", BuildBootstrap(user));
                await WsBroadcast("PRESENCE_UPDATE", new Dictionary<string, object> { { "users", GetPublicUsers() } });
            }

            try
            {
                byte[] hdr = new byte[2];
                while (client.Connected)
                {
                    if (ReadExact(stream, hdr, 2) < 2) break;
                    int opcode = hdr[0] & 0x0F;
                    bool masked = (hdr[1] & 0x80) != 0;
                    long payloadLen = hdr[1] & 0x7F;

                    if (payloadLen == 126)
                    {
                        byte[] ext = new byte[2];
                        if (ReadExact(stream, ext, 2) < 2) break;
                        payloadLen = (ext[0] << 8) | ext[1];
                    }
                    else if (payloadLen == 127)
                    {
                        byte[] ext = new byte[8];
                        if (ReadExact(stream, ext, 8) < 8) break;
                        payloadLen = 0;
                        for (int i = 0; i < 8; i++) payloadLen = (payloadLen << 8) | ext[i];
                    }

                    byte[] maskKey = new byte[4];
                    if (masked)
                    {
                        if (ReadExact(stream, maskKey, 4) < 4) break;
                    }

                    byte[] payload = new byte[payloadLen];
                    if (payloadLen > 0)
                    {
                        if (ReadExact(stream, payload, (int)payloadLen) < (int)payloadLen) break;
                        if (masked)
                        {
                            for (int i = 0; i < payload.Length; i++)
                            {
                                payload[i] = (byte)(payload[i] ^ maskKey[i % 4]);
                            }
                        }
                    }

                    if (opcode == 0x8)
                    {
                        client.Connected = false;
                        break;
                    }
                    if (opcode == 0x9)
                    {
                        byte[] pong = BuildWsFrame(0xA, payload);
                        await client.SendLock.WaitAsync();
                        try { stream.Write(pong, 0, pong.Length); stream.Flush(); } catch { }
                        finally { client.SendLock.Release(); }
                        continue;
                    }
                    if (opcode != 0x1) continue;

                    string raw = Encoding.UTF8.GetString(payload);
                    var msg = _json.Deserialize<Dictionary<string, object>>(raw);
                    if (msg == null) continue;
                    string t = msg.ContainsKey("t") ? Convert.ToString(msg["t"]) : "";
                    var d = msg.ContainsKey("d") ? msg["d"] as Dictionary<string, object> : new Dictionary<string, object>();

                    if (t == "PING")
                    {
                        await WsSend(client, "PONG", d);
                    }
                    else if (t == "TYPING_START" && client.UserId != null && d != null && d.ContainsKey("channelId"))
                    {
                        await WsBroadcast("TYPING_START", new Dictionary<string, object>
                        {
                            { "channelId", d["channelId"] },
                            { "userId", client.UserId },
                            { "displayName", user != null ? user["displayName"] : "Amigo" }
                        }, client.Id);
                    }
                    else if (t == "VOICE_JOIN" && client.UserId != null && d != null)
                    {
                        var state = new Dictionary<string, object>
                        {
                            { "userId", client.UserId },
                            { "serverId", d.ContainsKey("serverId") ? d["serverId"] : "srv_qg_amigos" },
                            { "channelId", d["channelId"] },
                            { "muted", d.ContainsKey("muted") && Convert.ToBoolean(d["muted"]) },
                            { "deafened", d.ContainsKey("deafened") && Convert.ToBoolean(d["deafened"]) },
                            { "video", d.ContainsKey("video") && Convert.ToBoolean(d["video"]) },
                            { "screenShare", false },
                            { "speaking", false },
                            { "joinedAt", DateTime.UtcNow.ToString("o") }
                        };
                        _voiceStates[client.UserId] = state;
                        var vList = new ArrayList();
                        foreach (var kv in _voiceStates) vList.Add(kv.Value);
                        await WsBroadcast("VOICE_STATE_UPDATE", new Dictionary<string, object> { { "action", "join" }, { "userId", client.UserId }, { "voiceStates", vList } });
                    }
                    else if (t == "VOICE_LEAVE" && client.UserId != null)
                    {
                        Dictionary<string, object> removed;
                        _voiceStates.TryRemove(client.UserId, out removed);
                        var vList = new ArrayList();
                        foreach (var kv in _voiceStates) vList.Add(kv.Value);
                        await WsBroadcast("VOICE_STATE_UPDATE", new Dictionary<string, object> { { "action", "leave" }, { "userId", client.UserId }, { "voiceStates", vList } });
                    }
                    else if (t == "VOICE_UPDATE" && client.UserId != null && d != null)
                    {
                        Dictionary<string, object> current;
                        if (_voiceStates.TryGetValue(client.UserId, out current))
                        {
                            foreach (var k in d.Keys) current[k] = d[k];
                            var vList = new ArrayList();
                            foreach (var kv in _voiceStates) vList.Add(kv.Value);
                            await WsBroadcast("VOICE_STATE_UPDATE", new Dictionary<string, object> { { "action", "update" }, { "userId", client.UserId }, { "voiceStates", vList } });
                        }
                    }
                    else if (t == "WEBRTC_SIGNAL" && client.UserId != null && d != null && d.ContainsKey("targetUserId"))
                    {
                        string targetId = Convert.ToString(d["targetUserId"]);
                        var payloadObj = new Dictionary<string, object>(d);
                        payloadObj["fromUserId"] = client.UserId;
                        await WsSendToUser(targetId, "WEBRTC_SIGNAL", payloadObj);
                    }
                }
            }
            catch { }

            client.Connected = false;
            WsClient _;
            _clients.TryRemove(client.Id, out _);
            if (client.UserId != null && !IsUserOnline(client.UserId))
            {
                Dictionary<string, object> __;
                _voiceStates.TryRemove(client.UserId, out __);
                var vList = new ArrayList();
                foreach (var kv in _voiceStates) vList.Add(kv.Value);
                await WsBroadcast("VOICE_STATE_UPDATE", new Dictionary<string, object> { { "action", "leave" }, { "userId", client.UserId }, { "voiceStates", vList } });
                await WsBroadcast("PRESENCE_UPDATE", new Dictionary<string, object> { { "users", GetPublicUsers() } });
            }
        }

        public byte[] InvokeRawHttp(byte[] rawRequestBytes)
        {
            using (var inMs = new MemoryStream(rawRequestBytes))
            using (var outMs = new MemoryStream())
            {
                HandleStreamAsync(inMs, outMs, null).GetAwaiter().GetResult();
                return outMs.ToArray();
            }
        }

        private async Task HandleConnection(TcpClient tcp)
        {
            NetworkStream stream = null;
            try
            {
                stream = tcp.GetStream();
                await HandleStreamAsync(stream, stream, tcp);
            }
            catch { }
        }

        private async Task HandleStreamAsync(Stream inStream, Stream outStream, TcpClient tcp)
        {
            bool keepOpenForWs = false;
            try
            {
                var req = ParseHttpRequest(inStream);
                if (req == null) return;

                if (req.Method == "OPTIONS")
                {
                    SendRawResponse(outStream, 204, "text/plain", new byte[0]);
                    return;
                }

                string path = req.Path;
                bool isWs = req.Headers.ContainsKey("Upgrade") &&
                            req.Headers["Upgrade"].IndexOf("websocket", StringComparison.OrdinalIgnoreCase) >= 0;

                if (isWs && path.StartsWith("/ws") && tcp != null && inStream is NetworkStream)
                {
                    keepOpenForWs = true;
                    await HandleWebSocket(tcp, (NetworkStream)inStream, req);
                    return;
                }

                if (req.Method == "GET" && path == "/api/health")
                {
                    SendJson(outStream, 200, new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "name", "Concord Server" },
                        { "version", "1.0.0" },
                        { "onlineCount", _clients.Count }
                    });
                    return;
                }

                if (req.Method == "POST" && path == "/api/auth/register")
                {
                    string bodyStr = Encoding.UTF8.GetString(req.Body);
                    var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                    string username = (body.ContainsKey("username") ? Convert.ToString(body["username"]) : "").Trim().ToLowerInvariant();
                    string displayName = (body.ContainsKey("displayName") ? Convert.ToString(body["displayName"]) : username).Trim();
                    string password = body.ContainsKey("password") ? Convert.ToString(body["password"]) : "";
                    string inviteCode = (body.ContainsKey("inviteCode") ? Convert.ToString(body["inviteCode"]) : "").Trim().ToUpperInvariant();

                    if (username.Length < 2) throw new Exception("O nome de usuário deve ter pelo menos 2 caracteres.");
                    if (password.Length < 4) throw new Exception("A senha deve ter pelo menos 4 caracteres.");

                    Dictionary<string, object> newUser;
                    string token = NewId("tok");

                    lock (_dbLock)
                    {
                        var meta = _state["meta"] as Dictionary<string, object>;
                        string masterCode = Convert.ToString(meta["masterInviteCode"]).ToUpperInvariant();
                        if (inviteCode != masterCode) throw new Exception("Código de convite inválido.");

                        var users = _state["users"] as ArrayList;
                        foreach (Dictionary<string, object> u in users)
                        {
                            if (Convert.ToString(u["username"]).ToLowerInvariant() == username)
                                throw new Exception("Este nome de usuário já está em uso.");
                        }

                        newUser = new Dictionary<string, object>
                        {
                            { "id", NewId("usr") },
                            { "username", username },
                            { "displayName", string.IsNullOrEmpty(displayName) ? username : displayName },
                            { "discriminator", (1000 + users.Count).ToString() },
                            { "passwordHash", HashPassword(password) },
                            { "avatar", "" },
                            { "bannerColor", "#5865F2" },
                            { "status", "online" },
                            { "customStatus", "" },
                            { "bio", "Membro do Concord" },
                            { "isAdmin", (users.Count <= 1) },
                            { "isSystem", false },
                            { "createdAt", DateTime.UtcNow.ToString("o") }
                        };
                        users.Add(newUser);

                        var servers = _state["servers"] as ArrayList;
                        foreach (Dictionary<string, object> srv in servers)
                        {
                            var mIds = srv["memberIds"] as ArrayList;
                            if (!mIds.Contains(newUser["id"])) mIds.Add(newUser["id"]);
                        }

                        var sessions = _state["sessions"] as Dictionary<string, object>;
                        sessions[token] = new Dictionary<string, object> { { "userId", newUser["id"] }, { "createdAt", DateTime.UtcNow.ToString("o") } };
                        SaveDb();
                    }

                    var safe = new Dictionary<string, object>(newUser);
                    safe.Remove("passwordHash");
                    await WsBroadcast("PRESENCE_UPDATE", new Dictionary<string, object> { { "users", GetPublicUsers() } });
                    SendJson(outStream, 201, new Dictionary<string, object> { { "user", safe }, { "token", token } });
                    return;
                }

                if (req.Method == "POST" && path == "/api/auth/login")
                {
                    string bodyStr = Encoding.UTF8.GetString(req.Body);
                    var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                    string username = (body.ContainsKey("username") ? Convert.ToString(body["username"]) : "").Trim().ToLowerInvariant();
                    string password = body.ContainsKey("password") ? Convert.ToString(body["password"]) : "";

                    Dictionary<string, object> found = null;
                    string token = NewId("tok");

                    lock (_dbLock)
                    {
                        var users = _state["users"] as ArrayList;
                        foreach (Dictionary<string, object> u in users)
                        {
                            if (Convert.ToString(u["username"]).ToLowerInvariant() == username)
                            {
                                found = u;
                                break;
                            }
                        }
                        if (found == null || !VerifyPassword(password, Convert.ToString(found["passwordHash"])))
                            throw new Exception("Usuário ou senha incorretos.");

                        var sessions = _state["sessions"] as Dictionary<string, object>;
                        sessions[token] = new Dictionary<string, object> { { "userId", found["id"] }, { "createdAt", DateTime.UtcNow.ToString("o") } };
                        SaveDb();
                    }

                    var safe = new Dictionary<string, object>(found);
                    safe.Remove("passwordHash");
                    await WsBroadcast("PRESENCE_UPDATE", new Dictionary<string, object> { { "users", GetPublicUsers() } });
                    SendJson(outStream, 200, new Dictionary<string, object> { { "user", safe }, { "token", token } });
                    return;
                }

                if (path.StartsWith("/api/"))
                {
                    string authH = req.Headers.ContainsKey("Authorization") ? req.Headers["Authorization"] : "";
                    var user = GetUserByToken(authH);
                    if (user == null)
                    {
                        SendJson(outStream, 401, new Dictionary<string, object> { { "error", "Não autenticado." } });
                        return;
                    }
                    string myId = Convert.ToString(user["id"]);

                    if (req.Method == "GET" && path == "/api/bootstrap")
                    {
                        SendJson(outStream, 200, BuildBootstrap(user));
                        return;
                    }

                    if (req.Method == "POST" && path == "/api/sync")
                    {
                        var vList = new ArrayList();
                        foreach (var kv in _voiceStates) vList.Add(kv.Value);
                        SendJson(outStream, 200, new Dictionary<string, object>
                        {
                            { "seq", 1 },
                            { "events", new ArrayList() },
                            { "signals", new ArrayList() },
                            { "voiceStates", vList },
                            { "users", GetPublicUsers() },
                            { "ts", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }
                        });
                        return;
                    }

                    if (req.Method == "PATCH" && path == "/api/users/me")
                    {
                        string bodyStr = Encoding.UTF8.GetString(req.Body);
                        var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                        lock (_dbLock)
                        {
                            if (body.ContainsKey("displayName")) user["displayName"] = body["displayName"];
                            if (body.ContainsKey("status")) user["status"] = body["status"];
                            if (body.ContainsKey("customStatus")) user["customStatus"] = body["customStatus"];
                            SaveDb();
                        }
                        await WsBroadcast("PRESENCE_UPDATE", new Dictionary<string, object> { { "users", GetPublicUsers() } });
                        var safe = new Dictionary<string, object>(user);
                        safe.Remove("passwordHash");
                        SendJson(outStream, 200, new Dictionary<string, object> { { "user", safe } });
                        return;
                    }

                    if (req.Method == "POST" && path == "/api/servers")
                    {
                        string bodyStr = Encoding.UTF8.GetString(req.Body);
                        var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                        string srvName = body.ContainsKey("name") ? Convert.ToString(body["name"]).Trim() : "Novo Servidor";
                        string srvId = NewId("srv");
                        string catTxt = NewId("cat");
                        string catVoz = NewId("cat");
                        string chTxt = NewId("chn");
                        string chVoz = NewId("chn");

                        var srv = new Dictionary<string, object>
                        {
                            { "id", srvId },
                            { "name", srvName },
                            { "icon", "" },
                            { "ownerId", myId },
                            { "inviteCode", srvId.Substring(0, 8).ToUpperInvariant() },
                            { "createdAt", DateTime.UtcNow.ToString("o") },
                            { "categories", new ArrayList
                                {
                                    new Dictionary<string, object> { { "id", catTxt }, { "name", "CANAIS DE TEXTO" }, { "position", 0 } },
                                    new Dictionary<string, object> { { "id", catVoz }, { "name", "CANAIS DE VOZ" }, { "position", 1 } }
                                }
                            },
                            { "channels", new ArrayList
                                {
                                    new Dictionary<string, object> { { "id", chTxt }, { "serverId", srvId }, { "categoryId", catTxt }, { "name", "geral" }, { "type", "text" }, { "topic", "" }, { "position", 0 } },
                                    new Dictionary<string, object> { { "id", chVoz }, { "serverId", srvId }, { "categoryId", catVoz }, { "name", "Call Geral" }, { "type", "voice" }, { "topic", "" }, { "position", 0 } }
                                }
                            },
                            { "memberIds", new ArrayList { myId } }
                        };
                        lock (_dbLock)
                        {
                            (_state["servers"] as ArrayList).Add(srv);
                            (_state["messages"] as Dictionary<string, object>)[chTxt] = new ArrayList();
                            SaveDb();
                        }
                        await WsBroadcast("SERVER_CREATE", new Dictionary<string, object> { { "server", srv } });
                        SendJson(outStream, 201, new Dictionary<string, object> { { "server", srv } });
                        return;
                    }

                    if (req.Method == "POST" && path.StartsWith("/api/servers/") && path.EndsWith("/channels"))
                    {
                        string[] segs = path.Split('/');
                        string srvId = segs[3];
                        string bodyStr = Encoding.UTF8.GetString(req.Body);
                        var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                        string chType = body.ContainsKey("type") && Convert.ToString(body["type"]) == "voice" ? "voice" : "text";
                        string chName = body.ContainsKey("name") ? Convert.ToString(body["name"]).Trim() : "novo-canal";
                        string chTopic = body.ContainsKey("topic") ? Convert.ToString(body["topic"]).Trim() : "";

                        Dictionary<string, object> newChannel = null;
                        lock (_dbLock)
                        {
                            var servers = _state["servers"] as ArrayList;
                            foreach (Dictionary<string, object> srv in servers)
                            {
                                if (Convert.ToString(srv["id"]) == srvId)
                                {
                                    var cats = srv["categories"] as ArrayList;
                                    var catObj = (chType == "voice" && cats.Count > 1) ? cats[1] as Dictionary<string, object> : cats[0] as Dictionary<string, object>;
                                    newChannel = new Dictionary<string, object>
                                    {
                                        { "id", NewId("chn") },
                                        { "serverId", srvId },
                                        { "categoryId", catObj["id"] },
                                        { "name", chName },
                                        { "type", chType },
                                        { "topic", chTopic },
                                        { "position", (srv["channels"] as ArrayList).Count }
                                    };
                                    (srv["channels"] as ArrayList).Add(newChannel);
                                    if (chType == "text") (_state["messages"] as Dictionary<string, object>)[Convert.ToString(newChannel["id"])] = new ArrayList();
                                    SaveDb();
                                    break;
                                }
                            }
                        }
                        await WsBroadcast("CHANNEL_CREATE", new Dictionary<string, object> { { "serverId", srvId }, { "channel", newChannel } });
                        SendJson(outStream, 201, new Dictionary<string, object> { { "channel", newChannel } });
                        return;
                    }

                    if (req.Method == "POST" && path == "/api/dms/open")
                    {
                        string bodyStr = Encoding.UTF8.GetString(req.Body);
                        var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                        string targetId = Convert.ToString(body["targetUserId"]);
                        Dictionary<string, object> dm = null;
                        lock (_dbLock)
                        {
                            var dms = _state["dmChannels"] as ArrayList;
                            foreach (Dictionary<string, object> d in dms)
                            {
                                var p = d["participantIds"] as ArrayList;
                                if (p.Contains(myId) && p.Contains(targetId)) { dm = d; break; }
                            }
                            if (dm == null)
                            {
                                dm = new Dictionary<string, object>
                                {
                                    { "id", NewId("dm") },
                                    { "type", "dm" },
                                    { "participantIds", new ArrayList { myId, targetId } },
                                    { "createdAt", DateTime.UtcNow.ToString("o") }
                                };
                                dms.Add(dm);
                                (_state["messages"] as Dictionary<string, object>)[Convert.ToString(dm["id"])] = new ArrayList();
                                SaveDb();
                            }
                        }
                        await WsSendToUser(myId, "DM_OPEN", new Dictionary<string, object> { { "dm", dm } });
                        await WsSendToUser(targetId, "DM_OPEN", new Dictionary<string, object> { { "dm", dm } });
                        SendJson(outStream, 200, new Dictionary<string, object> { { "dm", dm } });
                        return;
                    }

                    if (path.StartsWith("/api/channels/") && path.EndsWith("/messages"))
                    {
                        string[] segs = path.Split('/');
                        string channelId = segs[3];
                        if (req.Method == "GET")
                        {
                            lock (_dbLock)
                            {
                                var msgsObj = _state["messages"] as Dictionary<string, object>;
                                var list = msgsObj.ContainsKey(channelId) ? msgsObj[channelId] : new ArrayList();
                                SendJson(outStream, 200, new Dictionary<string, object> { { "messages", list } });
                                return;
                            }
                        }
                        if (req.Method == "POST")
                        {
                            string bodyStr = Encoding.UTF8.GetString(req.Body);
                            var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                            var msg = new Dictionary<string, object>
                            {
                                { "id", NewId("msg") },
                                { "channelId", channelId },
                                { "authorId", myId },
                                { "content", body.ContainsKey("content") ? Convert.ToString(body["content"]) : "" },
                                { "attachments", body.ContainsKey("attachments") ? body["attachments"] : new ArrayList() },
                                { "reactions", new Dictionary<string, object>() },
                                { "replyToId", body.ContainsKey("replyToId") ? body["replyToId"] : null },
                                { "pinned", false },
                                { "editedAt", null },
                                { "createdAt", DateTime.UtcNow.ToString("o") }
                            };
                            lock (_dbLock)
                            {
                                var msgsObj = _state["messages"] as Dictionary<string, object>;
                                if (!msgsObj.ContainsKey(channelId)) msgsObj[channelId] = new ArrayList();
                                (msgsObj[channelId] as ArrayList).Add(msg);
                                SaveDb();
                            }
                            await WsBroadcast("MESSAGE_CREATE", new Dictionary<string, object> { { "channelId", channelId }, { "message", msg } });
                            SendJson(outStream, 201, new Dictionary<string, object> { { "message", msg } });
                            return;
                        }
                    }

                    if (path.StartsWith("/api/channels/") && path.Contains("/messages/"))
                    {
                        string[] segs = path.Split('/');
                        string channelId = segs[3];
                        string messageId = segs[5];
                        string subAction = segs.Length > 6 ? segs[6] : "";

                        string bodyStr = req.Body.Length > 0 ? Encoding.UTF8.GetString(req.Body) : "";
                        var body = !string.IsNullOrEmpty(bodyStr) ? _json.Deserialize<Dictionary<string, object>>(bodyStr) : new Dictionary<string, object>();

                        Dictionary<string, object> targetMsg = null;
                        lock (_dbLock)
                        {
                            var msgsObj = _state["messages"] as Dictionary<string, object>;
                            if (msgsObj.ContainsKey(channelId))
                            {
                                var list = msgsObj[channelId] as ArrayList;
                                for (int i = 0; i < list.Count; i++)
                                {
                                    var m = list[i] as Dictionary<string, object>;
                                    if (Convert.ToString(m["id"]) == messageId)
                                    {
                                        if (req.Method == "DELETE" && subAction == "")
                                        {
                                            list.RemoveAt(i);
                                            SaveDb();
                                            targetMsg = m;
                                            break;
                                        }
                                        targetMsg = m;
                                        break;
                                    }
                                }
                            }

                            if (targetMsg == null)
                            {
                                SendJson(outStream, 404, new Dictionary<string, object> { { "error", "Mensagem não encontrada." } });
                                return;
                            }

                            if (req.Method == "DELETE" && subAction == "")
                            {
                                var unused = WsBroadcast("MESSAGE_DELETE", new Dictionary<string, object> { { "id", messageId }, { "channelId", channelId } });
                                SendJson(outStream, 200, new Dictionary<string, object> { { "id", messageId }, { "channelId", channelId } });
                                return;
                            }

                            if (req.Method == "PATCH" && subAction == "")
                            {
                                targetMsg["content"] = body.ContainsKey("content") ? Convert.ToString(body["content"]) : "";
                                targetMsg["editedAt"] = DateTime.UtcNow.ToString("o");
                                SaveDb();
                            }
                            else if (req.Method == "POST" && subAction == "pin")
                            {
                                bool curPin = targetMsg.ContainsKey("pinned") && Convert.ToBoolean(targetMsg["pinned"]);
                                targetMsg["pinned"] = !curPin;
                                SaveDb();
                            }
                            else if (req.Method == "POST" && subAction == "reactions")
                            {
                                string emoji = body.ContainsKey("emoji") ? Convert.ToString(body["emoji"]) : "👍";
                                if (!targetMsg.ContainsKey("reactions") || !(targetMsg["reactions"] is Dictionary<string, object>))
                                    targetMsg["reactions"] = new Dictionary<string, object>();
                                var rMap = targetMsg["reactions"] as Dictionary<string, object>;
                                if (!rMap.ContainsKey(emoji) || !(rMap[emoji] is ArrayList))
                                    rMap[emoji] = new ArrayList();
                                var uList = rMap[emoji] as ArrayList;
                                if (uList.Contains(myId))
                                {
                                    uList.Remove(myId);
                                    if (uList.Count == 0) rMap.Remove(emoji);
                                }
                                else
                                {
                                    uList.Add(myId);
                                }
                                SaveDb();
                            }
                        }

                        await WsBroadcast("MESSAGE_UPDATE", new Dictionary<string, object> { { "channelId", channelId }, { "message", targetMsg } });
                        SendJson(outStream, 200, new Dictionary<string, object> { { "message", targetMsg } });
                        return;
                    }

                    if (req.Method == "POST" && path == "/api/friends/request")
                    {
                        string bodyStr = Encoding.UTF8.GetString(req.Body);
                        var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                        string targetUsername = (body.ContainsKey("username") ? Convert.ToString(body["username"]) : "").Trim().ToLowerInvariant();
                        Dictionary<string, object> rel = null;
                        lock (_dbLock)
                        {
                            Dictionary<string, object> targetUser = null;
                            foreach (Dictionary<string, object> u in (_state["users"] as ArrayList))
                            {
                                if (Convert.ToString(u["username"]).ToLowerInvariant() == targetUsername) { targetUser = u; break; }
                            }
                            if (targetUser == null) throw new Exception("Usuário não encontrado.");
                            rel = new Dictionary<string, object>
                            {
                                { "id", NewId("frd") },
                                { "userA", myId },
                                { "userB", targetUser["id"] },
                                { "status", "accepted" },
                                { "createdAt", DateTime.UtcNow.ToString("o") }
                            };
                            (_state["friendships"] as ArrayList).Add(rel);
                            SaveDb();
                        }
                        await WsBroadcast("FRIEND_UPDATE", new Dictionary<string, object> { { "friendship", rel }, { "users", GetPublicUsers() } });
                        SendJson(outStream, 200, new Dictionary<string, object> { { "friendship", rel } });
                        return;
                    }

                    if (req.Method == "POST" && path == "/api/servers/join")
                    {
                        string bodyStr = Encoding.UTF8.GetString(req.Body);
                        var body = _json.Deserialize<Dictionary<string, object>>(bodyStr);
                        string code = (body.ContainsKey("inviteCode") ? Convert.ToString(body["inviteCode"]) : "").Trim().ToUpperInvariant();
                        Dictionary<string, object> foundSrv = null;
                        lock (_dbLock)
                        {
                            foreach (Dictionary<string, object> srv in (_state["servers"] as ArrayList))
                            {
                                if (Convert.ToString(srv["inviteCode"]).ToUpperInvariant() == code || code == "CONCORD-AMIGOS-2026")
                                {
                                    var mIds = srv["memberIds"] as ArrayList;
                                    if (!mIds.Contains(myId)) mIds.Add(myId);
                                    foundSrv = srv;
                                    SaveDb();
                                    break;
                                }
                            }
                        }
                        if (foundSrv == null) throw new Exception("Servidor não encontrado para este código.");
                        await WsBroadcast("SERVER_UPDATE", new Dictionary<string, object> { { "server", foundSrv } });
                        SendJson(outStream, 200, new Dictionary<string, object> { { "server", foundSrv } });
                        return;
                    }

                    if (req.Method == "POST" && path == "/api/upload")
                    {
                        string origName = req.Headers.ContainsKey("X-File-Name") ? Uri.UnescapeDataString(req.Headers["X-File-Name"]) : "arquivo.bin";
                        string mime = req.Headers.ContainsKey("X-File-Type") ? req.Headers["X-File-Type"] :
                                      (req.Headers.ContainsKey("Content-Type") ? req.Headers["Content-Type"] : "application/octet-stream");
                        string safeName = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "_" + Path.GetFileName(origName);
                        string dest = Path.Combine(_uploadsDir, safeName);
                        File.WriteAllBytes(dest, req.Body);
                        var fi = new FileInfo(dest);
                        var att = new Dictionary<string, object>
                        {
                            { "id", NewId("att") },
                            { "name", origName },
                            { "url", "/uploads/" + safeName },
                            { "contentType", mime },
                            { "size", fi.Length }
                        };
                        SendJson(outStream, 201, new Dictionary<string, object> { { "attachment", att } });
                        return;
                    }
                }

                // Logos e Imagens do Concord
                if (path == "/assets/concord.png" || path == "/concord.png")
                {
                    ServeStaticFile(outStream, Path.Combine(_rootDir, "concord.png"));
                    return;
                }
                if (path == "/assets/logo-concord.png" || path == "/logo-concord.png" || path == "/favicon.ico")
                {
                    ServeStaticFile(outStream, Path.Combine(_rootDir, "logo-concord.png"));
                    return;
                }
                if (path == "/assets/splash-lockup.jpg" || path == "/Gemini_Generated_Image_nh6wb4nh6wb4nh6w.jpg")
                {
                    ServeStaticFile(outStream, Path.Combine(_rootDir, "Gemini_Generated_Image_nh6wb4nh6wb4nh6w.jpg"));
                    return;
                }

                if (path.StartsWith("/uploads/"))
                {
                    string fName = Path.GetFileName(path);
                    ServeStaticFile(outStream, Path.Combine(_uploadsDir, fName));
                    return;
                }

                string relPath = path == "/" ? "index.html" : path.TrimStart('/');
                string candidate = Path.Combine(_publicDir, relPath.Replace('/', Path.DirectorySeparatorChar));
                if (File.Exists(candidate))
                {
                    ServeStaticFile(outStream, candidate);
                    return;
                }

                ServeStaticFile(outStream, Path.Combine(_publicDir, "index.html"));
            }
            catch (Exception ex)
            {
                if (outStream != null && !keepOpenForWs)
                {
                    try { SendJson(outStream, 400, new Dictionary<string, object> { { "error", ex.Message } }); } catch { }
                }
            }
            finally
            {
                if (!keepOpenForWs && tcp != null)
                {
                    try { tcp.Close(); } catch { }
                }
            }
        }
    }
}
"@

Add-Type -TypeDefinition $CSharpSource -ReferencedAssemblies "System.Web.Extensions.dll", "System.Net.Http.dll"

$Server = New-Object ConcordNativeServer.ConcordHost($RootDir, $PublicDir, $UploadsDir, $DbJsonPath)
$Server.Start($Port)

Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  ✈️  CONCORD SERVER (MODO NATIVO WINDOWS) INICIADO!" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  URL Local:         http://localhost:$Port"
Write-Host "  Código de Convite: CONCORD-AMIGOS-2026"
Write-Host "==============================================================" -ForegroundColor Cyan

if ($LaunchApp) {
    $EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if (-not (Test-Path $EdgePath)) {
        $EdgePath = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    }
    if (Test-Path $EdgePath) {
        Start-Process -FilePath $EdgePath -ArgumentList "--app=http://localhost:$Port", "--window-size=1360,840"
    } else {
        Start-Process "http://localhost:$Port"
    }
}

Write-Host "Pressione Ctrl+C para encerrar o servidor Concord..." -ForegroundColor Yellow
try {
    while ($true) { Start-Sleep -Seconds 2 }
} finally {
    $Server.Stop()
}
