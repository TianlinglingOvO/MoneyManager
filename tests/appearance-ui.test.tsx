// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearancePreferences } from "../shared/types";
import { api } from "../src/api";
import { AppearanceProvider, useAppearance } from "../src/appearance";
import { AppShell } from "../src/components/AppShell";
import { EntryContext } from "../src/entry-context";

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function ThemeHarness() {
  const { appearance, updateAppearance } = useAppearance();
  return <div><span>{appearance.preset}</span><span>{appearance.density}</span><span data-testid="background-preset">{appearance.backgroundPreset}</span><button onClick={() => updateAppearance({ preset: "ink-night", density: "compact" })}>切换</button><button onClick={() => updateAppearance({ backgroundPreset: "linen" })}>切换背景</button></div>;
}

describe("主题与导航状态", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.density; delete document.documentElement.dataset.background; delete document.documentElement.dataset.deviceBackground; });

  it("先应用本机缓存防闪，再用服务器设置同步并保存修改", async () => {
    const cached: AppearancePreferences = { preset: "warm-paper", accent: "#B85C3B", density: "comfortable", backgroundPreset: "paper", updatedAt: "2026-08-01T00:00:00.000Z" };
    const remote: AppearancePreferences = { preset: "porcelain", accent: "#82552F", density: "comfortable", backgroundPreset: "plain", updatedAt: "2026-08-18T00:00:00.000Z" };
    localStorage.setItem("money-manager.appearance.v1", JSON.stringify(cached));
    vi.spyOn(api, "appearance").mockResolvedValue(remote);
    const update = vi.spyOn(api, "updateAppearance").mockResolvedValue({ ...remote, preset: "ink-night", density: "compact" });
    render(<QueryClientProvider client={client()}><AppearanceProvider><ThemeHarness /></AppearanceProvider></QueryClientProvider>);

    await waitFor(() => expect(screen.getByText("porcelain")).toBeInTheDocument());
    expect(document.documentElement.dataset.theme).toBe("porcelain");
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("ink-night"));
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(update.mock.calls[0]?.[0]).toEqual({ preset: "ink-night", density: "compact" });
  });

  it("桌面侧栏可折叠，并只把折叠状态保存在当前设备", async () => {
    vi.spyOn(api, "proposals").mockResolvedValue([]);
    render(
      <QueryClientProvider client={client()}>
        <EntryContext.Provider value={{ openEntry: () => undefined, closeEntry: () => undefined }}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes><Route element={<AppShell />}><Route index element={<div>页面内容</div>} /></Route></Routes>
          </MemoryRouter>
        </EntryContext.Provider>
      </QueryClientProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(document.querySelector(".app-shell")).toHaveClass("sidebar-is-collapsed");
    expect(localStorage.getItem("money-manager.sidebar-collapsed")).toBe("true");
    expect(await screen.findByText("页面内容")).toBeInTheDocument();
  });

  it("兼容旧外观响应，并立即反馈背景选择", async () => {
    const cached: AppearancePreferences = { preset: "ink-night", accent: "#B85C3B", density: "comfortable", backgroundPreset: "paper", updatedAt: "2026-08-18T00:00:00.000Z" };
    localStorage.setItem("money-manager.appearance.v1", JSON.stringify(cached));
    const legacy = { preset: "ink-night", accent: "#B85C3B", density: "comfortable", updatedAt: "2026-08-18T01:00:00.000Z" } as unknown as AppearancePreferences;
    vi.spyOn(api, "appearance").mockResolvedValue(legacy);
    const update = vi.spyOn(api, "updateAppearance").mockResolvedValue(legacy);
    render(<QueryClientProvider client={client()}><AppearanceProvider><ThemeHarness /></AppearanceProvider></QueryClientProvider>);

    await waitFor(() => expect(screen.getByTestId("background-preset")).toHaveTextContent("paper"));
    fireEvent.click(screen.getByRole("button", { name: "切换背景" }));
    await waitFor(() => expect(screen.getByTestId("background-preset")).toHaveTextContent("linen"));
    expect(document.documentElement.dataset.background).toBe("linen");
    expect(update).toHaveBeenCalledWith({ backgroundPreset: "linen" });
  });

  it("桌面快捷键只在非输入状态触发，并能聚焦账单搜索", async () => {
    vi.spyOn(api, "proposals").mockResolvedValue([]);
    const openEntry = vi.fn();
    render(
      <QueryClientProvider client={client()}>
        <EntryContext.Provider value={{ openEntry, closeEntry: () => undefined }}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes><Route element={<AppShell />}><Route index element={<input data-global-search aria-label="账单搜索" />} /></Route></Routes>
          </MemoryRouter>
        </EntryContext.Provider>
      </QueryClientProvider>
    );

    fireEvent.keyDown(document, { key: "n" });
    expect(openEntry).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "/" });
    expect(screen.getByLabelText("账单搜索")).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText("账单搜索"), { key: "n" });
    expect(openEntry).toHaveBeenCalledTimes(1);
  });
});
