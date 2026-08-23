import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HealthIssue, HealthIssueType, HealthReport, Transaction } from "../shared/types";
import { budgetMonthSchema } from "../shared/schemas";
import type { AiService } from "./ai";
import type { BudgetService } from "./budgets";
import { ConflictError } from "./errors";
import type { LedgerRepository } from "./repository";

interface SubscriptionHealthRow {
  id: string;
  name: string;
  next_billing_date: string;
  reminder_days: number;
  updated_at: string;
}

function rangeForMonth(month: string): { start: string; end: string } {
  budgetMonthSchema.parse(month);
  const [year, value] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, value, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}` };
}

function dateOffset(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function fingerprint(type: HealthIssueType, values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify([type, ...values])).digest("hex");
}

function money(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function transactionHref(transaction: Transaction): string {
  const query = new URLSearchParams({
    view: "ledger",
    period: "month",
    anchor: `${transaction.localDate.slice(0, 7)}-01`,
    kind: transaction.kind,
    categoryId: transaction.categoryId
  });
  return `/bills?${query.toString()}`;
}

export class HealthService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly repository: LedgerRepository,
    private readonly budgets: BudgetService,
    private readonly ai: AiService
  ) {}

  report(month: string): HealthReport {
    const range = rangeForMonth(month);
    const transactions = this.repository.allTransactionsForPeriod(range.start, range.end);
    const issues: HealthIssue[] = [];
    const today = this.budgets.today();
    const exactDuplicateIds = this.addDuplicateIssues(transactions, issues);
    this.addOpenClawNearDuplicateIssues(transactions, exactDuplicateIds, issues);
    this.addFutureDateIssues(transactions, today, issues);
    this.addLargeExpenseIssues(month, transactions, issues);
    this.addBudgetIssues(month, issues);
    this.addSubscriptionIssues(range.start, range.end, issues);
    this.addForeignKeyIssues(issues);
    const acknowledgements = new Set((this.database.prepare(
      "SELECT fingerprint FROM health_acknowledgements"
    ).all() as unknown as Array<{ fingerprint: string }>).map((item) => item.fingerprint));
    const hydrated = issues
      .map((issue) => ({ ...issue, acknowledged: acknowledgements.has(issue.fingerprint) }))
      .sort((left, right) => {
        const weight = { critical: 0, warning: 1, info: 2 };
        return weight[left.severity] - weight[right.severity] || left.title.localeCompare(right.title);
      });
    const active = hydrated.filter((issue) => !issue.acknowledged);
    const penalty = active.reduce((total, issue) => total + (
      issue.severity === "critical" ? 20 : issue.severity === "warning" ? 10 : 4
    ), 0);
    const dataHash = createHash("sha256")
      .update(JSON.stringify(hydrated.map((issue) => issue.fingerprint)))
      .digest("hex");
    return {
      month,
      score: Math.max(0, 100 - penalty),
      issueCount: active.length,
      acknowledgedCount: hydrated.length - active.length,
      issues: hydrated,
      dataHash,
      generatedAt: new Date().toISOString()
    };
  }

  currentMonth(): string {
    return this.budgets.today().slice(0, 7);
  }

  acknowledge(month: string, issueFingerprint: string): HealthReport {
    const current = this.report(month);
    const issue = current.issues.find((item) => item.fingerprint === issueFingerprint);
    if (!issue) throw new ConflictError("这条体检结果已经失效，请重新检查");
    this.database.prepare(`INSERT INTO health_acknowledgements(fingerprint, issue_type, acknowledged_at)
      VALUES (?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET acknowledged_at = excluded.acknowledged_at`)
      .run(issue.fingerprint, issue.type, new Date().toISOString());
    this.repository.audit("user", "health.acknowledge", "health_issue", issue.fingerprint, {
      issueType: issue.type,
      month
    });
    return this.report(month);
  }

  async explain(month: string) {
    const report = this.report(month);
    if (report.issues.length === 0) throw new ConflictError("本月没有需要解释的体检项目");
    return this.ai.explainHealth(report);
  }

  private addDuplicateIssues(transactions: Transaction[], issues: HealthIssue[]): Set<string> {
    const groups = new Map<string, Transaction[]>();
    transactions.forEach((transaction) => {
      const note = transaction.note?.trim() ?? "";
      const key = JSON.stringify([
        transaction.localDate,
        transaction.kind,
        transaction.categoryId,
        transaction.amountMinor,
        note
      ]);
      groups.set(key, [...(groups.get(key) ?? []), transaction]);
    });
    const exactDuplicateIds = new Set<string>();
    groups.forEach((items) => {
      if (items.length < 2) return;
      const sorted = items.sort((left, right) => left.id.localeCompare(right.id));
      sorted.forEach((item) => exactDuplicateIds.add(item.id));
      const first = sorted[0];
      issues.push({
        fingerprint: fingerprint("duplicate", sorted.map((item) => [item.id, item.updatedAt])),
        type: "duplicate",
        severity: "warning",
        title: "可能重复记账",
        detail: `${first.localDate} 有 ${items.length} 笔相同的${first.kind === "expense" ? "支出" : "收入"}，请核对是否重复。`,
        relatedTransactionIds: sorted.map((item) => item.id),
        href: transactionHref(first),
        acknowledged: false
      });
    });
    return exactDuplicateIds;
  }

  private addOpenClawNearDuplicateIssues(
    transactions: Transaction[],
    exactDuplicateIds: Set<string>,
    issues: HealthIssue[]
  ): void {
    const groups = new Map<string, Transaction[]>();
    transactions
      .filter((transaction) => transaction.source === "openclaw")
      .forEach((transaction) => {
        const key = JSON.stringify([
          transaction.localDate,
          transaction.kind,
          transaction.categoryId,
          transaction.amountMinor
        ]);
        groups.set(key, [...(groups.get(key) ?? []), transaction]);
      });

    const tenMinutes = 10 * 60 * 1000;
    groups.forEach((items) => {
      const sorted = [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      let cluster: Transaction[] = [];
      const flush = () => {
        if (cluster.length < 2 || cluster.every((item) => exactDuplicateIds.has(item.id))) {
          cluster = [];
          return;
        }
        const first = cluster[0]!;
        issues.push({
          fingerprint: fingerprint("openclaw_duplicate", cluster.map((item) => [item.id, item.updatedAt])),
          type: "openclaw_duplicate",
          severity: "warning",
          title: "OpenClaw 近重复记账",
          detail: `${first.localDate} 的${first.category?.name ?? "分类"}有 ${cluster.length} 笔相同金额记录，且在 10 分钟内由 OpenClaw 写入，请核对是否重复。`,
          relatedTransactionIds: cluster.map((item) => item.id),
          href: transactionHref(first),
          acknowledged: false
        });
        cluster = [];
      };
      sorted.forEach((transaction) => {
        const currentTime = Date.parse(transaction.createdAt);
        const previousTime = cluster.length > 0 ? Date.parse(cluster[cluster.length - 1]!.createdAt) : NaN;
        if (!Number.isFinite(currentTime) || (cluster.length > 0 && (!Number.isFinite(previousTime) || currentTime - previousTime > tenMinutes))) {
          flush();
        }
        cluster.push(transaction);
      });
      flush();
    });
  }

  private addFutureDateIssues(transactions: Transaction[], today: string, issues: HealthIssue[]): void {
    transactions.filter((transaction) => transaction.localDate > today).forEach((transaction) => {
      issues.push({
        fingerprint: fingerprint("future_date", [transaction.id, transaction.updatedAt, today]),
        type: "future_date",
        severity: "warning",
        title: "账目日期在未来",
        detail: `${transaction.localDate} 的${transaction.kind === "expense" ? "支出" : "收入"}早于记录日期逻辑不成立；账本今天是 ${today}，请核对发生日期。`,
        relatedTransactionIds: [transaction.id],
        href: transactionHref(transaction),
        acknowledged: false
      });
    });
  }

  private addLargeExpenseIssues(month: string, transactions: Transaction[], issues: HealthIssue[]): void {
    const budget = this.budgets.get(month);
    const expenseItems = transactions.filter((item) => item.kind === "expense" && item.amountMinor >= 30_000);
    expenseItems.forEach((transaction) => {
      const historyStart = dateOffset(transaction.localDate, -90);
      const historyEnd = dateOffset(transaction.localDate, -1);
      const history = this.repository.allTransactionsForPeriod(historyStart, historyEnd)
        .filter((item) => item.kind === "expense" && item.categoryId === transaction.categoryId)
        .map((item) => item.amountMinor);
      const categoryMedian = history.length >= 5 ? median(history) : null;
      const unusualForCategory = categoryMedian !== null && transaction.amountMinor >= categoryMedian * 3;
      const materialForBudget = budget.totalMinor !== null && transaction.amountMinor >= budget.totalMinor * 0.2;
      if (!unusualForCategory && !materialForBudget) return;
      const reason = [
        unusualForCategory ? "达到同分类近 90 天中位数的 3 倍" : null,
        materialForBudget ? "达到月总预算的 20%" : null
      ].filter(Boolean).join("，");
      issues.push({
        fingerprint: fingerprint("large_expense", [
          transaction.id,
          transaction.updatedAt,
          categoryMedian,
          budget.updatedAt
        ]),
        type: "large_expense",
        severity: "warning",
        title: "大额支出需要核对",
        detail: `${transaction.localDate} 的${transaction.category?.name ?? "分类"}支出为 ${money(transaction.amountMinor)}，${reason}。`,
        relatedTransactionIds: [transaction.id],
        href: transactionHref(transaction),
        acknowledged: false
      });
    });
  }

  private addBudgetIssues(month: string, issues: HealthIssue[]): void {
    const budget = this.budgets.get(month);
    if (budget.totalMinor !== null) {
      const ratio = budget.spentMinor / budget.totalMinor;
      if (ratio >= 0.8) {
        const over = ratio >= 1;
        issues.push({
          fingerprint: fingerprint("budget_warning", [
            "total",
            month,
            budget.updatedAt,
            budget.spentMinor,
            budget.forecastMinor
          ]),
          type: "budget_warning",
          severity: over ? "critical" : "warning",
          title: over ? "月总预算已经超支" : "月总预算接近上限",
          detail: `本月已使用 ${Math.round(ratio * 100)}%，当前支出 ${money(budget.spentMinor)}。`,
          relatedTransactionIds: [],
          href: `/?grain=month&anchor=${month}-01&kind=expense`,
          acknowledged: false
        });
      }
      if (budget.forecastMinor > budget.totalMinor && budget.forecastMinor > budget.spentMinor) {
        issues.push({
          fingerprint: fingerprint("budget_warning", [
            "forecast",
            month,
            budget.updatedAt,
            budget.forecastMinor
          ]),
          type: "budget_warning",
          severity: "warning",
          title: "预计月底会超出预算",
          detail: `按当前进度预计月底支出 ${money(budget.forecastMinor)}。`,
          relatedTransactionIds: [],
          href: `/?grain=month&anchor=${month}-01&kind=expense`,
          acknowledged: false
        });
      }
    }
    budget.categories.forEach((category) => {
      const ratio = category.spentMinor / category.budgetMinor;
      if (ratio < 0.8) return;
      issues.push({
        fingerprint: fingerprint("budget_warning", [
          "category",
          month,
          budget.updatedAt,
          category.categoryId,
          category.spentMinor
        ]),
        type: "budget_warning",
        severity: ratio >= 1 ? "critical" : "warning",
        title: ratio >= 1 ? `${category.name}预算已经超支` : `${category.name}预算接近上限`,
        detail: `已使用 ${Math.round(ratio * 100)}%，当前支出 ${money(category.spentMinor)}。`,
        relatedTransactionIds: [],
        href: `/bills?view=ledger&period=month&anchor=${month}-01&kind=expense&categoryId=${category.categoryId}`,
        acknowledged: false
      });
    });
  }

  private addSubscriptionIssues(monthStart: string, monthEnd: string, issues: HealthIssue[]): void {
    const today = this.budgets.today();
    const currentMonth = today.slice(0, 7);
    const rows = (monthStart.slice(0, 7) === currentMonth
      ? this.database.prepare(`SELECT id, name, next_billing_date, reminder_days, updated_at
          FROM subscriptions
          WHERE deleted_at IS NULL AND status = 'active' AND next_billing_date IS NOT NULL
            AND next_billing_date <= ?
          ORDER BY next_billing_date`).all(monthEnd)
      : this.database.prepare(`SELECT id, name, next_billing_date, reminder_days, updated_at
          FROM subscriptions
          WHERE deleted_at IS NULL AND status = 'active' AND next_billing_date IS NOT NULL
            AND next_billing_date >= ? AND next_billing_date <= ?
          ORDER BY next_billing_date`).all(monthStart, monthEnd)
    ) as unknown as SubscriptionHealthRow[];
    rows.forEach((subscription) => {
      const reminderDate = dateOffset(subscription.next_billing_date, -Number(subscription.reminder_days));
      if (reminderDate > today && subscription.next_billing_date > today) return;
      const due = subscription.next_billing_date <= today;
      issues.push({
        fingerprint: fingerprint("subscription_due", [
          subscription.id,
          subscription.updated_at,
          subscription.next_billing_date
        ]),
        type: "subscription_due",
        severity: due ? "critical" : "info",
        title: due ? `${subscription.name}续费待确认` : `${subscription.name}即将续费`,
        detail: `续费日期为 ${subscription.next_billing_date}，SMB 不会自动假定已经续费。`,
        relatedTransactionIds: [],
        href: "/matters?tab=subscriptions",
        acknowledged: false
      });
    });
  }

  private addForeignKeyIssues(issues: HealthIssue[]): void {
    const rows = this.database.prepare("PRAGMA foreign_key_check").all() as unknown as Array<{
      table: string;
      rowid: number | null;
      parent: string;
      fkid: number;
    }>;
    if (rows.length === 0) return;
    issues.push({
      fingerprint: fingerprint("foreign_key", rows.map((item) => [item.table, item.rowid, item.parent, item.fkid])),
      type: "foreign_key",
      severity: "critical",
      title: "账本关联需要修复",
      detail: `检测到 ${rows.length} 处数据关联异常，请先创建备份再处理。`,
      relatedTransactionIds: [],
      href: "/settings",
      acknowledged: false
    });
  }
}
