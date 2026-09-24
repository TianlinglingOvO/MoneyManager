import { describe, expect, it } from "vitest";
import {
  categoryDetailAriaLabel,
  comparisonHeadline,
  formatSameProgressWindow,
  previousAmountLabel
} from "../src/insights-comparison";

describe("洞察同进度文案", () => {
  it("进行中的月份写较上月同期，并标出上期起止日", () => {
    expect(comparisonHeadline("month", true, "2026年8月")).toBe("较上月同期");
    expect(formatSameProgressWindow("2026-08-01", "2026-08-01")).toBe("8月1日–8月1日");
    expect(formatSameProgressWindow("2026-08-01", "2026-08-05")).toBe("8月1日–8月5日");
  });

  it("已结束的月份仍用完整上月名称", () => {
    expect(comparisonHeadline("month", false, "2026年7月")).toBe("较 2026年7月");
    expect(comparisonHeadline("week", true, "7月27日 – 8月2日")).toBe("较上周同期");
    expect(comparisonHeadline("year", true, "2025年")).toBe("较去年同期");
  });

  it("明细行写出上期金额，上期没有时为新增", () => {
    expect(previousAmountLabel(1_000, "up")).toBe("上期 ¥10.00");
    expect(previousAmountLabel(0, "new")).toBe("上期没有");
    expect(categoryDetailAriaLabel("日用", 3_000, 1_000, 200, "up")).toBe("查看日用分类账单，¥30.00，较上期 ¥10.00 增加 200.0%");
    expect(categoryDetailAriaLabel("午餐", 2_200, 0, null, "new")).toBe("查看午餐分类账单，¥22.00，上期没有此项，本期新增");
  });
});
