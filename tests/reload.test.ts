import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../shared/app-metadata";
import { applyReloadRequest, isProductionBuildStale, setReloadExitHandler } from "../server/reload";

describe("本机服务重新加载", () => {
  afterEach(() => {
    setReloadExitHandler(null);
    delete process.env.SMB_SUPERVISED;
  });

  it("仅在启动器托管且构建已更新时安排重启", () => {
    const exit = vi.fn();
    setReloadExitHandler(exit);
    const current = applyReloadRequest({
      runningVersion: APP_VERSION,
      builtVersion: APP_VERSION,
      supervised: true,
      stale: false
    });
    expect(current.restarting).toBe(false);
    expect(exit).not.toHaveBeenCalled();

    const unsupervised = applyReloadRequest({
      runningVersion: APP_VERSION,
      builtVersion: "9.9.9",
      supervised: false,
      stale: true
    });
    expect(unsupervised.restarting).toBe(false);
    expect(exit).not.toHaveBeenCalled();

    const stale = applyReloadRequest({
      runningVersion: APP_VERSION,
      builtVersion: "9.9.9",
      supervised: true,
      stale: true
    });
    expect(stale).toMatchObject({ restarting: true, supervised: true, stale: true });
    expect(exit).toHaveBeenCalledTimes(1);
    applyReloadRequest({
      runningVersion: APP_VERSION,
      builtVersion: "9.9.9",
      supervised: true,
      stale: true
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("磁盘构建新于进程启动时间时判定为过期", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "smb-reload-"));
    const distServer = path.join(directory, "dist-server");
    mkdirSync(distServer);
    const bundle = path.join(distServer, "index.js");
    writeFileSync(bundle, "export {};\n");
    const now = Date.now();
    expect(isProductionBuildStale(directory, now, 5)).toBe(true);
    expect(isProductionBuildStale(directory, now + 60_000, 1)).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  });
});
