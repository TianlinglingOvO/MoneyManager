// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { requestServiceReload, waitForServiceReady } from "../src/service-reload";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("检查并刷新时同步本机服务", () => {
  it("旧进程没有重新加载接口时继续只刷新网页", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));
    await expect(requestServiceReload()).resolves.toBeNull();
  });

  it("本机服务重启后等到健康检查恢复", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "2.5.2" })
      });
    vi.stubGlobal("fetch", fetchMock);
    await expect(waitForServiceReady("2.5.1", 2_000)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });
});
