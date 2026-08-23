import { describe, expect, it } from "vitest";
import type { Category, Transaction } from "../shared/types";
import { calculateFinanceReport, comparison, getPeriodDefinition } from "../server/periods";

const category: Category = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "expense",
  name: "餐饮",
  icon: "餐",
  color: "#D66A4C",
  sortOrder: 0,
  isArchived: false,
  transactionCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

function transaction(id: string, localDate: string, amountMinor: number, kind: "expense" | "income" = "expense"): Transaction {
  return {
    id,
    kind,
    amountMinor,
    currency: "CNY",
    categoryId: category.id,
    localDate,
    note: null,
    accountId: null,
    account: null,
    refundedAt: null,
    refundAccountId: null,
    source: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null
  };
}

describe("周期与金额计算", () => {
  it("把周一作为每周第一天，并对当前周使用上一周相同进度", () => {
    const period = getPeriodDefinition("week", "2026-08-05", "2026-08-05");
    expect(period.current).toMatchObject({ start: "2026-08-03", end: "2026-08-05" });
    expect(period.previous).toMatchObject({ start: "2026-07-27", end: "2026-07-29" });
    expect(period.isCurrentPeriod).toBe(true);
  });

  it("对已经结束的周期使用完整上一周期", () => {
    const period = getPeriodDefinition("week", "2026-07-22", "2026-08-05");
    expect(period.current).toMatchObject({ start: "2026-07-20", end: "2026-07-26" });
    expect(period.previous).toMatchObject({ start: "2026-07-13", end: "2026-07-19" });
    expect(period.isCurrentPeriod).toBe(false);
  });

  it("零基线显示新增，不产生无限百分比", () => {
    expect(comparison(500, 0)).toEqual({ current: 500, previous: 0, delta: 500, percent: null, state: "new" });
    expect(comparison(0, 0)).toEqual({ current: 0, previous: 0, delta: 0, percent: 0, state: "same" });
  });

  it("所有汇总都使用整数分并保持精确", () => {
    const report = calculateFinanceReport({
      transactions: [
        transaction("a", "2026-08-03", 101),
        transaction("b", "2026-08-04", 202),
        transaction("c", "2026-08-04", 500, "income")
      ],
      categories: [category],
      grain: "month",
      anchor: "2026-08-05",
      kind: "expense",
      todayKey: "2026-08-05"
    });
    expect(report.expenseMinor).toBe(303);
    expect(report.incomeMinor).toBe(500);
    expect(report.balanceMinor).toBe(197);
    expect(report.selectedTotalMinor).toBe(303);
    expect(report.selectedAverageMinor).toBe(61);
    expect(report.averageDivisor).toBe(5);
    expect(report.averageUnit).toBe("day");
  });

  it("完整月份按全部自然日计算日均值", () => {
    const report = calculateFinanceReport({
      transactions: [transaction("a", "2026-07-31", 3_100)],
      categories: [category],
      grain: "month",
      anchor: "2026-07-15",
      kind: "expense",
      todayKey: "2026-08-05"
    });
    expect(report.selectedAverageMinor).toBe(100);
    expect(report.averageDivisor).toBe(31);
  });

  it("当前周只按截至今天的自然日计算平均值", () => {
    const report = calculateFinanceReport({
      transactions: [transaction("a", "2026-08-03", 900)],
      categories: [category],
      grain: "week",
      anchor: "2026-08-05",
      kind: "expense",
      todayKey: "2026-08-05"
    });
    expect(report.selectedAverageMinor).toBe(300);
    expect(report.averageDivisor).toBe(3);
  });

  it("年度按已覆盖月份计算月均值，零金额仍返回零", () => {
    const current = calculateFinanceReport({
      transactions: [transaction("a", "2026-02-01", 1_600)],
      categories: [category],
      grain: "year",
      anchor: "2026-08-05",
      kind: "expense",
      todayKey: "2026-08-05"
    });
    expect(current.selectedAverageMinor).toBe(200);
    expect(current.averageDivisor).toBe(8);
    expect(current.averageUnit).toBe("month");

    const empty = calculateFinanceReport({
      transactions: [], categories: [category], grain: "month", anchor: "2024-02-20", kind: "expense", todayKey: "2026-08-05"
    });
    expect(empty.selectedAverageMinor).toBe(0);
    expect(empty.averageDivisor).toBe(29);
  });
});
