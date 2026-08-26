import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  Borrower,
  Category,
  Loan,
  LoanRepayment,
  OpenClawControlSettings,
  OpenClawDirectResult,
  OpenClawMode,
  OpenClawOperation,
  OpenClawOperationDetail,
  Proposal,
  Subscription,
  SubscriptionPayment,
  Transaction
} from "../shared/types";
import type { Account, AccountAdjustment, Transfer } from "../shared/types";
import { requestIdSchema } from "../shared/schemas";
import type { LedgerRepository } from "./repository";
import type { AppConfig } from "./config";
import type { BudgetService, BudgetSnapshot } from "./budgets";
import { AppError, ConflictError, NotFoundError } from "./errors";
import type { FundsService } from "./funds";

type EntityType = "transaction" | "category" | "proposal" | "setting"
  | "borrower" | "loan" | "loan_repayment" | "subscription" | "subscription_payment" | "budget" | "account" | "transfer" | "account_adjustment";
type SqlValue = string | number | bigint | Uint8Array | null;

function sql(value: unknown): SqlValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  throw new ConflictError("恢复快照包含无效字段");
}

interface OperationRow {
  id: string;
  request_id: string;
  request_hash: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  status: "running" | "applied" | "undone" | "failed";
  undoable: number;
  summary: string;
  result_json: string | null;
  created_at: string;
  expires_at: string;
  undone_at: string | null;
  failed_at: string | null;
}

interface OperationItemRow {
  sequence: number;
  entity_type: EntityType;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
}

interface SnapshotItem {
  entityType: EntityType;
  entityId: string;
  before: unknown | null;
  after: unknown | null;
}

type MatterSnapshotValues = (snapshot: Record<string, unknown>) => SqlValue[];

function snapshotField(snapshot: Record<string, unknown>, key: string): unknown {
  return snapshot[key] === undefined ? null : snapshot[key];
}

function ledgerLinkValues(snapshot: Record<string, unknown>): [SqlValue, SqlValue] {
  const link = snapshotField(snapshot, "ledgerLink");
  if (!link || typeof link !== "object") return ["none", null];
  const value = link as Record<string, unknown>;
  return [sql(value.mode ?? "none"), sql(value.transactionId ?? null)];
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

export function hashOpenClawRequest(action: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue({ action, input }))).digest("hex");
}

function mapOperation(row: OperationRow): OpenClawOperation {
  return {
    id: row.id,
    requestId: row.request_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    undoable: Boolean(row.undoable),
    summary: row.summary,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    undoneAt: row.undone_at,
    failedAt: row.failed_at
  };
}

function transactionSnapshot(transaction: Transaction): Record<string, unknown> {
  return {
    id: transaction.id,
    kind: transaction.kind,
    amountMinor: transaction.amountMinor,
    accountAmountMinor: transaction.accountAmountMinor,
    currency: transaction.currency,
    categoryId: transaction.categoryId,
    localDate: transaction.localDate,
    note: transaction.note,
    source: transaction.source,
    accountId: transaction.accountId,
    refundedAt: transaction.refundedAt,
    refundAccountId: transaction.refundAccountId,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    deletedAt: transaction.deletedAt
  };
}

function categorySnapshot(category: Category): Record<string, unknown> {
  return {
    id: category.id,
    kind: category.kind,
    name: category.name,
    icon: category.icon,
    color: category.color,
    sortOrder: category.sortOrder,
    isArchived: category.isArchived,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt
  };
}

function proposalSnapshot(proposal: Proposal): Record<string, unknown> {
  return {
    id: proposal.id,
    action: proposal.action,
    targetTransactionId: proposal.targetTransactionId,
    payload: proposal.payload,
    reason: proposal.reason,
    source: proposal.source,
    status: proposal.status,
    revision: proposal.revision,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    resolvedAt: proposal.resolvedAt
  };
}

/*
 * Matter snapshots intentionally use the public camelCase shape rather than
 * copying database rows.  This keeps the operation log independent from the
 * SQL column layout and, more importantly, means the same snapshot can be
 * used by the web UI and MCP undo path without exposing a raw query result.
 * Derived fields (totals, status and payment history) are ignored when a
 * snapshot is restored; only the persisted fields are written back.
 */
function borrowerSnapshot(borrower: Borrower): Record<string, unknown> {
  return {
    id: borrower.id, name: borrower.name, note: borrower.note,
    isArchived: borrower.isArchived, createdAt: borrower.createdAt,
    updatedAt: borrower.updatedAt, deletedAt: borrower.deletedAt
  };
}

function loanSnapshot(loan: Loan): Record<string, unknown> {
  return {
    id: loan.id, borrowerId: loan.borrowerId, principalMinor: loan.principalMinor,
    localDate: loan.localDate, purpose: loan.purpose, note: loan.note,
    ledgerLink: loan.ledgerLink, accountId: loan.accountId, createdAt: loan.createdAt,
    updatedAt: loan.updatedAt, deletedAt: loan.deletedAt
  };
}

function repaymentSnapshot(repayment: LoanRepayment): Record<string, unknown> {
  return {
    id: repayment.id, loanId: repayment.loanId, amountMinor: repayment.amountMinor,
    localDate: repayment.localDate, note: repayment.note, ledgerLink: repayment.ledgerLink, accountId: repayment.accountId,
    createdAt: repayment.createdAt, updatedAt: repayment.updatedAt,
    deletedAt: repayment.deletedAt
  };
}

function subscriptionSnapshot(subscription: Subscription): Record<string, unknown> {
  return {
    id: subscription.id, name: subscription.name, plan: subscription.plan,
    startDate: subscription.startDate, recurringAmountMinor: subscription.recurringAmountMinor,
    currency: subscription.currency, cycle: subscription.cycle, customDays: subscription.customDays,
    nextBillingDate: subscription.nextBillingDate, reminderDays: subscription.reminderDays,
    status: subscription.status, website: subscription.website, note: subscription.note,
    createdAt: subscription.createdAt, updatedAt: subscription.updatedAt,
    deletedAt: subscription.deletedAt
  };
}

function paymentSnapshot(payment: SubscriptionPayment): Record<string, unknown> {
  return {
    id: payment.id, subscriptionId: payment.subscriptionId, amountMinor: payment.amountMinor,
    currency: payment.currency, localDate: payment.localDate, note: payment.note,
    paymentType: payment.paymentType, ledgerLink: payment.ledgerLink,
    refundedAt: payment.refundedAt,
    nextBillingDateBefore: payment.nextBillingDateBefore, nextBillingDateAfter: payment.nextBillingDateAfter,
    createdAt: payment.createdAt, updatedAt: payment.updatedAt,
    deletedAt: payment.deletedAt
  };
}
function accountSnapshot(account: Account): Record<string, unknown> {
  return {
    id: account.id, name: account.name, icon: account.icon, aliases: account.aliases,
    currency: account.currency,
    openingBalanceMinor: account.openingBalanceMinor, openedOn: account.openedOn,
    isArchived: account.isArchived, createdAt: account.createdAt, updatedAt: account.updatedAt
  };
}

function transferSnapshot(transfer: Transfer): Record<string, unknown> {
  return {
    id: transfer.id, fromAccountId: transfer.fromAccountId, toAccountId: transfer.toAccountId,
    debitedMinor: transfer.debitedMinor, creditedMinor: transfer.creditedMinor,
    feeTransactionId: transfer.feeTransactionId, localDate: transfer.localDate, note: transfer.note,
    createdAt: transfer.createdAt, updatedAt: transfer.updatedAt, deletedAt: transfer.deletedAt
  };
}

function adjustmentSnapshot(adjustment: AccountAdjustment): Record<string, unknown> {
  return {
    id: adjustment.id, accountId: adjustment.accountId, targetBalanceMinor: adjustment.targetBalanceMinor,
    deltaMinor: adjustment.deltaMinor, localDate: adjustment.localDate, note: adjustment.note,
    createdAt: adjustment.createdAt, updatedAt: adjustment.updatedAt
  };
}


export class OpenClawControlService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly repository: LedgerRepository,
    private readonly config?: AppConfig,
    private readonly budgets?: BudgetService,
    private readonly funds?: FundsService
  ) {}

  settings(): OpenClawControlSettings {
    const row = this.database.prepare("SELECT value, updated_at FROM settings WHERE key = 'openclaw.mode'")
      .get() as { value: OpenClawMode; updated_at: string } | undefined;
    return {
      mode: row?.value === "direct" ? "direct" : "confirm",
      directCapabilities: ["transactions", "transactionBatch", "categories", "budgets", "matters", "funds", "ai", "backup", "timezone", "undo"],
      credentialsExposed: false,
      updatedAt: row?.updated_at ?? new Date(0).toISOString()
    };
  }

  setMode(mode: OpenClawMode): OpenClawControlSettings {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES ('openclaw.mode', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(mode, now);
    this.repository.audit("user", "openclaw.mode.update", "settings", "openclaw.mode", { mode });
    return this.settings();
  }

  assertDirectMode(): void {
    if (this.settings().mode !== "direct") {
      throw new AppError("OpenClaw 直接操作模式尚未开启，请在网页中开启或改用提案工具", 403, "OPENCLAW_DIRECT_DISABLED");
    }
  }

  listOperations(limit = 50): OpenClawOperation[] {
    this.reconcileStaleRunningOperations();
    this.purgeExpiredOperations();
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.database.prepare("SELECT * FROM openclaw_operations WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?")
      .all(new Date().toISOString(), safeLimit) as unknown as OperationRow[];
    return rows.map(mapOperation);
  }

  reconcileStaleRunningOperations(maxAgeMs = 15 * 60 * 1000, now = new Date()): number {
    const failedAt = now.toISOString();
    const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
    const result = this.database.prepare(`UPDATE openclaw_operations
      SET status = 'failed', failed_at = ?, result_json = ?
      WHERE status = 'running' AND created_at <= ?`)
      .run(failedAt, JSON.stringify({ failureReason: "服务重启前未完成" }), cutoff);
    const count = Number(result.changes);
    if (count > 0) {
      this.repository.audit("system", "openclaw.interrupted", "openclaw_operation", null, { count });
    }
    return count;
  }

  purgeExpiredOperations(): number {
    const result = this.database.prepare(`DELETE FROM openclaw_operations
      WHERE status != 'running' AND expires_at <= ?`).run(new Date().toISOString());
    return Number(result.changes);
  }

  getOperation(id: string): OpenClawOperation {
    const row = this.database.prepare("SELECT * FROM openclaw_operations WHERE id = ?").get(id) as unknown as OperationRow | undefined;
    if (!row) throw new NotFoundError("OpenClaw 操作记录不存在");
    return mapOperation(row);
  }

  getOperationDetail(id: string): OpenClawOperationDetail {
    this.reconcileStaleRunningOperations();
    this.purgeExpiredOperations();
    const row = this.database.prepare("SELECT * FROM openclaw_operations WHERE id = ?")
      .get(id) as unknown as OperationRow | undefined;
    if (!row) throw new NotFoundError("OpenClaw 操作记录不存在");
    const items = this.database.prepare(`SELECT sequence, entity_type, entity_id, before_json, after_json
      FROM openclaw_operation_items WHERE operation_id = ? ORDER BY sequence`)
      .all(id) as unknown as OperationItemRow[];
    return {
      ...mapOperation(row),
      result: row.result_json ? JSON.parse(row.result_json) as unknown : null,
      items: items.map((item) => ({
        sequence: Number(item.sequence),
        entityType: item.entity_type,
        entityId: item.entity_id,
        before: item.before_json ? JSON.parse(item.before_json) as Record<string, unknown> : null,
        after: item.after_json ? JSON.parse(item.after_json) as Record<string, unknown> : null
      }))
    };
  }

  execute<T>(input: {
    requestId: string;
    action: string;
    entityType: string;
    summary: string;
    undoable?: boolean;
    request: unknown;
    run: () => { result: T; entityId?: string | null; snapshots?: SnapshotItem[] };
  }): OpenClawDirectResult<T> {
    this.assertDirectMode();
    this.purgeExpiredOperations();
    const normalizedRequestId = requestIdSchema.parse(input.requestId);
    const hash = hashOpenClawRequest(input.action, input.request);
    const existing = this.database.prepare("SELECT * FROM openclaw_operations WHERE request_id = ?")
      .get(normalizedRequestId) as unknown as OperationRow | undefined;
    if (existing) {
      if (existing.request_hash !== hash) throw new ConflictError("相同 requestId 已用于不同操作");
      if (existing.status === "running") throw new ConflictError("相同 requestId 的操作仍在处理中");
      if (existing.status === "failed") throw new ConflictError("相同 requestId 的操作此前失败，请使用新的 requestId 重试");
      if (!existing.result_json) throw new ConflictError("相同 requestId 的操作结果不完整");
      return { operation: mapOperation(existing), result: JSON.parse(existing.result_json) as T, duplicate: true };
    }

    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO openclaw_operations(
        id, request_id, request_hash, action, entity_type, entity_id, status, undoable,
        summary, result_json, created_at, expires_at, undone_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'running', ?, ?, NULL, ?, ?, NULL)`)
        .run(id, normalizedRequestId, hash, input.action, input.entityType, input.undoable === false ? 0 : 1, input.summary, now.toISOString(), expiresAt);
      const output = input.run();
      (output.snapshots ?? []).forEach((item, index) => {
        this.database.prepare(`INSERT INTO openclaw_operation_items(
          id, operation_id, sequence, entity_type, entity_id, before_json, after_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), id, index, item.entityType, item.entityId,
            item.before === null ? null : JSON.stringify(item.before),
            item.after === null ? null : JSON.stringify(item.after));
      });
      this.database.prepare(`UPDATE openclaw_operations SET entity_id = ?, status = 'applied', result_json = ? WHERE id = ?`)
        .run(output.entityId ?? null, JSON.stringify(output.result), id);
      this.repository.audit("openclaw", "openclaw.direct", input.entityType, output.entityId ?? null, { action: input.action, operationId: id });
      this.database.exec("COMMIT");
      return { operation: this.getOperation(id), result: output.result, duplicate: false };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async executeExternal<T>(input: {
    requestId: string;
    action: string;
    entityType: string;
    summary: string;
    request: unknown;
    cooldownMs?: number;
    maxPerWindow?: { count: number; windowMs: number };
    run: () => Promise<T>;
  }): Promise<OpenClawDirectResult<T>> {
    this.assertDirectMode();
    this.purgeExpiredOperations();
    const normalizedRequestId = requestIdSchema.parse(input.requestId);
    const hash = hashOpenClawRequest(input.action, input.request);
    const existing = this.database.prepare("SELECT * FROM openclaw_operations WHERE request_id = ?")
      .get(normalizedRequestId) as unknown as OperationRow | undefined;
    if (existing) {
      if (existing.request_hash !== hash) throw new ConflictError("相同 requestId 已用于不同操作");
      if (existing.status === "running") throw new ConflictError("相同 requestId 的操作仍在处理中");
      if (existing.status === "failed") throw new ConflictError("相同 requestId 的操作此前失败，请使用新的 requestId 重试");
      if (!existing.result_json) throw new ConflictError("相同 requestId 的操作结果不完整");
      return { operation: mapOperation(existing), result: JSON.parse(existing.result_json) as T, duplicate: true };
    }
    if (input.cooldownMs) {
      const cutoff = new Date(Date.now() - input.cooldownMs).toISOString();
      const recent = this.database.prepare(`SELECT 1 FROM openclaw_operations
        WHERE action = ? AND status = 'applied' AND created_at > ? LIMIT 1`).get(input.action, cutoff);
      if (recent) throw new AppError("这项操作刚刚执行过，请稍后再试", 429, "OPENCLAW_COOLDOWN");
    }
    if (input.maxPerWindow) {
      const cutoff = new Date(Date.now() - input.maxPerWindow.windowMs).toISOString();
      const row = this.database.prepare(`SELECT COUNT(*) AS count FROM openclaw_operations
        WHERE action = ? AND status IN ('running', 'applied') AND created_at > ?`).get(input.action, cutoff) as { count: number };
      if (Number(row.count) >= input.maxPerWindow.count) throw new AppError("这项操作请求过于频繁，请稍后再试", 429, "RATE_LIMITED");
    }
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.database.prepare(`INSERT INTO openclaw_operations(
      id, request_id, request_hash, action, entity_type, entity_id, status, undoable,
      summary, result_json, created_at, expires_at, undone_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'running', 0, ?, NULL, ?, ?, NULL)`)
      .run(id, normalizedRequestId, hash, input.action, input.entityType, input.summary, now.toISOString(), expiresAt);
    try {
      const result = await input.run();
      this.database.prepare("UPDATE openclaw_operations SET status = 'applied', result_json = ? WHERE id = ?")
        .run(JSON.stringify(result), id);
      this.repository.audit("openclaw", "openclaw.direct", input.entityType, null, { action: input.action, operationId: id });
      return { operation: this.getOperation(id), result, duplicate: false };
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.database.prepare(`UPDATE openclaw_operations
        SET status = 'failed', failed_at = ?, result_json = ? WHERE id = ? AND status = 'running'`)
        .run(failedAt, JSON.stringify({ failureReason: "外部操作执行失败" }), id);
      this.repository.audit("openclaw", "openclaw.failed", input.entityType, null, {
        action: input.action,
        operationId: id
      });
      throw error;
    }
  }

  transactionSnapshot(transaction: Transaction): Record<string, unknown> { return transactionSnapshot(transaction); }
  categorySnapshot(category: Category): Record<string, unknown> { return categorySnapshot(category); }
  proposalSnapshot(proposal: Proposal): Record<string, unknown> { return proposalSnapshot(proposal); }
  borrowerSnapshot(borrower: Borrower): Record<string, unknown> { return borrowerSnapshot(borrower); }
  loanSnapshot(loan: Loan): Record<string, unknown> { return loanSnapshot(loan); }
  repaymentSnapshot(repayment: LoanRepayment): Record<string, unknown> { return repaymentSnapshot(repayment); }
  subscriptionSnapshot(subscription: Subscription): Record<string, unknown> { return subscriptionSnapshot(subscription); }
  paymentSnapshot(payment: SubscriptionPayment): Record<string, unknown> { return paymentSnapshot(payment); }
  budgetSnapshot(month: string): BudgetSnapshot | null {
    if (!this.budgets) throw new ConflictError("预算服务尚未启用");
    return this.budgets.snapshot(month);
  }
  accountSnapshot(account: Account): Record<string, unknown> { return accountSnapshot(account); }
  transferSnapshot(transfer: Transfer): Record<string, unknown> { return transferSnapshot(transfer); }
  adjustmentSnapshot(adjustment: AccountAdjustment): Record<string, unknown> { return adjustmentSnapshot(adjustment); }
  settingSnapshot(key: string): Record<string, unknown> | null {
    const row = this.database.prepare("SELECT value, updated_at FROM settings WHERE key = ?").get(key) as { value: string; updated_at: string } | undefined;
    return row ? { value: row.value, updatedAt: row.updated_at } : null;
  }
  updateSetting(key: string, value: string): Record<string, unknown> {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, value, now);
    if (key === "timezone" && this.config) this.config.timezone = value;
    return { value, updatedAt: now };
  }

  undo(operationId: string, actor: "user" | "openclaw"): OpenClawOperation {
    const operationRow = this.database.prepare("SELECT * FROM openclaw_operations WHERE id = ?")
      .get(operationId) as unknown as OperationRow | undefined;
    if (!operationRow) throw new NotFoundError("OpenClaw 操作记录不存在");
    if (operationRow.status === "undone") return mapOperation(operationRow);
    if (operationRow.status === "failed") throw new ConflictError("这项操作已经失败，不能撤销");
    if (operationRow.status !== "applied") throw new ConflictError("这项操作尚未完成，不能撤销");
    if (!operationRow.undoable) throw new ConflictError("AI 分析和备份等操作不支持撤销");
    if (operationRow.expires_at <= new Date().toISOString()) throw new ConflictError("这项操作已经超过 30 天撤销期限");
    const items = this.database.prepare("SELECT * FROM openclaw_operation_items WHERE operation_id = ? ORDER BY sequence DESC")
      .all(operationId) as unknown as OperationItemRow[];
    if (items.length === 0) throw new ConflictError("这项操作没有可恢复内容");

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) this.restoreItem(item);
      this.funds?.reconcileAllSources(operationId);
      const now = new Date().toISOString();
      this.database.prepare("UPDATE openclaw_operations SET status = 'undone', undone_at = ? WHERE id = ? AND status = 'applied'")
        .run(now, operationId);
      this.repository.audit(actor, "openclaw.undo", operationRow.entity_type, operationRow.entity_id, { operationId, action: operationRow.action });
      this.database.exec("COMMIT");
      return this.getOperation(operationId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private restoreItem(item: OperationItemRow): void {
    const before = item.before_json ? JSON.parse(item.before_json) as Record<string, unknown> : null;
    const after = item.after_json ? JSON.parse(item.after_json) as Record<string, unknown> : null;
    if (item.entity_type === "transaction") return this.restoreTransactionSnapshot(item.entity_id, before, after);
    if (item.entity_type === "category") return this.restoreCategorySnapshot(item.entity_id, before, after);
    if (item.entity_type === "proposal") return this.restoreProposalSnapshot(item.entity_id, before, after);
    if (item.entity_type === "borrower") return this.restoreBorrowerSnapshot(item.entity_id, before, after);
    if (item.entity_type === "loan") return this.restoreLoanSnapshot(item.entity_id, before, after);
    if (item.entity_type === "loan_repayment") return this.restoreLoanRepaymentSnapshot(item.entity_id, before, after);
    if (item.entity_type === "subscription") return this.restoreSubscriptionSnapshot(item.entity_id, before, after);
    if (item.entity_type === "subscription_payment") return this.restoreSubscriptionPaymentSnapshot(item.entity_id, before, after);
    if (item.entity_type === "account") return this.restoreAccountSnapshot(item.entity_id, before, after);
    if (item.entity_type === "transfer") return this.restoreTransferSnapshot(item.entity_id, before, after);
    if (item.entity_type === "account_adjustment") return this.restoreAdjustmentSnapshot(item.entity_id, before, after);
    if (item.entity_type === "budget") {
      if (!this.budgets) throw new ConflictError("预算服务尚未启用");
      this.budgets.restoreSnapshot(
        item.entity_id,
        before as unknown as BudgetSnapshot | null,
        after as unknown as BudgetSnapshot | null
      );
      return;
    }
    this.restoreSettingSnapshot(item.entity_id, before, after);
  }

  private restoreAccountSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    if (!this.funds) throw new ConflictError("资金服务尚未启用");
    const current = this.funds.getAccount(id);
    if (!before && after) {
      if (current.updatedAt !== after.updatedAt) throw new ConflictError("账户后来已经改变，不能撤销创建");
      const defaults = this.funds.summary();
      if ([defaults.defaultExpenseAccountId, defaults.defaultIncomeAccountId].includes(id)) throw new ConflictError("账户已经成为默认账户，不能撤销创建");
      this.funds.assertAccountUnused(id);
      this.database.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      return;
    }
    if (!before || !after || current.updatedAt !== after.updatedAt) throw new ConflictError("账户后来已经改变，不能覆盖新内容");
    let restored = this.funds.updateAccount(id, {
      name: String(before.name),
      icon: String(before.icon),
      currency: before.currency === undefined ? current.currency : String(before.currency) as Account["currency"],
      aliases: Array.isArray(before.aliases) ? before.aliases.map(String) : [],
      expectedUpdatedAt: current.updatedAt
    });
    if (Boolean(before.isArchived) && !restored.isArchived) restored = this.funds.archiveAccount(id, { expectedUpdatedAt: restored.updatedAt });
    if (!before.isArchived && restored.isArchived) this.funds.restoreAccount(id, { expectedUpdatedAt: restored.updatedAt });
  }

  private restoreTransferSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    if (!this.funds) throw new ConflictError("资金服务尚未启用");
    if (before || !after) throw new ConflictError("转账恢复快照不完整");
    const current = this.funds.getTransfer(id);
    if (current.updatedAt !== after.updatedAt || current.deletedAt !== after.deletedAt) throw new ConflictError("转账后来已经改变，不能撤销");
    this.funds.deleteTransfer(id, { expectedUpdatedAt: current.updatedAt, requestId: `undo-transfer:${id}` });
  }

  private restoreAdjustmentSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    if (!this.funds) throw new ConflictError("资金服务尚未启用");
    if (before || !after) throw new ConflictError("校准恢复快照不完整");
    const current = this.database.prepare("SELECT updated_at FROM account_adjustments WHERE id = ?").get(id) as { updated_at: string } | undefined;
    if (!current || current.updated_at !== after.updatedAt) throw new ConflictError("余额校准后来已经改变，不能撤销");
    this.funds.undoAdjustment(id);
  }

  private restoreTransactionSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    if (!before && after) {
      const current = this.repository.getTransaction(id, true);
      if (current.updatedAt !== after.updatedAt || current.deletedAt !== after.deletedAt) throw new ConflictError("账目后来已经改变，不能覆盖新内容");
      const now = new Date().toISOString();
      this.database.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      return;
    }
    if (!before || !after) throw new ConflictError("账目恢复快照不完整");
    const current = this.repository.getTransaction(id, true);
    if (current.updatedAt !== after.updatedAt || current.deletedAt !== after.deletedAt) throw new ConflictError("账目后来已经改变，不能覆盖新内容");
    this.database.prepare(`UPDATE transactions SET kind = ?, amount_minor = ?, account_amount_minor = ?, category_id = ?, occurred_at = ?,
      local_date = ?, note = ?, source = ?, account_id = ?, refunded_at = ?, refund_account_id = ?, updated_at = ?, deleted_at = ? WHERE id = ?`)
      .run(sql(before.kind), sql(before.amountMinor), sql(snapshotField(before, "accountAmountMinor")), sql(before.categoryId), sql(before.localDate), sql(before.localDate), sql(before.note),
        sql(before.source), sql(before.accountId), sql(before.refundedAt), sql(before.refundAccountId), sql(before.updatedAt), sql(before.deletedAt), id);
  }

  private restoreCategorySnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    const currentRow = this.database.prepare("SELECT * FROM categories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!before && after) {
      if (!currentRow || currentRow.updated_at !== after.updatedAt) throw new ConflictError("分类后来已经改变，不能覆盖新内容");
      const used = this.database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id = ?").get(id) as { count: number };
      if (Number(used.count) > 0) throw new ConflictError("新分类已经被账目使用，不能撤销创建");
      const budgetUses = this.database.prepare("SELECT COUNT(*) AS count FROM category_monthly_budgets WHERE category_id = ?").get(id) as { count: number };
      if (Number(budgetUses.count) > 0) throw new ConflictError("新分类已经被预算使用，不能撤销创建");
      this.database.prepare("DELETE FROM categories WHERE id = ?").run(id);
      return;
    }
    if (!before) throw new ConflictError("分类恢复快照不完整");
    if (after && currentRow?.updated_at !== after.updatedAt) throw new ConflictError("分类后来已经改变，不能覆盖新内容");
    this.database.prepare(`INSERT INTO categories(id, kind, name, icon, color, sort_order, is_archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, color=excluded.color,
        sort_order=excluded.sort_order, is_archived=excluded.is_archived, updated_at=excluded.updated_at`)
      .run(id, sql(before.kind), sql(before.name), sql(before.icon), sql(before.color), sql(before.sortOrder),
        before.isArchived ? 1 : 0, sql(before.createdAt), sql(before.updatedAt));
  }

  private restoreProposalSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    if (!before || !after) throw new ConflictError("提案恢复快照不完整");
    const current = this.repository.getProposal(id);
    if (current.updatedAt !== after.updatedAt || current.revision !== after.revision) throw new ConflictError("提案后来已经改变，不能覆盖新内容");
    this.database.prepare(`UPDATE proposals SET payload = ?, status = ?, revision = ?, updated_at = ?, resolved_at = ? WHERE id = ?`)
      .run(JSON.stringify(before.payload), sql(before.status), sql(before.revision), sql(before.updatedAt), sql(before.resolvedAt), id);
  }

  /** Restore a matter row without going through the matter service.  Direct
   * matter operations already execute inside the same SQLite transaction as
   * the operation log, so using the small fixed SQL maps here keeps undo
   * atomic and avoids a second repository dependency. */
  private restoreMatterRecord(
    table: "borrowers" | "loans" | "loan_repayments" | "subscriptions" | "subscription_payments",
    id: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    columns: string[],
    values: MatterSnapshotValues
  ): void {
    const current = this.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as { updated_at?: string } | undefined;
    if (!before && after) {
      if (!current || current.updated_at !== after.updatedAt) throw new ConflictError("事项后来已经改变，不能撤销");
      this.database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      return;
    }
    if (!before) throw new ConflictError("事项恢复快照不完整");
    if (after && (!current || current.updated_at !== after.updatedAt)) {
      throw new ConflictError("事项后来已经改变，不能覆盖新内容");
    }
    const rowValues = values(before);
    if (!current) {
      this.database.prepare(`INSERT INTO ${table}(id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`)
        .run(id, ...rowValues);
      return;
    }
    this.database.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
      .run(...rowValues, id);
  }

  private restoreBorrowerSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    this.restoreMatterRecord("borrowers", id, before, after,
      ["name", "note", "is_archived", "created_at", "updated_at", "deleted_at"],
      (snapshot) => [sql(snapshotField(snapshot, "name")), sql(snapshotField(snapshot, "note")),
        sql(snapshotField(snapshot, "isArchived") ? 1 : 0), sql(snapshotField(snapshot, "createdAt")),
        sql(snapshotField(snapshot, "updatedAt")), sql(snapshotField(snapshot, "deletedAt"))]);
  }

  private restoreLoanSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    this.restoreMatterRecord("loans", id, before, after,
      ["borrower_id", "principal_minor", "local_date", "purpose", "note", "ledger_link_mode", "ledger_transaction_id", "account_id", "created_at", "updated_at", "deleted_at"],
      (snapshot) => {
        const [mode, transactionId] = ledgerLinkValues(snapshot);
        return [sql(snapshotField(snapshot, "borrowerId")), sql(snapshotField(snapshot, "principalMinor")),
          sql(snapshotField(snapshot, "localDate")), sql(snapshotField(snapshot, "purpose")), sql(snapshotField(snapshot, "note")),
          mode, transactionId, sql(snapshotField(snapshot, "accountId")), sql(snapshotField(snapshot, "createdAt")), sql(snapshotField(snapshot, "updatedAt")),
          sql(snapshotField(snapshot, "deletedAt"))];
      });
  }

  private restoreLoanRepaymentSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    this.restoreMatterRecord("loan_repayments", id, before, after,
      ["loan_id", "amount_minor", "local_date", "note", "ledger_link_mode", "ledger_transaction_id", "account_id", "created_at", "updated_at", "deleted_at"],
      (snapshot) => {
        const [mode, transactionId] = ledgerLinkValues(snapshot);
        return [sql(snapshotField(snapshot, "loanId")), sql(snapshotField(snapshot, "amountMinor")),
          sql(snapshotField(snapshot, "localDate")), sql(snapshotField(snapshot, "note")), mode, transactionId, sql(snapshotField(snapshot, "accountId")),
          sql(snapshotField(snapshot, "createdAt")), sql(snapshotField(snapshot, "updatedAt")), sql(snapshotField(snapshot, "deletedAt"))];
      });
  }

  private restoreSubscriptionSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    this.restoreMatterRecord("subscriptions", id, before, after,
      ["name", "plan", "start_date", "recurring_amount_minor", "currency", "cycle", "custom_days", "next_billing_date", "reminder_days", "status", "website", "note", "created_at", "updated_at", "deleted_at"],
      (snapshot) => [sql(snapshotField(snapshot, "name")), sql(snapshotField(snapshot, "plan")), sql(snapshotField(snapshot, "startDate")),
        sql(snapshotField(snapshot, "recurringAmountMinor")), sql(snapshotField(snapshot, "currency")), sql(snapshotField(snapshot, "cycle")),
        sql(snapshotField(snapshot, "customDays")), sql(snapshotField(snapshot, "nextBillingDate")), sql(snapshotField(snapshot, "reminderDays")),
        sql(snapshotField(snapshot, "status")), sql(snapshotField(snapshot, "website")), sql(snapshotField(snapshot, "note")),
        sql(snapshotField(snapshot, "createdAt")), sql(snapshotField(snapshot, "updatedAt")), sql(snapshotField(snapshot, "deletedAt"))]);
  }

  private restoreSubscriptionPaymentSnapshot(id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    this.restoreMatterRecord("subscription_payments", id, before, after,
      ["subscription_id", "amount_minor", "currency", "local_date", "note", "payment_type", "ledger_link_mode", "ledger_transaction_id", "next_billing_date_before", "next_billing_date_after", "refunded_at", "created_at", "updated_at", "deleted_at"],
      (snapshot) => {
        const [mode, transactionId] = ledgerLinkValues(snapshot);
        return [sql(snapshotField(snapshot, "subscriptionId")), sql(snapshotField(snapshot, "amountMinor")), sql(snapshotField(snapshot, "currency")),
          sql(snapshotField(snapshot, "localDate")), sql(snapshotField(snapshot, "note")), sql(snapshotField(snapshot, "paymentType")),
          mode, transactionId, sql(snapshotField(snapshot, "nextBillingDateBefore")), sql(snapshotField(snapshot, "nextBillingDateAfter")),
          sql(snapshotField(snapshot, "refundedAt")), sql(snapshotField(snapshot, "createdAt")), sql(snapshotField(snapshot, "updatedAt")), sql(snapshotField(snapshot, "deletedAt"))];
      });
  }

  private restoreSettingSnapshot(key: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    const current = this.database.prepare("SELECT value, updated_at FROM settings WHERE key = ?").get(key) as { value: string; updated_at: string } | undefined;
    if (after && (!current || current.updated_at !== after.updatedAt || current.value !== after.value)) throw new ConflictError("设置后来已经改变，不能覆盖新内容");
    if (!before) this.database.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, sql(before.value), sql(before.updatedAt));
    if (key === "timezone" && this.config && before) this.config.timezone = String(before.value);
  }
}
