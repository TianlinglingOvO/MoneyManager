import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { MonthlyBudget, MonthlyBudgetInput } from "../shared/types";
import { budgetMonthSchema, monthlyBudgetInputSchema } from "../shared/schemas";
import { ConflictError, NotFoundError } from "./errors";
import type { LedgerRepository } from "./repository";

type BudgetInput = z.infer<typeof monthlyBudgetInputSchema>;
type Actor = "user" | "openclaw" | "system";

interface BudgetRow {
  month: string;
  total_minor: number | null;
  created_at: string;
  updated_at: string;
}

interface CategoryBudgetRow {
  month: string;
  category_id: string;
  amount_minor: number;
  created_at: string;
  updated_at: string;
  name?: string;
  icon?: string;
  color?: string;
  is_archived?: number;
}

export interface BudgetSnapshot {
  month: string;
  totalMinor: number | null;
  categories: Array<{ categoryId: string; amountMinor: number; createdAt: string; updatedAt: string }>;
  createdAt: string;
  updatedAt: string;
}

function monthRange(month: string): { start: string; end: string; days: number } {
  budgetMonthSchema.parse(month);
  const [year, value] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, value, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}`, days };
}

function localToday(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export class BudgetService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly repository: LedgerRepository,
    private readonly timezone: () => string
  ) {}

  today(): string {
    return localToday(this.timezone());
  }

  get(month: string): MonthlyBudget {
    const range = monthRange(month);
    const row = this.database.prepare("SELECT * FROM monthly_budgets WHERE month = ?")
      .get(month) as unknown as BudgetRow | undefined;
    const spentRow = this.database.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS value
      FROM transactions WHERE kind = 'expense' AND deleted_at IS NULL
        AND local_date >= ? AND local_date <= ?`).get(range.start, range.end) as { value: number };
    const categorySpentRows = this.database.prepare(`SELECT category_id, COALESCE(SUM(amount_minor), 0) AS value
      FROM transactions WHERE kind = 'expense' AND deleted_at IS NULL
        AND local_date >= ? AND local_date <= ? GROUP BY category_id`)
      .all(range.start, range.end) as unknown as Array<{ category_id: string; value: number }>;
    const spentByCategory = new Map(categorySpentRows.map((item) => [item.category_id, Number(item.value)]));
    const categoryRows = this.database.prepare(`SELECT b.*, c.name, c.icon, c.color, c.is_archived
      FROM category_monthly_budgets b JOIN categories c ON c.id = b.category_id
      WHERE b.month = ? ORDER BY b.amount_minor DESC, c.sort_order, c.name`)
      .all(month) as unknown as CategoryBudgetRow[];
    const spentMinor = Number(spentRow.value);
    const today = localToday(this.timezone());
    const todayMonth = today.slice(0, 7);
    const elapsedDays = month < todayMonth ? range.days : month > todayMonth ? 0 : Number(today.slice(8, 10));
    const remainingDays = month === todayMonth ? Math.max(0, range.days - elapsedDays) : 0;
    const forecastMinor = month === todayMonth && elapsedDays > 0
      ? Math.round(spentMinor / elapsedDays * range.days)
      : spentMinor;
    const remainingMinor = row?.total_minor == null ? null : Number(row.total_minor) - spentMinor;
    return {
      month,
      totalMinor: row?.total_minor == null ? null : Number(row.total_minor),
      spentMinor,
      remainingMinor,
      forecastMinor,
      elapsedDays,
      daysInMonth: range.days,
      remainingDays,
      recommendedDailyMinor: remainingMinor == null || remainingDays <= 0
        ? null
        : Math.max(0, Math.round(remainingMinor / remainingDays)),
      categories: categoryRows.map((item) => {
        const categorySpent = spentByCategory.get(item.category_id) ?? 0;
        return {
          categoryId: item.category_id,
          name: item.name ?? "未知分类",
          icon: item.icon ?? "✦",
          color: item.color ?? "#7A7A73",
          isArchived: Boolean(item.is_archived),
          budgetMinor: Number(item.amount_minor),
          spentMinor: categorySpent,
          remainingMinor: Number(item.amount_minor) - categorySpent,
          progressPercent: Number(item.amount_minor) > 0 ? categorySpent / Number(item.amount_minor) * 100 : 0
        };
      }),
      updatedAt: row?.updated_at ?? null
    };
  }

  snapshot(month: string): BudgetSnapshot | null {
    budgetMonthSchema.parse(month);
    const row = this.database.prepare("SELECT * FROM monthly_budgets WHERE month = ?")
      .get(month) as unknown as BudgetRow | undefined;
    if (!row) return null;
    const categories = this.database.prepare(`SELECT month, category_id, amount_minor, created_at, updated_at
      FROM category_monthly_budgets WHERE month = ? ORDER BY category_id`)
      .all(month) as unknown as CategoryBudgetRow[];
    return {
      month: row.month,
      totalMinor: row.total_minor == null ? null : Number(row.total_minor),
      categories: categories.map((item) => ({
        categoryId: item.category_id,
        amountMinor: Number(item.amount_minor),
        createdAt: item.created_at,
        updatedAt: item.updated_at
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  snapshotsForCategory(categoryId: string): BudgetSnapshot[] {
    const rows = this.database.prepare(
      "SELECT month FROM category_monthly_budgets WHERE category_id = ? ORDER BY month"
    ).all(categoryId) as unknown as Array<{ month: string }>;
    return rows.map((item) => this.snapshot(item.month)).filter((item): item is BudgetSnapshot => Boolean(item));
  }

  put(month: string, rawInput: MonthlyBudgetInput, options: {
    actor?: Actor;
    idempotencyKey?: string | null;
    withinTransaction?: boolean;
  } = {}): MonthlyBudget {
    budgetMonthSchema.parse(month);
    const input = monthlyBudgetInputSchema.parse(rawInput);
    if (input.totalMinor === null && input.categories.length === 0) {
      throw new ConflictError("请至少设置月总预算或一个分类预算");
    }
    return this.withIdempotency(
      options.idempotencyKey ?? null,
      `budget.put:${month}`,
      input,
      options.withinTransaction ?? false,
      () => this.writeBudget(
        month,
        input,
        options.actor ?? "user",
        (options.withinTransaction ?? false) || Boolean(options.idempotencyKey)
      )
    );
  }

  private writeBudget(month: string, input: BudgetInput, actor: Actor, withinTransaction: boolean): MonthlyBudget {
    const current = this.snapshot(month);
    const expected = input.expectedUpdatedAt ?? null;
    if ((current?.updatedAt ?? null) !== expected) {
      throw new ConflictError("预算已经在其他设备上更新，请刷新后重试");
    }
    const currentAmounts = new Map(current?.categories.map((item) => [item.categoryId, item.amountMinor]) ?? []);
    input.categories.forEach((item) => {
      const category = this.repository.getCategory(item.categoryId);
      if (category.kind !== "expense") throw new ConflictError("只能为支出分类设置预算");
      if (category.isArchived && currentAmounts.get(item.categoryId) !== item.amountMinor) {
        throw new ConflictError("停用分类只能保留已有预算，不能新增或修改");
      }
    });
    if (!withinTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO monthly_budgets(month, total_minor, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(month) DO UPDATE SET total_minor = excluded.total_minor, updated_at = excluded.updated_at`)
        .run(month, input.totalMinor, current?.createdAt ?? now, now);
      this.database.prepare("DELETE FROM category_monthly_budgets WHERE month = ?").run(month);
      const insert = this.database.prepare(`INSERT INTO category_monthly_budgets(
        month, category_id, amount_minor, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`);
      input.categories.forEach((item) => insert.run(month, item.categoryId, item.amountMinor, now, now));
      this.repository.audit(actor, "budget.update", "budget", month, {
        changedFields: ["totalMinor", "categories"],
        categoryCount: input.categories.length
      });
      if (!withinTransaction) this.database.exec("COMMIT");
      return this.get(month);
    } catch (error) {
      if (!withinTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  delete(month: string, expectedUpdatedAt: string, options: {
    actor?: Actor;
    idempotencyKey?: string | null;
    withinTransaction?: boolean;
  } = {}): { month: string; deleted: true } {
    budgetMonthSchema.parse(month);
    return this.withIdempotency(
      options.idempotencyKey ?? null,
      `budget.delete:${month}`,
      { expectedUpdatedAt },
      options.withinTransaction ?? false,
      () => {
        const current = this.snapshot(month);
        if (!current) throw new NotFoundError("这个月份还没有预算");
        if (current.updatedAt !== expectedUpdatedAt) throw new ConflictError("预算已经在其他设备上更新，请刷新后重试");
        const nested = (options.withinTransaction ?? false) || Boolean(options.idempotencyKey);
        if (!nested) this.database.exec("BEGIN IMMEDIATE");
        try {
          this.database.prepare("DELETE FROM monthly_budgets WHERE month = ? AND updated_at = ?")
            .run(month, expectedUpdatedAt);
          this.repository.audit(options.actor ?? "user", "budget.delete", "budget", month, {
            changedFields: ["totalMinor", "categories"],
            categoryCount: current.categories.length
          });
          if (!nested) this.database.exec("COMMIT");
          return { month, deleted: true as const };
        } catch (error) {
          if (!nested) this.database.exec("ROLLBACK");
          throw error;
        }
      }
    );
  }

  restoreSnapshot(month: string, before: BudgetSnapshot | null, after: BudgetSnapshot | null): void {
    const current = this.snapshot(month);
    if (after && current?.updatedAt !== after.updatedAt) {
      throw new ConflictError("预算后来已经改变，不能覆盖新内容");
    }
    if (!before) {
      this.database.prepare("DELETE FROM monthly_budgets WHERE month = ?").run(month);
      return;
    }
    this.database.prepare(`INSERT INTO monthly_budgets(month, total_minor, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(month) DO UPDATE SET total_minor = excluded.total_minor,
        created_at = excluded.created_at, updated_at = excluded.updated_at`)
      .run(before.month, before.totalMinor, before.createdAt, before.updatedAt);
    this.database.prepare("DELETE FROM category_monthly_budgets WHERE month = ?").run(month);
    const insert = this.database.prepare(`INSERT INTO category_monthly_budgets(
      month, category_id, amount_minor, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`);
    before.categories.forEach((item) => insert.run(
      before.month, item.categoryId, item.amountMinor, item.createdAt, item.updatedAt
    ));
  }

  exportData(): BudgetSnapshot[] {
    const rows = this.database.prepare("SELECT month FROM monthly_budgets ORDER BY month")
      .all() as unknown as Array<{ month: string }>;
    return rows.map((row) => this.snapshot(row.month)).filter((item): item is BudgetSnapshot => Boolean(item));
  }

  private withIdempotency<T>(
    key: string | null,
    operation: string,
    input: unknown,
    withinTransaction: boolean,
    run: () => T
  ): T {
    if (!key) return run();
    const hash = requestHash(input);
    const existing = this.database.prepare(`SELECT operation, request_hash, result_json
      FROM matter_idempotency WHERE idempotency_key = ?`).get(key) as {
        operation: string;
        request_hash: string;
        result_json: string;
      } | undefined;
    if (existing) {
      if (existing.operation !== operation || existing.request_hash !== hash) {
        throw new ConflictError("相同幂等键已用于不同的预算操作");
      }
      return JSON.parse(existing.result_json) as T;
    }
    if (!withinTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.database.prepare(`INSERT INTO matter_idempotency(
        idempotency_key, operation, request_hash, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`).run(key, operation, hash, JSON.stringify(result), new Date().toISOString());
      if (!withinTransaction) this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (!withinTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
