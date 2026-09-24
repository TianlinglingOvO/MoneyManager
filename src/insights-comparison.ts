import { format, parseISO } from "date-fns";
import type { ReportGrain } from "@shared/types";
import { money } from "./utils";

export function comparisonHeadline(grain: ReportGrain, isCurrentPeriod: boolean, previousLabel: string): string {
  if (!isCurrentPeriod) return `较 ${previousLabel}`;
  if (grain === "week") return "较上周同期";
  if (grain === "year") return "较去年同期";
  if (grain === "day") return "较前一天";
  return "较上月同期";
}

export function formatSameProgressWindow(start: string, end: string, includeYear = false): string {
  const needsYear = includeYear || start.slice(0, 4) !== end.slice(0, 4);
  const pattern = needsYear ? "yyyy年M月d日" : "M月d日";
  return `${format(parseISO(start), pattern)}–${format(parseISO(end), pattern)}`;
}

export function previousAmountLabel(previousAmountMinor: number, changeState: "up" | "down" | "same" | "new"): string {
  if (changeState === "new" || previousAmountMinor === 0) return "上期没有";
  return `上期 ${money(previousAmountMinor)}`;
}

export function categoryDetailAriaLabel(
  name: string,
  amountMinor: number,
  previousAmountMinor: number,
  changePercent: number | null,
  changeState: "up" | "down" | "same" | "new"
): string {
  const current = money(amountMinor);
  if (changeState === "new" || previousAmountMinor === 0) {
    return `查看${name}分类账单，${current}，上期没有此项，本期新增`;
  }
  const previous = money(previousAmountMinor);
  if (changeState === "same") return `查看${name}分类账单，${current}，与上期 ${previous} 持平`;
  const percent = Math.abs(changePercent ?? 0).toFixed(1);
  if (changeState === "down") return `查看${name}分类账单，${current}，较上期 ${previous} 减少 ${percent}%`;
  return `查看${name}分类账单，${current}，较上期 ${previous} 增加 ${percent}%`;
}
