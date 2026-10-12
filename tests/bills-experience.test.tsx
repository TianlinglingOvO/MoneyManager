// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceReport, FundsSummary, Transaction, TransactionList } from "../shared/types";
import { api } from "../src/api";
import { EntryContext } from "../src/entry-context";
import { QuickEntry } from "../src/components/QuickEntry";
import { LedgerClockProvider } from "../src/ledger-clock";
import { BillsPage } from "../src/pages/BillsPage";
import { ToastContext } from "../src/toast-context";

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

    const search = screen.getByPlaceholderText("搜索备注、分类或金额");
    const initialCalls = transactions.mock.calls.length;
    fireEvent.change(search, { target: { value: "晚餐" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(transactions.mock.calls.length).toBe(initialCalls);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(transactions.mock.calls.some(([filters]) => filters.search === "晚餐")).toBe(true);
  });

  it("搜索时可以切到全部时间，导出链接沿用当前筛选", async () => {
    vi.spyOn(api, "report").mockResolvedValue(report);
    vi.spyOn(api, "categories").mockResolvedValue([]);
    const totals = vi.spyOn(api, "dailyTotals").mockResolvedValue([]);
    const transactions = vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    renderPage();

    fireEvent.change(screen.getByPlaceholderText("搜索备注、分类或金额"), { target: { value: "35" } });
    const scope = await screen.findByRole("group", { name: "搜索范围" }, { timeout: 2000 });
    expect(within(scope).getByRole("button", { name: "本月" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(scope).getByRole("button", { name: "全部时间" }));
    await waitFor(() => expect(transactions.mock.calls.some(([filters]) => filters.search === "35" && filters.start === undefined && filters.end === undefined)).toBe(true));
    expect(totals.mock.calls.some(([filters]) => filters.search === "35" && filters.start === "1970-01-01")).toBe(true);
    expect(document.querySelector(".period-switcher--static")).toHaveTextContent("全部时间");
    const exportLink = screen.getAllByRole("link", { name: /导出当前视图/ })[0]!;
    expect(exportLink.getAttribute("href")).toBe("/api/v1/transactions.csv?search=35");
  });

  it("不在本月时提供回到本月", async () => {
    vi.spyOn(api, "report").mockResolvedValue(report);
    vi.spyOn(api, "categories").mockResolvedValue([]);
    vi.spyOn(api, "dailyTotals").mockResolvedValue([]);
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    renderPage(["/bills?view=ledger&period=month&anchor=2020-01-01"]);
    fireEvent.click(await screen.findByRole("button", { name: /回到本月/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /回到本月/ })).not.toBeInTheDocument());
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
    expect(within(dialog).getByRole("link", { name: /导出当前视图/ })).toHaveAttribute("href", expect.stringContaining("/api/v1/transactions.csv?start=2026-08-01&end=2026-08-31"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog.closest(".modal-backdrop")).toHaveClass("is-closing");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "账单筛选" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("编辑弹窗中的全额退款", () => {
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

  const foodCategory = { id: "11111111-1111-4111-8111-111111111111", kind: "expense" as const, name: "餐饮", icon: "饭", color: "#D66A4C", sortOrder: 0, isArchived: false, transactionCount: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };

  function renderEntry(value: Transaction) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const notify = vi.fn();
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <LedgerClockProvider>
          <ToastContext.Provider value={notify}>
            <MemoryRouter><QuickEntry open transaction={value} onClose={onClose} /></MemoryRouter>
          </ToastContext.Provider>
        </LedgerClockProvider>
      </QueryClientProvider>
    );
    return { notify, onClose };
  }

  it("账单行不再放退款按钮，退款在编辑弹窗里确认后执行", async () => {
    const confirm = vi.spyOn(window, "confirm");
    vi.spyOn(api, "settings").mockResolvedValue({ currency: "CNY", timezone: "Asia/Shanghai", today: "2026-08-20", rows: [] });
    vi.spyOn(api, "categories").mockResolvedValue([foodCategory]);
    vi.spyOn(api, "fundsSummary").mockResolvedValue(funds);
    const refund = vi.spyOn(api, "refundTransaction").mockResolvedValue({ ...transaction, refundedAt: "2026-08-11T00:00:00.000Z" });
    renderEntry(transaction);

    fireEvent.click(await screen.findByRole("button", { name: /全额退款/ }));
    let panel = await screen.findByRole("alertdialog", { name: "确认全额退款？" });
    expect(panel).toHaveTextContent("原账会保留并标记为已退款");
    fireEvent.click(within(panel).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "确认全额退款？" })).not.toBeInTheDocument());
    expect(refund).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /全额退款/ }));
    panel = await screen.findByRole("alertdialog", { name: "确认全额退款？" });
    fireEvent.click(within(panel).getByRole("button", { name: "确认全额退款" }));
    await waitFor(() => expect(refund).toHaveBeenCalledWith(transaction.id, transaction.updatedAt, undefined));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("没有账户的旧账退款必须选择人民币到账账户", async () => {
    const cny = { id: accountId, name: "微信", icon: "微", currency: "CNY" as const, aliases: [], openingBalanceMinor: 0, balanceMinor: 10_000, openedOn: "2026-08-01", isArchived: false, isUnused: false, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };
    const usd = { ...cny, id: "44444444-4444-4444-8444-444444444444", name: "美元卡", icon: "$", currency: "USD" as const };
    vi.spyOn(api, "settings").mockResolvedValue({ currency: "CNY", timezone: "Asia/Shanghai", today: "2026-08-20", rows: [] });
    vi.spyOn(api, "categories").mockResolvedValue([foodCategory]);
    vi.spyOn(api, "fundsSummary").mockResolvedValue({ ...funds, accounts: [cny, usd] });
    const refund = vi.spyOn(api, "refundTransaction").mockResolvedValue({ ...transaction, refundedAt: "2026-08-11T00:00:00.000Z" });
    renderEntry({ ...transaction, accountId: null, localDate: "2026-07-10", fundsBaseline: true });

    fireEvent.click(await screen.findByRole("button", { name: /全额退款/ }));
    const panel = await screen.findByRole("alertdialog", { name: "确认全额退款？" });
    expect(panel).toHaveTextContent("请选择退款实际到账的人民币账户");
    fireEvent.click(within(panel).getByRole("combobox", { name: "退款到账账户" }));
    expect(within(panel).queryByRole("option", { name: /美元卡/ })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("option", { name: /微信/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "确认全额退款" }));
    await waitFor(() => expect(refund).toHaveBeenCalledWith(transaction.id, transaction.updatedAt, accountId));
  });

  it("已退款的账目锁定字段，只能撤销退款", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ currency: "CNY", timezone: "Asia/Shanghai", today: "2026-08-20", rows: [] });
    vi.spyOn(api, "categories").mockResolvedValue([foodCategory]);
    vi.spyOn(api, "fundsSummary").mockResolvedValue(funds);
    const undo = vi.spyOn(api, "undoTransactionRefund").mockResolvedValue(transaction);
    const refunded = { ...transaction, refundedAt: "2026-08-11T00:00:00.000Z" };
    renderEntry(refunded);

    expect(await screen.findByText(/这笔账已全额退款/)).toBeInTheDocument();
    expect(screen.getByLabelText("金额")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "保存修改" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /撤销退款/ }));
    const panel = await screen.findByRole("alertdialog", { name: "撤销退款？" });
    fireEvent.click(within(panel).getByRole("button", { name: "撤销退款" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith(refunded.id, refunded.updatedAt));
  });
});
