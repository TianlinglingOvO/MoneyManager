// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, FundsSummary } from "../shared/types";
import { api } from "../src/api";
import { FundsPage } from "../src/pages/FundsPage";
import { DangerConfirmDialog } from "../src/components/DangerConfirmDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  currency: "CNY",
  aliases: ["零钱"],
  openingBalanceMinor: 100_000,
  balanceMinor: 95_000,
  openedOn: "2026-08-23",
  isArchived: false,
  isUnused: false,
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
    ...overrides,
    currencyTotals: overrides.currencyTotals ?? { CNY: overrides.totalMinor ?? 95_000, USD: 0, USDT: 0 }
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
        currency: "CNY",
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

    expect(await screen.findByText("人民币可用资金")).toBeInTheDocument();
    expect(screen.getAllByText("¥950.00").length).toBeGreaterThan(0);
    expect(screen.getByText(/CNY 账户 · 别名：零钱/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "永久删除 微信" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "永久删除 微信" })).toHaveAttribute("title", "已有资金记录的账户不能永久删除");
    expect(screen.getByRole("button", { name: "转账" })).toBeInTheDocument();
  });

  it("最近资金流水按发生日倒序并提供加载更多", async () => {
    const newer = {
      id: "22222222-2222-4222-8222-222222222222",
      accountId: account.id,
      accountName: account.name,
      currency: "CNY" as const,
      deltaMinor: -2_900,
      sourceType: "transaction" as const,
      sourceId: "33333333-3333-4333-8333-333333333333",
      localDate: "2026-08-29",
      requestId: null,
      operationId: null,
      reversalOfId: null,
      createdAt: "2026-08-29T00:00:00.000Z"
    };
    const older = {
      ...newer,
      id: "44444444-4444-4444-8444-444444444444",
      sourceId: "55555555-5555-4555-8555-555555555555",
      localDate: "2026-08-27",
      createdAt: "2026-08-27T00:00:00.000Z",
      deltaMinor: -1_200
    };
    vi.spyOn(api, "fundsSummary").mockResolvedValue(summary());
    vi.spyOn(api, "accounts").mockResolvedValue([account]);
    const movements = vi.spyOn(api, "accountMovements").mockImplementation(async (filters = {}) => {
      if ((filters.page ?? 1) === 1) return { items: [newer], total: 2, page: 1, pageSize: 1 };
      return { items: [older], total: 2, page: 2, pageSize: 1 };
    });
    vi.spyOn(api, "transfers").mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("人民币可用资金")).toBeInTheDocument();
    expect(await screen.findByText("2026-08-29 · 账目")).toBeInTheDocument();
    expect(screen.queryByText("2026-08-27 · 账目")).not.toBeInTheDocument();
    expect(document.querySelector(".funds-movement-list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() => expect(screen.getByText("2026-08-27 · 账目")).toBeInTheDocument());
    expect(movements).toHaveBeenCalledWith(expect.objectContaining({ sort: "recent" }));
  });

  it("允许永久删除带非零初始余额但从未使用的非默认账户", async () => {
    const unused: Account = {
      ...account,
      id: "44444444-4444-4444-8444-444444444444",
      name: "Bybit",
      currency: "USD",
      aliases: [],
      openingBalanceMinor: 755,
      balanceMinor: 755,
      isUnused: true
    };
    vi.spyOn(api, "fundsSummary").mockResolvedValue(summary({ accountCount: 2, accounts: [account, unused] }));
    vi.spyOn(api, "accounts").mockResolvedValueOnce([account, unused]).mockResolvedValue([account]);
    vi.spyOn(api, "accountMovements").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    vi.spyOn(api, "transfers").mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "永久删除 Bybit" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getAllByText("US$7.55")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/accounts/" + unused.id, expect.objectContaining({ method: "DELETE" })));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Bybit")).not.toBeInTheDocument());
  });

  it("未使用账户可在编辑页直接提交初始余额与币种", async () => {
    const unused: Account = {
      ...account,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Bybit",
      currency: "USD",
      aliases: [],
      openingBalanceMinor: 755,
      balanceMinor: 755,
      isUnused: true
    };
    vi.spyOn(api, "fundsSummary").mockResolvedValue(summary({ accountCount: 2, accounts: [account, unused] }));
    vi.spyOn(api, "accounts").mockResolvedValue([account, unused]);
    vi.spyOn(api, "accountMovements").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    vi.spyOn(api, "transfers").mockResolvedValue([]);
    const update = vi.spyOn(api, "updateAccount").mockResolvedValue({ ...unused, currency: "USDT", openingBalanceMinor: 1_234, balanceMinor: 1_234 });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "编辑 Bybit" }));
    fireEvent.change(screen.getByLabelText(/初始余额/), { target: { value: "12.34" } });
    fireEvent.change(screen.getByLabelText(/币种/), { target: { value: "USDT" } });
    fireEvent.click(screen.getByRole("button", { name: "保存账户" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(unused.id, expect.objectContaining({
      currency: "USDT",
      balanceChange: expect.objectContaining({ targetBalanceMinor: 1_234, note: null })
    })));
  });

  it("校准默认折叠且不混入最近流水，并只允许撤销最新记录", async () => {
    vi.spyOn(api, "fundsSummary").mockResolvedValue(summary());
    vi.spyOn(api, "accounts").mockResolvedValue([account]);
    vi.spyOn(api, "accountMovements").mockResolvedValue({
      items: [{
        id: "66666666-6666-4666-8666-666666666666",
        accountId: account.id,
        accountName: account.name,
        currency: "CNY",
        deltaMinor: 1_000,
        sourceType: "adjustment",
        sourceId: "77777777-7777-4777-8777-777777777777",
        localDate: "2026-08-24",
        requestId: null,
        operationId: null,
        reversalOfId: null,
        createdAt: "2026-08-24T00:00:00.000Z"
      }],
      total: 1,
      page: 1,
      pageSize: 30
    });
    vi.spyOn(api, "transfers").mockResolvedValue([]);
    const list = vi.spyOn(api, "accountAdjustments").mockResolvedValue({
      items: [{
        id: "77777777-7777-4777-8777-777777777777",
        accountId: account.id,
        accountName: account.name,
        currency: "CNY",
        balanceBeforeMinor: 94_000,
        targetBalanceMinor: 95_000,
        deltaMinor: 1_000,
        localDate: "2026-08-24",
        note: "对照银行余额",
        canUndo: true,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z"
      }],
      total: 1,
      page: 1,
      pageSize: 30
    });
    const undo = vi.spyOn(api, "undoAccountAdjustment").mockResolvedValue(account);

    renderPage();
    expect(await screen.findByText("还没有资金流水。")).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /余额校准记录/ }));
    expect(await screen.findByText("¥940.00 → ¥950.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销 微信 2026-08-24 的余额校准" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith(
      "77777777-7777-4777-8777-777777777777",
      expect.objectContaining({ expectedUpdatedAt: "2026-08-24T00:00:00.000Z" })
    ));
  });

it("脏账户表单会拦截 Escape、遮罩和 Android 返回，确认后才关闭", async () => {
    const unused: Account = {
      ...account,
      id: "88888888-8888-4888-8888-888888888888",
      name: "Bybit",
      isUnused: true
    };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.spyOn(api, "fundsSummary").mockResolvedValue(summary({ accountCount: 2, accounts: [account, unused] }));
    vi.spyOn(api, "accounts").mockResolvedValue([account, unused]);
    vi.spyOn(api, "accountMovements").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    vi.spyOn(api, "transfers").mockResolvedValue([]);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "编辑 Bybit" }));
    fireEvent.change(screen.getByLabelText("账户名称"), { target: { value: "Bybit 卡" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("heading", { name: "编辑资金账户" })).toBeInTheDocument();
    fireEvent.mouseDown(document.querySelector(".bottom-sheet-backdrop")!);
    expect(screen.getByRole("heading", { name: "编辑资金账户" })).toBeInTheDocument();
    fireEvent.popState(window);
    expect(screen.getByRole("heading", { name: "编辑资金账户" })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "编辑资金账户" })).not.toBeInTheDocument());
  });

  it("校准记录可逐页加载且展开状态保持不变", async () => {
    vi.spyOn(api, "fundsSummary").mockResolvedValue(summary());
    vi.spyOn(api, "accounts").mockResolvedValue([account]);
    vi.spyOn(api, "accountMovements").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    vi.spyOn(api, "transfers").mockResolvedValue([]);
    const list = vi.spyOn(api, "accountAdjustments").mockImplementation(async (filters = {}) => {
      const { page = 1, pageSize = 30 } = filters;
      return {
        items: page === 1 ? [{
        id: "99999999-9999-4999-8999-999999999999",
        accountId: account.id,
        accountName: account.name,
        currency: "CNY",
        balanceBeforeMinor: 94_000,
        targetBalanceMinor: 95_000,
        deltaMinor: 1_000,
        localDate: "2026-08-24",
        note: null,
        canUndo: true,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z"
      }] : [],
      total: 31,
      page,
        pageSize
      };
    });

    renderPage();
    const toggle = await screen.findByRole("button", { name: /余额校准记录/ });
    fireEvent.click(toggle);
    const more = await screen.findByRole("button", { name: "加载更多" });
    fireEvent.click(more);
    await waitFor(() => expect(list).toHaveBeenCalledWith({ page: 2, pageSize: 30 }));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("危险确认在 pending 时拦截 Escape、遮罩与 Android 返回，并将错误作为 alert", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
    const onClose = vi.fn();
    const view = render(<DangerConfirmDialog title="永久删除" description="不可恢复" confirmLabel="删除" isPending error="删除失败" onConfirm={vi.fn()} onClose={onClose} />);

    expect(screen.getByRole("alert")).toHaveTextContent("删除失败");
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" }).parentElement).toHaveClass("confirm-action-group");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    fireEvent.popState(window);
    expect(onClose).not.toHaveBeenCalled();

    view.rerender(<DangerConfirmDialog title="永久删除" description="不可恢复" confirmLabel="删除" error="删除失败" onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.popState(window);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
