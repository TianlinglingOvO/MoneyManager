import {
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  format,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subMonths,
  subQuarters,
  subWeeks,
  subYears
} from "date-fns";
import { zhCN } from "date-fns/locale";
import type { TransactionKind } from "@shared/types";

const currencyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function money(amountMinor: number): string {
  return currencyFormatter.format(amountMinor / 100);
}

export function plainMoney(amountMinor: number): string {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100);
}

export function signedMoney(amountMinor: number, kind: TransactionKind): string {
  return `${kind === "expense" ? "−" : "+"}${money(amountMinor)}`;
}

export function parseAmountMinor(value: string): number | null {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;

  const amount = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (amount <= 0n || amount > 100_000_000_000n) return null;
  return Number(amount);
}

export function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function monthRange(anchor: string): { start: string; end: string } {
  const date = new Date(`${anchor}T12:00:00`);
  return { start: format(startOfMonth(date), "yyyy-MM-dd"), end: format(endOfMonth(date), "yyyy-MM-dd") };
}

export function yearRange(anchor: string): { start: string; end: string } {
  const date = new Date(`${anchor}T12:00:00`);
  return { start: format(startOfYear(date), "yyyy-MM-dd"), end: format(endOfYear(date), "yyyy-MM-dd") };
}

export type AnalysisPeriodPreset = "last-week" | "last-month" | "last-quarter" | "last-year";

export function analysisPeriodRange(preset: AnalysisPeriodPreset, anchor: string): { start: string; end: string } {
  const date = new Date(`${anchor}T12:00:00`);
  if (preset === "last-week") {
    const previous = subWeeks(date, 1);
    return {
      start: format(startOfWeek(previous, { weekStartsOn: 1 }), "yyyy-MM-dd"),
      end: format(endOfWeek(previous, { weekStartsOn: 1 }), "yyyy-MM-dd")
    };
  }
  if (preset === "last-month") {
    const previous = subMonths(date, 1);
    return { start: format(startOfMonth(previous), "yyyy-MM-dd"), end: format(endOfMonth(previous), "yyyy-MM-dd") };
  }
  if (preset === "last-quarter") {
    const previous = subQuarters(date, 1);
    return { start: format(startOfQuarter(previous), "yyyy-MM-dd"), end: format(endOfQuarter(previous), "yyyy-MM-dd") };
  }
  const previous = subYears(date, 1);
  return { start: format(startOfYear(previous), "yyyy-MM-dd"), end: format(endOfYear(previous), "yyyy-MM-dd") };
}

export function friendlyDate(date: string): string {
  const value = new Date(`${date}T12:00:00`);
  if (date === todayKey()) return "今天";
  return format(value, "M月d日 EEEE", { locale: zhCN });
}

export function percentLabel(percent: number | null, state: "up" | "down" | "same" | "new"): string {
  if (state === "new") return "新增";
  if (state === "same") return "持平";
  return `${state === "up" ? "+" : ""}${(percent ?? 0).toFixed(1)}%`;
}
