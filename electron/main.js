"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  globalShortcut,
  Tray,
  Menu,
  nativeImage
} = require("electron");
const path = require("path");

let splashWindow = null;
let mainWindow = null;
let tray = null;
let selectedCaptureSource = { sourceId: null, withAudio: true };
let isQuitting = false;

// Inicia o servidor local embutido automaticamente
let localServerInfo = { port: 3456 };
try {
  const srvModule = require("../server/index.js");
  localServerInfo.port = srvModule.PORT || 3456;
  srvModule.server.listen(localServerInfo.port, "0.0.0.0", () => {
    console.log(`[Concord Electron] Servidor local rodando na porta ${localServerInfo.port}`);
  });
} catch (err) {
  console.warn("[Concord Electron] Servidor local já em execução ou externo:", err.message);
}

const ICON_PATH = path.join(__dirname, "..", "logo-concord.png");

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 300,
    height: 360,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true
    }
  });
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 940,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: "#1e1f22",
    title: "Concord",
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // Configura captura de tela nativa + loopback de áudio do sistema (Windows)
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      let chosen = null;
      if (selectedCaptureSource.sourceId) {
        chosen = sources.find((s) => s.id === selectedCaptureSource.sourceId);
      }
      if (!chosen && sources.length > 0) {
        chosen = sources[0];
      }
      if (!chosen) {
        callback({});
        return;
      }
      const response = { video: chosen };
      if (request.audioRequested && selectedCaptureSource.withAudio !== false) {
        response.audio = "loopback";
      }
      callback(response);
    } catch (err) {
      console.error("[Concord Electron] Erro no DisplayMediaHandler:", err);
      callback({});
    }
  });

  // Libera permissões de microfone, câmera e captura de tela automaticamente
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = [
      "media",
      "AudioCapture",
      "VideoCapture",
      "desktopCapture",
      "display-capture",
      "notifications",
      "fullscreen"
    ];
    callback(allowed.includes(permission));
  });

  const targetUrl = process.env.CONCORD_URL || `http://localhost:${localServerInfo.port}`;
  mainWindow.loadURL(targetUrl);

  mainWindow.once("ready-to-show", () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      mainWindow.show();
      mainWindow.focus();
    }, 900);
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function setupTray() {
  try {
    const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip("Concord — Voz, Vídeo e Tela P2P");
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Abrir Concord",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { type: "separator" },
      {
        label: "Alternar Microfone (Ctrl+Shift+M)",
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send("concord:shortcut:triggered", { action: "TOGGLE_MUTE" });
          }
        }
      },
      {
        label: "Alternar Áudio / Deafen (Ctrl+Shift+D)",
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send("concord:shortcut:triggered", { action: "TOGGLE_DEAFEN" });
          }
        }
      },
      { type: "separator" },
      {
        label: "Sair do Concord",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on("click", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn("[Concord Electron] Falha ao criar ícone na bandeja:", err.message);
  }
}

function setupGlobalShortcuts() {
  const bindings = [
    { accelerator: "CommandOrControl+Shift+M", action: "TOGGLE_MUTE" },
    { accelerator: "CommandOrControl+Shift+D", action: "TOGGLE_DEAFEN" },
    { accelerator: "CommandOrControl+Shift+Space", action: "TOGGLE_PTT" }
  ];

  for (const b of bindings) {
    try {
      globalShortcut.register(b.accelerator, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("concord:shortcut:triggered", {
            action: b.action,
            accelerator: b.accelerator
          });
        }
      });
    } catch (_) {}
  }
}

// IPC Handlers (idênticos ao DiscordNative)
ipcMain.handle("concord:window:minimize", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle("concord:window:maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  } else {
    mainWindow.maximize();
    return true;
  }
});

ipcMain.handle("concord:window:close", () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle("concord:window:isMaximized", () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle("concord:desktopCapture:getSources", async (_event, options = {}) => {
  const sources = await desktopCapturer.getSources({
    types: options.types || ["screen", "window"],
    thumbnailSize: { width: 420, height: 236 },
    fetchWindowIcons: true
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    displayId: s.display_id,
    isScreen: s.id.startsWith("screen:"),
    thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : null,
    appIconDataUrl: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
  }));
});

ipcMain.handle("concord:desktopCapture:selectSource", (_event, payload) => {
  selectedCaptureSource = {
    sourceId: payload && payload.sourceId ? payload.sourceId : null,
    withAudio: payload && typeof payload.withAudio === "boolean" ? payload.withAudio : true
  };
  return { ok: true };
});

ipcMain.handle("concord:shortcuts:register", (_event, { accelerator, action }) => {
  try {
    globalShortcut.register(accelerator, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("concord:shortcut:triggered", { action, accelerator });
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("concord:app:relaunch", () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.on("concord:voice:updateState", (_event, state) => {
  if (!tray || !state) return;
  const statusLabel = state.connected
    ? state.deafened
      ? "Concord — Áudio Desativado"
      : state.muted
      ? "Concord — Microfone Mutado"
      : "Concord — Voz Conectada"
    : "Concord — Online";
  tray.setToolTip(statusLabel);
});

app.whenReady().then(() => {
  createSplashWindow();
  setupTray();
  setupGlobalShortcuts();
  createMainWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
