// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, FundsSummary } from "../shared/types";
import { api } from "../src/api";
import { FundsPage } from "../src/pages/FundsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><FundsPage /></MemoryRouter>
    </QueryClientProvider>
  );
}

const account: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "微信",
  icon: "微",
  aliases: ["零钱"],
  openingBalanceMinor: 100_000,
  balanceMinor: 95_000,
  openedOn: "2026-08-23",
  isArchived: false,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z"
};

function summary(overrides: Partial<FundsSummary> = {}): FundsSummary {
  return {
    enabled: true,
    startedOn: "2026-08-23",
    totalMinor: 95_000,
    accountCount: 1,
    defaultExpenseAccountId: account.id,
    defaultIncomeAccountId: account.id,
    defaultFeeCategoryId: null,
    accounts: [account],
    ...overrides
  };
}

describe("资金页面", () => {
  it("未启用时展示不追溯历史的向导并提交现实余额", async () => {
    vi.spyOn(api, "fundsSummary").mockResolvedValue(summary({
      enabled: false,
      startedOn: null,
      totalMinor: 0,
      accountCount: 0,
      defaultExpenseAccountId: null,
      defaultIncomeAccountId: null,
      accounts: []
    }));
    const activate = vi.spyOn(api, "activateFunds").mockResolvedValue(summary());

    renderPage();

    expect(await screen.findByRole("heading", { name: "开始资金追踪" })).toBeInTheDocument();
    expect(screen.getByText(/启用前的旧账不会被追溯/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("第 1 个账户名称"), { target: { value: "微信钱包" } });
    fireEvent.change(screen.getByLabelText("第 1 个账户图标"), { target: { value: "微" } });
    fireEvent.change(screen.getAllByText("当前余额")[0]!.nextElementSibling!, { target: { value: "123.45" } });
    fireEvent.change(screen.getByText("默认支出账户").nextElementSibling!, { target: { value: "微信钱包" } });
    fireEvent.change(screen.getByText("默认收入账户").nextElementSibling!, { target: { value: "微信钱包" } });
    fireEvent.click(screen.getByRole("button", { name: "确认启用" }));

    await waitFor(() => expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      accounts: expect.arrayContaining([expect.objectContaining({ name: "微信钱包", openingBalanceMinor: 12_345 })]),
      defaultExpenseAccountName: "微信钱包",
      defaultIncomeAccountName: "微信钱包"
    })));
  });

  it("已启用时展示总资金、账户、流水并提供未使用账户删除入口", async () => {
    vi.spyOn(api, "fundsSummary").mockResolvedValue(summary());
    vi.spyOn(api, "accounts").mockResolvedValue([account]);
    vi.spyOn(api, "accountMovements").mockResolvedValue({
      items: [{
        id: "22222222-2222-4222-8222-222222222222",
        accountId: account.id,
        accountName: account.name,
        deltaMinor: -5_000,
        sourceType: "transaction",
        sourceId: "33333333-3333-4333-8333-333333333333",
        localDate: "2026-08-23",
        requestId: null,
        operationId: null,
        reversalOfId: null,
        createdAt: "2026-08-23T00:00:00.000Z"
      }],
      total: 1,
      page: 1,
      pageSize: 30
    });
    vi.spyOn(api, "transfers").mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText("总资金")).toBeInTheDocument();
    expect(screen.getAllByText("¥950.00").length).toBeGreaterThan(0);
    expect(screen.getByText("别名：零钱")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "永久删除 微信" })).toHaveAttribute("title", "仅未使用账户可以永久删除");
    expect(screen.getByRole("button", { name: "转账" })).toBeInTheDocument();
  });
});
