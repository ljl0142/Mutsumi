const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { extractPageTextWithPdfium, renderPageWithPdfium, selectTextWithPdfium } = require("./pdfiumText.cjs");
const { runCloudAssistant } = require("./cloudAssistant.cjs");

const isDev = process.env.NODE_ENV === "development" || process.env.ELECTRON_START_URL;
const devUrl = process.env.ELECTRON_START_URL || "http://127.0.0.1:5173";
const customUserDataDir = process.env.PDF_READING_USER_DATA_DIR;
const splashByWebContentsId = new Map();
let localTranslatorModule = null;
let ocrTextModule = null;

app.setName("Mutsumi");
Menu.setApplicationMenu(null);
if (customUserDataDir) {
  app.setPath("userData", customUserDataDir);
}

function storageDir() {
  const dir = path.join(app.getPath("userData"), "storage");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function modelsDir() {
  const dir = path.join(app.getPath("userData"), "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheDir() {
  const dir = path.join(app.getPath("userData"), "cache");
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

function iconPath() {
  return path.join(__dirname, "..", "build", "icon.ico");
}

function iconDataUrl() {
  try {
    const icon = fs.readFileSync(path.join(__dirname, "..", "build", "icon.png"));
    return `data:image/png;base64,${icon.toString("base64")}`;
  } catch {
    return "";
  }
}

function translateLocally(request) {
  if (!localTranslatorModule) {
    localTranslatorModule = require("./localTranslator.cjs");
  }
  return localTranslatorModule.translateLocally(request);
}

function extractPageTextWithOcr(request) {
  if (!ocrTextModule) {
    ocrTextModule = require("./ocrText.cjs");
  }
  return ocrTextModule.extractPageTextWithOcr(request);
}

function createSplashWindow() {
  const splashIcon = iconDataUrl();
  const splash = new BrowserWindow({
    width: 340,
    height: 150,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: true,
    alwaysOnTop: true,
    title: "Mutsumi",
    icon: iconPath(),
    backgroundColor: "#f8faf4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <style>
          * { box-sizing: border-box; }
          html, body {
            width: 100%;
            height: 100%;
            margin: 0;
            overflow: hidden;
            background: #f8faf4;
            color: #26312d;
            font-family: Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
          }
          body {
            display: grid;
            place-items: center;
            border: 1px solid rgba(89, 103, 96, 0.22);
          }
          .wrap {
            width: 100%;
            padding: 24px 28px;
            display: grid;
            grid-template-columns: 42px 1fr;
            align-items: center;
            gap: 16px;
          }
          .mark {
            width: 42px;
            height: 42px;
            display: grid;
            place-items: center;
            border-radius: 10px;
            background: #e6efe7;
            overflow: hidden;
          }
          .mark img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          strong {
            display: block;
            font-size: 15px;
            margin-bottom: 6px;
          }
          span {
            display: block;
            font-size: 12px;
            color: #6b7670;
          }
          .bar {
            grid-column: 1 / -1;
            height: 3px;
            overflow: hidden;
            border-radius: 999px;
            background: #dbe3dc;
          }
          .bar::before {
            content: "";
            display: block;
            width: 38%;
            height: 100%;
            border-radius: inherit;
            background: #5f9d78;
            animation: load 1.1s ease-in-out infinite;
          }
          @keyframes load {
            0% { transform: translateX(-110%); }
            100% { transform: translateX(280%); }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="mark">${splashIcon ? `<img src="${splashIcon}" alt="" />` : ""}</div>
          <div>
            <strong>Mutsumi</strong>
            <span>正在启动...</span>
          </div>
          <div class="bar"></div>
        </div>
      </body>
    </html>
  `)}`);

  return splash;
}

function createWindow() {
  const splash = createSplashWindow();
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "Mutsumi",
    icon: iconPath(),
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

  if (isDev) {
    win.webContents.on("before-input-event", (event, input) => {
      const opensDevTools = input.type === "keyDown" && input.key.toLowerCase() === "i" && input.control && input.shift;
      if (!opensDevTools) return;
      event.preventDefault();
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: "detach" });
      }
    });
  }

  const showWindow = () => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    if (!splash.isDestroyed()) splash.close();
    splashByWebContentsId.delete(winContentsId);
  };
  const winContentsId = win.webContents.id;
  splashByWebContentsId.set(winContentsId, splash);

  win.on("closed", () => {
    if (!splash.isDestroyed()) splash.close();
    splashByWebContentsId.delete(winContentsId);
  });
  win.webContents.on("did-fail-load", (_event, _errorCode, errorDescription) => {
    console.error(`Mutsumi failed to load renderer: ${errorDescription}`);
  });
  win.webContents.once("dom-ready", showWindow);

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

ipcMain.handle("assistant:run", (_event, request) => runCloudAssistant(request, readJson(settingsPath())));

ipcMain.handle("pdfium-text:extract-page", async (_event, request) => {
  try {
    return await extractPageTextWithPdfium(request);
  } catch {
    return null;
  }
});

ipcMain.handle("ocr-text:extract-page", async (_event, request) => {
  try {
    return await extractPageTextWithOcr(request);
  } catch {
    return null;
  }
});

ipcMain.handle("pdfium-render:render-page", async (_event, request) => {
  try {
    return await renderPageWithPdfium(request);
  } catch {
    return null;
  }
});

ipcMain.handle("pdfium-text:select", async (_event, request) => {
  try {
    return await selectTextWithPdfium(request);
  } catch {
    return null;
  }
});

ipcMain.on("app:renderer-ready", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  const splash = splashByWebContentsId.get(event.sender.id);
  if (splash && !splash.isDestroyed()) splash.close();
  splashByWebContentsId.delete(event.sender.id);
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
  storageDir();
  modelsDir();
  cacheDir();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
