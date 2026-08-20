import {
  addDays,
  addMonths,
  addYears,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  isAfter,
  isBefore,
  parseISO,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
  subYears
} from "date-fns";
import { zhCN } from "date-fns/locale";
import type {
  Category,
  ComparisonValue,
  FinanceReport,
  PeriodRange,
  ReportGrain,
  Transaction,
  TransactionKind,
  TrendPoint
} from "../shared/types";

function dateKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function minDate(a: Date, b: Date): Date {
  return isBefore(a, b) ? a : b;
}

function periodLabel(grain: ReportGrain, start: Date): string {
  if (grain === "day") return format(start, "M月d日 EEEE", { locale: zhCN });
  if (grain === "week") {
    const end = endOfWeek(start, { weekStartsOn: 1 });
    return `${format(start, "M月d日")} – ${format(end, "M月d日")}`;
  }
  if (grain === "month") return format(start, "yyyy年M月");
  return format(start, "yyyy年");
}

export interface PeriodDefinition {
  current: PeriodRange;
  previous: PeriodRange;
  currentFullEnd: string;
  isCurrentPeriod: boolean;
}

export function getPeriodDefinition(grain: ReportGrain, anchorKey: string, todayKey = dateKey(new Date())): PeriodDefinition {
  const anchor = parseISO(anchorKey);
  const today = parseISO(todayKey);
  let start: Date;
  let fullEnd: Date;
  let previousStart: Date;
  let previousFullEnd: Date;

  if (grain === "day") {
    start = anchor;
    fullEnd = anchor;
    previousStart = subDays(start, 1);
    previousFullEnd = previousStart;
  } else if (grain === "week") {
    start = startOfWeek(anchor, { weekStartsOn: 1 });
    fullEnd = endOfWeek(anchor, { weekStartsOn: 1 });
    previousStart = subWeeks(start, 1);
    previousFullEnd = endOfWeek(previousStart, { weekStartsOn: 1 });
  } else if (grain === "month") {
    start = startOfMonth(anchor);
    fullEnd = endOfMonth(anchor);
    previousStart = startOfMonth(subMonths(start, 1));
    previousFullEnd = endOfMonth(previousStart);
  } else {
    start = startOfYear(anchor);
    fullEnd = endOfYear(anchor);
    previousStart = startOfYear(subYears(start, 1));
    previousFullEnd = endOfYear(previousStart);
  }

  const isCurrentPeriod = !isBefore(today, start) && !isAfter(today, fullEnd);
  const currentEnd = isCurrentPeriod ? today : fullEnd;
  const elapsedDays = differenceInCalendarDays(currentEnd, start);
  const previousEnd = minDate(addDays(previousStart, elapsedDays), previousFullEnd);

  return {
    current: { start: dateKey(start), end: dateKey(currentEnd), label: periodLabel(grain, start) },
    previous: { start: dateKey(previousStart), end: dateKey(previousEnd), label: periodLabel(grain, previousStart) },
    currentFullEnd: dateKey(fullEnd),
    isCurrentPeriod
  };
}

export function comparison(current: number, previous: number): ComparisonValue {
  const delta = current - previous;
  if (previous === 0 && current > 0) {
    return { current, previous, delta, percent: null, state: "new" };
  }
  const percent = previous === 0 ? 0 : Math.round((delta / previous) * 10_000) / 100;
  const state = delta > 0 ? "up" : delta < 0 ? "down" : "same";
  return { current, previous, delta, percent, state };
}

function buildTrend(grain: ReportGrain, range: PeriodRange, transactions: Transaction[]): TrendPoint[] {
  if (grain === "day") {
    return [{
      key: range.start,
      label: format(parseISO(range.start), "M月d日"),
      amountMinor: transactions.reduce((sum, transaction) => sum + transaction.amountMinor, 0)
    }];
  }

  if (grain === "year") {
    const start = parseISO(range.start);
    const end = parseISO(range.end);
    const amounts = new Map<string, number>();
    for (const transaction of transactions) {
      const month = transaction.localDate.slice(0, 7);
      amounts.set(month, (amounts.get(month) ?? 0) + transaction.amountMinor);
    }
    const points: TrendPoint[] = [];
    let cursor = startOfMonth(start);
    while (!isAfter(cursor, end)) {
      const key = format(cursor, "yyyy-MM");
      points.push({ key, label: format(cursor, "M月"), amountMinor: amounts.get(key) ?? 0 });
      cursor = addMonths(cursor, 1);
    }
    return points;
  }

  const amounts = new Map<string, number>();
  for (const transaction of transactions) {
    amounts.set(transaction.localDate, (amounts.get(transaction.localDate) ?? 0) + transaction.amountMinor);
  }
  const points: TrendPoint[] = [];
  let cursor = parseISO(range.start);
  const end = parseISO(range.end);
  while (!isAfter(cursor, end)) {
    const key = dateKey(cursor);
    points.push({
      key,
      label: grain === "week" ? format(cursor, "EEE", { locale: zhCN }) : format(cursor, "M/d"),
      amountMinor: amounts.get(key) ?? 0
    });
    cursor = addDays(cursor, 1);
  }
  return points;
}

export function calculateFinanceReport(input: {
  transactions: Transaction[];
  categories: Category[];
  grain: ReportGrain;
  anchor: string;
  kind: TransactionKind;
  todayKey?: string;
}): FinanceReport {
  const definition = getPeriodDefinition(input.grain, input.anchor, input.todayKey);
  const currentAll = input.transactions.filter((item) =>
    item.localDate >= definition.current.start && item.localDate <= definition.current.end && !item.deletedAt
  );
  const previousAll = input.transactions.filter((item) =>
    item.localDate >= definition.previous.start && item.localDate <= definition.previous.end && !item.deletedAt
  );
  const currentSelected = currentAll.filter((item) => item.kind === input.kind);
  const previousSelected = previousAll.filter((item) => item.kind === input.kind);

  const incomeMinor = currentAll.filter((item) => item.kind === "income").reduce((sum, item) => sum + item.amountMinor, 0);
  const expenseMinor = currentAll.filter((item) => item.kind === "expense").reduce((sum, item) => sum + item.amountMinor, 0);
  const selectedTotalMinor = currentSelected.reduce((sum, item) => sum + item.amountMinor, 0);
  const previousTotalMinor = previousSelected.reduce((sum, item) => sum + item.amountMinor, 0);
  const trend = buildTrend(input.grain, definition.current, currentSelected);
  const averageDivisor = Math.max(1, trend.length);
  const selectedAverageMinor = Math.round(selectedTotalMinor / averageDivisor);
  const averageUnit = input.grain === "year" ? "month" : "day";

  const currentByCategory = new Map<string, number>();
  const previousByCategory = new Map<string, number>();
  currentSelected.forEach((item) => currentByCategory.set(item.categoryId, (currentByCategory.get(item.categoryId) ?? 0) + item.amountMinor));
  previousSelected.forEach((item) => previousByCategory.set(item.categoryId, (previousByCategory.get(item.categoryId) ?? 0) + item.amountMinor));

  const categories = input.categories
    .filter((category) => category.kind === input.kind)
    .map((category) => {
      const amountMinor = currentByCategory.get(category.id) ?? 0;
      const previousAmountMinor = previousByCategory.get(category.id) ?? 0;
      const change = comparison(amountMinor, previousAmountMinor);
      return {
        categoryId: category.id,
        name: category.name,
        icon: category.icon,
        color: category.color,
        amountMinor,
        percent: selectedTotalMinor === 0 ? 0 : Math.round((amountMinor / selectedTotalMinor) * 10_000) / 100,
        previousAmountMinor,
        deltaMinor: amountMinor - previousAmountMinor,
        changePercent: change.percent,
        changeState: change.state
      };
    })
    .filter((item) => item.amountMinor > 0 || item.previousAmountMinor > 0)
    .sort((a, b) => b.amountMinor - a.amountMinor);

  return {
    grain: input.grain,
    anchor: input.anchor,
    kind: input.kind,
    range: definition.current,
    previousRange: definition.previous,
    incomeMinor,
    expenseMinor,
    balanceMinor: incomeMinor - expenseMinor,
    selectedTotalMinor,
    selectedAverageMinor,
    averageDivisor,
    averageUnit,
    selectedComparison: comparison(selectedTotalMinor, previousTotalMinor),
    transactionCount: currentSelected.length,
    trend,
    categories,
    generatedAt: new Date().toISOString()
  };
}

export function rangeForQuery(grain: ReportGrain, anchor: string, todayKey?: string): { start: string; end: string } {
  const definition = getPeriodDefinition(grain, anchor, todayKey);
  return {
    start: definition.previous.start,
    end: definition.current.end
  };
}
