import {
  endOfMonth,
  endOfYear,
  format,
  startOfMonth,
  startOfYear,
  subDays
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
  // Negative balances use the true minus sign, like signed amounts elsewhere ("−¥518.00", not "-¥518.00").
  return currencyFormatter.format(amountMinor / 100).replace(/^-/, "−");
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

/**
 * Parses an account balance, which, unlike an entry amount, may be zero or negative
 * (an emptied wallet, an overdrawn card). Accepts "-12.5", "−12.50" and "0".
 */
export function parseSignedAmountMinor(value: string): number | null {
  const match = /^([-−])?\s*(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const amount = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  if (amount > 100_000_000_000n) return null;
  const minor = Number(amount);
  return match[1] && minor !== 0 ? -minor : minor;
}

/** Browser-clock date. Only a fallback before the ledger clock loads; use `useLedgerClock().today` everywhere else. */
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

/** Relative day labels follow the ledger's today, never the device clock. */
export function friendlyDate(date: string, today: string): string {
  const value = new Date(`${date}T12:00:00`);
  if (date === today) return "今天";
  if (date === format(subDays(new Date(`${today}T12:00:00`), 1), "yyyy-MM-dd")) return "昨天";
  return format(value, "M月d日 EEEE", { locale: zhCN });
}

export function percentLabel(percent: number | null, state: "up" | "down" | "same" | "new"): string {
  if (state === "new") return "新增";
  if (state === "same") return "持平";
  const value = percent ?? 0;
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}%`;
}
