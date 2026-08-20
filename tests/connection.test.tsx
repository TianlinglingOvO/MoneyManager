// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, shouldRetryRequest } from "../src/api";
import { ConnectionBanner } from "../src/components/ConnectionBanner";
import {
  clearConnectionIssue,
  getConnectionIssue,
  reportConnectionIssue
} from "../src/connection-status";

function response(options: {
  status?: number;
  contentType?: string;
  body?: unknown;
  type?: ResponseType;
  redirected?: boolean;
  url?: string;
} = {}): Response {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    type: options.type ?? "basic",
    redirected: options.redirected ?? false,
    url: options.url ?? "https://money.sutady.top/api/v1/status",
    headers: { get: (name: string) => name.toLowerCase() === "content-type" ? (options.contentType ?? "application/json") : null },
    json: vi.fn().mockResolvedValue(options.body ?? { data: { service: "ok" } })
  } as unknown as Response;
}

afterEach(() => {
  cleanup();
  clearConnectionIssue();
});

describe("连接错误分类", () => {
  it("将 Cloudflare 手动跳转识别为登录过期，且认证错误不重试", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ status: 0, type: "opaqueredirect" })));

    await expect(api.status()).rejects.toMatchObject({ code: "AUTH_EXPIRED", status: 401 });
    expect(getConnectionIssue()?.code).toBe("AUTH_EXPIRED");
    expect(shouldRetryRequest(0, new ApiError("expired", "AUTH_EXPIRED", 401))).toBe(false);
    expect(fetch).toHaveBeenCalledWith("/api/v1/status", expect.objectContaining({ redirect: "manual", credentials: "same-origin" }));
  });

  it.each([
    [401, "UNAUTHORIZED", "AUTH_EXPIRED"],
    [403, "FORBIDDEN", "FORBIDDEN"],
    [530, "ORIGIN_ERROR", "SERVICE_UNAVAILABLE"]
  ])("将 HTTP %s 分类为 %s", async (status, serverCode, expectedCode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      status,
      body: { error: { code: serverCode, message: "测试错误" } }
    })));

    await expect(api.status()).rejects.toMatchObject({ code: expectedCode });
    expect(getConnectionIssue()?.code).toBe(expectedCode);
  });

  it("区分离线、异常 HTML 和已恢复连接", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.status()).rejects.toMatchObject({ code: "OFFLINE" });

    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    vi.mocked(fetch).mockResolvedValueOnce(response({ contentType: "text/html", body: "login" }));
    await expect(api.status()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    vi.mocked(fetch).mockResolvedValueOnce(response({ body: { data: { service: "ok" } } }));
    await expect(api.status()).resolves.toMatchObject({ service: "ok" });
    expect(getConnectionIssue()).toBeNull();
  });
});

describe("全局连接提示", () => {
  it("登录过期时提供重新登录、重试和重置入口", () => {
    reportConnectionIssue({ code: "AUTH_EXPIRED", message: "expired" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ConnectionBanner /></QueryClientProvider>);

    expect(screen.getByRole("alert")).toHaveTextContent("登录状态已过期");
    expect(screen.getByRole("link", { name: "重新登录" })).toHaveAttribute("href", "/auth/refresh");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /重置登录状态/ })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  });

  it("离线提示不提供登录入口", () => {
    reportConnectionIssue({ code: "OFFLINE", message: "offline" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ConnectionBanner /></QueryClientProvider>);

    expect(screen.getByRole("alert")).toHaveTextContent("设备暂时没有网络");
    expect(screen.queryByRole("link", { name: "重新登录" })).not.toBeInTheDocument();
  });
});
