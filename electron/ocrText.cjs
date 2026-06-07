const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const OCR_TIMEOUT_MS = 45000;

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function ocrCacheDir() {
  return ensureDirectory(path.join(app.getPath("userData"), "cache", "ocr"));
}

function writeCachedImage(data) {
  const buffer = Buffer.from(data);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const filePath = path.join(ocrCacheDir(), `${hash}.png`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
  return filePath;
}

function ocrEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1"
  };
}

function runOcrCommand(command, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      env: ocrEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("OCR text extraction timed out."));
    }, OCR_TIMEOUT_MS);

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
        reject(new Error(stderr.trim() || `OCR text extraction exited with code ${code}.`));
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

async function extractPageTextWithOcr(request) {
  if (!process.env.PDF_READING_OCR_COMMAND) return null;

  const imagePath = request.imagePath || writeCachedImage(request.data);
  return runOcrCommand(process.env.PDF_READING_OCR_COMMAND, {
    imagePath,
    page: request.page,
    width: request.width,
    height: request.height,
    scale: request.scale,
    rotation: request.rotation
  });
}

module.exports = {
  extractPageTextWithOcr
};
