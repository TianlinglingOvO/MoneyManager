import { describe, expect, it } from "vitest";
import type { CategoryMetric } from "../shared/types";
import {
  buildCategoryComposition,
  categoryCompositionPadding,
  categoryCompositionPercent
} from "../src/category-composition";

function category(index: number, amountMinor = index * 100): CategoryMetric {
  return {
    categoryId: `category-${index}`,
    name: `分类 ${index}`,
    icon: "●",
    color: `#${String(index).padStart(6, "0")}`,
    amountMinor,
    percent: 0,
    previousAmountMinor: 0,
    deltaMinor: amountMinor,
    changePercent: null,
    changeState: "new"
  };
}

describe("分类构成", () => {
  it.each([1, 8, 9, 16, 20])("%i 个当前分类全部保留且占比合计为 100%%", (count) => {
    const categories = Array.from({ length: count }, (_, index) => category(index + 1));
    const result = buildCategoryComposition(categories);

    expect(result).toHaveLength(count);
    expect(result.map((item) => item.categoryId)).toEqual(categories.map((item) => item.categoryId));
    expect(result.some((item) => item.name === "其他")).toBe(false);
    expect(result.reduce((total, item) => total + item.percent, 0)).toBeCloseTo(100, 10);
  });

  it("过滤本期零金额分类，并根据本期总额重算占比", () => {
    const result = buildCategoryComposition([
      category(1, 1),
      category(2, 999),
      category(3, 0)
    ]);

    expect(result.map((item) => item.categoryId)).toEqual(["category-1", "category-2"]);
    expect(result[0]?.percent).toBeCloseTo(0.1, 10);
    expect(result[1]?.percent).toBeCloseTo(99.9, 10);
  });

  it("按分类数量缩小真实扇区间隔", () => {
    expect(categoryCompositionPadding(1)).toBe(0);
    expect(categoryCompositionPadding(8)).toBe(2);
    expect(categoryCompositionPadding(9)).toBe(1);
    expect(categoryCompositionPadding(16)).toBe(1);
    expect(categoryCompositionPadding(20)).toBe(0.5);
  });

  it("极小占比使用小于 0.1% 的可读格式", () => {
    expect(categoryCompositionPercent(0.01)).toBe("<0.1%");
    expect(categoryCompositionPercent(0.1)).toBe("0.1%");
    expect(categoryCompositionPercent(12.345)).toBe("12.3%");
  });
});
