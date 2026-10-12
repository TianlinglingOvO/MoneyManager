import { describe, expect, it } from "vitest";
import { friendlyDate, parseAmountMinor, parseSignedAmountMinor, percentLabel } from "../src/utils";

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

describe("账户余额输入", () => {
  it("余额可以是 0 或负数，仍然不接受多于两位小数", () => {
    expect(parseSignedAmountMinor("0")).toBe(0);
    expect(parseSignedAmountMinor("0.00")).toBe(0);
    expect(parseSignedAmountMinor("-12.5")).toBe(-1_250);
    expect(parseSignedAmountMinor("−12.50")).toBe(-1_250);
    expect(parseSignedAmountMinor("-0")).toBe(0);
    expect(parseSignedAmountMinor("1.001")).toBeNull();
    expect(parseSignedAmountMinor("")).toBeNull();
    expect(parseSignedAmountMinor("-")).toBeNull();
  });
});

describe("日期与百分比文案", () => {
  it("今天和昨天跟随账本日期，而不是设备时钟", () => {
    expect(friendlyDate("2030-01-02", "2030-01-02")).toBe("今天");
    expect(friendlyDate("2030-01-01", "2030-01-02")).toBe("昨天");
    expect(friendlyDate("2029-12-31", "2030-01-02")).toBe("12月31日 星期一");
  });

  it("下降的百分比使用减号，与金额的写法一致", () => {
    expect(percentLabel(-11.1, "down")).toBe("−11.1%");
    expect(percentLabel(28.5, "up")).toBe("+28.5%");
    expect(percentLabel(null, "new")).toBe("新增");
  });
});
