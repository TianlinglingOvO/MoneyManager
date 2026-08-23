import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  Category,
  CategoryDeletionImpact,
  CategoryDispositionResult,
  DailyTransactionTotal,
  DashboardData,
  FinanceReport,
  Proposal,
  ProposalStatus,
  PermanentDeletionResult,
  ReportGrain,
  Transaction,
  TransactionKind,
  TransactionList
} from "../shared/types";
import type { z } from "zod";
import {
  categoryDispositionSchema,
  categoryInputSchema,
  categoryPatchSchema,
  dailyTotalsQuerySchema,
  proposalInputSchema,
  proposalRevisionInputSchema,
  requestIdSchema,
  transactionInputSchema,
  transactionPatchSchema,
  transactionQuerySchema
} from "../shared/schemas";
import { calculateFinanceReport, rangeForQuery } from "./periods";
import { AppError, ConflictError, NotFoundError, ProposalRevisionConflictError } from "./errors";

type TransactionInput = z.infer<typeof transactionInputSchema>;
type TransactionPatch = z.infer<typeof transactionPatchSchema>;
type CategoryInput = z.infer<typeof categoryInputSchema>;
type CategoryPatch = z.infer<typeof categoryPatchSchema>;
type CategoryDisposition = z.infer<typeof categoryDispositionSchema>;
type TransactionQuery = z.infer<typeof transactionQuerySchema>;
type DailyTotalsQuery = z.infer<typeof dailyTotalsQuerySchema>;
type ProposalInput = z.infer<typeof proposalInputSchema>;
type ProposalRevisionInput = z.infer<typeof proposalRevisionInputSchema>;
type SqlValue = string | number | null;

interface ProposalCreateOptions {
  requestId?: string | null;
  requestHash?: string | null;
}

interface CategoryRow {
  id: string;
  kind: TransactionKind;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
  is_archived: number;
  transaction_count?: number;
  created_at: string;
  updated_at: string;
}

interface TransactionRow {
  id: string;
  kind: TransactionKind;
  amount_minor: number;
  currency: "CNY";
  category_id: string;
  local_date: string;
  note: string | null;
  source: "user" | "openclaw" | "system";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  category_name?: string;
  category_icon?: string;
  category_color?: string;
}

interface ProposalRow {
  id: string;
  action: "create" | "update" | "delete";
  target_transaction_id: string | null;
  payload: string;
  reason: string | null;
  source: "openclaw" | "system";
  status: ProposalStatus;
  revision: number;
  request_id: string | null;
  request_hash: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface LinkedMatterRow {
  tableName: "loans" | "loan_repayments" | "subscription_payments";
  entityType: "loan" | "loan_repayment" | "subscription_payment";
  id: string;
  updatedAt: string;
}

const categorySelect = `SELECT categories.*,
  (SELECT COUNT(*) FROM transactions WHERE transactions.category_id = categories.id) AS transaction_count
  FROM categories`;

const transactionSelect = `SELECT t.id, t.kind, t.amount_minor, t.currency, t.category_id,
  t.local_date, t.note, t.source, t.created_at, t.updated_at, t.deleted_at,
  c.name AS category_name, c.icon AS category_icon, c.color AS category_color
  FROM transactions t JOIN categories c ON c.id = t.category_id`;

function mapCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    icon: row.icon,
    color: row.color,
    sortOrder: Number(row.sort_order),
    isArchived: Boolean(row.is_archived),
    transactionCount: Number(row.transaction_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    kind: row.kind,
    amountMinor: Number(row.amount_minor),
    currency: "CNY",
    categoryId: row.category_id,
    category: row.category_name ? {
      id: row.category_id,
      name: row.category_name,
      icon: row.category_icon ?? "✦",
      color: row.category_color ?? "#7A7A73"
    } : undefined,
    localDate: row.local_date,
    note: row.note,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function mapProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    action: row.action,
    targetTransactionId: row.target_transaction_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    reason: row.reason,
    source: row.source,
    status: row.status,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at
  };
}

export class LedgerRepository {
  constructor(private readonly database: DatabaseSync) {}

  audit(actor: "user" | "openclaw" | "system", action: string, entity: string, entityId?: string | null, metadata?: Record<string, unknown>): void {
    this.database.prepare(`INSERT INTO audit_logs(id, actor, action, entity, entity_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), actor, action, entity, entityId ?? null, metadata ? JSON.stringify(metadata) : null, new Date().toISOString());
  }

  listCategories(kind?: TransactionKind, includeArchived = false): Category[] {
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (kind) {
      clauses.push("kind = ?");
      values.push(kind);
    }
    if (!includeArchived) clauses.push("is_archived = 0");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`${categorySelect} ${where} ORDER BY kind, sort_order, name`).all(...values) as unknown as CategoryRow[];
    return rows.map(mapCategory);
  }

  categoryDependencies(categoryId: string): { transactions: Transaction[]; proposals: Proposal[] } {
    const transactionRows = this.database.prepare(`${transactionSelect} WHERE t.category_id = ? ORDER BY t.created_at`)
      .all(categoryId) as unknown as TransactionRow[];
    const proposalRows = this.database.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at")
      .all() as unknown as ProposalRow[];
    return {
      transactions: transactionRows.map(mapTransaction),
      proposals: proposalRows.map(mapProposal).filter((proposal) => proposal.payload.categoryId === categoryId)
    };
  }

  getCategory(id: string): Category {
    const row = this.database.prepare(`${categorySelect} WHERE categories.id = ?`).get(id) as unknown as CategoryRow | undefined;
    if (!row) throw new NotFoundError("分类不存在");
    return mapCategory(row);
  }

  private linkedMatters(transactionId?: string, categoryId?: string): LinkedMatterRow[] {
    const clause = transactionId
      ? "ledger_transaction_id = ?"
      : "ledger_transaction_id IN (SELECT id FROM transactions WHERE category_id = ?)";
    const value = transactionId ?? categoryId;
    if (!value) return [];
    const rows = this.database.prepare(`
      SELECT 'loans' AS table_name, 'loan' AS entity_type, id, updated_at FROM loans WHERE ${clause}
      UNION ALL
      SELECT 'loan_repayments' AS table_name, 'loan_repayment' AS entity_type, id, updated_at FROM loan_repayments WHERE ${clause}
      UNION ALL
      SELECT 'subscription_payments' AS table_name, 'subscription_payment' AS entity_type, id, updated_at FROM subscription_payments WHERE ${clause}
    `).all(value, value, value) as unknown as Array<{
      table_name: LinkedMatterRow["tableName"];
      entity_type: LinkedMatterRow["entityType"];
      id: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({ tableName: row.table_name, entityType: row.entity_type, id: row.id, updatedAt: row.updated_at }));
  }

  private pendingProposalsForDeletion(transactionIds: Set<string>, categoryId?: string): Proposal[] {
    const rows = this.database.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at")
      .all() as unknown as ProposalRow[];
    return rows.map(mapProposal).filter((proposal) => {
      if (proposal.targetTransactionId && transactionIds.has(proposal.targetTransactionId)) return true;
      return Boolean(categoryId && proposal.payload.categoryId === categoryId);
    });
  }

  categoryDeletionImpact(id: string): CategoryDeletionImpact {
    const category = this.getCategory(id);
    const transactions = this.categoryDependencies(id).transactions;
    const transactionIds = new Set(transactions.map((item) => item.id));
    const links = this.linkedMatters(undefined, id);
    const proposals = this.pendingProposalsForDeletion(transactionIds, id);
    const budgetRows = this.database.prepare("SELECT month, amount_minor, updated_at FROM category_monthly_budgets WHERE category_id = ? ORDER BY month")
      .all(id) as unknown as Array<{ month: string; amount_minor: number; updated_at: string }>;
    const revision = createHash("sha256").update(JSON.stringify({
      category: [category.id, category.name, category.updatedAt],
      transactions: transactions.map((item) => [item.id, item.updatedAt, item.deletedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      links: links.map((item) => [item.entityType, item.id, item.updatedAt]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      proposals: proposals.map((item) => [item.id, item.revision, item.updatedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      budgets: budgetRows.map((item) => [item.month, item.amount_minor, item.updated_at])
    })).digest("hex");
    return {
      categoryId: category.id,
      categoryName: category.name,
      activeTransactionCount: transactions.filter((item) => !item.deletedAt).length,
      trashedTransactionCount: transactions.filter((item) => Boolean(item.deletedAt)).length,
      linkedMatterCount: links.length,
      pendingProposalCount: proposals.length,
      revision
    };
  }

  private invalidateOpenClawOperations(refs: Array<{ entityType: string; id: string }>): number {
    const operationIds = new Set<string>();
    const find = this.database.prepare("SELECT operation_id FROM openclaw_operation_items WHERE entity_type = ? AND entity_id = ?");
    refs.forEach((ref) => {
      const rows = find.all(ref.entityType, ref.id) as unknown as Array<{ operation_id: string }>;
      rows.forEach((row) => operationIds.add(row.operation_id));
    });
    const removeItems = this.database.prepare("DELETE FROM openclaw_operation_items WHERE operation_id = ?");
    const invalidate = this.database.prepare(`UPDATE openclaw_operations
      SET undoable = 0, result_json = ? WHERE id = ?`);
    operationIds.forEach((operationId) => {
      removeItems.run(operationId);
      invalidate.run(JSON.stringify({ invalidatedByPermanentDeletion: true }), operationId);
    });
    return operationIds.size;
  }

  private permanentlyDeleteBatch(transactions: Transaction[], actor: "user" | "openclaw" | "system", categoryId?: string): PermanentDeletionResult {
    const transactionIds = new Set(transactions.map((item) => item.id));
    const links = categoryId
      ? this.linkedMatters(undefined, categoryId)
      : transactions.flatMap((item) => this.linkedMatters(item.id));
    const proposals = this.pendingProposalsForDeletion(transactionIds, categoryId);
    const now = new Date().toISOString();
    const matterRefs: Array<{ entityType: string; id: string }> = [];
    const detachStatements = {
      loans: this.database.prepare("UPDATE loans SET ledger_link_mode = 'none', ledger_transaction_id = NULL, updated_at = ? WHERE id = ?"),
      loan_repayments: this.database.prepare("UPDATE loan_repayments SET ledger_link_mode = 'none', ledger_transaction_id = NULL, updated_at = ? WHERE id = ?"),
      subscription_payments: this.database.prepare("UPDATE subscription_payments SET ledger_link_mode = 'none', ledger_transaction_id = NULL, updated_at = ? WHERE id = ?")
    };
    links.forEach((link) => {
      detachStatements[link.tableName].run(now, link.id);
      matterRefs.push({ entityType: link.entityType, id: link.id });
    });
    const reject = this.database.prepare(`UPDATE proposals SET status = 'rejected', resolved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`);
    proposals.forEach((proposal) => {
      reject.run(now, now, proposal.id);
      this.audit(actor, "proposal.reject", "proposal", proposal.id, { action: proposal.action, trigger: "permanent_deletion" });
    });
    const refs = [
      ...transactions.map((item) => ({ entityType: "transaction", id: item.id })),
      ...matterRefs,
      ...proposals.map((item) => ({ entityType: "proposal", id: item.id })),
      ...(categoryId ? [{ entityType: "category", id: categoryId }] : [])
    ];
    const invalidatedOperationCount = this.invalidateOpenClawOperations(refs);
    const remove = this.database.prepare("DELETE FROM transactions WHERE id = ?");
    transactions.forEach((item) => remove.run(item.id));
    return {
      entityType: categoryId ? "category" : "transaction",
      entityId: categoryId ?? transactions[0]?.id ?? "",
      permanentlyDeletedTransactionCount: transactions.length,
      detachedLedgerLinkCount: links.length,
      rejectedProposalCount: proposals.length,
      invalidatedOperationCount
    };
  }

  createCategory(rawInput: CategoryInput, actor: "user" | "openclaw" = "user"): Category {
    const input = categoryInputSchema.parse(rawInput);
    const duplicate = this.database.prepare("SELECT id FROM categories WHERE kind = ? AND name = ? COLLATE NOCASE")
      .get(input.kind, input.name);
    if (duplicate) throw new ConflictError("同类型下已经有这个分类名称");
    const maxRow = this.database.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM categories WHERE kind = ?")
      .get(input.kind) as { value: number };
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database.prepare(`INSERT INTO categories(id, kind, name, icon, color, sort_order, is_archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(id, input.kind, input.name, input.icon, input.color, input.sortOrder ?? Number(maxRow.value) + 1, now, now);
    this.audit(actor, "category.create", "category", id, { kind: input.kind });
    return this.getCategory(id);
  }

  updateCategory(id: string, rawPatch: CategoryPatch, actor: "user" | "openclaw" = "user"): Category {
    const current = this.getCategory(id);
    const patch = categoryPatchSchema.parse(rawPatch);
    const next = { ...current, ...patch };
    if (patch.name) {
      const duplicate = this.database.prepare("SELECT id FROM categories WHERE kind = ? AND name = ? COLLATE NOCASE AND id != ?")
        .get(current.kind, patch.name, id);
      if (duplicate) throw new ConflictError("同类型下已经有这个分类名称");
    }
    this.database.prepare(`UPDATE categories SET name = ?, icon = ?, color = ?, sort_order = ?, is_archived = ?, updated_at = ? WHERE id = ?`)
      .run(next.name, next.icon, next.color, next.sortOrder, next.isArchived ? 1 : 0, new Date().toISOString(), id);
    this.audit(actor, "category.update", "category", id, { archived: next.isArchived });
    return this.getCategory(id);
  }

  manageCategory(
    id: string,
    rawInput: CategoryDisposition,
    actor: "user" | "openclaw" = "user",
    withinTransaction = false
  ): CategoryDispositionResult {
    const input = categoryDispositionSchema.parse(rawInput);
    const category = this.getCategory(id);

    if (input.action === "purge") {
      return this.permanentlyDeleteCategory(id, input.expectedRevision, input.confirmName, actor, withinTransaction);
    }

    if (input.action === "archive" || input.action === "restore") {
      const updated = this.updateCategory(id, { isArchived: input.action === "archive" }, actor);
      this.audit(actor, `category.${input.action}`, "category", id, { transactionCount: category.transactionCount });
      return { action: input.action, category: updated, migratedTransactionCount: 0 };
    }

    const pendingProposals = this.database.prepare("SELECT id, action, payload, revision FROM proposals WHERE status = 'pending'")
      .all() as unknown as Array<{ id: string; action: Proposal["action"]; payload: string; revision: number }>;
    const proposalsUsingCategory = pendingProposals.filter((proposal) => {
      try { return (JSON.parse(proposal.payload) as { categoryId?: string }).categoryId === id; }
      catch { return false; }
    });

    if (input.action === "delete") {
      if (category.transactionCount > 0) throw new ConflictError("这个分类仍有账目，请先迁移或选择停用");
      if (proposalsUsingCategory.length > 0) throw new ConflictError("这个分类仍被待确认操作使用，请先处理待确认操作");
      const budgetMonths = this.database.prepare(
        "SELECT month FROM category_monthly_budgets WHERE category_id = ?"
      ).all(id) as unknown as Array<{ month: string }>;
      this.database.prepare("DELETE FROM categories WHERE id = ?").run(id);
      budgetMonths.forEach(({ month }) => {
        this.database.prepare(`DELETE FROM monthly_budgets WHERE month = ? AND total_minor IS NULL
          AND NOT EXISTS (SELECT 1 FROM category_monthly_budgets WHERE month = ?)`).run(month, month);
      });
      this.audit(actor, "category.delete", "category", id, { kind: category.kind });
      return { action: "delete", migratedTransactionCount: 0 };
    }

    if (input.targetCategoryId === id) throw new ConflictError("不能迁移到原分类");
    const target = this.getCategory(input.targetCategoryId);
    if (target.kind !== category.kind) throw new ConflictError("只能迁移到相同收支类型的分类");
    if (target.isArchived) throw new ConflictError("不能迁移到已停用的分类");

    if (!withinTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const migrated = this.database.prepare("UPDATE transactions SET category_id = ?, updated_at = ? WHERE category_id = ?")
        .run(target.id, now, category.id);
      for (const proposal of proposalsUsingCategory) {
        const payload = JSON.parse(proposal.payload) as Record<string, unknown>;
        payload.categoryId = target.id;
        const previousRevision = Number(proposal.revision);
        this.database.prepare(`UPDATE proposals SET payload = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'pending' AND revision = ?`)
          .run(JSON.stringify(payload), now, proposal.id, previousRevision);
        this.audit(actor, "proposal.revise", "proposal", proposal.id, {
          action: proposal.action,
          previousRevision,
          revision: previousRevision + 1,
          changedFields: ["categoryId"],
          trigger: "category_migration"
        });
      }
      const budgetMonths = this.database.prepare(
        "SELECT month FROM category_monthly_budgets WHERE category_id = ? ORDER BY month"
      ).all(category.id) as unknown as Array<{ month: string }>;
      this.database.prepare("INSERT INTO category_monthly_budgets(month, category_id, amount_minor, created_at, updated_at) SELECT month, ?, amount_minor, created_at, ? FROM category_monthly_budgets WHERE category_id = ? ON CONFLICT(month, category_id) DO UPDATE SET amount_minor = category_monthly_budgets.amount_minor + excluded.amount_minor, updated_at = excluded.updated_at")
        .run(target.id, now, category.id);
      this.database.prepare("DELETE FROM category_monthly_budgets WHERE category_id = ?").run(category.id);
      const touchBudget = this.database.prepare("UPDATE monthly_budgets SET updated_at = ? WHERE month = ?");
      budgetMonths.forEach((item) => touchBudget.run(now, item.month));
      this.database.prepare("DELETE FROM categories WHERE id = ?").run(category.id);
      this.audit(actor, "category.migrate", "category", category.id, {
        targetCategoryId: target.id,
        transactionCount: Number(migrated.changes),
        proposalCount: proposalsUsingCategory.length
      });
      if (!withinTransaction) this.database.exec("COMMIT");
      return { action: "migrate", category: this.getCategory(target.id), migratedTransactionCount: Number(migrated.changes) };
    } catch (error) {
      if (!withinTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  permanentlyDeleteCategory(
    id: string,
    expectedRevision: string,
    confirmName: string,
    actor: "user" | "openclaw" = "user",
    withinTransaction = false
  ): CategoryDispositionResult {
    const category = this.getCategory(id);
    if (confirmName !== category.name) throw new ConflictError("请输入完整的分类名称以确认永久删除");
    const impact = this.categoryDeletionImpact(id);
    if (impact.revision !== expectedRevision) throw new ConflictError("分类或关联内容已经变化，请重新查看影响后再删除");
    if (!withinTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const budgetMonths = this.database.prepare(
        "SELECT month FROM category_monthly_budgets WHERE category_id = ?"
      ).all(id) as unknown as Array<{ month: string }>;
      const currentImpact = this.categoryDeletionImpact(id);
      if (currentImpact.revision !== expectedRevision) throw new ConflictError("分类或关联内容已经变化，请重新查看影响后再删除");
      const transactions = this.categoryDependencies(id).transactions;
      const result = this.permanentlyDeleteBatch(transactions, actor, id);
      this.database.prepare("DELETE FROM categories WHERE id = ?").run(id);
      const now = new Date().toISOString();
      budgetMonths.forEach(({ month }) => {
        const removed = this.database.prepare(`DELETE FROM monthly_budgets WHERE month = ? AND total_minor IS NULL
          AND NOT EXISTS (SELECT 1 FROM category_monthly_budgets WHERE month = ?)`).run(month, month);
        if (Number(removed.changes) === 0) {
          this.database.prepare("UPDATE monthly_budgets SET updated_at = ? WHERE month = ?").run(now, month);
        }
      });
      this.audit(actor, "category.purge", "category", id, {
        transactionCount: result.permanentlyDeletedTransactionCount,
        detachedLedgerLinkCount: result.detachedLedgerLinkCount,
        rejectedProposalCount: result.rejectedProposalCount,
        invalidatedOperationCount: result.invalidatedOperationCount
      });
      if (!withinTransaction) this.database.exec("COMMIT");
      return {
        action: "purge",
        migratedTransactionCount: 0,
        permanentlyDeletedTransactionCount: result.permanentlyDeletedTransactionCount,
        detachedLedgerLinkCount: result.detachedLedgerLinkCount,
        rejectedProposalCount: result.rejectedProposalCount,
        invalidatedOperationCount: result.invalidatedOperationCount
      };
    } catch (error) {
      if (!withinTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private assertCategoryForTransaction(categoryId: string, kind: TransactionKind): Category {
    const category = this.getCategory(categoryId);
    if (category.kind !== kind) throw new ConflictError("分类类型与收支类型不一致");
    if (category.isArchived) throw new ConflictError("停用的分类不能用于新账目");
    return category;
  }

  private effectiveProposalTransaction(proposal: Proposal): TransactionInput {
    if (proposal.action === "create") {
      return transactionInputSchema.parse(proposal.payload);
    }
    if (proposal.action === "delete" || !proposal.targetTransactionId) {
      throw new ConflictError("删除提案不能编辑");
    }
    const target = this.getTransaction(proposal.targetTransactionId, false);
    return transactionInputSchema.parse({
      kind: target.kind,
      amountMinor: target.amountMinor,
      categoryId: target.categoryId,
      localDate: target.localDate,
      note: target.note,
      ...proposal.payload
    });
  }

  getTransaction(id: string, includeDeleted = true): Transaction {
    const deletedClause = includeDeleted ? "" : " AND t.deleted_at IS NULL";
    const row = this.database.prepare(`${transactionSelect} WHERE t.id = ?${deletedClause}`).get(id) as unknown as TransactionRow | undefined;
    if (!row) throw new NotFoundError("账目不存在");
    return mapTransaction(row);
  }

  createTransaction(rawInput: TransactionInput, options: {
    source?: "user" | "openclaw" | "system";
    idempotencyKey?: string | null;
    actor?: "user" | "openclaw" | "system";
  } = {}): Transaction {
    const input = transactionInputSchema.parse(rawInput);
    if (options.idempotencyKey) {
      const existing = this.database.prepare(`${transactionSelect} WHERE t.idempotency_key = ?`)
        .get(options.idempotencyKey) as unknown as TransactionRow | undefined;
      if (existing) return mapTransaction(existing);
    }
    this.assertCategoryForTransaction(input.categoryId, input.kind);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO transactions(
      id, kind, amount_minor, currency, category_id, occurred_at, local_date, note,
      source, idempotency_key, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(
        id, input.kind, input.amountMinor, input.categoryId, input.localDate, input.localDate,
        input.note?.trim() || null, options.source ?? "user", options.idempotencyKey ?? null, now, now
      );
    this.audit(options.actor ?? "user", "transaction.create", "transaction", id, { kind: input.kind, source: options.source ?? "user" });
    return this.getTransaction(id);
  }

  updateTransaction(
    id: string,
    rawPatch: TransactionPatch,
    actor: "user" | "openclaw" = "user",
    expectedUpdatedAt?: string
  ): Transaction {
    const current = this.getTransaction(id, false);
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
      throw new ConflictError("这笔账已经在其他设备上更新，请刷新后重试");
    }
    const patch = transactionPatchSchema.parse(rawPatch);
    const next = { ...current, ...patch };
    this.assertCategoryForTransaction(next.categoryId, next.kind);
    const updatedAt = new Date().toISOString();
    const result = expectedUpdatedAt
      ? this.database.prepare("UPDATE transactions SET kind = ?, amount_minor = ?, category_id = ?, occurred_at = ?, local_date = ?, note = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND updated_at = ?")
        .run(next.kind, next.amountMinor, next.categoryId, next.localDate, next.localDate, next.note?.trim() || null, updatedAt, id, expectedUpdatedAt)
      : this.database.prepare("UPDATE transactions SET kind = ?, amount_minor = ?, category_id = ?, occurred_at = ?, local_date = ?, note = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(next.kind, next.amountMinor, next.categoryId, next.localDate, next.localDate, next.note?.trim() || null, updatedAt, id);
    if (Number(result.changes) !== 1) throw new ConflictError("这笔账已经在其他设备上更新，请刷新后重试");
    this.audit(actor, "transaction.update", "transaction", id, { kind: next.kind });
    return this.getTransaction(id);
  }

  softDeleteTransaction(
    id: string,
    actor: "user" | "openclaw" = "user",
    expectedUpdatedAt?: string
  ): Transaction {
    const current = this.getTransaction(id, false);
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
      throw new ConflictError("这笔账已经在其他设备上更新，请刷新后重试");
    }
    const now = new Date().toISOString();
    const result = expectedUpdatedAt
      ? this.database.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND updated_at = ?")
        .run(now, now, id, expectedUpdatedAt)
      : this.database.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(now, now, id);
    if (Number(result.changes) !== 1) throw new ConflictError("这笔账已经在其他设备上更新，请刷新后重试");
    this.audit(actor, "transaction.delete", "transaction", id);
    return this.getTransaction(id);
  }

  restoreTransaction(id: string, actor: "user" | "openclaw" = "user"): Transaction {
    const current = this.getTransaction(id, true);
    if (!current.deletedAt) return current;
    const category = this.getCategory(current.categoryId);
    if (category.isArchived) throw new ConflictError("请先恢复这笔账使用的分类");
    this.database.prepare("UPDATE transactions SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    this.audit(actor, "transaction.restore", "transaction", id);
    return this.getTransaction(id);
  }

  permanentlyDeleteTransaction(
    id: string,
    expectedUpdatedAt: string,
    confirmation: "PERMANENT_DELETE",
    actor: "user" | "openclaw" = "user",
    withinTransaction = false
  ): PermanentDeletionResult {
    if (confirmation !== "PERMANENT_DELETE") throw new ConflictError("需要明确确认才能永久删除账目");
    const current = this.getTransaction(id, true);
    if (!current.deletedAt) throw new ConflictError("只能永久删除已进入回收站的账目");
    if (current.updatedAt !== expectedUpdatedAt) throw new ConflictError("这笔账已经变化，请重新查看后再删除");
    if (!withinTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.getTransaction(id, true);
      if (!latest.deletedAt || latest.updatedAt !== expectedUpdatedAt) throw new ConflictError("这笔账已经变化，请重新查看后再删除");
      const result = this.permanentlyDeleteBatch([latest], actor);
      this.audit(actor, "transaction.purge", "transaction", id, {
        detachedLedgerLinkCount: result.detachedLedgerLinkCount,
        rejectedProposalCount: result.rejectedProposalCount,
        invalidatedOperationCount: result.invalidatedOperationCount
      });
      if (!withinTransaction) this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (!withinTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  purgeExpiredTrash(now = new Date()): number {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.database.prepare(`${transactionSelect} WHERE t.deleted_at IS NOT NULL AND t.deleted_at < ? ORDER BY t.deleted_at`)
      .all(cutoff) as unknown as TransactionRow[];
    const transactions = rows.map(mapTransaction);
    if (transactions.length === 0) return 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.permanentlyDeleteBatch(transactions, "system");
      this.audit("system", "trash.purge", "transaction", null, {
        count: result.permanentlyDeletedTransactionCount,
        detachedLedgerLinkCount: result.detachedLedgerLinkCount,
        rejectedProposalCount: result.rejectedProposalCount,
        invalidatedOperationCount: result.invalidatedOperationCount
      });
      this.database.exec("COMMIT");
      return result.permanentlyDeletedTransactionCount;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTransactions(rawQuery: Partial<TransactionQuery> = {}): TransactionList {
    const query = transactionQuerySchema.parse(rawQuery);
    if (query.deleted !== "active") this.purgeExpiredTrash();
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (query.kind) { clauses.push("t.kind = ?"); values.push(query.kind); }
    if (query.categoryId) { clauses.push("t.category_id = ?"); values.push(query.categoryId); }
    if (query.start) { clauses.push("t.local_date >= ?"); values.push(query.start); }
    if (query.end) { clauses.push("t.local_date <= ?"); values.push(query.end); }
    if (query.search) { clauses.push("COALESCE(t.note, '') LIKE ? ESCAPE '\\'"); values.push(`%${query.search.replace(/[\\%_]/g, "\\$&")}%`); }
    if (query.deleted === "active") clauses.push("t.deleted_at IS NULL");
    if (query.deleted === "trash") clauses.push("t.deleted_at IS NOT NULL");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const countRow = this.database.prepare(`SELECT COUNT(*) AS count FROM transactions t ${where}`).get(...values) as { count: number };
    const offset = (query.page - 1) * query.pageSize;
    const orderBy = query.sort === "recorded"
      ? "t.created_at DESC, t.rowid DESC"
      : query.sort === "deleted"
        ? "t.deleted_at DESC, t.rowid DESC"
        : "t.local_date DESC, t.created_at DESC, t.rowid DESC";
    const rows = this.database.prepare(`${transactionSelect} ${where}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...values, query.pageSize, offset) as unknown as TransactionRow[];
    return { items: rows.map(mapTransaction), total: Number(countRow.count), page: query.page, pageSize: query.pageSize };
  }

  getDailyTotals(rawQuery: DailyTotalsQuery): DailyTransactionTotal[] {
    const query = dailyTotalsQuerySchema.parse(rawQuery);
    const clauses = ["t.deleted_at IS NULL", "t.local_date BETWEEN ? AND ?"];
    const values: SqlValue[] = [query.start, query.end];
    if (query.kind) { clauses.push("t.kind = ?"); values.push(query.kind); }
    if (query.categoryId) { clauses.push("t.category_id = ?"); values.push(query.categoryId); }
    if (query.search) {
      clauses.push("COALESCE(t.note, '') LIKE ? ESCAPE '\\'");
      values.push(`%${query.search.replace(/[\\%_]/g, "\\$&")}%`);
    }
    const rows = this.database.prepare(`SELECT
      t.local_date,
      SUM(CASE WHEN t.kind = 'income' THEN t.amount_minor ELSE 0 END) AS income_minor,
      SUM(CASE WHEN t.kind = 'expense' THEN t.amount_minor ELSE 0 END) AS expense_minor,
      COUNT(*) AS transaction_count
      FROM transactions t
      WHERE ${clauses.join(" AND ")}
      GROUP BY t.local_date
      ORDER BY t.local_date DESC`).all(...values) as unknown as Array<{
        local_date: string;
        income_minor: number;
        expense_minor: number;
        transaction_count: number;
      }>;
    return rows.map((row) => ({
      localDate: row.local_date,
      incomeMinor: Number(row.income_minor),
      expenseMinor: Number(row.expense_minor),
      transactionCount: Number(row.transaction_count)
    }));
  }

  getDashboard(today: string): DashboardData {
    const monthStart = `${today.slice(0, 7)}-01`;
    const monthRows = this.database.prepare(`SELECT kind, SUM(amount_minor) AS total FROM transactions
      WHERE deleted_at IS NULL AND local_date BETWEEN ? AND ? GROUP BY kind`).all(monthStart, today) as unknown as Array<{ kind: TransactionKind; total: number }>;
    const todayRows = this.database.prepare(`SELECT kind, SUM(amount_minor) AS total FROM transactions
      WHERE deleted_at IS NULL AND local_date = ? GROUP BY kind`).all(today) as unknown as Array<{ kind: TransactionKind; total: number }>;
    const totals = (rows: Array<{ kind: TransactionKind; total: number }>) => {
      const incomeMinor = Number(rows.find((row) => row.kind === "income")?.total ?? 0);
      const expenseMinor = Number(rows.find((row) => row.kind === "expense")?.total ?? 0);
      return { incomeMinor, expenseMinor, balanceMinor: incomeMinor - expenseMinor };
    };
    const recent = this.listTransactions({ pageSize: 6 }).items;
    this.expireProposals();
    const pending = this.database.prepare("SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending'").get() as { count: number };
    return { today: totals(todayRows), month: totals(monthRows), recent, pendingProposalCount: Number(pending.count) };
  }

  getFinanceReport(grain: ReportGrain, anchor: string, kind: TransactionKind, todayKey?: string): FinanceReport {
    const range = rangeForQuery(grain, anchor, todayKey);
    const transactions = this.listTransactions({ start: range.start, end: range.end, pageSize: 100, deleted: "active" });
    const items = [...transactions.items];
    let page = 2;
    while (items.length < transactions.total) {
      items.push(...this.listTransactions({ start: range.start, end: range.end, pageSize: 100, page, deleted: "active" }).items);
      page += 1;
    }
    return calculateFinanceReport({
      transactions: items,
      categories: this.listCategories(undefined, true),
      grain,
      anchor,
      kind,
      todayKey
    });
  }

  createProposal(
    rawInput: ProposalInput,
    source: "openclaw" | "system" = "openclaw",
    options: ProposalCreateOptions = {}
  ): Proposal {
    const requestId = options.requestId ? requestIdSchema.parse(options.requestId) : null;
    const requestHash = options.requestHash?.trim() || null;
    if (Boolean(requestId) !== Boolean(requestHash)) throw new AppError("提案幂等信息不完整");
    if (requestId) {
      const existing = this.database.prepare("SELECT * FROM proposals WHERE request_id = ?")
        .get(requestId) as unknown as ProposalRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new ConflictError("相同 requestId 已用于不同提案");
        return mapProposal(existing);
      }
    }
    const input = proposalInputSchema.parse(rawInput);
    if (input.action === "create") {
      this.assertCategoryForTransaction(input.payload.categoryId, input.payload.kind);
    } else {
      const target = this.getTransaction(input.targetTransactionId, false);
      if (input.action === "update") {
        const effective = transactionInputSchema.parse({
          kind: target.kind,
          amountMinor: target.amountMinor,
          categoryId: target.categoryId,
          localDate: target.localDate,
          note: target.note,
          ...input.payload
        });
        this.assertCategoryForTransaction(effective.categoryId, effective.kind);
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO proposals(
      id, action, target_transaction_id, payload, reason, source, status, revision,
      request_id, request_hash, created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, NULL)`)
      .run(
        id, input.action, input.action === "create" ? null : input.targetTransactionId,
        JSON.stringify(input.payload), input.reason ?? null, source, requestId, requestHash, now, now
      );
    this.audit(source === "openclaw" ? "openclaw" : "system", "proposal.create", "proposal", id, {
      action: input.action,
      requestId
    });
    return this.getProposal(id);
  }

  getProposal(id: string): Proposal {
    const row = this.database.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as unknown as ProposalRow | undefined;
    if (!row) throw new NotFoundError("待确认操作不存在");
    return mapProposal(row);
  }

  reviseProposal(
    id: string,
    rawInput: ProposalRevisionInput,
    actor: "user" | "openclaw" = "user"
  ): Proposal {
    const { expectedRevision, ...changes } = proposalRevisionInputSchema.parse(rawInput);
    this.expireProposals();
    const proposal = this.getProposal(id);
    if (proposal.status !== "pending") throw new ConflictError("这个操作已经处理过了");
    if (proposal.action === "delete") throw new ConflictError("删除提案不能编辑");
    if (actor === "openclaw" && proposal.source !== "openclaw") {
      throw new AppError("OpenClaw 只能修订自己创建的待确认操作", 403, "FORBIDDEN");
    }
    if (proposal.revision !== expectedRevision) throw new ProposalRevisionConflictError();

    const current = this.effectiveProposalTransaction(proposal);
    const next = transactionInputSchema.parse({ ...current, ...changes });
    this.assertCategoryForTransaction(next.categoryId, next.kind);
    const fields = ["kind", "amountMinor", "categoryId", "localDate", "note"] as const;
    const changedFields = fields.filter((field) => current[field] !== next[field]);
    if (changedFields.length === 0) return proposal;

    const now = new Date().toISOString();
    const result = this.database.prepare(`UPDATE proposals
      SET payload = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'pending' AND revision = ?`)
      .run(JSON.stringify(next), now, id, expectedRevision);
    if (Number(result.changes) !== 1) throw new ProposalRevisionConflictError();
    this.audit(actor, "proposal.revise", "proposal", id, {
      action: proposal.action,
      previousRevision: expectedRevision,
      revision: expectedRevision + 1,
      changedFields
    });
    return this.getProposal(id);
  }

  expireProposals(): number {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = this.database.prepare(`UPDATE proposals SET status = 'expired', resolved_at = ?
      WHERE status = 'pending' AND created_at < ?`).run(new Date().toISOString(), cutoff);
    return Number(result.changes);
  }

  listProposals(status: ProposalStatus = "pending"): Proposal[] {
    this.expireProposals();
    const rows = this.database.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT 100")
      .all(status) as unknown as ProposalRow[];
    return rows.map(mapProposal);
  }

  resolveProposal(id: string, decision: "approve" | "reject", expectedRevision: number): { proposal: Proposal; transaction?: Transaction } {
    this.expireProposals();
    const proposal = this.getProposal(id);
    if (proposal.revision !== expectedRevision) throw new ProposalRevisionConflictError();
    if (proposal.status !== "pending") throw new ConflictError("这个操作已经处理过了");
    const now = new Date().toISOString();
    if (decision === "reject") {
      const result = this.database.prepare(`UPDATE proposals SET status = 'rejected', resolved_at = ?
        WHERE id = ? AND status = 'pending' AND revision = ?`).run(now, id, expectedRevision);
      if (Number(result.changes) !== 1) throw new ProposalRevisionConflictError();
      this.audit("user", "proposal.reject", "proposal", id, { action: proposal.action, revision: expectedRevision });
      return { proposal: this.getProposal(id) };
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      let transaction: Transaction;
      if (proposal.action === "create") {
        transaction = this.createTransaction(proposal.payload as unknown as TransactionInput, {
          source: "openclaw",
          actor: "openclaw",
          idempotencyKey: `proposal:${proposal.id}`
        });
      } else if (proposal.action === "update") {
        transaction = this.updateTransaction(proposal.targetTransactionId!, proposal.payload as unknown as TransactionPatch, "openclaw");
      } else {
        transaction = this.softDeleteTransaction(proposal.targetTransactionId!, "openclaw");
      }
      const result = this.database.prepare(`UPDATE proposals SET status = 'approved', resolved_at = ?
        WHERE id = ? AND status = 'pending' AND revision = ?`).run(now, id, expectedRevision);
      if (Number(result.changes) !== 1) throw new ProposalRevisionConflictError();
      this.audit("user", "proposal.approve", "proposal", id, { action: proposal.action, revision: expectedRevision });
      this.database.exec("COMMIT");
      return { proposal: this.getProposal(id), transaction };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  allTransactionsForPeriod(start: string, end: string): Transaction[] {
    const first = this.listTransactions({ start, end, pageSize: 100, deleted: "active" });
    const items = [...first.items];
    let page = 2;
    while (items.length < first.total) {
      items.push(...this.listTransactions({ start, end, page, pageSize: 100, deleted: "active" }).items);
      page += 1;
    }
    return items.sort((a, b) => a.localDate.localeCompare(b.localDate) || a.createdAt.localeCompare(b.createdAt));
  }

  dataHash(start: string, end: string): { hash: string; transactions: Transaction[] } {
    const transactions = this.allTransactionsForPeriod(start, end);
    const hash = createHash("sha256").update(JSON.stringify(transactions.map((item) => [
      item.id,
      item.kind,
      item.amountMinor,
      item.categoryId,
      item.category?.name,
      item.localDate,
      item.note,
      item.updatedAt,
      item.deletedAt
    ]))).digest("hex");
    return { hash, transactions };
  }

  exportData(): Record<string, unknown> {
    const first = this.listTransactions({ deleted: "all", pageSize: 100 });
    const transactions = [...first.items];
    let page = 2;
    while (transactions.length < first.total) {
      transactions.push(...this.listTransactions({ deleted: "all", page, pageSize: 100 }).items);
      page += 1;
    }
    const settings = this.database.prepare("SELECT key, value, updated_at FROM settings ORDER BY key").all();
    return {
      format: "sutady-money-manager",
      version: 1,
      exportedAt: new Date().toISOString(),
      currency: "CNY",
      categories: this.listCategories(undefined, true),
      transactions,
      settings
    };
  }
}
