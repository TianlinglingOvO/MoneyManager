// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AiAnalysis, Category, Proposal, Transaction } from "../shared/types";
import { api, ApiError } from "../src/api";
import { QuickEntry } from "../src/components/QuickEntry";
import { RecentRecordedList } from "../src/components/RecentRecordedList";
import { TransactionList } from "../src/components/TransactionList";
import { AiPage } from "../src/pages/AiPage";
import { ProposalsPage } from "../src/pages/ProposalsPage";
import { analysisPeriodRange, todayKey } from "../src/utils";

afterEach(() => cleanup());

function renderWithProviders(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

function category(): Category {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "expense",
    name: "餐饮",
    icon: "饭",
    color: "#D66A4C",
    sortOrder: 0,
    isArchived: false,
    transactionCount: 0,
    createdAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z"
  };
}

function transaction(id: string, localDate: string, note: string): Transaction {
  return {
    id,
    kind: "expense",
    amountMinor: 1_234,
    currency: "CNY",
    accountAmountMinor: null,
    categoryId: category().id,
    category: { id: category().id, name: "餐饮", icon: "饭", color: "#D66A4C" },
    localDate,
    note,
    accountId: null,
    account: null,
    refundedAt: null,
    fundsBaseline: false,
    refundAccountId: null,
    source: "user",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    deletedAt: null
  };
}

function pendingProposal(): Proposal {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    action: "create",
    targetTransactionId: null,
    payload: {
      kind: "expense",
      amountMinor: 2_440,
      categoryId: category().id,
      localDate: "2026-08-07",
      note: "晚餐"
    },
    reason: "代为记账",
    source: "openclaw",
    status: "pending",
    revision: 1,
    createdAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z",
    resolvedAt: null
  };
}

describe("账目列表优化", () => {
  it("首页紧凑列表使用日期分隔线且不在每笔备注中重复日期", () => {
    const view = render(<TransactionList compact items={[
      transaction("a", "2026-08-04", "午餐"),
      transaction("b", "2026-08-03", "晚餐")
    ]} />);
    expect(view.container.querySelectorAll(".compact-date-divider")).toHaveLength(2);
    expect(screen.getByText("午餐")).toBeInTheDocument();
    expect(screen.getByText("晚餐")).toBeInTheDocument();
  });

  it("最近录入同时区分来源、发生日期和录入相对日期，不显示具体时间", () => {
    const value = transaction("a", todayKey(), "OpenClaw 晚餐");
    value.source = "openclaw";
    value.createdAt = new Date().toISOString();
    const view = render(<RecentRecordedList items={[value]} />);
    const metadata = view.container.querySelector(".recent-recorded-list__body em");
    expect(metadata).toHaveTextContent("OpenClaw");
    expect(metadata).toHaveTextContent("发生于");
    expect(metadata).toHaveTextContent("今天录入");
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).not.toBeInTheDocument();
  });

  it("账单日期标题展示筛选后的每日收支", () => {
    render(<TransactionList items={[transaction("a", "2026-08-04", "午餐")]} dailyTotals={[
      { localDate: "2026-08-04", incomeMinor: 5_000, expenseMinor: 1_234, transactionCount: 2 }
    ]} />);
    expect(screen.getByText(/收入.*50\.00/)).toBeInTheDocument();
    expect(screen.getByText(/支出.*12\.34/)).toBeInTheDocument();
  });
});

describe("日期快捷操作", () => {
  it("记账弹窗提供今天、昨天和前天", async () => {
    vi.spyOn(api, "categories").mockResolvedValue([]);
    renderWithProviders(<QuickEntry open onClose={() => undefined} />);
    expect(screen.getByRole("button", { name: "今天" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "昨天" }));
    expect(screen.getByLabelText("自定义发生日期")).not.toHaveValue(todayKey());
  });

  it("AI 默认完整上月并保留五种周期与自定义日期", async () => {
    vi.spyOn(api, "aiPreview").mockResolvedValue({ transactionCount: 0, fields: [] });
    vi.spyOn(api, "aiAnalyses").mockResolvedValue([]);
    renderWithProviders(<AiPage />);
    expect(screen.getByRole("button", { name: "上月" })).toHaveClass("is-active");
    ["上周", "上月", "上季度", "去年", "自定义"].forEach((label) => expect(screen.getByRole("button", { name: label })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "上周" }));
    const previousWeek = analysisPeriodRange("last-week", todayKey());
    await waitFor(() => expect(api.aiPreview).toHaveBeenLastCalledWith(previousWeek.start, previousWeek.end));

    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    expect(screen.getByText("开始日期")).toBeInTheDocument();
    expect(screen.getByText("结束日期")).toBeInTheDocument();
  });

  it("新账保存后先给出明确反馈，再关闭弹窗", async () => {
    vi.spyOn(api, "categories").mockResolvedValue([category()]);
    const created = transaction("55555555-5555-4555-8555-555555555555", todayKey(), "");
    const create = vi.spyOn(api, "createTransaction").mockResolvedValue(created);
    const close = vi.fn();
    renderWithProviders(<QuickEntry open onClose={close} />);

    fireEvent.change(screen.getByLabelText("金额"), { target: { value: "12.34" } });
    fireEvent.click(await screen.findByRole("button", { name: /餐饮/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存支出" }));

    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 1_234 }), expect.any(String));
    expect(close).not.toHaveBeenCalled();
  });

  it("记账内容发生修改后，关闭前要求确认放弃", async () => {
    vi.spyOn(api, "categories").mockResolvedValue([]);
    const close = vi.fn();
    renderWithProviders(<QuickEntry open onClose={close} />);

    fireEvent.change(screen.getByLabelText("金额"), { target: { value: "8.80" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(await screen.findByRole("alertdialog", { name: "放弃这次修改？" })).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃并关闭" }));
    expect(screen.getByRole("dialog").closest(".modal-backdrop")).toHaveClass("is-closing");
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("AI 条件变化后把现有内容标为上一份结果", async () => {
    const lastMonth = analysisPeriodRange("last-month", todayKey());
    const analysis: AiAnalysis = {
      id: "77777777-7777-4777-8777-777777777777",
      title: "上月收支分析",
      overview: "概览",
      highlights: [],
      suggestions: [],
      answer: null,
      periodStart: lastMonth.start,
      periodEnd: lastMonth.end,
      transactionCount: 3,
      model: "deepseek-chat",
      includeNotes: false,
      createdAt: new Date().toISOString(),
      isStale: false
    };
    vi.spyOn(api, "aiPreview").mockResolvedValue({ transactionCount: 3, fields: [] });
    vi.spyOn(api, "aiAnalyses").mockResolvedValue([analysis]);
    renderWithProviders(<AiPage />);

    expect(await screen.findByRole("heading", { name: "上月收支分析" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上周" }));
    expect(await screen.findByText("上一份结果")).toBeInTheDocument();
    expect(screen.getByText("条件已改变")).toBeInTheDocument();
  });
});

describe("待确认操作修订", () => {
  it("复用记账表单预填内容，保存修订后不会自动批准", async () => {
    const proposal = pendingProposal();
    vi.spyOn(api, "proposals").mockResolvedValue([proposal]);
    vi.spyOn(api, "categories").mockResolvedValue([category()]);
    const revise = vi.spyOn(api, "reviseProposal").mockResolvedValue({ ...proposal, revision: 2, updatedAt: "2026-08-07T13:00:00.000Z" });
    const resolve = vi.spyOn(api, "resolveProposal").mockResolvedValue({ proposal });
    renderWithProviders(<ProposalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "修订待确认内容" })).toBeInTheDocument();
    expect(screen.getByLabelText("金额")).toHaveValue("24.40");
    fireEvent.change(screen.getByLabelText("金额"), { target: { value: "24.20" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修订（仍待确认）" }));

    await waitFor(() => expect(revise).toHaveBeenCalledWith(proposal.id, 1, expect.objectContaining({ amountMinor: 2_420 })));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("修改提案会合并目标账目与拟修改内容后预填表单", async () => {
    const target = transaction("33333333-3333-4333-8333-333333333333", "2026-08-06", "原备注");
    const proposal: Proposal = {
      ...pendingProposal(),
      action: "update",
      targetTransactionId: target.id,
      payload: { amountMinor: 2_420 }
    };
    vi.spyOn(api, "proposals").mockResolvedValue([proposal]);
    vi.spyOn(api, "categories").mockResolvedValue([category()]);
    vi.spyOn(api, "transaction").mockResolvedValue(target);
    renderWithProviders(<ProposalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    await waitFor(() => expect(screen.getByLabelText("金额")).toHaveValue("24.20"));
    expect(screen.getByLabelText("自定义发生日期")).toHaveValue("2026-08-06");
    expect(screen.getByLabelText("备注 选填")).toHaveValue("原备注");
  });

  it("旧版本保存冲突时关闭编辑框并刷新待确认内容", async () => {
    const proposal = pendingProposal();
    vi.spyOn(api, "proposals").mockResolvedValue([proposal]);
    vi.spyOn(api, "categories").mockResolvedValue([category()]);
    vi.spyOn(api, "reviseProposal").mockRejectedValue(new ApiError("待确认内容已经更新，请重新查看后再操作", "PROPOSAL_REVISION_CONFLICT", 409));
    renderWithProviders(<ProposalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存修订（仍待确认）" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("待确认内容已经更新");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "修订待确认内容" })).not.toBeInTheDocument());
  });
});

describe("OpenClaw 操作中心", () => {
  it("显示直接模式、最近操作和网页撤销入口", async () => {
    vi.spyOn(api, "proposals").mockResolvedValue([]);
    vi.spyOn(api, "categories").mockResolvedValue([]);
    vi.spyOn(api, "openClawSettings").mockResolvedValue({
      mode: "direct", directCapabilities: ["transactions", "categories", "ai", "backup", "timezone", "undo"], credentialsExposed: false, updatedAt: "2026-08-12T00:00:00.000Z"
    });
    vi.spyOn(api, "openClawOperations").mockResolvedValue([{
      id: "33333333-3333-4333-8333-333333333333", requestId: "ui-operation-001", action: "transaction.create",
      entityType: "transaction", entityId: "44444444-4444-4444-8444-444444444444", status: "applied", undoable: true,
      summary: "OpenClaw 新增账目", createdAt: "2026-08-12T00:00:00.000Z", expiresAt: "2026-09-11T00:00:00.000Z", undoneAt: null, failedAt: null
    }]);
    vi.spyOn(api, "openClawOperation").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333", requestId: "ui-operation-001", action: "transaction.create",
      entityType: "transaction", entityId: "44444444-4444-4444-8444-444444444444", status: "applied", undoable: true,
      summary: "OpenClaw 新增账目", createdAt: "2026-08-12T00:00:00.000Z", expiresAt: "2026-09-11T00:00:00.000Z", undoneAt: null, failedAt: null,
      result: null,
      items: [{ sequence: 0, entityType: "transaction", entityId: "44444444-4444-4444-8444-444444444444", before: null, after: { amountMinor: 2420, note: "敏感备注" } }]
    });
    const undo = vi.spyOn(api, "undoOpenClawOperation").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333", requestId: "ui-operation-001", action: "transaction.create",
      entityType: "transaction", entityId: "44444444-4444-4444-8444-444444444444", status: "undone", undoable: true,
      summary: "OpenClaw 新增账目", createdAt: "2026-08-12T00:00:00.000Z", expiresAt: "2026-09-11T00:00:00.000Z", undoneAt: "2026-08-12T01:00:00.000Z", failedAt: null
    });
    renderWithProviders(<ProposalsPage />);

    expect(await screen.findByText("直接接管已开启")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw 新增账目")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(await screen.findByText("amountMinor、note")).toBeInTheDocument();
    expect(screen.queryByText("敏感备注")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /显示字段值/ }));
    expect(await screen.findByText(/敏感备注/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", expect.anything()));
  });
});
