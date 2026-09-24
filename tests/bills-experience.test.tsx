// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceReport, FundsSummary, Transaction, TransactionList } from "../shared/types";
import { api } from "../src/api";
import { EntryContext } from "../src/entry-context";
import { BillsPage } from "../src/pages/BillsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const report: FinanceReport = {
  grain: "month",
  anchor: "2026-08-01",
  kind: "expense",
  range: { start: "2026-08-01", end: "2026-08-31", label: "2026年8月" },
  previousRange: { start: "2026-07-01", end: "2026-07-31", label: "2026年7月" },
  isCurrentPeriod: false,
  incomeMinor: 0,
  expenseMinor: 0,
  balanceMinor: 0,
  selectedTotalMinor: 0,
  selectedAverageMinor: 0,
  averageDivisor: 31,
  averageUnit: "day",
  selectedComparison: { current: 0, previous: 0, delta: 0, percent: null, state: "same" },
  transactionCount: 0,
  trend: [],
  categories: [],
  generatedAt: "2026-08-19T00:00:00.000Z"
};

function renderPage(initialEntries = ["/bills?view=ledger&period=month&anchor=2026-08-01"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const value = { openEntry: vi.fn(), closeEntry: vi.fn() };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <EntryContext.Provider value={value}><BillsPage /></EntryContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("账单页移动查询", () => {
  it("搜索等待约 300ms 后才请求，并在请求期间保留旧列表", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "report").mockResolvedValue(report);
    vi.spyOn(api, "categories").mockResolvedValue([]);
    vi.spyOn(api, "dailyTotals").mockResolvedValue([]);
    const list: TransactionList = { items: [], total: 0, page: 1, pageSize: 100 };
    const transactions = vi.spyOn(api, "transactions").mockResolvedValue(list);
    renderPage();

    const search = screen.getByPlaceholderText("搜索备注");
    const initialCalls = transactions.mock.calls.length;
    fireEvent.change(search, { target: { value: "晚餐" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(transactions.mock.calls.length).toBe(initialCalls);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(transactions.mock.calls.some(([filters]) => filters.search === "晚餐")).toBe(true);
  });

  it("通过筛选按钮打开带收支、分类和完整导出的抽屉", async () => {
    vi.spyOn(api, "report").mockResolvedValue(report);
    vi.spyOn(api, "categories").mockResolvedValue([]);
    vi.spyOn(api, "dailyTotals").mockResolvedValue([]);
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    renderPage();

    const trigger = await screen.findByRole("button", { name: /打开筛选/ });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "账单筛选" });
    expect(within(dialog).getByRole("group", { name: "收支筛选" })).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "筛选分类" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "回收站" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /导出全部账本 CSV/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog.closest(".modal-backdrop")).toHaveClass("is-closing");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "账单筛选" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("账单页退款确认", () => {
  const accountId = "22222222-2222-4222-8222-222222222222";
  const funds: FundsSummary = {
    enabled: true,
    startedOn: "2026-08-01",
    totalMinor: 10_000,
    accountCount: 1,
    defaultExpenseAccountId: accountId,
    defaultIncomeAccountId: accountId,
    defaultFeeCategoryId: null,
    accounts: [],
    currencyTotals: { CNY: 10_000, USD: 0, USDT: 0 }
  };
  const transaction: Transaction = {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "expense",
    amountMinor: 2_000,
    currency: "CNY",
    accountAmountMinor: null,
    categoryId: "11111111-1111-4111-8111-111111111111",
    category: { id: "11111111-1111-4111-8111-111111111111", name: "餐饮", icon: "饭", color: "#D66A4C" },
    localDate: "2026-08-10",
    note: null,
    accountId,
    account: null,
    refundedAt: null,
    fundsBaseline: false,
    refundAccountId: null,
    source: "user",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    deletedAt: null
  };

  it("全额退款使用应用内确认，关闭不会退款", async () => {
    const confirm = vi.spyOn(window, "confirm");
    vi.spyOn(api, "report").mockResolvedValue(report);
    vi.spyOn(api, "categories").mockResolvedValue([]);
    vi.spyOn(api, "dailyTotals").mockResolvedValue([]);
    vi.spyOn(api, "fundsSummary").mockResolvedValue(funds);
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [transaction], total: 1, page: 1, pageSize: 100 });
    const refund = vi.spyOn(api, "refundTransaction").mockResolvedValue({ ...transaction, refundedAt: "2026-08-11T00:00:00.000Z" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "全额退款" }));
    let dialog = await screen.findByRole("dialog", { name: "确认全额退款" });
    expect(dialog).toHaveTextContent("原账会保留，但不再计入收支和预算");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭全额退款确认" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认全额退款" })).not.toBeInTheDocument());
    expect(refund).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "全额退款" }));
    dialog = await screen.findByRole("dialog", { name: "确认全额退款" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认全额退款" }));
    await waitFor(() => expect(refund).toHaveBeenCalledWith(transaction.id, transaction.updatedAt, undefined));
    expect(confirm).not.toHaveBeenCalled();
  });
});
