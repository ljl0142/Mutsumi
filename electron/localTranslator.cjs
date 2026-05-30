const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");

let argosWorker = null;
let argosWorkerCommandKey = "";
const TRANSLATION_TIMEOUT_MS = 30000;

function projectRoot() {
  return path.join(__dirname, "..");
}

function bundledRuntimeRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "local-runtime", "translator");
  return path.join(projectRoot(), "local-runtime", "translator");
}

function runtimeScriptPath() {
  return path.join(bundledRuntimeRoot(), "argos_translate.py");
}

function bundledTranslatorPath() {
  const executable = process.platform === "win32" ? "translator.exe" : "translator";
  return path.join(bundledRuntimeRoot(), executable);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function argosConfigHome() {
  const candidates = [
    path.join(app.getPath("userData"), "argos-config"),
    path.join(projectRoot(), ".argos-config")
  ];

  for (const candidate of candidates) {
    try {
      return ensureDirectory(candidate);
    } catch {
      // Try the next location.
    }
  }

  return projectRoot();
}

function translatorEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    XDG_CONFIG_HOME: argosConfigHome(),
    XDG_CACHE_HOME: ensureDirectory(path.join(projectRoot(), ".argos-cache"))
  };
}

function runTranslatorProcess(command, args, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: translatorEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `本地翻译进程已退出：${code}`));
    });

    child.stdin.end(JSON.stringify(request));
  });
}

function createTranslatorWorker(command, args) {
  const child = spawn(command, args, {
    env: translatorEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  const pending = [];
  let buffer = "";
  let stderr = "";

  function rejectPending(error) {
    while (pending.length) {
      const item = pending.shift();
      clearTimeout(item.timer);
      item.reject(error);
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    lines.forEach((line) => {
      if (!line.trim()) return;
      const request = pending.shift();
      if (!request) return;
      clearTimeout(request.timer);

      try {
        const payload = JSON.parse(line);
        if (payload.ok) request.resolve(payload.result ?? "");
        else request.reject(new Error(payload.error || "本地翻译失败。"));
      } catch (error) {
        request.reject(error);
      }
    });
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.on("error", (error) => {
    rejectPending(error);
  });

  child.on("close", (code) => {
    rejectPending(new Error(stderr.trim() || `本地翻译 worker 已退出：${code}`));
    argosWorker = null;
    argosWorkerCommandKey = "";
  });

  return {
    translate(request) {
      return new Promise((resolve, reject) => {
        const item = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            reject(new Error("本地翻译超时。"));
          }, TRANSLATION_TIMEOUT_MS)
        };

        pending.push(item);
        child.stdin.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
          if (!error) return;
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          clearTimeout(item.timer);
          reject(error);
        });
      });
    }
  };
}

async function translateWithLocalCommand(request) {
  return runTranslatorProcess(process.env.PDF_READING_TRANSLATOR_COMMAND, [], request);
}

async function translateWithBundledExecutable(request) {
  const translatorPath = bundledTranslatorPath();
  if (!fs.existsSync(translatorPath)) {
    throw new Error(`未找到内置翻译程序：${translatorPath}`);
  }

  return runTranslatorProcess(translatorPath, [], request);
}

async function translateWithArgosPython(request) {
  const scriptPath = runtimeScriptPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`未找到 Argos 翻译脚本：${scriptPath}`);
  }

  const candidates = process.env.PDF_READING_PYTHON
    ? [[process.env.PDF_READING_PYTHON, [scriptPath]]]
    : [
        [path.join(projectRoot(), ".venv-argos", "Scripts", "python.exe"), [scriptPath]],
        [path.join(projectRoot(), ".venv-argos", "bin", "python"), [scriptPath]],
        ["python", [scriptPath]],
        ["py", ["-3", scriptPath]]
      ];

  let lastError = null;
  for (const [command, args] of candidates) {
    try {
      const commandKey = `${command}\0${args.join("\0")}`;
      if (!argosWorker || argosWorkerCommandKey !== commandKey) {
        argosWorker = createTranslatorWorker(command, args);
        argosWorkerCommandKey = commandKey;
      }
      return await argosWorker.translate(request);
    } catch (error) {
      argosWorker = null;
      argosWorkerCommandKey = "";
      lastError = error;
    }
  }

  throw new Error(lastError?.message ?? "Argos Translate 不可用。");
}

async function translateLocally(request) {
  try {
    if (process.env.PDF_READING_TRANSLATOR_COMMAND) {
      return await translateWithLocalCommand(request);
    }

    const bundledPath = bundledTranslatorPath();
    if (fs.existsSync(bundledPath)) {
      return await translateWithBundledExecutable(request);
    }

    return await translateWithArgosPython(request);
  } catch (error) {
    throw new Error(
      `${error.message}\n\n本地翻译运行时未就绪。开发期请安装 .venv-argos，发布版会内置 translator runtime。`
    );
  }
}

module.exports = {
  translateLocally
};
