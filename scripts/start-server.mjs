import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Must match `RELOAD_EXIT_CODE` in `server/reload.ts`. */
const RELOAD_EXIT_CODE = 82;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(projectRoot, "dist-server", "index.js");

process.env.NODE_ENV ??= "production";

if (!existsSync(entry)) {
  console.error("缺少生产构建，请先运行 npm.cmd run build。");
  process.exit(1);
}

let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      SMB_SUPERVISED: "1"
    },
    stdio: "inherit",
    windowsHide: false
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) {
      process.exit(typeof code === "number" ? code : 0);
      return;
    }
    if (code === RELOAD_EXIT_CODE) {
      start();
      return;
    }
    process.exit(typeof code === "number" ? code : signal ? 1 : 0);
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (!child) {
    process.exit(0);
    return;
  }
  if (process.platform === "win32") child.kill();
  else child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

start();
