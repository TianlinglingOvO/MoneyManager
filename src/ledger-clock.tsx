import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { todayKey } from "./utils";

export interface LedgerClock {
  timezone: string;
  today: string;
  isLoading: boolean;
  isError: boolean;
}

const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

function validTimezone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return undefined;
  }
}

function isDateKey(value: string | undefined): value is string {
  if (!value || !dateKeyPattern.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function partsToDateKey(parts: Intl.DateTimeFormatPart[]): string | null {
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) return null;
  return `${values.year}-${values.month}-${values.day}`;
}

export function todayForTimezone(timezone: string): string {
  try {
    const key = partsToDateKey(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date()));
    return key && isDateKey(key) ? key : todayKey();
  } catch {
    return todayKey();
  }
}

export function localDateForTimestamp(timestamp: string, timezone: string): string | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return partsToDateKey(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date));
  } catch {
    return null;
  }
}

function createFallbackClock(): LedgerClock {
  const timezone = browserTimezone();
  return { timezone, today: todayForTimezone(timezone), isLoading: true, isError: false };
}

const LedgerClockContext = createContext<LedgerClock>(createFallbackClock());

export function LedgerClockProvider({ children }: { children: ReactNode }) {
  const fallback = useMemo(createFallbackClock, []);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const timezone = validTimezone(settings.data?.timezone) ?? fallback.timezone;
  const today = isDateKey(settings.data?.today) ? settings.data.today : todayForTimezone(timezone);
  const value = useMemo<LedgerClock>(() => ({
    timezone,
    today,
    isLoading: settings.isPending,
    isError: settings.isError
  }), [settings.isError, settings.isPending, today, timezone]);

  return <LedgerClockContext.Provider value={value}>{children}</LedgerClockContext.Provider>;
}

export function useLedgerClock(): LedgerClock {
  return useContext(LedgerClockContext);
}
