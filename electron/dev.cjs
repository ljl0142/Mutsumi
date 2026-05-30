const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.join(__dirname, "..");
const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const electronBin = require("electron");
const mainProcess = path.join(__dirname, "main.cjs");
const devUserDataDir = path.join("D:", "AliceWonderland", "Tools", "pdf_data");

function spawnProcess(command, args, env = {}) {
  return spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort = 5173) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available dev server port found from ${startPort}.`);
}

function waitForRenderer(rendererUrl, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(rendererUrl, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("Vite dev server did not start in time."));
          return;
        }
        setTimeout(check, 250);
      });
    };

    check();
  });
}

let vite = null;

(async () => {
  const rendererPort = await findAvailablePort();
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  vite = spawnProcess(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(rendererPort), "--strictPort"]);

  await waitForRenderer(rendererUrl);
  return rendererUrl;
})()
  .then((rendererUrl) => {
    const electron = spawnProcess(electronBin, [mainProcess], {
      ELECTRON_START_URL: rendererUrl,
      NODE_ENV: "development",
      PDF_READING_USER_DATA_DIR: process.env.PDF_READING_USER_DATA_DIR || devUserDataDir
    });

    electron.on("exit", (code) => {
      vite?.kill();
      process.exit(code ?? 0);
    });
  })
  .catch((error) => {
    console.error(error);
    vite?.kill();
    process.exit(1);
  });

process.on("SIGINT", () => {
  vite?.kill();
  process.exit(0);
});
