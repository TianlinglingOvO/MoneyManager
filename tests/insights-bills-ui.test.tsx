// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Category, FinanceReport, Transaction, TransactionList } from "../shared/types";
import { api } from "../src/api";
import { RecentRecordedList } from "../src/components/RecentRecordedList";
import { EntryContext } from "../src/entry-context";
import { BillsPage } from "../src/pages/BillsPage";
import { InsightsPage } from "../src/pages/InsightsPage";
import { todayKey } from "../src/utils";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const category: Category = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "expense",
  name: "餐饮",
  icon: "饭",
  color: "#D66A4C",
  sortOrder: 0,
  isArchived: false,
  transactionCount: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

const incomeCategory: Category = { ...category, id: "22222222-2222-4222-8222-222222222222", kind: "income", name: "工资", icon: "钱", color: "#3E8066" };

const transaction: Transaction = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "expense",
  amountMinor: 2_440,
  accountAmountMinor: null,
  currency: "CNY",
  categoryId: category.id,
  category: { id: category.id, name: category.name, icon: category.icon, color: category.color },
  localDate: "2026-08-07",
  note: "晚餐",
  accountId: null,
  account: null,
  fundsBaseline: false,
  refundedAt: null,
  refundAccountId: null,
  source: "openclaw",
  createdAt: "2026-08-07T12:00:00.000Z",
  updatedAt: "2026-08-07T12:00:00.000Z",
  deletedAt: null
};

const report: FinanceReport = {
  grain: "month",
  anchor: "2026-08-01",
  kind: "expense",
  range: { start: "2026-08-01", end: "2026-08-31", label: "2026年8月" },
  previousRange: { start: "2026-07-01", end: "2026-07-31", label: "2026年7月" },
  isCurrentPeriod: false,
  incomeMinor: 0,
  expenseMinor: 2_440,
  balanceMinor: -2_440,
  selectedTotalMinor: 2_440,
  selectedAverageMinor: 79,
  averageDivisor: 31,
  averageUnit: "day",
  selectedComparison: { current: 2_440, previous: 0, delta: 2_440, percent: null, state: "new" },
  transactionCount: 1,
  trend: [{ key: "2026-08-07", label: "8月7日", amountMinor: 2_440 }],
  categories: [{
    categoryId: category.id,
    name: category.name,
    icon: category.icon,
    color: category.color,
    amountMinor: 2_440,
    percent: 100,
    previousAmountMinor: 0,
    deltaMinor: 2_440,
    changePercent: null,
    changeState: "new"
  }],
  generatedAt: "2026-08-19T00:00:00.000Z"
};

function renderWithProviders(node: ReactNode, initialEntries = ["/"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

function EntryProvider({ children }: { children: ReactNode }) {
  return <EntryContext.Provider value={{ openEntry: vi.fn(), closeEntry: vi.fn() }}>{children}</EntryContext.Provider>;
}

function LocationProbe() {
  const [params] = useSearchParams();
  return <output data-testid="location-search">{params.toString()}</output>;
}

describe("洞察与账单下钻", () => {
  it("分类明细与构成互斥显示，并都能下钻到账单筛选", async () => {
    vi.spyOn(api, "report").mockResolvedValue(report);
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 6 });

    renderWithProviders(<EntryProvider><InsightsPage /></EntryProvider>);

    expect(await screen.findByRole("heading", { level: 1, name: "2026年8月" })).toBeInTheDocument();
    expect(screen.queryByText("INSIGHTS")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "分类明细" })).toBeInTheDocument();
    expect(screen.queryByText("前三类占比")).not.toBeInTheDocument();
    const detailLink = screen.getByRole("link", { name: /查看餐饮分类账单/ });
    const href = detailLink.getAttribute("href") ?? "";
    expect(href).toContain(`/bills?view=ledger&period=month&anchor=${todayKey()}&kind=expense`);
    expect(href).toContain(`categoryId=${category.id}`);
    expect(href).toContain("returnTo=");

    fireEvent.click(screen.getByRole("button", { name: "构成" }));
    expect(screen.getByRole("heading", { name: "分类构成" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "分类明细" })).not.toBeInTheDocument();
    expect(screen.queryByText("前三类占比")).not.toBeInTheDocument();
    const compositionLink = screen.getByRole("link", { name: /查看餐饮分类账单/ });
    fireEvent.focus(compositionLink);
    expect(compositionLink).toHaveClass("is-active");
    fireEvent.blur(compositionLink);
    expect(compositionLink).not.toHaveClass("is-active");
  });

  it("分类构成完整显示超过八个分类且不生成其他", async () => {
    const categories = Array.from({ length: 10 }, (_, index) => ({
      ...report.categories[0]!,
      categoryId: `category-${index + 1}`,
      name: `分类 ${index + 1}`,
      amountMinor: (10 - index) * 100
    }));
    vi.spyOn(api, "report").mockResolvedValue({ ...report, categories });
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 6 });

    renderWithProviders(<EntryProvider><InsightsPage /></EntryProvider>);
    expect(await screen.findByRole("heading", { level: 1, name: "2026年8月" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "构成" }));

    for (const item of categories) {
      expect(screen.getByRole("link", { name: new RegExp(`查看${item.name}分类账单`) })).toBeInTheDocument();
    }
    expect(screen.queryByText("其他")).not.toBeInTheDocument();
  });

  it("分类明细和环比卡片写出上期同进度窗口与金额", async () => {
    vi.spyOn(api, "report").mockResolvedValue({
      ...report,
      grain: "month",
      range: { start: "2026-09-01", end: "2026-09-01", label: "2026年9月" },
      previousRange: { start: "2026-08-01", end: "2026-08-01", label: "2026年8月" },
      isCurrentPeriod: true,
      selectedTotalMinor: 3_000,
      selectedComparison: { current: 3_000, previous: 1_000, delta: 2_000, percent: 200, state: "up" },
      categories: [{
        ...report.categories[0]!,
        name: "日用",
        amountMinor: 3_000,
        previousAmountMinor: 1_000,
        deltaMinor: 2_000,
        changePercent: 200,
        changeState: "up"
      }]
    });
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 6 });
    renderWithProviders(<EntryProvider><InsightsPage /></EntryProvider>, ["/?grain=month&anchor=2026-09-01&kind=expense"]);
    expect(await screen.findByText("较上月同期")).toBeInTheDocument();
    expect(screen.getByText("8月1日–8月1日 · +¥20.00")).toBeInTheDocument();
    expect(screen.getByText("上期 ¥10.00")).toBeInTheDocument();
    expect(screen.getAllByText("+200.0%").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /较上期 ¥10.00 增加 200.0%/ })).toBeInTheDocument();
  });

  it("从账单 URL 初始化筛选，并在切换筛选时同步 URL", async () => {
    const calls: Array<Record<string, string | number | boolean | undefined>> = [];
    const list: TransactionList = { items: [transaction], total: 1, page: 1, pageSize: 100 };
    vi.spyOn(api, "report").mockResolvedValue(report);
    vi.spyOn(api, "categories").mockResolvedValue([category, incomeCategory]);
    vi.spyOn(api, "transactions").mockImplementation(async (filters) => {
      calls.push(filters);
      return list;
    });
    vi.spyOn(api, "dailyTotals").mockResolvedValue([{ localDate: "2026-08-07", incomeMinor: 0, expenseMinor: 2_440, transactionCount: 1 }]);

    renderWithProviders(<EntryProvider><BillsPage /><LocationProbe /></EntryProvider>, [
      `/bills?view=ledger&period=month&anchor=2026-08-01&kind=expense&categoryId=${category.id}`
    ]);

    expect(await screen.findByRole("heading", { level: 1, name: "账单" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "筛选分类" })).toHaveValue(category.id);
    await waitFor(() => expect(calls.some((value) => value.kind === "expense" && value.categoryId === category.id)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "收入" }));
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("view=ledger&period=month&anchor=2026-08-01&kind=income"));
    await waitFor(() => expect(calls.some((value) => value.kind === "income" && value.categoryId === undefined)).toBe(true));
  }, 10_000);

  it("使用最近录入、月账单、年账单和回收站四个平级页签", async () => {
    vi.spyOn(api, "report").mockResolvedValue(report);
    vi.spyOn(api, "categories").mockResolvedValue([category]);
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    vi.spyOn(api, "dailyTotals").mockResolvedValue([]);

    renderWithProviders(<EntryProvider><BillsPage /><LocationProbe /></EntryProvider>, [
      "/bills?view=ledger&period=month&anchor=2026-08-01"
    ]);

    expect(await screen.findByRole("tab", { name: "最近录入" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "月账单" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "年账单" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "回收站" })).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByText("月度流水")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "年账单" }));
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("view=ledger&period=year&anchor=2026-08-01"));
    expect(screen.getByRole("tab", { name: "年账单" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("2026年")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "最近录入" }));
    await waitFor(() => expect(screen.getByTestId("location-search")).not.toHaveTextContent("view=ledger"));
    expect(screen.getByRole("tab", { name: "最近录入" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "回收站" }));
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("view=trash"));
    expect(screen.getByRole("tab", { name: "回收站" })).toHaveAttribute("aria-selected", "true");
  });

  it("回收站跨日期加载并通过危险确认永久删除", async () => {
    const deleted = { ...transaction, localDate: "2025-01-02", updatedAt: "2026-08-18T09:00:00.000Z", deletedAt: "2026-08-18T09:00:00.000Z" };
    vi.spyOn(api, "categories").mockResolvedValue([category]);
    const transactions = vi.spyOn(api, "transactions").mockResolvedValue({ items: [deleted], total: 1, page: 1, pageSize: 100 });
    const permanentDelete = vi.spyOn(api, "permanentlyDeleteTransaction").mockResolvedValue({
      entityType: "transaction",
      entityId: deleted.id,
      permanentlyDeletedTransactionCount: 1,
      detachedLedgerLinkCount: 0,
      rejectedProposalCount: 0,
      invalidatedOperationCount: 0
    });

    renderWithProviders(<EntryProvider><BillsPage /><LocationProbe /></EntryProvider>, ["/bills?view=trash&kind=expense"]);
    expect(await screen.findByRole("tab", { name: "回收站" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(transactions).toHaveBeenCalledWith(expect.objectContaining({ deleted: "trash", sort: "deleted" })));
    const trashFilters = transactions.mock.calls[0]?.[0];
    expect(trashFilters).not.toHaveProperty("start");
    expect(trashFilters).not.toHaveProperty("end");
    expect(screen.getByText("发生于 2025-01-02")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    const dialog = screen.getByRole("alertdialog", { name: "永久删除这笔账？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(permanentDelete).toHaveBeenCalledWith(deleted.id, deleted.updatedAt));
  });
});

describe("最近录入可访问提示", () => {
  it("可编辑时提供明确的按钮语义和方向提示", () => {
    render(<RecentRecordedList items={[transaction]} onEdit={() => undefined} />);
    expect(screen.getByRole("button", { name: /编辑餐饮.*支出.*¥24\.40.*发生于8月7日/ })).toBeInTheDocument();
    expect(screen.getByText("›")).toBeInTheDocument();
  });
});
