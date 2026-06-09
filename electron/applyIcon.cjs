const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const exePath = path.join(root, "release", "win-unpacked", "Mutsumi.exe");
const iconPath = path.join(root, "build", "icon.ico");
const rceditCandidates = [
  path.join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe"),
  path.join(root, ".builder-cache", "winCodeSign", "343368767", "rcedit-x64.exe"),
  path.join(root, ".builder-cache", "winCodeSign", "458502535", "rcedit-x64.exe"),
  path.join(root, ".builder-cache", "winCodeSign", "459687619", "rcedit-x64.exe"),
  path.join(root, ".builder-cache", "winCodeSign", "817979263", "rcedit-x64.exe")
];

const rceditPath = rceditCandidates.find((candidate) => fs.existsSync(candidate));

if (!fs.existsSync(exePath)) {
  throw new Error(`Executable was not found: ${exePath}`);
}

if (!fs.existsSync(iconPath)) {
  throw new Error(`Icon was not found: ${iconPath}`);
}

if (!rceditPath) {
  throw new Error("rcedit.exe was not found. Run electron-builder once or install dependencies.");
}

const result = spawnSync(rceditPath, [exePath, "--set-icon", iconPath], {
  stdio: "inherit",
  windowsHide: true
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Applied Windows icon to ${exePath}`);
