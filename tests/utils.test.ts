import { describe, expect, it } from "vitest";
import { analysisPeriodRange, parseAmountMinor } from "../src/utils";

describe("金额输入", () => {
  it("精确转换元和分，不经过浮点数计算", () => {
    expect(parseAmountMinor("0.01")).toBe(1);
    expect(parseAmountMinor("12.34")).toBe(1234);
    expect(parseAmountMinor("1000")).toBe(100000);
    expect(parseAmountMinor("001.20")).toBe(120);
  });

  it("拒绝空值、非正数、超过两位小数和超限金额", () => {
    expect(parseAmountMinor("")).toBeNull();
    expect(parseAmountMinor("0")).toBeNull();
    expect(parseAmountMinor("1.001")).toBeNull();
    expect(parseAmountMinor("1..2")).toBeNull();
    expect(parseAmountMinor("1000000000.01")).toBeNull();
  });
});

describe("AI 快捷分析周期", () => {
  it("以上周一作为完整上一周的起点", () => {
    expect(analysisPeriodRange("last-week", "2026-08-05")).toEqual({ start: "2026-07-27", end: "2026-08-02" });
  });

  it("正确处理闰年月份、跨年季度和去年", () => {
    expect(analysisPeriodRange("last-month", "2024-03-10")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(analysisPeriodRange("last-quarter", "2026-01-15")).toEqual({ start: "2025-10-01", end: "2025-12-31" });
    expect(analysisPeriodRange("last-year", "2026-08-05")).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });
});
