// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category } from "../shared/types";
import { api } from "../src/api";
import { AppShell } from "../src/components/AppShell";
import { EntryContext } from "../src/entry-context";
import { CategoriesPage } from "../src/pages/CategoriesPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function category(overrides: Partial<Category>): Category {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "expense",
    name: "餐饮",
    icon: "饭",
    color: "#D66A4C",
    sortOrder: 0,
    isArchived: false,
    transactionCount: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

describe("分类页面", () => {
  it("独立页面按支出/收入列出分类，并能调整顺序和打开新增分类", async () => {
    const food = category({});
    const travel = category({ id: "22222222-2222-4222-8222-222222222222", name: "交通", icon: "车", sortOrder: 1 });
    const salary = category({ id: "33333333-3333-4333-8333-333333333333", kind: "income", name: "工资", icon: "薪" });
    vi.spyOn(api, "categories").mockResolvedValue([food, travel, salary]);
    const reorder = vi.spyOn(api, "reorderCategories").mockResolvedValue([travel, food]);
    render(<QueryClientProvider client={client()}><MemoryRouter><CategoriesPage /></MemoryRouter></QueryClientProvider>);

    expect(screen.getByRole("heading", { level: 1, name: "分类" })).toBeInTheDocument();
    expect(await screen.findByText("餐饮")).toBeInTheDocument();
    expect(screen.getByText("交通")).toBeInTheDocument();
    expect(screen.queryByText("工资")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下移餐饮" }));
    // The whole new order goes out in one request, so a failure cannot leave duplicate positions.
    await waitFor(() => expect(reorder).toHaveBeenCalledWith("expense", [travel.id, food.id]));

    fireEvent.click(screen.getByRole("button", { name: "收入分类" }));
    expect(await screen.findByText("工资")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /新增分类/ }));
    const dialog = await screen.findByRole("dialog", { name: "新增收入分类" });
    expect(within(dialog).queryByRole("checkbox", { name: /固定支出/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "关闭新增分类" })).toBeInTheDocument();
  });

  it("支出分类可以标记为固定支出，列表显示固定标记", async () => {
    const rent = category({ id: "44444444-4444-4444-8444-444444444444", name: "居住", icon: "房", isFixed: true });
    vi.spyOn(api, "categories").mockResolvedValue([rent]);
    const create = vi.spyOn(api, "createCategory").mockResolvedValue(category({ id: "55555555-5555-4555-8555-555555555555", name: "保险", isFixed: true }));
    render(<QueryClientProvider client={client()}><MemoryRouter><CategoriesPage /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText("居住")).toBeInTheDocument();
    expect(screen.getByText("固定")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /新增分类/ }));
    const dialog = await screen.findByRole("dialog", { name: "新增支出分类" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "分类名称" }), { target: { value: "保险" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /固定支出/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存分类" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "expense", name: "保险", isFixed: true })));
  });

  it("改了一半的分类表单关闭前会确认", async () => {
    vi.spyOn(api, "categories").mockResolvedValue([category({})]);
    render(<QueryClientProvider client={client()}><MemoryRouter><CategoriesPage /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "编辑餐饮" }));
    const dialog = await screen.findByRole("dialog", { name: "修改支出分类" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "分类名称" }), { target: { value: "吃饭" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("alertdialog", { name: "放弃这次修改？" })).toBeInTheDocument();
  });

  it("侧栏在资金下方提供分类入口，手机顶栏也能进入", async () => {
    vi.spyOn(api, "proposals").mockResolvedValue([]);
    vi.spyOn(api, "subscriptionSummary").mockResolvedValue({ activeCount: 0, attentionCount: 0, dueCount: 0, upcomingCount: 0, upcoming: [], currencies: [] });
    vi.spyOn(api, "planSummary").mockResolvedValue({ openCount: 0, attentionCount: 0, dueCount: 0, overdueCount: 0, openAmountMinor: 0, upcoming: [] });
    render(
      <QueryClientProvider client={client()}>
        <EntryContext.Provider value={{ openEntry: () => undefined, closeEntry: () => undefined }}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes><Route element={<AppShell />}><Route index element={<div>页面内容</div>} /></Route></Routes>
          </MemoryRouter>
        </EntryContext.Provider>
      </QueryClientProvider>
    );

    const sidebar = await screen.findByRole("navigation", { name: "主导航" });
    const labels = within(sidebar).getAllByRole("link").map((link) => link.textContent?.trim());
    expect(labels.indexOf("分类")).toBe(labels.indexOf("资金") + 1);
    const links = screen.getAllByRole("link", { name: "分类" });
    expect(links.length).toBeGreaterThanOrEqual(2);
    links.forEach((link) => expect(link).toHaveAttribute("href", "/categories"));
  });
});
