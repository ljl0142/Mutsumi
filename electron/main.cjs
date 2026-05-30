const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { translateLocally } = require("./localTranslator.cjs");

const isDev = process.env.NODE_ENV === "development" || process.env.ELECTRON_START_URL;
const devUrl = process.env.ELECTRON_START_URL || "http://127.0.0.1:5173";
const customUserDataDir = process.env.PDF_READING_USER_DATA_DIR;

app.setName("PDF Reading");
Menu.setApplicationMenu(null);
if (customUserDataDir) {
  app.setPath("userData", customUserDataDir);
}

function storageDir() {
  const dir = path.join(app.getPath("userData"), "storage");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function encodeKey(key) {
  return Buffer.from(key, "utf8").toString("base64url");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function documentPath(paperKey) {
  return path.join(storageDir(), "documents", `${encodeKey(paperKey)}.json`);
}

function settingsPath() {
  return path.join(storageDir(), "assistant-settings.json");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "PDF Reading",
    backgroundColor: "#eef1ec",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const showWindow = () => {
    if (win.isDestroyed() || win.isVisible()) return;
    win.show();
  };

  const fallbackTimer = setTimeout(showWindow, 5000);
  win.on("closed", () => clearTimeout(fallbackTimer));

  if (isDev) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

ipcMain.on("storage:load-document", (event, paperKey) => {
  event.returnValue = readJson(documentPath(paperKey));
});

ipcMain.on("storage:save-document", (event, data) => {
  writeJson(documentPath(data.paperKey), data);
  event.returnValue = true;
});

ipcMain.on("storage:load-assistant-settings", (event) => {
  event.returnValue = readJson(settingsPath());
});

ipcMain.on("storage:save-assistant-settings", (event, settings) => {
  writeJson(settingsPath(), settings);
  event.returnValue = true;
});

ipcMain.handle("translator:translate", (_event, request) => translateLocally(request));

ipcMain.on("app:renderer-ready", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.show();
});

ipcMain.handle("file:save-pdf", async (_event, request) => {
  const result = await dialog.showSaveDialog({
    title: "导出 PDF",
    defaultPath: request.defaultName || "document.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, Buffer.from(request.data));
  return { canceled: false, filePath: result.filePath };
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
