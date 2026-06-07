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

contextBridge.exposeInMainWorld("pdfReadingText", {
  extractPage(request) {
    return ipcRenderer.invoke("pdfium-text:extract-page", request);
  },
  selectText(request) {
    return ipcRenderer.invoke("pdfium-text:select", request);
  }
});

contextBridge.exposeInMainWorld("pdfReadingRender", {
  renderPage(request) {
    return ipcRenderer.invoke("pdfium-render:render-page", request);
  }
});

contextBridge.exposeInMainWorld("pdfReadingOcr", {
  extractPage(request) {
    return ipcRenderer.invoke("ocr-text:extract-page", request);
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
