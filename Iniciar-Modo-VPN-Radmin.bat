@echo off
chcp 65001 >nul
title Concord — Rede Local e Radmin VPN / Tailscale
cd /d "%~dp0"

echo ======================================================================
echo   MODO REDE LOCAL / RADMIN VPN / TAILSCALE (CONCORD P2P)
echo ======================================================================
echo.
echo Este modo conecta seus amigos diretamente ao seu PC com latencia minima
echo (5ms a 20ms) usando sua rede virtual (Radmin VPN, Tailscale ou Wi-Fi).
echo.

REM 1. Lista os IPs de todas as placas de rede (incluindo Radmin VPN 26.x.x.x)
echo Enderecos IP detectados no seu computador:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$nics = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' }; foreach ($n in $nics) { Write-Host ('  * [' + $n.InterfaceAlias + ']: http://' + $n.IPAddress + ':3456') -ForegroundColor Cyan }"
echo.

echo ======================================================================
echo   COMO SEUS AMIGOS DEVEM CONECTAR:
echo ======================================================================
echo 1. Seus amigos entram na sua sala do Radmin VPN ou Tailscale.
echo 2. Envie para eles o IP do Radmin listado acima (ex: http://26.x.x.x:3456).
echo 3. Codigo de convite padrao: CONCORD-AMIGOS-2026
echo.
echo DICA DE OURO: Para link HTTPS publico sem precisar de Radmin nem flags,
echo execute o arquivo 'Hospedar-Cloudflare-Tunnel.bat'!
echo ======================================================================
echo.
echo Iniciando servidor Concord e abrindo seu navegador...
start "" "http://localhost:3456"
echo.

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    node server\index.js
) else if exist "C:\Program Files\nodejs\node.exe" (
    "C:\Program Files\nodejs\node.exe" server\index.js
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\native-host.ps1" -Port 3456
)

echo.
echo O servidor foi encerrado.
pause
