// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category, HealthReport, MonthlyBudget } from "../shared/types";
import { api } from "../src/api";
import { BudgetSheet } from "../src/components/BudgetSheet";
import { HealthSheet } from "../src/components/HealthSheet";
import { ToastContext } from "../src/toast-context";

const category: Category = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "expense",
  name: "餐饮",
  icon: "饭",
  color: "#D66A4C",
  sortOrder: 0,
  isArchived: false,
  transactionCount: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

const drinkCategory: Category = {
  ...category,
  id: "22222222-2222-4222-8222-222222222222",
  name: "饮料",
  icon: "杯",
  transactionCount: 0
};

const budget: MonthlyBudget = {
  month: "2026-08",
  totalMinor: 300_000,
  spentMinor: 80_000,
  remainingMinor: 220_000,
  forecastMinor: 120_000,
  elapsedDays: 21,
  daysInMonth: 31,
  remainingDays: 10,
  recommendedDailyMinor: 22_000,
  categories: [{
    categoryId: category.id,
    name: category.name,
    icon: category.icon,
    color: category.color,
    isArchived: false,
    budgetMinor: 100_000,
    spentMinor: 80_000,
    remainingMinor: 20_000,
    progressPercent: 80
  }],
  updatedAt: "2026-08-21T00:00:00.000Z"
};

const health: HealthReport = {
  month: "2026-08",
  score: 90,
  issueCount: 1,
  acknowledgedCount: 0,
  issues: [{
    fingerprint: "duplicate-test",
    type: "duplicate",
    severity: "warning",
    title: "可能重复记账",
    detail: "同一天有两笔相同支出，请核对。",
    relatedTransactionIds: ["a", "b"],
    href: "/bills?view=ledger",
    acknowledged: false
  }],
  dataHash: "health-hash",
  generatedAt: "2026-08-21T00:00:00.000Z"
};

function renderWithQuery(node: React.ReactNode, notify: (text: string) => void = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><ToastContext.Provider value={notify}>{node}</ToastContext.Provider></MemoryRouter></QueryClientProvider>);
}


function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{`${location.pathname}${location.search}`}</output>;
}
async function expectNoAxeViolations() {
  const result = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } }
  });
  expect(result.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => node.target)
  }))).toEqual([]);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SMB 2.1.2 响应式弹层基线", () => {
  it("预算弹层具有可读标签和可操作触控控件", async () => {
    renderWithQuery(<BudgetSheet open month="2026-08" budget={budget} categories={[category]} onClose={() => undefined} />);
    await expectNoAxeViolations();
  });

  it("账本体检结果保留标题层级、链接和操作名称", async () => {
    renderWithQuery(<HealthSheet open month="2026-08" report={health} isLoading={false} isError={false} onClose={() => undefined} onOpenBudget={() => undefined} />);
    await expectNoAxeViolations();
  });

  it("使用独立正文和固定操作区，并把焦点放到预算金额", async () => {
    renderWithQuery(<BudgetSheet open month="2026-08" budget={budget} categories={[category]} onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: "管理 2026年8月预算" });
    const input = screen.getByRole("textbox", { name: /本月总支出预算/ });
    expect(dialog.querySelector(".bottom-sheet__body")).toContainElement(input);
    expect(dialog.querySelector(".bottom-sheet__footer")).toContainElement(screen.getByRole("button", { name: "保存预算" }));
    expect(screen.getByRole("button", { name: "向下拖动关闭" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "关闭预算" })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("预算有改动时所有关闭入口都会经过应用内放弃确认", async () => {
    const confirm = vi.spyOn(window, "confirm");
    renderWithQuery(<BudgetSheet open month="2026-08" budget={budget} categories={[category]} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox", { name: /本月总支出预算/ }), { target: { value: "3500.00" } });
    const sheet = () => screen.getByRole("dialog", { name: "管理 2026年8月预算" }).closest(".modal-backdrop");
    const close = screen.getByRole("button", { name: "关闭预算" });

    fireEvent.click(close);
    const prompt = screen.getByRole("alertdialog", { name: "放弃这次修改？" });
    expect(prompt).toHaveTextContent("未保存的预算修改会丢失。");
    await waitFor(() => expect(screen.getByRole("button", { name: "继续编辑" })).toHaveFocus());
    expect(sheet()).not.toHaveClass("is-closing");
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("alertdialog", { name: "放弃这次修改？" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sheet()).not.toHaveClass("is-closing");

    fireEvent.click(close);
    fireEvent.click(screen.getByRole("button", { name: "放弃并关闭" }));
    expect(sheet()).toHaveClass("is-closing");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("删除预算在弹层内二次确认，取消不会调用接口", async () => {
    const remove = vi.spyOn(api, "deleteBudget").mockResolvedValue(undefined as never);
    renderWithQuery(<BudgetSheet open month="2026-08" budget={budget} categories={[category]} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "删除预算" }));
    expect(screen.getByRole("group", { name: "确认删除预算" })).toHaveTextContent("删除2026年8月的预算？账目不会受到影响。");
    await waitFor(() => expect(screen.getByRole("button", { name: "取消" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存预算" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "删除预算" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "删除预算" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("2026-08", budget.updatedAt));
  });

  it("保存预算后提供全局反馈并通过共享退出动画关闭", async () => {
    const notify = vi.fn();
    vi.spyOn(api, "updateBudget").mockResolvedValue({ ...budget, totalMinor: 350_000 });
    renderWithQuery(<BudgetSheet open month="2026-08" budget={budget} categories={[category]} onClose={() => undefined} />, notify);
    fireEvent.change(screen.getByRole("textbox", { name: /本月总支出预算/ }), { target: { value: "3500.00" } });
    fireEvent.click(screen.getByRole("button", { name: "保存预算" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("预算已保存"));
    expect(screen.getByRole("dialog", { name: "管理 2026年8月预算" }).closest(".modal-backdrop")).toHaveClass("is-closing");
  });
  it("体检使用内容对应的关闭名称并在退出后通过应用内导航下钻", async () => {
    const onClose = vi.fn();
    renderWithQuery(<><HealthSheet open month="2026-08" report={health} isLoading={false} isError={false} onClose={onClose} onOpenBudget={() => undefined} /><LocationProbe /></>);
    expect(screen.getByRole("button", { name: "关闭账本体检" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看账目" }));
    expect(screen.getByRole("dialog", { name: "账本体检" }).closest(".modal-backdrop")).toHaveClass("is-closing");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText("当前位置")).toHaveTextContent("/bills?view=ledger"));
  });

  it("已核对的体检问题不再出现在列表里", () => {
    const acknowledgedHealth: HealthReport = {
      ...health,
      issueCount: 0,
      acknowledgedCount: 1,
      issues: [{
        ...health.issues[0],
        fingerprint: "budget-over-test",
        type: "budget_warning",
        title: "月总预算已经超支",
        acknowledged: true
      }]
    };
    renderWithQuery(<HealthSheet open month="2026-08" report={acknowledgedHealth} isLoading={false} isError={false} onClose={() => undefined} onOpenBudget={() => undefined} />);
    expect(screen.queryByRole("heading", { name: "月总预算已经超支" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标记已核对" })).not.toBeInTheDocument();
    expect(screen.getByText(/另有 1 项已核对，不再列出/)).toBeInTheDocument();
  });

  it("预算体检提醒退出后直接打开对应月份的预算管理", async () => {
    const onClose = vi.fn();
    const onOpenBudget = vi.fn();
    const budgetHealth: HealthReport = {
      ...health,
      issues: [{
        ...health.issues[0],
        fingerprint: "budget-forecast-test",
        type: "budget_warning",
        title: "预计月底会超出预算",
        href: "/?grain=month&anchor=2026-08-01&kind=expense"
      }]
    };
    renderWithQuery(<HealthSheet open month="2026-08" report={budgetHealth} isLoading={false} isError={false} onClose={onClose} onOpenBudget={onOpenBudget} />);
    fireEvent.click(screen.getByRole("button", { name: "管理预算" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(onOpenBudget).toHaveBeenCalled());
  });

  it("预算分类选择使用主题内面板并支持键盘关闭与选择", async () => {
    renderWithQuery(<BudgetSheet open month="2026-08" budget={budget} categories={[category, drinkCategory]} onClose={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "添加分类预算" });
    fireEvent.click(trigger);
    const option = await screen.findByRole("option", { name: "饮料" });
    await waitFor(() => expect(document.activeElement).toBe(option));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.keyDown(option, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "可添加的支出分类" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "饮料" }));
    expect(screen.getByRole("textbox", { name: "饮料预算" })).toBeInTheDocument();
  });
});
