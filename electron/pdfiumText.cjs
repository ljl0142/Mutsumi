const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const PDFIUM_TIMEOUT_MS = 15000;

function projectRoot() {
  return path.join(__dirname, "..");
}

function runtimeRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "local-runtime", "pdfium");
  return path.join(projectRoot(), "local-runtime", "pdfium");
}

function scriptPath() {
  return path.join(runtimeRoot(), "pdfium_text.py");
}

function renderScriptPath() {
  return path.join(runtimeRoot(), "pdfium_render.py");
}

function selectScriptPath() {
  return path.join(runtimeRoot(), "pdfium_select.py");
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function pdfiumCacheDir() {
  return ensureDirectory(path.join(app.getPath("userData"), "cache", "pdfium"));
}

function writeCachedPdf(data) {
  const buffer = Buffer.from(data);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const filePath = path.join(pdfiumCacheDir(), `${hash}.pdf`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
  return filePath;
}

function pdfiumEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1"
  };
}

function pythonCandidates() {
  if (process.env.PDF_READING_PYTHON) return [[process.env.PDF_READING_PYTHON, []]];
  return [
    [path.join(projectRoot(), ".venv-pdfium", "Scripts", "python.exe"), []],
    [path.join(projectRoot(), ".venv-pdfium", "bin", "python"), []],
    [path.join(projectRoot(), ".venv-argos", "Scripts", "python.exe"), []],
    [path.join(projectRoot(), ".venv-argos", "bin", "python"), []],
    ["python", []],
    ["py", ["-3"]]
  ];
}

function runPdfiumProcess(command, args, request, targetScript = scriptPath()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, targetScript], {
      env: pdfiumEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PDFium text extraction timed out."));
    }, PDFIUM_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PDFium text extraction exited with code ${code}.`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(JSON.stringify(request));
  });
}

async function extractPageTextWithPdfium(request) {
  const script = scriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(`PDFium text runtime was not found: ${script}`);
  }

  const pdfPath = request.pdfPath || writeCachedPdf(request.data);
  const payload = {
    pdfPath,
    page: request.page,
    scale: request.scale,
    rotation: request.rotation
  };

  if (process.env.PDF_READING_PDFIUM_TEXT_COMMAND) {
    return runPdfiumProcess(process.env.PDF_READING_PDFIUM_TEXT_COMMAND, [], payload);
  }

  let lastError = null;
  for (const [command, args] of pythonCandidates()) {
    try {
      return await runPdfiumProcess(command, args, payload);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message ?? "PDFium text extraction is unavailable.");
}

async function renderPageWithPdfium(request) {
  const script = renderScriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(`PDFium render runtime was not found: ${script}`);
  }

  const pdfPath = request.pdfPath || writeCachedPdf(request.data);
  const payload = {
    pdfPath,
    page: request.page,
    scale: request.scale,
    rotation: request.rotation
  };

  let lastError = null;
  for (const [command, args] of pythonCandidates()) {
    try {
      return await runPdfiumProcess(command, args, payload, script);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message ?? "PDFium rendering is unavailable.");
}

async function selectTextWithPdfium(request) {
  const script = selectScriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(`PDFium selection runtime was not found: ${script}`);
  }

  const pdfPath = request.pdfPath || writeCachedPdf(request.data);
  const payload = {
    pdfPath,
    page: request.page,
    scale: request.scale,
    rotation: request.rotation,
    start: request.start,
    end: request.end
  };

  let lastError = null;
  for (const [command, args] of pythonCandidates()) {
    try {
      return await runPdfiumProcess(command, args, payload, script);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message ?? "PDFium text selection is unavailable.");
}

module.exports = {
  extractPageTextWithPdfium,
  renderPageWithPdfium,
  selectTextWithPdfium
};
