// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  return <div><span data-testid="preset">{appearance.preset}</span><span data-testid="background-preset">{appearance.backgroundPreset}</span><button onClick={() => updateAppearance({ preset: "ink-night" })}>切换</button><button onClick={() => updateAppearance({ preset: "auto" })}>跟随系统</button><button onClick={() => updateAppearance({ backgroundPreset: "linen" })}>切换背景</button></div>;
}

describe("主题与导航状态", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(api, "subscriptionSummary").mockResolvedValue({ activeCount: 0, attentionCount: 0, dueCount: 0, upcomingCount: 0, upcoming: [], currencies: [] });
    vi.spyOn(api, "planSummary").mockResolvedValue({ openCount: 0, attentionCount: 0, dueCount: 0, overdueCount: 0, openAmountMinor: 0, upcoming: [] });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.background; delete document.documentElement.dataset.deviceBackground; });

  it("先应用本机缓存防闪，再用服务器设置同步并保存修改", async () => {
    const cached: AppearancePreferences = { preset: "ink-night", accent: "#B85C3B", backgroundPreset: "paper", updatedAt: "2026-08-01T00:00:00.000Z" };
    const remote: AppearancePreferences = { preset: "warm-paper", accent: "#82552F", backgroundPreset: "plain", updatedAt: "2026-08-18T00:00:00.000Z" };
    localStorage.setItem("money-manager.appearance.v1", JSON.stringify(cached));
    vi.spyOn(api, "appearance").mockResolvedValue(remote);
    const update = vi.spyOn(api, "updateAppearance").mockResolvedValue({ ...remote, preset: "ink-night" });
    render(<QueryClientProvider client={client()}><AppearanceProvider><ThemeHarness /></AppearanceProvider></QueryClientProvider>);

    await waitFor(() => expect(screen.getByTestId("preset")).toHaveTextContent("warm-paper"));
    expect(document.documentElement.dataset.theme).toBe("warm-paper");
    expect(document.documentElement.dataset.density).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("ink-night"));
    expect(update.mock.calls[0]?.[0]).toEqual({ preset: "ink-night" });
  });

  it("停用的亮色主题并入温暖纸张，并保留主色与背景", async () => {
    const legacy = { preset: "sage-ledger", accent: "#82552F", density: "compact", backgroundPreset: "mist", updatedAt: "2026-08-18T00:00:00.000Z" } as unknown as AppearancePreferences;
    localStorage.setItem("money-manager.appearance.v1", JSON.stringify({ ...legacy, preset: "porcelain" }));
    vi.spyOn(api, "appearance").mockResolvedValue(legacy);
    render(<QueryClientProvider client={client()}><AppearanceProvider><ThemeHarness /></AppearanceProvider></QueryClientProvider>);

    await waitFor(() => expect(screen.getByTestId("background-preset")).toHaveTextContent("mist"));
    expect(screen.getByTestId("preset")).toHaveTextContent("warm-paper");
    expect(document.documentElement.dataset.theme).toBe("warm-paper");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#82552F");
  });

  it("跟随系统时按设备深浅色显示，并随系统切换", async () => {
    let dark = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query.includes("prefers-color-scheme: dark") ? dark : false; },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    }) as unknown as MediaQueryList);
    const remote: AppearancePreferences = { preset: "warm-paper", accent: "#B85C3B", backgroundPreset: "paper", updatedAt: "2026-08-18T00:00:00.000Z" };
    vi.spyOn(api, "appearance").mockResolvedValue(remote);
    vi.spyOn(api, "updateAppearance").mockResolvedValue({ ...remote, preset: "auto" });
    render(<QueryClientProvider client={client()}><AppearanceProvider><ThemeHarness /></AppearanceProvider></QueryClientProvider>);

    await waitFor(() => expect(screen.getByTestId("preset")).toHaveTextContent("warm-paper"));
    fireEvent.click(screen.getByRole("button", { name: "跟随系统" }));
    await waitFor(() => expect(screen.getByTestId("preset")).toHaveTextContent("auto"));
    expect(document.documentElement.dataset.theme).toBe("ink-night");

    dark = false;
    act(() => listeners.forEach((listener) => listener()));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("warm-paper"));
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
    const cached: AppearancePreferences = { preset: "ink-night", accent: "#B85C3B", backgroundPreset: "paper", updatedAt: "2026-08-18T00:00:00.000Z" };
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

  it("订阅有待处理事项时导航徽标说明归属并默认进入订阅页", async () => {
    vi.spyOn(api, "proposals").mockResolvedValue([]);
    vi.mocked(api.subscriptionSummary).mockResolvedValue({ activeCount: 2, attentionCount: 2, dueCount: 1, upcomingCount: 1, upcoming: [], currencies: [] });
    render(
      <QueryClientProvider client={client()}>
        <EntryContext.Provider value={{ openEntry: () => undefined, closeEntry: () => undefined }}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes><Route element={<AppShell />}><Route index element={<div>页面内容</div>} /></Route></Routes>
          </MemoryRouter>
        </EntryContext.Provider>
      </QueryClientProvider>
    );

    const links = await screen.findAllByRole("link", { name: "事项，2项订阅需要留意" });
    expect(links.length).toBeGreaterThan(0);
    links.forEach((link) => expect(link).toHaveAttribute("href", "/matters?tab=subscriptions"));
  });

  it("仅计划需要留意时导航徽标进入计划页", async () => {
    vi.spyOn(api, "proposals").mockResolvedValue([]);
    vi.mocked(api.planSummary).mockResolvedValue({ openCount: 1, attentionCount: 1, dueCount: 0, overdueCount: 1, openAmountMinor: 0, upcoming: [] });
    render(
      <QueryClientProvider client={client()}>
        <EntryContext.Provider value={{ openEntry: () => undefined, closeEntry: () => undefined }}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes><Route element={<AppShell />}><Route index element={<div>页面内容</div>} /></Route></Routes>
          </MemoryRouter>
        </EntryContext.Provider>
      </QueryClientProvider>
    );

    const links = await screen.findAllByRole("link", { name: "事项，1项计划需要留意" });
    expect(links.length).toBeGreaterThan(0);
    links.forEach((link) => expect(link).toHaveAttribute("href", "/matters?tab=plans"));
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
