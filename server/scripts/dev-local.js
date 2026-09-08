const { spawn } = require("node:child_process");
const path = require("node:path");

const serverDir = path.join(__dirname, "..");
const children = [
  spawn(process.execPath, ["src/server.js"], {
    cwd: serverDir,
    env: process.env,
    stdio: "inherit",
  }),
  spawn(process.execPath, ["scripts/dev-http-proxy.js"], {
    cwd: serverDir,
    env: process.env,
    stdio: "inherit",
  }),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 250).unref();
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping && code && !signal) stop(code);
  });
  child.on("error", (error) => {
    console.error("[dev-local] child process failed:", error.message);
    stop(1);
  });
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
