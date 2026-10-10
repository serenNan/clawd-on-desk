const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceCaption", {
  onShow: (cb) => ipcRenderer.on("voice-caption:show", (_, payload) => cb(payload)),
  onHide: (cb) => ipcRenderer.on("voice-caption:hide", () => cb()),
});
