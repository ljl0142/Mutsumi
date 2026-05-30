const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pdfReadingStorage", {
  loadDocument(paperKey) {
    return ipcRenderer.sendSync("storage:load-document", paperKey);
  },
  saveDocument(data) {
    return ipcRenderer.sendSync("storage:save-document", data);
  },
  loadAssistantSettings() {
    return ipcRenderer.sendSync("storage:load-assistant-settings");
  },
  saveAssistantSettings(settings) {
    return ipcRenderer.sendSync("storage:save-assistant-settings", settings);
  }
});

contextBridge.exposeInMainWorld("pdfReadingTranslator", {
  translate(request) {
    return ipcRenderer.invoke("translator:translate", request);
  }
});

contextBridge.exposeInMainWorld("pdfReadingFile", {
  savePdf(request) {
    return ipcRenderer.invoke("file:save-pdf", request);
  }
});

contextBridge.exposeInMainWorld("pdfReadingApp", {
  ready() {
    ipcRenderer.send("app:renderer-ready");
  }
});
