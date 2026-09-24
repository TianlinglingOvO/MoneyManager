import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { APP_VERSION } from "../shared/app-metadata";
import type { SystemReload } from "../shared/types";

export const RELOAD_EXIT_CODE = 82;

export type ReloadInspect = Omit<SystemReload, "restarting">;

let scheduled = false;
let exitHandler = () => {
  setTimeout(() => process.exit(RELOAD_EXIT_CODE), 300).unref();
};

export function setReloadExitHandler(handler: (() => void) | null): void {
  exitHandler = handler ?? (() => {
    setTimeout(() => process.exit(RELOAD_EXIT_CODE), 300).unref();
  });
  scheduled = false;
}

export function scheduleReloadExit(): void {
  if (scheduled) return;
  scheduled = true;
  exitHandler();
}

export function readBuiltVersion(projectRoot = process.cwd()): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version?: string };
    return parsed.version || APP_VERSION;
  } catch {
    return APP_VERSION;
  }
}

export function isProductionBuildStale(
  projectRoot = process.cwd(),
  now = Date.now(),
  uptimeSeconds = process.uptime()
): boolean {
  const startedAt = now - uptimeSeconds * 1000;
  try {
    return statSync(path.join(projectRoot, "dist-server", "index.js")).mtimeMs > startedAt + 1000;
  } catch {
    return false;
  }
}

export function inspectReload(projectRoot = process.cwd()): ReloadInspect {
  const builtVersion = readBuiltVersion(projectRoot);
  const supervised = process.env.SMB_SUPERVISED === "1";
  return {
    runningVersion: APP_VERSION,
    builtVersion,
    supervised,
    stale: builtVersion !== APP_VERSION || isProductionBuildStale(projectRoot)
  };
}

export function applyReloadRequest(inspect: ReloadInspect = inspectReload()): SystemReload {
  const restarting = inspect.supervised && inspect.stale;
  if (restarting) scheduleReloadExit();
  return { ...inspect, restarting };
}
