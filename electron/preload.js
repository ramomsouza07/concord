"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const nativeBridge = {
  isRenderer: true,
  isElectron: true,
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.invoke("concord:window:minimize"),
    maximize: () => ipcRenderer.invoke("concord:window:maximize"),
    close: () => ipcRenderer.invoke("concord:window:close"),
    isMaximized: () => ipcRenderer.invoke("concord:window:isMaximized")
  },
  desktopCapture: {
    getSources: (options) => ipcRenderer.invoke("concord:desktopCapture:getSources", options),
    selectSource: (sourceId, withAudio) =>
      ipcRenderer.invoke("concord:desktopCapture:selectSource", { sourceId, withAudio })
  },
  shortcuts: {
    register: (accelerator, action) =>
      ipcRenderer.invoke("concord:shortcuts:register", { accelerator, action }),
    onTriggered: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("concord:shortcut:triggered", handler);
      return () => ipcRenderer.removeListener("concord:shortcut:triggered", handler);
    }
  },
  voice: {
    updateState: (state) => ipcRenderer.send("concord:voice:updateState", state)
  },
  app: {
    getVersion: () => "1.0.0",
    relaunch: () => ipcRenderer.invoke("concord:app:relaunch")
  }
};

contextBridge.exposeInMainWorld("ConcordNative", nativeBridge);
contextBridge.exposeInMainWorld("DiscordNative", nativeBridge);
