// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Borrower, Category, Loan, Subscription } from "../shared/types";
import { api } from "../src/api";
import { MattersPage } from "../src/pages/MattersPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(api, "subscriptionSummary").mockResolvedValue({ activeCount: 0, attentionCount: 0, dueCount: 0, upcomingCount: 0, upcoming: [], currencies: [] });
});

function renderPage(path = "/matters?tab=loans") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><MattersPage /></MemoryRouter></QueryClientProvider>);
}

const borrower: Borrower = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "小林",
  note: null,
  isArchived: false,
  totalLentMinor: 36_500,
  totalRepaidMinor: 0,
  outstandingMinor: 36_500,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null
};

const loan: Loan = {
  id: "22222222-2222-4222-8222-222222222222",
  borrowerId: borrower.id,
  borrowerName: borrower.name,
  principalMinor: 36_500,
  amountMinor: 36_500,
  repaidMinor: 0,
  outstandingMinor: 36_500,
  localDate: "2026-08-18",
  lentDate: "2026-08-18",
  purpose: "生活费和买花",
  note: null,
  accountId: null,
  status: "active",
  ledgerLink: { mode: "none", transactionId: null, amountMinor: null, accountAmountMinor: null, currency: "CNY" },
  repayments: [],
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  deletedAt: null
};

const subscription: Subscription = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "OpenAI",
  plan: "Pro",
  startDate: "2026-08-01",
  recurringAmountMinor: 1_000,
  currency: "USD",
  cycle: "month",
  customDays: null,
  nextBillingDate: "2026-08-22",
  nextRenewalDate: "2026-08-22",
  reminderDays: 3,
  status: "active",
  url: "https://example.com",
  website: "https://example.com",
  note: "首月优惠",
  lastPaymentDate: "2026-08-01",
  renewalState: "upcoming",
  payments: [],
  lastPayment: null,
  priceMinor: 1_000,
  initialPriceMinor: null,
  cycleDays: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null
};

const cnyAccount: Account = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "微信",
  icon: "微",
  currency: "CNY",
  aliases: [],
  openingBalanceMinor: 20_000,
  balanceMinor: 20_000,
  openedOn: "2026-08-01",
  isArchived: false,
  isUnused: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

const usdAccount: Account = { ...cnyAccount, id: "55555555-5555-4555-8555-555555555555", name: "美元卡", icon: "卡", currency: "USD", balanceMinor: 5_000 };
const usdtAccount: Account = { ...cnyAccount, id: "66666666-6666-4666-8666-666666666666", name: "Bybit", icon: "B", currency: "USDT", balanceMinor: 8_000 };

const expenseCategory: Category = {
  id: "77777777-7777-4777-8777-777777777777",
  kind: "expense",
  name: "订阅服务",
  icon: "订",
  color: "#D66A4C",
  sortOrder: 0,
  isArchived: false,
  transactionCount: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

function enabledFunds() {
  return {
    enabled: true,
    startedOn: "2026-08-01",
    totalMinor: cnyAccount.balanceMinor,
    currencyTotals: { CNY: cnyAccount.balanceMinor, USD: usdAccount.balanceMinor, USDT: usdtAccount.balanceMinor },
    accountCount: 3,
    defaultExpenseAccountId: cnyAccount.id,
    defaultIncomeAccountId: cnyAccount.id,
    defaultFeeCategoryId: null,
    accounts: [cnyAccount, usdAccount, usdtAccount]
  };
}

describe("财务事项页面", () => {
  it("按借款人展示余额，展开后显示用途并提供还款入口", async () => {
    vi.spyOn(api, "borrowers").mockResolvedValue({ items: [borrower], total: 1, page: 1, pageSize: 30 });
    vi.spyOn(api, "loans").mockResolvedValue({ items: [loan], total: 1, page: 1, pageSize: 30 });
    vi.spyOn(api, "loanSummary").mockResolvedValue({ totalLentMinor: 36_500, totalRepaidMinor: 0, outstandingMinor: 36_500, borrowerCount: 1, openLoanCount: 1 });

    renderPage();
    expect(await screen.findByText("小林")).toBeInTheDocument();
    expect(screen.getAllByText("¥365.00").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /小林/ }));
    expect(await screen.findByText("生活费和买花")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "还款" })).toBeInTheDocument();
  });

  it("订阅页展示近期续费和记录续费入口", async () => {
    vi.spyOn(api, "subscriptions").mockResolvedValue({ items: [subscription], total: 1, page: 1, pageSize: 30 });
    vi.mocked(api.subscriptionSummary).mockResolvedValue({ activeCount: 1, attentionCount: 1, dueCount: 1, upcomingCount: 1, upcoming: [subscription], currencies: [{ currency: "USD", amountMinor: 1_000 }] });
    renderPage("/matters?tab=subscriptions");
    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /记录续费/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "订阅，1项需要留意" })).toHaveTextContent("1");
  });

  it("续费可选择外币账户并传递实际扣款金额", async () => {
    vi.spyOn(api, "subscriptions").mockResolvedValue({ items: [subscription], total: 1, page: 1, pageSize: 30 });
    vi.mocked(api.subscriptionSummary).mockResolvedValue({ activeCount: 1, attentionCount: 1, dueCount: 1, upcomingCount: 1, upcoming: [subscription], currencies: [{ currency: "USD", amountMinor: 1_000 }] });
    vi.spyOn(api, "fundsSummary").mockResolvedValue(enabledFunds());
    vi.spyOn(api, "categories").mockResolvedValue([expenseCategory]);
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    const createPayment = vi.spyOn(api, "createSubscriptionPayment").mockResolvedValue({} as never);

    renderPage("/matters?tab=subscriptions");
    fireEvent.click(await screen.findByRole("button", { name: /记录续费/ }));
    const picker = await screen.findByRole("combobox", { name: "订阅扣款账户" });

    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("option", { name: /美元卡/ }));
    expect(screen.getByLabelText(/实际扣款 USD/)).toHaveValue("10.00");
    expect(screen.getByLabelText(/实际扣款 USD/)).toHaveAttribute("readonly");

    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("option", { name: /Bybit/ }));
    fireEvent.change(screen.getByLabelText(/实际扣款 USDT/), { target: { value: "9.80" } });
    fireEvent.change(screen.getByLabelText(/实际扣款人民币/), { target: { value: "72.00" } });
    fireEvent.change(screen.getByLabelText("订阅支出分类"), { target: { value: expenseCategory.id } });
    fireEvent.click(screen.getByRole("button", { name: "确认已付款" }));

    await waitFor(() => expect(createPayment).toHaveBeenCalledWith(subscription.id, expect.objectContaining({
      amountMinor: 1_000,
      currency: "USD",
      ledgerLink: expect.objectContaining({
        accountId: usdtAccount.id,
        accountAmountMinor: 980,
        ledgerAmountMinor: 7_200
      })
    })));
  });

  it("事项回收站使用独立查询，不把已删除内容混入正常列表", async () => {
    const subscriptions = vi.spyOn(api, "subscriptions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    renderPage("/matters?tab=subscriptions");
    fireEvent.click(await screen.findByRole("button", { name: "回收站" }));
    await waitFor(() => expect(subscriptions).toHaveBeenLastCalledWith(expect.objectContaining({ status: "trash" })));
    expect(screen.getByText("订阅回收站")).toBeInTheDocument();
  });

  it("记录借款使用可搜索的单一借款人选择器并支持键盘关闭列表", async () => {
    vi.spyOn(api, "borrowers").mockResolvedValue({ items: [borrower], total: 1, page: 1, pageSize: 30 });
    vi.spyOn(api, "loans").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    vi.spyOn(api, "categories").mockResolvedValue([]);
    vi.spyOn(api, "transactions").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "记录借款" }));
    const combobox = screen.getByRole("combobox", { name: "搜索或新建借款人" });
    fireEvent.focus(combobox);
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    const options = screen.getByRole("listbox");
    expect(options.parentElement).toHaveClass("borrower-picker");
    expect(options.previousElementSibling).toHaveClass("borrower-picker__control");
    expect(screen.queryByText("或")).not.toBeInTheDocument();
    fireEvent.change(combobox, { target: { value: "小林" } });
    fireEvent.click(screen.getByRole("option", { name: /小林/ }));
    expect(screen.getByText("已选择借款人")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更换" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "搜索或新建借款人" }), { key: "Escape" });
    expect(screen.getByRole("combobox", { name: "搜索或新建借款人" })).toHaveAttribute("aria-expanded", "false");
  });
});
