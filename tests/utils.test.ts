import { describe, expect, it } from "vitest";
import { parseAmountMinor } from "../src/utils";

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
