// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Category, Transaction } from "../shared/types";
import { api } from "../src/api";
import { QuickEntry } from "../src/components/QuickEntry";
import { Toast, toastDurations } from "../src/components/Toast";
import { subscriptionRenewalHint } from "../src/pages/InsightsPage";
import { offerUndo, ToastContext, type ToastOptions } from "../src/toast-context";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderWithProviders(node: ReactNode, notify: (text: string, options?: ToastOptions) => void = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><ToastContext.Provider value={notify}>{node}</ToastContext.Provider></MemoryRouter></QueryClientProvider>);
}

const category: Category = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "expense",
  name: "餐饮",
  icon: "饭",
  color: "#D66A4C",
  sortOrder: 0,
  isArchived: false,
  transactionCount: 1,
  createdAt: "2026-08-07T12:00:00.000Z",
  updatedAt: "2026-08-07T12:00:00.000Z"
};

const transaction: Transaction = {
  id: "55555555-5555-4555-8555-555555555555",
  kind: "expense",
  amountMinor: 1_234,
  currency: "CNY",
  accountAmountMinor: null,
  categoryId: category.id,
  category: { id: category.id, name: category.name, icon: category.icon, color: category.color },
  localDate: "2026-09-20",
  note: "",
  accountId: null,
  account: null,
  refundedAt: null,
  fundsBaseline: false,
  refundAccountId: null,
  source: "user",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  deletedAt: null
};

describe("撤销提示", () => {
  it("带操作的提示停留更久，悬停时暂停计时", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const run = vi.fn();
    render(<Toast message={{ id: 1, text: "已移入回收站", action: { label: "撤销", run } }} onDismiss={dismiss} />);

    act(() => { vi.advanceTimersByTime(toastDurations.plain + 100); });
    expect(dismiss).not.toHaveBeenCalled();

    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => { vi.advanceTimersByTime(toastDurations.withAction * 2); });
    expect(dismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(screen.getByRole("status"));
    act(() => { vi.advanceTimersByTime(toastDurations.withAction); });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("点击撤销会关闭提示并执行操作", () => {
    const dismiss = vi.fn();
    const run = vi.fn();
    render(<Toast message={{ id: 1, text: "已移入回收站", action: { label: "撤销", run } }} onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("恢复成功刷新数据，失败时给出错误提示", async () => {
    const notify = vi.fn();
    const onRestored = vi.fn();
    offerUndo(notify, "已移入回收站", () => Promise.resolve(), onRestored);
    notify.mock.calls[0][1].action.run();
    await waitFor(() => expect(notify).toHaveBeenLastCalledWith("已恢复"));
    expect(onRestored).toHaveBeenCalledTimes(1);

    notify.mockClear();
    offerUndo(notify, "已移入回收站", () => Promise.reject(new Error("这笔账已被修改")), onRestored);
    notify.mock.calls[0][1].action.run();
    await waitFor(() => expect(notify).toHaveBeenLastCalledWith("这笔账已被修改", { tone: "error" }));
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("记账弹窗移入回收站不再弹浏览器确认，并可一键撤销", async () => {
    const confirm = vi.spyOn(window, "confirm");
    vi.spyOn(api, "categories").mockResolvedValue([category]);
    const remove = vi.spyOn(api, "deleteTransaction").mockResolvedValue({ ...transaction, deletedAt: "2026-09-24T00:00:00.000Z" });
    const restore = vi.spyOn(api, "restoreTransaction").mockResolvedValue(transaction);
    const notify = vi.fn();
    renderWithProviders(<QuickEntry open transaction={transaction} onClose={() => undefined} />, notify);

    fireEvent.click(await screen.findByRole("button", { name: /移入回收站/ }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(transaction.id, transaction.updatedAt));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(notify).toHaveBeenCalledWith("已移入回收站", expect.objectContaining({ action: expect.objectContaining({ label: "撤销" }) })));

    const options = notify.mock.calls.find(([text]) => text === "已移入回收站")![1] as ToastOptions;
    options.action!.run();
    await waitFor(() => expect(restore).toHaveBeenCalledWith(transaction.id));
    await waitFor(() => expect(notify).toHaveBeenLastCalledWith("已恢复"));
  });
});

describe("近期续费卡片文案", () => {
  it("只把到期或逾期的订阅称为待确认", () => {
    expect(subscriptionRenewalHint({ attentionCount: 2, activeCount: 5 })).toBe("2 项待确认续费");
    expect(subscriptionRenewalHint({ attentionCount: 0, activeCount: 5 })).toBe("暂无待确认，共 5 项订阅");
    expect(subscriptionRenewalHint({ attentionCount: 0, activeCount: 0 })).toBe("暂无订阅");
  });
});

describe("应用内确认", () => {
  it("前端不再使用浏览器原生确认框", () => {
    const root = path.resolve(__dirname, "../src");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const full = path.join(directory, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(root);
    const offenders = files.filter((file) => /window\.(confirm|alert|prompt)\(/.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });
});
