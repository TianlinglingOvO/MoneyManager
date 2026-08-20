import type { CategoryMetric } from "@shared/types";

export interface CategoryCompositionSlice {
  categoryId: string;
  name: string;
  icon: string;
  color: string;
  amountMinor: number;
  percent: number;
}

export function buildCategoryComposition(categories: CategoryMetric[]): CategoryCompositionSlice[] {
  const current = categories.filter((category) => category.amountMinor > 0);
  const totalMinor = current.reduce((total, category) => total + category.amountMinor, 0);

  return current.map(({ categoryId, name, icon, color, amountMinor }) => ({
    categoryId,
    name,
    icon,
    color,
    amountMinor,
    percent: totalMinor > 0 ? (amountMinor / totalMinor) * 100 : 0
  }));
}

export function categoryCompositionPadding(categoryCount: number): number {
  if (categoryCount <= 1) return 0;
  if (categoryCount <= 8) return 2;
  if (categoryCount <= 16) return 1;
  return 0.5;
}

export function categoryCompositionPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}
