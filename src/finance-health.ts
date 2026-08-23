import type { MonthlyBudget } from "@shared/types";

export type {
  HealthExplanation,
  HealthIssue,
  HealthReport,
  MonthlyBudget,
  MonthlyBudgetCategory,
  MonthlyBudgetInput
} from "@shared/types";

export function budgetProgress(totalMinor: number | null, spentMinor: number): number | null {
  if (!totalMinor || totalMinor <= 0) return null;
  return Math.max(0, Math.min(100, spentMinor / totalMinor * 100));
}

export function budgetTone(totalMinor: number | null, spentMinor: number): "normal" | "caution" | "over" {
  const progress = budgetProgress(totalMinor, spentMinor);
  if (progress === null) return "normal";
  if (progress >= 100) return "over";
  if (progress >= 80) return "caution";
  return "normal";
}

export function hasConfiguredBudget(budget: MonthlyBudget | undefined): boolean {
  return Boolean(budget && (budget.totalMinor !== null || budget.categories.length > 0));
}
