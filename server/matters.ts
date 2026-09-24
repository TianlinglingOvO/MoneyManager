import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Express, Request, Response, NextFunction } from "express";
import type {
  Borrower,
  LedgerLink,
  Loan,
  LoanRepayment,
  LoanSummary,
  MatterCurrency,
  Plan,
  PlanAttentionState,
  PlanSummary,
  Subscription,
  SubscriptionPayment,
  SubscriptionSummary
} from "../shared/types";
import {
  borrowerInputSchema,
  borrowerPatchSchema,
  ledgerLinkInputSchema,
  loanCreateInputSchema,
  loanInputSchema,
  loanPatchSchema,
  matterDeleteSchema,
  matterQuerySchema,
  planCompleteSchema,
  planInputSchema,
  planPatchSchema,
  planQuerySchema,
  repaymentInputSchema,
  repaymentPatchSchema,
  subscriptionInputSchema,
  subscriptionPatchSchema,
  subscriptionPaymentInputSchema,
  subscriptionPaymentPatchSchema
} from "../shared/schemas";
import type { FundsService } from "./funds";
import { ConflictError, NotFoundError } from "./errors";
import { LedgerRepository } from "./repository";

type BorrowerInput = z.infer<typeof borrowerInputSchema>;
type BorrowerPatch = z.infer<typeof borrowerPatchSchema>;
type MatterQuery = z.infer<typeof matterQuerySchema>;
type LoanInput = z.infer<typeof loanInputSchema>;
type LoanCreateInput = z.infer<typeof loanCreateInputSchema>;
type LoanPatch = z.infer<typeof loanPatchSchema>;
type RepaymentInput = z.infer<typeof repaymentInputSchema>;
type RepaymentPatch = z.infer<typeof repaymentPatchSchema>;
type SubscriptionInput = z.infer<typeof subscriptionInputSchema>;
type SubscriptionPatch = z.infer<typeof subscriptionPatchSchema>;
type PaymentInput = z.infer<typeof subscriptionPaymentInputSchema>;
type PaymentPatch = z.infer<typeof subscriptionPaymentPatchSchema>;
type PlanInput = z.input<typeof planInputSchema>;
type PlanPatch = z.input<typeof planPatchSchema>;
type PlanCompleteInput = z.input<typeof planCompleteSchema>;
type PlanQuery = z.input<typeof planQuerySchema>;
type LinkInput = z.infer<typeof ledgerLinkInputSchema>;

type Actor = "user" | "openclaw" | "system";
type IdempotencyOptions = { idempotencyKey?: string | null; actor?: Actor };
type SqlValue = string | number | null;

interface BorrowerRow {
  id: string;
  name: string;
  note: string | null;
  is_archived: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  total_lent_minor?: number;
  total_repaid_minor?: number;
  outstanding_minor?: number;
}

interface LoanRow {
  id: string;
  borrower_id: string;
  borrower_name?: string;
  principal_minor: number;
  local_date: string;
  purpose: string | null;
  note: string | null;
  ledger_link_mode: "none" | "existing" | "create";
  ledger_transaction_id: string | null;
  created_at: string;
  account_id: string | null;
  updated_at: string;
  deleted_at: string | null;
  repaid_minor?: number;
}

interface RepaymentRow {
  id: string;
  loan_id: string;
  amount_minor: number;
  local_date: string;
  note: string | null;
  ledger_link_mode: "none" | "existing" | "create";
  ledger_transaction_id: string | null;
  created_at: string;
  account_id: string | null;
  updated_at: string;
  deleted_at: string | null;
}

interface SubscriptionRow {
  id: string;
  name: string;
  plan: string | null;
  start_date: string;
  recurring_amount_minor: number;
  currency: MatterCurrency;
  cycle: "month" | "year" | "custom";
  custom_days: number | null;
  next_billing_date: string | null;
  reminder_days: number;
  status: "active" | "paused" | "cancelled";
  website: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface PlanRow {
  id: string;
  title: string;
  amount_minor: number | null;
  due_date: string | null;
  reminder_days: number;
  status: "open" | "completed" | "cancelled";
  note: string | null;
  completed_at: string | null;
  ledger_link_mode: "none" | "existing" | "create";
  ledger_transaction_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface PaymentRow {
  id: string;
  subscription_id: string;
  amount_minor: number;
  currency: MatterCurrency;
  local_date: string;
  note: string | null;
  payment_type: "initial" | "renewal" | "manual";
  ledger_link_mode: "none" | "existing" | "create";
  ledger_transaction_id: string | null;
  refunded_at: string | null;
  next_billing_date_before: string | null;
  next_billing_date_after: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addBillingPeriod(date: string, cycle: "month" | "year" | "custom", customDays: number | null, anchorDay: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (cycle === "custom") {
    const next = new Date(Date.UTC(year, month - 1, day));
    next.setUTCDate(next.getUTCDate() + (customDays ?? 1));
    return next.toISOString().slice(0, 10);
  }
  const monthOffset = cycle === "year" ? 12 : 1;
  const targetMonth = month - 1 + monthOffset;
  const targetYear = year + Math.floor(targetMonth / 12);
  const targetMonthIndex = ((targetMonth % 12) + 12) % 12;
  const targetDay = Math.min(anchorDay, daysInMonth(targetYear, targetMonthIndex));
  return `${targetYear.toString().padStart(4, "0")}-${(targetMonthIndex + 1).toString().padStart(2, "0")}-${targetDay.toString().padStart(2, "0")}`;
}

function mapLink(mode: "none" | "existing" | "create", transactionId: string | null, amountMinor: number | null, currency: MatterCurrency, accountAmountMinor: number | null = null): LedgerLink {
  return { mode, transactionId, amountMinor: amountMinor == null ? null : Number(amountMinor), accountAmountMinor, currency };
}

export class MattersRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly ledger: LedgerRepository,
    private readonly timezone = "Asia/Shanghai",
    private readonly funds: FundsService | null = null
  ) {}

  private transaction<T>(work: () => T): T {
    const savepoint = `matter_${randomUUID().replaceAll("-", "")}`;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = work();
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  private executeIdempotent<T>(options: IdempotencyOptions, operation: string, request: unknown, work: () => T): T {
    const key = options.idempotencyKey?.trim() || null;
    if (!key) return this.transaction(work);
    if (key.length > 128) throw new ConflictError("幂等键过长");
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.database.prepare("SELECT operation, request_hash, result_json FROM matter_idempotency WHERE idempotency_key = ?")
      .get(key) as { operation: string; request_hash: string; result_json: string } | undefined;
    if (existing) {
      if (existing.operation !== operation || existing.request_hash !== hash) throw new ConflictError("幂等键已经用于其他请求");
      return JSON.parse(existing.result_json) as T;
    }
    return this.transaction(() => {
      const race = this.database.prepare("SELECT operation, request_hash, result_json FROM matter_idempotency WHERE idempotency_key = ?")
        .get(key) as { operation: string; request_hash: string; result_json: string } | undefined;
      if (race) {
        if (race.operation !== operation || race.request_hash !== hash) throw new ConflictError("幂等键已经用于其他请求");
        return JSON.parse(race.result_json) as T;
      }
      const result = work();
      this.database.prepare("INSERT INTO matter_idempotency(idempotency_key, operation, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(key, operation, hash, JSON.stringify(result), new Date().toISOString());
      return result;
    });
  }

  private audit(actor: Actor, action: string, entity: string, entityId: string | null, fields?: string[]): void {
    this.ledger.audit(actor, action, entity, entityId, fields ? { changedFields: fields } : undefined);
  }

  private assertExpected(current: string, expected?: string | null): void {
    if (expected && current !== expected) throw new ConflictError("记录已经更新，请刷新后重试");
  }

  private getLedgerLinkTransaction(link: LinkInput | undefined, expectedKind: "expense" | "income", amountMinor: number, currency: MatterCurrency, localDate: string, note: string | null = null): { mode: "none" | "existing" | "create"; transactionId: string | null; amountMinor: number | null } {
    const input = ledgerLinkInputSchema.parse(link ?? { mode: "none" });
    if (input.mode === "none") return { mode: "none", transactionId: null, amountMinor: null };
    if (input.mode === "existing") {
      const transaction = this.ledger.getTransaction(input.transactionId!, false);
      if (transaction.kind !== expectedKind) throw new ConflictError("关联账目的收支类型不正确");
      if (currency === "CNY" && transaction.amountMinor !== amountMinor) throw new ConflictError("关联账目金额必须与事项金额一致");
      this.assertLedgerTransactionUnused(input.transactionId!);
      return { mode: "existing", transactionId: input.transactionId!, amountMinor: transaction.amountMinor };
    }
    const ledgerAmount = currency === "CNY" ? amountMinor : input.ledgerAmountMinor;
    let accountAmountMinor = input.accountAmountMinor;
    if (input.accountId && this.funds) {
      const account = this.funds.getAccount(input.accountId, false);
      if (account.currency === "CNY") accountAmountMinor = undefined;
      else if (account.currency === "USD" && currency === "USD" && accountAmountMinor === undefined) accountAmountMinor = amountMinor;
    }
    if (!ledgerAmount) throw new ConflictError("美元事项创建账目时必须填写实际人民币金额");
    const transaction = this.ledger.createTransaction({
      kind: expectedKind,
      amountMinor: ledgerAmount,
      categoryId: input.categoryId!,
      localDate,
      note,
      accountId: input.accountId,
      accountAmountMinor
    }, { source: "user", actor: "user", idempotencyKey: `matter-ledger:${randomUUID()}` });
    return { mode: "create", transactionId: transaction.id, amountMinor: transaction.amountMinor };
  }

  private assertLedgerTransactionUnused(transactionId: string): void {
    const row = this.database.prepare(`SELECT 1 AS value FROM loans WHERE ledger_transaction_id = ?
      UNION ALL SELECT 1 FROM loan_repayments WHERE ledger_transaction_id = ?
      UNION ALL SELECT 1 FROM subscription_payments WHERE ledger_transaction_id = ?
      UNION ALL SELECT 1 FROM plans WHERE ledger_transaction_id = ? LIMIT 1`).get(transactionId, transactionId, transactionId, transactionId);
    if (row) throw new ConflictError("这个账目已经关联了其他财务事项");
  }

  private borrowerFromRow(row: BorrowerRow): Borrower {
    const totalLent = Number(row.total_lent_minor ?? 0);
    const totalRepaid = Number(row.total_repaid_minor ?? 0);
    return {
      id: row.id,
      name: row.name,
      note: row.note,
      isArchived: Boolean(row.is_archived),
      totalLentMinor: totalLent,
      totalRepaidMinor: totalRepaid,
      outstandingMinor: Math.max(0, totalLent - totalRepaid),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  private borrowerSelect = `SELECT b.*,
    COALESCE((SELECT SUM(l.principal_minor) FROM loans l WHERE l.borrower_id = b.id AND l.deleted_at IS NULL), 0) AS total_lent_minor,
    COALESCE((SELECT SUM(r.amount_minor) FROM loan_repayments r JOIN loans l ON l.id = r.loan_id WHERE l.borrower_id = b.id AND l.deleted_at IS NULL AND r.deleted_at IS NULL), 0) AS total_repaid_minor
    FROM borrowers b`;

  listBorrowers(rawQuery: Partial<MatterQuery> = {}): { items: Borrower[]; total: number; page: number; pageSize: number } {
    const query = matterQuerySchema.parse(rawQuery);
    this.purgeExpiredTrash();
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (query.status === "active") clauses.push("b.deleted_at IS NULL");
    if (query.status === "trash") clauses.push("b.deleted_at IS NOT NULL");
    if (query.search) { clauses.push("(b.name LIKE ? ESCAPE '\\' OR COALESCE(b.note, '') LIKE ? ESCAPE '\\')"); const term = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`; values.push(term, term); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = this.database.prepare(`SELECT COUNT(*) AS count FROM borrowers b ${where}`).get(...values) as { count: number };
    const rows = this.database.prepare(`${this.borrowerSelect} ${where} ORDER BY b.is_archived, b.name LIMIT ? OFFSET ?`)
      .all(...values, query.pageSize, (query.page - 1) * query.pageSize) as unknown as BorrowerRow[];
    return { items: rows.map((row) => this.borrowerFromRow(row)), total: Number(count.count), page: query.page, pageSize: query.pageSize };
  }

  getBorrower(id: string, includeDeleted = true): Borrower {
    const where = includeDeleted ? "" : " AND b.deleted_at IS NULL";
    const row = this.database.prepare(`${this.borrowerSelect} WHERE b.id = ?${where}`).get(id) as unknown as BorrowerRow | undefined;
    if (!row) throw new NotFoundError("借款人不存在");
    return this.borrowerFromRow(row);
  }

  createBorrower(rawInput: BorrowerInput, options: IdempotencyOptions = {}): Borrower {
    const input = borrowerInputSchema.parse(rawInput);
    return this.executeIdempotent(options, "borrower.create", input, () => {
      const duplicate = this.database.prepare("SELECT id FROM borrowers WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL").get(input.name);
      if (duplicate) throw new ConflictError("已经有同名借款人");
      const now = new Date().toISOString();
      const id = randomUUID();
      this.database.prepare("INSERT INTO borrowers(id, name, note, is_archived, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 0, ?, ?, NULL)")
        .run(id, input.name, input.note?.trim() || null, now, now);
      this.audit(options.actor ?? "user", "borrower.create", "borrower", id);
      return this.getBorrower(id);
    });
  }

  updateBorrower(id: string, rawPatch: BorrowerPatch, options: IdempotencyOptions = {}): Borrower {
    const input = borrowerPatchSchema.parse(rawPatch);
    const current = this.getBorrower(id, false);
    this.assertExpected(current.updatedAt, input.expectedUpdatedAt);
    return this.executeIdempotent(options, "borrower.update", { id, input }, () => {
      if (input.name && input.name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
        const duplicate = this.database.prepare("SELECT id FROM borrowers WHERE name = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL").get(input.name, id);
        if (duplicate) throw new ConflictError("已经有同名借款人");
      }
      const now = new Date().toISOString();
      this.database.prepare("UPDATE borrowers SET name = ?, note = ?, is_archived = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(input.name ?? current.name, input.note === undefined ? current.note : input.note?.trim() || null, input.isArchived === undefined ? (current.isArchived ? 1 : 0) : (input.isArchived ? 1 : 0), now, id);
      this.audit(options.actor ?? "user", "borrower.update", "borrower", id, Object.keys(input).filter((key) => key !== "expectedUpdatedAt"));
      return this.getBorrower(id);
    });
  }

  deleteBorrower(id: string, options: IdempotencyOptions = {}, expectedUpdatedAt?: string): Borrower {
    const current = this.getBorrower(id, false);
    this.assertExpected(current.updatedAt, expectedUpdatedAt);
    return this.executeIdempotent(options, "borrower.delete", { id, expectedUpdatedAt }, () => {
      const activeLoans = this.database.prepare("SELECT COUNT(*) AS count FROM loans WHERE borrower_id = ? AND deleted_at IS NULL").get(id) as { count: number };
      if (Number(activeLoans.count) > 0) throw new ConflictError("这个借款人还有未删除的借款，不能删除");
      const now = new Date().toISOString();
      this.database.prepare("UPDATE borrowers SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
      this.audit(options.actor ?? "user", "borrower.delete", "borrower", id);
      return this.getBorrower(id);
    });
  }

  restoreBorrower(id: string, options: IdempotencyOptions = {}): Borrower {
    return this.executeIdempotent(options, "borrower.restore", { id }, () => {
      const current = this.getBorrower(id, true);
      if (!current.deletedAt) return current;
      const now = new Date().toISOString();
      this.database.prepare("UPDATE borrowers SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      this.audit(options.actor ?? "user", "borrower.restore", "borrower", id);
      return this.getBorrower(id);
    });
  }

  private repaymentFromRow(row: RepaymentRow, currency: MatterCurrency = "CNY"): LoanRepayment {
    return {
      id: row.id,
      loanId: row.loan_id,
      amountMinor: Number(row.amount_minor),
      localDate: row.local_date,
      note: row.note,
      ledgerLink: mapLink(row.ledger_link_mode, row.ledger_transaction_id, null, currency),
      accountId: row.account_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  private loanFromRow(row: LoanRow, includeDeleted = false): Loan {
    const clauses = includeDeleted ? "" : " AND deleted_at IS NULL";
    const repaymentRows = this.database.prepare(`SELECT * FROM loan_repayments WHERE loan_id = ?${clauses} ORDER BY local_date DESC, created_at DESC`)
      .all(row.id) as unknown as RepaymentRow[];
    const repaid = Number(row.repaid_minor ?? repaymentRows.reduce((sum, item) => sum + Number(item.amount_minor), 0));
    return {
      id: row.id,
      borrowerId: row.borrower_id,
      borrowerName: row.borrower_name,
      principalMinor: Number(row.principal_minor),
      amountMinor: Number(row.principal_minor),
      repaidMinor: repaid,
      outstandingMinor: Math.max(0, Number(row.principal_minor) - repaid),
      localDate: row.local_date,
      lentDate: row.local_date,
      purpose: row.purpose,
      note: row.note,
      status: repaid >= Number(row.principal_minor) ? "settled" : "active",
      ledgerLink: mapLink(row.ledger_link_mode, row.ledger_transaction_id, Number(row.principal_minor), "CNY"),
      accountId: row.account_id,
      repayments: repaymentRows.map((item) => this.repaymentFromRow(item)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  private loanSelect = `SELECT l.*, b.name AS borrower_name,
    COALESCE((SELECT SUM(r.amount_minor) FROM loan_repayments r WHERE r.loan_id = l.id AND r.deleted_at IS NULL), 0) AS repaid_minor
    FROM loans l JOIN borrowers b ON b.id = l.borrower_id`;

  listLoans(rawQuery: Partial<MatterQuery> & { borrowerId?: string; loanStatus?: "active" | "settled" } = {}): { items: Loan[]; total: number; page: number; pageSize: number } {
    const query = matterQuerySchema.parse(rawQuery);
    this.purgeExpiredTrash();
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (query.status === "active") clauses.push("l.deleted_at IS NULL");
    if (query.status === "trash") clauses.push("l.deleted_at IS NOT NULL");
    if (rawQuery.borrowerId) { clauses.push("l.borrower_id = ?"); values.push(rawQuery.borrowerId); }
    if (rawQuery.loanStatus === "active") clauses.push("l.principal_minor > COALESCE((SELECT SUM(rs.amount_minor) FROM loan_repayments rs WHERE rs.loan_id = l.id AND rs.deleted_at IS NULL), 0)");
    if (rawQuery.loanStatus === "settled") clauses.push("l.principal_minor <= COALESCE((SELECT SUM(rs.amount_minor) FROM loan_repayments rs WHERE rs.loan_id = l.id AND rs.deleted_at IS NULL), 0)");
    if (query.search) { clauses.push("(b.name LIKE ? ESCAPE '\\' OR COALESCE(l.purpose, '') LIKE ? ESCAPE '\\' OR COALESCE(l.note, '') LIKE ? ESCAPE '\\')"); const term = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`; values.push(term, term, term); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = this.database.prepare(`SELECT COUNT(*) AS count FROM loans l JOIN borrowers b ON b.id = l.borrower_id ${where}`).get(...values) as { count: number };
    const rows = this.database.prepare(`${this.loanSelect} ${where} ORDER BY l.local_date DESC, l.created_at DESC LIMIT ? OFFSET ?`)
      .all(...values, query.pageSize, (query.page - 1) * query.pageSize) as unknown as LoanRow[];
    return { items: rows.map((row) => this.loanFromRow(row, query.status !== "active")), total: Number(count.count), page: query.page, pageSize: query.pageSize };
  }

  getLoan(id: string, includeDeleted = true): Loan {
    const deleted = includeDeleted ? "" : " AND l.deleted_at IS NULL";
    const row = this.database.prepare(`${this.loanSelect} WHERE l.id = ?${deleted}`).get(id) as unknown as LoanRow | undefined;
    if (!row) throw new NotFoundError("借款不存在");
    return this.loanFromRow(row, includeDeleted);
  }

  private resolveMatterAccount(kind: "expense" | "income", localDate: string, requested?: string | null): string | null {
    return this.funds ? this.funds.resolveTransactionAccount(kind, localDate, requested) : requested ?? null;
  }

  private reconcileLoanFunds(id: string, requestId?: string | null): void {
    if (!this.funds) return;
    const row = this.database.prepare("SELECT id, principal_minor, local_date, account_id, deleted_at FROM loans WHERE id = ?").get(id) as {
      id: string; principal_minor: number; local_date: string; account_id: string | null; deleted_at: string | null;
    } | undefined;
    if (!row) {
      this.funds.reconcileSource("loan", id, new Map(), todayInTimezone(this.timezone), requestId);
      return;
    }
    const startedOn = this.funds.startedOn();
    const active = !row.deleted_at && Boolean(startedOn) && row.local_date >= startedOn!;
    this.funds.reconcileSource(
      "loan",
      id,
      this.funds.desiredLoanImpact(row.account_id, Number(row.principal_minor), active),
      row.local_date,
      requestId
    );
    const repaymentRows = this.database.prepare("SELECT id FROM loan_repayments WHERE loan_id = ?").all(id) as unknown as Array<{ id: string }>;
    repaymentRows.forEach((repayment) => this.reconcileRepaymentFunds(repayment.id, requestId));
  }

  private reconcileRepaymentFunds(id: string, requestId?: string | null): void {
    if (!this.funds) return;
    const row = this.database.prepare(`SELECT r.id, r.amount_minor, r.local_date, r.account_id, r.deleted_at, l.deleted_at AS loan_deleted_at
      FROM loan_repayments r JOIN loans l ON l.id = r.loan_id WHERE r.id = ?`).get(id) as {
        id: string; amount_minor: number; local_date: string; account_id: string | null;
        deleted_at: string | null; loan_deleted_at: string | null;
      } | undefined;
    if (!row) {
      this.funds.reconcileSource("loan_repayment", id, new Map(), todayInTimezone(this.timezone), requestId);
      return;
    }
    const startedOn = this.funds.startedOn();
    const active = !row.deleted_at && !row.loan_deleted_at && Boolean(startedOn) && row.local_date >= startedOn!;
    this.funds.reconcileSource(
      "loan_repayment",
      id,
      this.funds.desiredRepaymentImpact(row.account_id, Number(row.amount_minor), active),
      row.local_date,
      requestId
    );
  }

  createLoan(rawInput: LoanInput, options: IdempotencyOptions = {}): Loan {
    const input = loanInputSchema.parse(rawInput);
    return this.executeIdempotent(options, "loan.create", input, () => {
      const borrower = this.getBorrower(input.borrowerId, false);
      if (borrower.isArchived) throw new ConflictError("停用的借款人不能新增借款");
      const accountId = this.resolveMatterAccount("expense", input.localDate, input.accountId);
      if (accountId && input.ledgerLink?.mode && input.ledgerLink.mode !== "none") {
        throw new ConflictError("启用资金追踪后的借款不能再创建普通支出账目");
      }
      const link = accountId
        ? { mode: "none" as const, transactionId: null, amountMinor: null }
        : this.getLedgerLinkTransaction(input.ledgerLink, "expense", input.principalMinor, "CNY", input.localDate);
      const now = new Date().toISOString();
      const id = randomUUID();
      this.database.prepare(`INSERT INTO loans(
        id, borrower_id, principal_minor, local_date, purpose, note, ledger_link_mode,
        ledger_transaction_id, account_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        id, input.borrowerId, input.principalMinor, input.localDate, input.purpose?.trim() || null,
        input.note?.trim() || null, link.mode, link.transactionId, accountId, now, now
      );
      this.reconcileLoanFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.create", "loan", id, ["borrowerId", "principalMinor", "localDate", "purpose", "note", "ledgerLink", "accountId"]);
      return this.getLoan(id);
    });
  }

  createLoanForBorrowerSelection(rawInput: LoanCreateInput, options: IdempotencyOptions = {}): Loan {
    const input = loanCreateInputSchema.parse(rawInput);
    return this.executeIdempotent(options, "loan.create", input, () => {
      let borrower: Borrower;
      if (input.borrowerId) {
        borrower = this.getBorrower(input.borrowerId, false);
      } else {
        const normalizedName = input.newBorrowerName!.trim().replace(/\s+/g, " ");
        const existing = this.database.prepare("SELECT id FROM borrowers WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL")
          .get(normalizedName) as { id: string } | undefined;
        if (existing) {
          borrower = this.getBorrower(existing.id, false);
        } else {
          const now = new Date().toISOString();
          const id = randomUUID();
          this.database.prepare("INSERT INTO borrowers(id, name, note, is_archived, created_at, updated_at, deleted_at) VALUES (?, ?, NULL, 0, ?, ?, NULL)")
            .run(id, normalizedName, now, now);
          this.audit(options.actor ?? "user", "borrower.create", "borrower", id, ["name"]);
          borrower = this.getBorrower(id, false);
        }
      }
      if (borrower.isArchived) throw new ConflictError("同名借款人已停用，请先恢复后再选择");
      const accountId = this.resolveMatterAccount("expense", input.localDate, input.accountId);
      if (accountId && input.ledgerLink?.mode && input.ledgerLink.mode !== "none") {
        throw new ConflictError("启用资金追踪后的借款不能再创建普通支出账目");
      }
      const link = accountId
        ? { mode: "none" as const, transactionId: null, amountMinor: null }
        : this.getLedgerLinkTransaction(input.ledgerLink, "expense", input.principalMinor, "CNY", input.localDate);
      const now = new Date().toISOString();
      const id = randomUUID();
      this.database.prepare(`INSERT INTO loans(
        id, borrower_id, principal_minor, local_date, purpose, note, ledger_link_mode,
        ledger_transaction_id, account_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        id, borrower.id, input.principalMinor, input.localDate, input.purpose?.trim() || null,
        input.note?.trim() || null, link.mode, link.transactionId, accountId, now, now
      );
      this.reconcileLoanFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.create", "loan", id, ["borrowerId", "principalMinor", "localDate", "purpose", "note", "ledgerLink", "accountId"]);
      return this.getLoan(id);
    });
  }
  updateLoan(id: string, rawPatch: LoanPatch, options: IdempotencyOptions = {}): Loan {
    const input = loanPatchSchema.parse(rawPatch);
    const current = this.getLoan(id, false);
    this.assertExpected(current.updatedAt, input.expectedUpdatedAt);
    return this.executeIdempotent(options, "loan.update", { id, input }, () => {
      const principal = input.principalMinor ?? current.principalMinor;
      if (principal < current.repaidMinor) throw new ConflictError("借款本金不能低于已经归还的金额");
      const localDate = input.localDate ?? current.localDate;
      const accountId = this.resolveMatterAccount("expense", localDate, input.accountId === undefined ? current.accountId : input.accountId);
      if (accountId && current.ledgerLink.mode !== "none") throw new ConflictError("关联普通账目的旧借款不能直接改为资金账户");
      const now = new Date().toISOString();
      this.database.prepare("UPDATE loans SET principal_minor = ?, local_date = ?, purpose = ?, note = ?, account_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(
          principal,
          localDate,
          input.purpose === undefined ? current.purpose : input.purpose?.trim() || null,
          input.note === undefined ? current.note : input.note?.trim() || null,
          accountId,
          now,
          id
        );
      this.reconcileLoanFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.update", "loan", id, Object.keys(input).filter((key) => key !== "expectedUpdatedAt"));
      return this.getLoan(id);
    });
  }

  deleteLoan(id: string, options: IdempotencyOptions = {}, expectedUpdatedAt?: string): Loan {
    const current = this.getLoan(id, false);
    this.assertExpected(current.updatedAt, expectedUpdatedAt);
    return this.executeIdempotent(options, "loan.delete", { id, expectedUpdatedAt }, () => {
      const now = new Date().toISOString();
      this.database.prepare("UPDATE loans SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
      this.reconcileLoanFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.delete", "loan", id);
      return this.getLoan(id);
    });
  }

  restoreLoan(id: string, options: IdempotencyOptions = {}): Loan {
    return this.executeIdempotent(options, "loan.restore", { id }, () => {
      const current = this.getLoan(id, true);
      if (!current.deletedAt) return current;
      const borrower = this.getBorrower(current.borrowerId, false);
      if (borrower.isArchived) throw new ConflictError("请先恢复这位借款人");
      if (current.accountId) this.funds?.restoreHistoricalAccount(current.accountId);
      const now = new Date().toISOString();
      this.database.prepare("UPDATE loans SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      this.reconcileLoanFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.restore", "loan", id);
      return this.getLoan(id);
    });
  }
  listRepayments(loanId: string, includeDeleted = false): LoanRepayment[] {
    const loan = this.getLoan(loanId, includeDeleted);
    return loan.repayments;
  }

  createRepayment(loanId: string, rawInput: RepaymentInput, options: IdempotencyOptions = {}): LoanRepayment {
    const input = repaymentInputSchema.parse(rawInput);
    return this.executeIdempotent(options, "loan.repayment.create", { loanId, input }, () => {
      const loan = this.getLoan(loanId, false);
      if (input.amountMinor > loan.outstandingMinor) throw new ConflictError("还款金额不能超过剩余未还金额");
      const accountId = this.resolveMatterAccount("income", input.localDate, input.accountId);
      if (accountId && input.ledgerLink?.mode && input.ledgerLink.mode !== "none") {
        throw new ConflictError("启用资金追踪后的还款不能再创建普通收入账目");
      }
      const link = accountId
        ? { mode: "none" as const, transactionId: null, amountMinor: null }
        : this.getLedgerLinkTransaction(input.ledgerLink, "income", input.amountMinor, "CNY", input.localDate);
      const now = new Date().toISOString();
      const id = randomUUID();
      this.database.prepare(`INSERT INTO loan_repayments(
        id, loan_id, amount_minor, local_date, note, ledger_link_mode, ledger_transaction_id,
        account_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        id, loanId, input.amountMinor, input.localDate, input.note?.trim() || null,
        link.mode, link.transactionId, accountId, now, now
      );
      this.database.prepare("UPDATE loans SET updated_at = ? WHERE id = ?").run(now, loanId);
      this.reconcileRepaymentFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.repayment.create", "loan_repayment", id, ["amountMinor", "localDate", "note", "ledgerLink", "accountId"]);
      return this.getRepayment(id);
    });
  }

  getRepayment(id: string, includeDeleted = true): LoanRepayment {
    const deleted = includeDeleted ? "" : " AND deleted_at IS NULL";
    const row = this.database.prepare(`SELECT r.*, 'CNY' AS currency FROM loan_repayments r WHERE r.id = ?${deleted}`).get(id) as unknown as (RepaymentRow & { currency: MatterCurrency }) | undefined;
    if (!row) throw new NotFoundError("还款记录不存在");
    return this.repaymentFromRow(row, row.currency);
  }

  updateRepayment(id: string, rawPatch: RepaymentPatch, options: IdempotencyOptions = {}): LoanRepayment {
    const input = repaymentPatchSchema.parse(rawPatch);
    const current = this.getRepayment(id, false);
    this.assertExpected(current.updatedAt, input.expectedUpdatedAt);
    return this.executeIdempotent(options, "loan.repayment.update", { id, input }, () => {
      const loan = this.getLoan(current.loanId, false);
      const amount = input.amountMinor ?? current.amountMinor;
      if (amount > loan.outstandingMinor + current.amountMinor) throw new ConflictError("还款金额不能超过剩余未还金额");
      const localDate = input.localDate ?? current.localDate;
      const accountId = this.resolveMatterAccount("income", localDate, input.accountId === undefined ? current.accountId : input.accountId);
      if (accountId && current.ledgerLink.mode !== "none") throw new ConflictError("关联普通账目的旧还款不能直接改为资金账户");
      const now = new Date().toISOString();
      this.database.prepare("UPDATE loan_repayments SET amount_minor = ?, local_date = ?, note = ?, account_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(amount, localDate, input.note === undefined ? current.note : input.note?.trim() || null, accountId, now, id);
      this.database.prepare("UPDATE loans SET updated_at = ? WHERE id = ?").run(now, loan.id);
      this.reconcileRepaymentFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.repayment.update", "loan_repayment", id, Object.keys(input).filter((key) => key !== "expectedUpdatedAt"));
      return this.getRepayment(id);
    });
  }

  deleteRepayment(id: string, options: IdempotencyOptions = {}, expectedUpdatedAt?: string): LoanRepayment {
    const current = this.getRepayment(id, false);
    this.assertExpected(current.updatedAt, expectedUpdatedAt);
    return this.executeIdempotent(options, "loan.repayment.delete", { id, expectedUpdatedAt }, () => {
      const now = new Date().toISOString();
      this.database.prepare("UPDATE loan_repayments SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
      this.database.prepare("UPDATE loans SET updated_at = ? WHERE id = ?").run(now, current.loanId);
      this.reconcileRepaymentFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.repayment.delete", "loan_repayment", id);
      return this.getRepayment(id);
    });
  }

  restoreRepayment(id: string, options: IdempotencyOptions = {}): LoanRepayment {
    return this.executeIdempotent(options, "loan.repayment.restore", { id }, () => {
      const current = this.getRepayment(id, true);
      if (!current.deletedAt) return current;
      const loan = this.getLoan(current.loanId, false);
      if (current.amountMinor > loan.outstandingMinor) throw new ConflictError("恢复还款后会超过借款余额");
      if (current.accountId) this.funds?.restoreHistoricalAccount(current.accountId);
      const now = new Date().toISOString();
      this.database.prepare("UPDATE loan_repayments SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      this.database.prepare("UPDATE loans SET updated_at = ? WHERE id = ?").run(now, loan.id);
      this.reconcileRepaymentFunds(id, options.idempotencyKey);
      this.audit(options.actor ?? "user", "loan.repayment.restore", "loan_repayment", id);
      return this.getRepayment(id);
    });
  }
  private paymentFromRow(row: PaymentRow): SubscriptionPayment {
    const linked = row.ledger_link_mode === "create" ? this.linkedTransactionDetails(row.ledger_transaction_id) : null;
    const actualCnyAmountMinor = linked?.amountMinor ?? null;
    return {
      id: row.id,
      subscriptionId: row.subscription_id,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      localDate: row.local_date,
      paidDate: row.local_date,
      note: row.note,
      paymentType: row.payment_type,
      ledgerLink: mapLink(row.ledger_link_mode, row.ledger_transaction_id, actualCnyAmountMinor, "CNY", linked?.accountAmountMinor ?? null),
      actualCnyAmountMinor,
      nextBillingDateBefore: row.next_billing_date_before,
      nextBillingDateAfter: row.next_billing_date_after,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      refundedAt: row.refunded_at
    };
  }

  private linkedTransactionDetails(transactionId: string | null): { amountMinor: number; accountAmountMinor: number | null } | null {
    if (!transactionId) return null;
    const row = this.database.prepare("SELECT amount_minor, account_amount_minor FROM transactions WHERE id = ?").get(transactionId) as {
      amount_minor: number;
      account_amount_minor: number | null;
    } | undefined;
    return row ? { amountMinor: Number(row.amount_minor), accountAmountMinor: row.account_amount_minor == null ? null : Number(row.account_amount_minor) } : null;
  }

  private subscriptionState(row: SubscriptionRow, today = todayInTimezone(this.timezone)): Subscription["renewalState"] {
    if (row.status === "paused") return "paused";
    if (row.status === "cancelled") return "cancelled";
    if (!row.next_billing_date) return "active";
    if (row.next_billing_date < today) return "overdue";
    const due = new Date(`${today}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + Number(row.reminder_days));
    return row.next_billing_date <= due.toISOString().slice(0, 10) ? "due" : "upcoming";
  }

  private subscriptionFromRow(row: SubscriptionRow, includeDeleted = false, today?: string): Subscription {
    const deleted = includeDeleted ? "" : " AND deleted_at IS NULL";
    const payments = this.database.prepare(`SELECT * FROM subscription_payments WHERE subscription_id = ?${deleted} ORDER BY local_date DESC, created_at DESC`)
      .all(row.id) as unknown as PaymentRow[];
    const mappedPayments = payments.map((payment) => this.paymentFromRow(payment));
    const activePayments = mappedPayments.filter((payment) => !payment.deletedAt && !payment.refundedAt);
    const last = activePayments[0]?.localDate ?? null;
    const renewalState = this.subscriptionState(row, today);
    return {
      id: row.id,
      name: row.name,
      plan: row.plan,
      startDate: row.start_date,
      recurringAmountMinor: Number(row.recurring_amount_minor),
      currency: row.currency,
      cycle: row.cycle,
      customDays: row.custom_days == null ? null : Number(row.custom_days),
      nextBillingDate: row.next_billing_date ?? row.start_date,
      nextRenewalDate: row.next_billing_date ?? row.start_date,
      reminderDays: Number(row.reminder_days),
      status: row.status,
      website: row.website,
      url: row.website,
      note: row.note,
      lastPaymentDate: last,
      lastPayment: activePayments[0] ?? null,
      priceMinor: Number(row.recurring_amount_minor),
      initialPriceMinor: mappedPayments.find((payment) => payment.paymentType === "initial")?.amountMinor ?? null,
      cycleDays: row.custom_days == null ? null : Number(row.custom_days),
      renewalState,
      payments: mappedPayments,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  listSubscriptions(rawQuery: Partial<MatterQuery> & { subscriptionStatus?: "active" | "paused" | "cancelled" } = {}, today = todayInTimezone(this.timezone)): { items: Subscription[]; total: number; page: number; pageSize: number } {
    const query = matterQuerySchema.parse(rawQuery);
    this.purgeExpiredTrash();
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (query.status === "active") clauses.push("s.deleted_at IS NULL");
    if (query.status === "trash") clauses.push("s.deleted_at IS NOT NULL");
    if (rawQuery.subscriptionStatus) { clauses.push("s.status = ?"); values.push(rawQuery.subscriptionStatus); }
    if (query.search) { clauses.push("(s.name LIKE ? ESCAPE '\\' OR COALESCE(s.plan, '') LIKE ? ESCAPE '\\' OR COALESCE(s.note, '') LIKE ? ESCAPE '\\')"); const term = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`; values.push(term, term, term); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = this.database.prepare(`SELECT COUNT(*) AS count FROM subscriptions s ${where}`).get(...values) as { count: number };
    const rows = this.database.prepare(`SELECT s.* FROM subscriptions s ${where}
      ORDER BY CASE WHEN s.status = 'active' AND s.next_billing_date <= ? THEN 0 ELSE 1 END, s.next_billing_date, s.name LIMIT ? OFFSET ?`)
      .all(...values, today, query.pageSize, (query.page - 1) * query.pageSize) as unknown as SubscriptionRow[];
    return { items: rows.map((row) => this.subscriptionFromRow(row, query.status !== "active", today)), total: Number(count.count), page: query.page, pageSize: query.pageSize };
  }

  getSubscription(id: string, includeDeleted = true, today = todayInTimezone(this.timezone)): Subscription {
    const deleted = includeDeleted ? "" : " AND s.deleted_at IS NULL";
    const row = this.database.prepare(`SELECT s.* FROM subscriptions s WHERE s.id = ?${deleted}`).get(id) as unknown as SubscriptionRow | undefined;
    if (!row) throw new NotFoundError("订阅不存在");
    return this.subscriptionFromRow(row, includeDeleted, today);
  }

  createSubscription(rawInput: SubscriptionInput, options: IdempotencyOptions = {}): Subscription {
    const input = subscriptionInputSchema.parse(rawInput);
    return this.executeIdempotent(options, "subscription.create", input, () => {
      const now = new Date().toISOString();
      const id = randomUUID();
      const nextDate = input.nextBillingDate ?? addBillingPeriod(input.startDate, input.cycle, input.customDays ?? null, Number(input.startDate.slice(8, 10)));
      const initial = input.initialPayment;
      if (initial && initial.currency !== input.currency) throw new ConflictError("首笔付款币种必须与订阅一致");
      this.database.prepare(`INSERT INTO subscriptions(id, name, plan, start_date, recurring_amount_minor, currency, cycle, custom_days, next_billing_date, reminder_days, status, website, note, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)`).run(id, input.name, input.plan?.trim() || null, input.startDate, input.recurringAmountMinor, input.currency, input.cycle, input.customDays ?? null, nextDate, input.reminderDays, input.website || null, input.note?.trim() || null, now, now);
      if (initial) {
        this.createPaymentInternal(id, initial, options.actor ?? "user");
        if (input.nextBillingDate) this.database.prepare("UPDATE subscriptions SET next_billing_date = ?, updated_at = ? WHERE id = ?").run(input.nextBillingDate, now, id);
      }
      this.audit(options.actor ?? "user", "subscription.create", "subscription", id, ["name", "plan", "startDate", "recurringAmountMinor", "currency", "cycle", "nextBillingDate"]);
      return this.getSubscription(id);
    });
  }

  updateSubscription(id: string, rawPatch: SubscriptionPatch, options: IdempotencyOptions = {}): Subscription {
    const input = subscriptionPatchSchema.parse(rawPatch);
    const current = this.getSubscription(id, false);
    this.assertExpected(current.updatedAt, input.expectedUpdatedAt);
    return this.executeIdempotent(options, "subscription.update", { id, input }, () => {
      const cycle = input.cycle ?? current.cycle;
      const customDays = input.customDays === undefined ? current.customDays : input.customDays;
      if (cycle === "custom" && !customDays) throw new ConflictError("自定义周期需要填写天数");
      if (cycle !== "custom" && customDays) throw new ConflictError("月度或年度周期不需要自定义天数");
      if (input.currency && input.currency !== current.currency && current.payments.length > 0) {
        throw new ConflictError("已有付款记录的订阅不能更换币种");
      }
      const now = new Date().toISOString();
      this.database.prepare(`UPDATE subscriptions SET name = ?, plan = ?, start_date = ?, recurring_amount_minor = ?, currency = ?, cycle = ?, custom_days = ?, next_billing_date = ?, reminder_days = ?, status = ?, website = ?, note = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
        .run(input.name ?? current.name, input.plan === undefined ? current.plan : input.plan?.trim() || null, input.startDate ?? current.startDate, input.recurringAmountMinor ?? current.recurringAmountMinor, input.currency ?? current.currency, cycle, customDays ?? null, input.nextBillingDate === undefined ? current.nextBillingDate : input.nextBillingDate, input.reminderDays ?? current.reminderDays, input.status ?? current.status, input.website === undefined ? current.website : input.website || null, input.note === undefined ? current.note : input.note?.trim() || null, now, id);
      this.audit(options.actor ?? "user", "subscription.update", "subscription", id, Object.keys(input).filter((key) => key !== "expectedUpdatedAt"));
      return this.getSubscription(id);
    });
  }

  deleteSubscription(id: string, options: IdempotencyOptions = {}, expectedUpdatedAt?: string): Subscription {
    const current = this.getSubscription(id, false);
    this.assertExpected(current.updatedAt, expectedUpdatedAt);
    return this.executeIdempotent(options, "subscription.delete", { id, expectedUpdatedAt }, () => {
      const now = new Date().toISOString();
      this.database.prepare("UPDATE subscriptions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
      this.audit(options.actor ?? "user", "subscription.delete", "subscription", id);
      return this.getSubscription(id);
    });
  }

  restoreSubscription(id: string, options: IdempotencyOptions = {}): Subscription {
    return this.executeIdempotent(options, "subscription.restore", { id }, () => {
      const current = this.getSubscription(id, true);
      if (!current.deletedAt) return current;
      const now = new Date().toISOString();
      this.database.prepare("UPDATE subscriptions SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      this.audit(options.actor ?? "user", "subscription.restore", "subscription", id);
      return this.getSubscription(id);
    });
  }

  private createPaymentInternal(subscriptionId: string, input: PaymentInput | (PaymentInput & { currency: MatterCurrency }), actor: Actor): SubscriptionPayment {
    const subscription = this.getSubscription(subscriptionId, false);
    if (input.currency !== subscription.currency) throw new ConflictError("付款币种必须与订阅一致");
    const trackingStarted = this.funds?.startedOn();
    if (trackingStarted && input.localDate >= trackingStarted && (!input.ledgerLink || input.ledgerLink.mode === "none")) {
      throw new ConflictError("资金追踪启用后的订阅付款必须选择支出分类和支付账户");
    }
    const link = this.getLedgerLinkTransaction(input.ledgerLink, "expense", input.amountMinor, input.currency, input.localDate);
    if (trackingStarted && input.localDate >= trackingStarted && link.transactionId && !this.ledger.getTransaction(link.transactionId, false).accountId) {
      throw new ConflictError("订阅付款关联的支出账目缺少资金账户");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const beforeDate = subscription.nextBillingDate;
    const afterDate = input.paymentType === "renewal"
      ? addBillingPeriod(beforeDate, subscription.cycle, subscription.customDays, Number(subscription.startDate.slice(8, 10)))
      : beforeDate;
    this.database.prepare(`INSERT INTO subscription_payments(id, subscription_id, amount_minor, currency, local_date, note, payment_type, ledger_link_mode, ledger_transaction_id, next_billing_date_before, next_billing_date_after, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(id, subscriptionId, input.amountMinor, input.currency, input.localDate, input.note?.trim() || null, input.paymentType, link.mode, link.transactionId, beforeDate, afterDate, now, now);
    if (afterDate !== beforeDate) this.database.prepare("UPDATE subscriptions SET next_billing_date = ?, updated_at = ? WHERE id = ?").run(afterDate, now, subscriptionId);
    this.audit(actor, "subscription.payment.create", "subscription_payment", id, ["amountMinor", "currency", "localDate", "paymentType", "ledgerLink"]);
    return this.getPayment(id);
  }

  createPayment(subscriptionId: string, rawInput: PaymentInput, options: IdempotencyOptions = {}): SubscriptionPayment {
    const input = subscriptionPaymentInputSchema.parse(rawInput);
    return this.executeIdempotent(options, "subscription.payment.create", { subscriptionId, input }, () => this.createPaymentInternal(subscriptionId, input, options.actor ?? "user"));
  }

  listPayments(subscriptionId: string, includeDeleted = false): SubscriptionPayment[] {
    return this.getSubscription(subscriptionId, includeDeleted).payments;
  }

  getPayment(id: string, includeDeleted = true): SubscriptionPayment {
    const deleted = includeDeleted ? "" : " AND deleted_at IS NULL";
    const row = this.database.prepare(`SELECT * FROM subscription_payments WHERE id = ?${deleted}`).get(id) as unknown as PaymentRow | undefined;
    if (!row) throw new NotFoundError("订阅付款记录不存在");
    return this.paymentFromRow(row);
  }
  getPaymentByTransactionId(transactionId: string): SubscriptionPayment | null {
    const row = this.database.prepare(`SELECT * FROM subscription_payments
      WHERE ledger_transaction_id = ? AND deleted_at IS NULL`).get(transactionId) as unknown as PaymentRow | undefined;
    return row ? this.paymentFromRow(row) : null;
  }

  updatePayment(id: string, rawPatch: PaymentPatch, options: IdempotencyOptions = {}): SubscriptionPayment {
    const input = subscriptionPaymentPatchSchema.parse(rawPatch);
    const current = this.getPayment(id, false);
    this.assertExpected(current.updatedAt, input.expectedUpdatedAt);
    return this.executeIdempotent(options, "subscription.payment.update", { id, input }, () => {
      const subscription = this.getSubscription(current.subscriptionId, false);
      const currency = input.currency ?? current.currency;
      if (currency !== subscription.currency) throw new ConflictError("付款币种必须与订阅一致");
      if (current.ledgerLink.mode === "create" && current.ledgerLink.transactionId) {
        const linked = this.ledger.getTransaction(current.ledgerLink.transactionId, false);
        const changes: Record<string, unknown> = {};
        if (input.localDate !== undefined) changes.localDate = input.localDate;
        if (currency === "CNY" && input.amountMinor !== undefined) changes.amountMinor = input.amountMinor;
        if (Object.keys(changes).length > 0) {
          this.ledger.updateTransaction(linked.id, changes, options.actor === "openclaw" ? "openclaw" : "user");
        }
      }
      const now = new Date().toISOString();
      this.database.prepare("UPDATE subscription_payments SET amount_minor = ?, currency = ?, local_date = ?, note = ?, payment_type = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(input.amountMinor ?? current.amountMinor, currency, input.localDate ?? current.localDate, input.note === undefined ? current.note : input.note?.trim() || null, input.paymentType ?? current.paymentType, now, id);
      this.database.prepare("UPDATE subscriptions SET updated_at = ? WHERE id = ?").run(now, subscription.id);
      this.audit(options.actor ?? "user", "subscription.payment.update", "subscription_payment", id, Object.keys(input).filter((key) => key !== "expectedUpdatedAt"));
      return this.getPayment(id);
    });
  }

  deletePayment(id: string, options: IdempotencyOptions = {}, expectedUpdatedAt?: string): SubscriptionPayment {
    const current = this.getPayment(id, false);
    this.assertExpected(current.updatedAt, expectedUpdatedAt);
    return this.executeIdempotent(options, "subscription.payment.delete", { id, expectedUpdatedAt }, () => {
      const now = new Date().toISOString();
      this.database.prepare("UPDATE subscription_payments SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
      const subscription = this.getSubscription(current.subscriptionId, false);
      if (current.ledgerLink.mode === "create" && current.ledgerLink.transactionId) {
        const transaction = this.ledger.getTransaction(current.ledgerLink.transactionId, false);
        this.ledger.softDeleteTransaction(transaction.id, options.actor === "openclaw" ? "openclaw" : "user");
      }
      const shouldRewind = Boolean(current.nextBillingDateBefore && current.nextBillingDateAfter
        && subscription.nextBillingDate === current.nextBillingDateAfter
        && current.nextBillingDateBefore !== current.nextBillingDateAfter);
      this.database.prepare("UPDATE subscriptions SET next_billing_date = ?, updated_at = ? WHERE id = ?")
        .run(shouldRewind ? (current.nextBillingDateBefore ?? subscription.nextBillingDate) : subscription.nextBillingDate, now, current.subscriptionId);
      this.audit(options.actor ?? "user", "subscription.payment.delete", "subscription_payment", id);
      return this.getPayment(id);
    });
  }

  restorePayment(id: string, options: IdempotencyOptions = {}): SubscriptionPayment {
    return this.executeIdempotent(options, "subscription.payment.restore", { id }, () => {
      const current = this.getPayment(id, true);
      if (!current.deletedAt) return current;
      const subscription = this.getSubscription(current.subscriptionId, false);
      const now = new Date().toISOString();
      this.database.prepare("UPDATE subscription_payments SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      const shouldAdvance = Boolean(current.nextBillingDateBefore && current.nextBillingDateAfter
        && subscription.nextBillingDate === current.nextBillingDateBefore
        && current.nextBillingDateBefore !== current.nextBillingDateAfter);
      if (current.ledgerLink.mode === "create" && current.ledgerLink.transactionId) {
        const transaction = this.ledger.getTransaction(current.ledgerLink.transactionId, true);
        if (transaction.deletedAt) this.ledger.restoreTransaction(transaction.id, options.actor === "openclaw" ? "openclaw" : "user");
      }
      this.database.prepare("UPDATE subscriptions SET next_billing_date = ?, updated_at = ? WHERE id = ?")
        .run(shouldAdvance ? (current.nextBillingDateAfter ?? subscription.nextBillingDate) : subscription.nextBillingDate, now, subscription.id);
      this.audit(options.actor ?? "user", "subscription.payment.restore", "subscription_payment", id);
      return this.getPayment(id);
    });
  }

  loanSummary(): LoanSummary {
    const row = this.database.prepare(`SELECT COALESCE(SUM(l.principal_minor), 0) AS total_lent,
      COALESCE((SELECT SUM(r.amount_minor) FROM loan_repayments r JOIN loans lr ON lr.id = r.loan_id WHERE lr.deleted_at IS NULL AND r.deleted_at IS NULL), 0) AS total_repaid,
      COUNT(DISTINCT CASE WHEN l.principal_minor > COALESCE((SELECT SUM(r2.amount_minor) FROM loan_repayments r2 WHERE r2.loan_id = l.id AND r2.deleted_at IS NULL), 0) THEN l.id END) AS open_loans,
      COUNT(DISTINCT l.borrower_id) AS borrower_count
      FROM loans l WHERE l.deleted_at IS NULL`).get() as { total_lent: number; total_repaid: number; open_loans: number; borrower_count: number };
    return { totalLentMinor: Number(row.total_lent), totalRepaidMinor: Number(row.total_repaid), outstandingMinor: Math.max(0, Number(row.total_lent) - Number(row.total_repaid)), borrowerCount: Number(row.borrower_count), openLoanCount: Number(row.open_loans) };
  }

  subscriptionSummary(today = todayInTimezone(this.timezone)): SubscriptionSummary {
    const list = this.allPages((page) => this.listSubscriptions({ page, pageSize: 100, status: "active" }, today));
    const dueItems = list.filter((item) => item.renewalState === "due" || item.renewalState === "overdue");
    const upcoming = list.filter((item) => item.renewalState === "upcoming").slice(0, 10);
    const currencies = (["CNY", "USD"] as const).map((currency) => ({ currency, amountMinor: list.filter((item) => item.currency === currency && item.status !== "paused" && item.status !== "cancelled").reduce((sum, item) => sum + item.recurringAmountMinor, 0) })).filter((item) => item.amountMinor > 0);
    return { activeCount: list.filter((item) => item.status !== "paused" && item.status !== "cancelled").length, attentionCount: dueItems.length, dueCount: dueItems.length, upcomingCount: upcoming.length, upcoming: [...dueItems.slice(0, 10), ...upcoming].slice(0, 10), currencies };
  }

  private planAttentionState(row: PlanRow, today = todayInTimezone(this.timezone)): PlanAttentionState {
    if (row.status !== "open" || row.deleted_at || !row.due_date) return "none";
    if (row.due_date < today) return "overdue";
    const due = new Date(`${today}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + Number(row.reminder_days));
    return row.due_date <= due.toISOString().slice(0, 10) ? "due" : "scheduled";
  }

  private planFromRow(row: PlanRow, today?: string): Plan {
    const linked = row.ledger_link_mode === "create" || row.ledger_link_mode === "existing"
      ? this.linkedTransactionDetails(row.ledger_transaction_id)
      : null;
    const amountMinor = row.amount_minor == null ? null : Number(row.amount_minor);
    return {
      id: row.id,
      title: row.title,
      amountMinor,
      dueDate: row.due_date,
      reminderDays: Number(row.reminder_days),
      status: row.status,
      note: row.note,
      completedAt: row.completed_at,
      attentionState: this.planAttentionState(row, today),
      ledgerLink: mapLink(row.ledger_link_mode, row.ledger_transaction_id, linked?.amountMinor ?? amountMinor, "CNY", linked?.accountAmountMinor ?? null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  listPlans(rawQuery: Partial<PlanQuery> = {}, today = todayInTimezone(this.timezone)): { items: Plan[]; total: number; page: number; pageSize: number } {
    const query = planQuerySchema.parse(rawQuery);
    this.purgeExpiredTrash();
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (query.status === "active") clauses.push("deleted_at IS NULL");
    if (query.status === "trash") clauses.push("deleted_at IS NOT NULL");
    if (query.planStatus) { clauses.push("status = ?"); values.push(query.planStatus); }
    if (query.search) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR COALESCE(note, '') LIKE ? ESCAPE '\\')");
      const term = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(term, term);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = this.database.prepare(`SELECT COUNT(*) AS count FROM plans ${where}`).get(...values) as { count: number };
    const rows = this.database.prepare(`SELECT * FROM plans ${where}
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'cancelled' THEN 1 ELSE 2 END,
        CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at DESC
      LIMIT ? OFFSET ?`).all(...values, query.pageSize, (query.page - 1) * query.pageSize) as unknown as PlanRow[];
    return { items: rows.map((row) => this.planFromRow(row, today)), total: Number(count.count), page: query.page, pageSize: query.pageSize };
  }

  getPlan(id: string, includeDeleted = true, today = todayInTimezone(this.timezone)): Plan {
    const deleted = includeDeleted ? "" : " AND deleted_at IS NULL";
    const row = this.database.prepare(`SELECT * FROM plans WHERE id = ?${deleted}`).get(id) as unknown as PlanRow | undefined;
    if (!row) throw new NotFoundError("计划不存在");
    return this.planFromRow(row, today);
  }

  getPlanByTransactionId(transactionId: string): Plan | null {
    const row = this.database.prepare(`SELECT * FROM plans WHERE ledger_transaction_id = ? AND deleted_at IS NULL`)
      .get(transactionId) as unknown as PlanRow | undefined;
    return row ? this.planFromRow(row) : null;
  }

  createPlan(rawInput: PlanInput, options: IdempotencyOptions = {}): Plan {
    const input = planInputSchema.parse(rawInput);
    return this.executeIdempotent(options, "plan.create", { input }, () => {
      const now = new Date().toISOString();
      const id = randomUUID();
      this.database.prepare(`INSERT INTO plans(id, title, amount_minor, due_date, reminder_days, status, note, completed_at, ledger_link_mode, ledger_transaction_id, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, 'none', NULL, ?, ?, NULL)`)
        .run(id, input.title, input.amountMinor ?? null, input.dueDate ?? null, input.reminderDays, input.note?.trim() || null, now, now);
      this.audit(options.actor ?? "user", "plan.create", "plan", id, ["title", "amountMinor", "dueDate", "reminderDays", "note"]);
      return this.getPlan(id);
    });
  }

  updatePlan(id: string, rawPatch: PlanPatch, options: IdempotencyOptions = {}): Plan {
    const input = planPatchSchema.parse(rawPatch);
    const current = this.getPlan(id, false);
    this.assertExpected(current.updatedAt, input.expectedUpdatedAt);
    if (current.status !== "open" || current.ledgerLink.mode !== "none") {
      throw new ConflictError("已完成或已入账的计划不能修改，请新建一项或软删除");
    }
    return this.executeIdempotent(options, "plan.update", { id, input }, () => {
      const nextStatus = input.status ?? current.status;
      if (nextStatus === "cancelled" && current.ledgerLink.mode !== "none") {
        throw new ConflictError("已入账的计划不能取消");
      }
      const now = new Date().toISOString();
      this.database.prepare(`UPDATE plans SET title = ?, amount_minor = ?, due_date = ?, reminder_days = ?, status = ?, note = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`)
        .run(
          input.title ?? current.title,
          input.amountMinor === undefined ? current.amountMinor : input.amountMinor,
          input.dueDate === undefined ? current.dueDate : input.dueDate,
          input.reminderDays ?? current.reminderDays,
          nextStatus,
          input.note === undefined ? current.note : input.note?.trim() || null,
          nextStatus === "open" ? null : current.completedAt,
          now,
          id
        );
      this.audit(options.actor ?? "user", "plan.update", "plan", id, Object.keys(input).filter((key) => key !== "expectedUpdatedAt"));
      return this.getPlan(id);
    });
  }

  completePlan(id: string, rawInput: PlanCompleteInput, options: IdempotencyOptions = {}): Plan {
    const input = planCompleteSchema.parse(rawInput);
    const current = this.getPlan(id, false);
    this.assertExpected(current.updatedAt, input.expectedUpdatedAt);
    if (current.status !== "open") throw new ConflictError("只有未完成的计划可以勾选完成");
    if (current.ledgerLink.mode !== "none") throw new ConflictError("这项计划已经入账");
    const amountMinor = input.amountMinor ?? current.amountMinor;
    const paidDate = input.localDate ?? todayInTimezone(this.timezone);
    const note = input.note === undefined ? current.note : input.note?.trim() || null;
    return this.executeIdempotent(options, "plan.complete", { id, input }, () => {
      let link: { mode: "none" | "existing" | "create"; transactionId: string | null; amountMinor: number | null } = {
        mode: "none",
        transactionId: null,
        amountMinor: null
      };
      if (amountMinor) {
        const trackingStarted = this.funds?.startedOn();
        if (!input.ledgerLink || input.ledgerLink.mode === "none") {
          throw new ConflictError(trackingStarted && paidDate >= trackingStarted
            ? "资金追踪启用后，有金额的计划完成必须选择支出分类和支付账户"
            : "有金额的计划完成必须关联或创建账目");
        }
        if (trackingStarted && paidDate >= trackingStarted && input.ledgerLink.mode === "create" && !input.ledgerLink.accountId) {
          throw new ConflictError("资金追踪启用后，有金额的计划完成必须选择支付账户");
        }
        link = this.getLedgerLinkTransaction(input.ledgerLink, "expense", amountMinor, "CNY", paidDate, note ?? current.title);
        if (trackingStarted && paidDate >= trackingStarted && link.transactionId && !this.ledger.getTransaction(link.transactionId, false).accountId) {
          throw new ConflictError("计划入账的支出缺少资金账户");
        }
      } else if (input.ledgerLink && input.ledgerLink.mode !== "none") {
        throw new ConflictError("没有金额的计划不能关联账本");
      }
      const now = new Date().toISOString();
      this.database.prepare(`UPDATE plans SET amount_minor = ?, status = 'completed', note = ?, completed_at = ?, ledger_link_mode = ?, ledger_transaction_id = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`)
        .run(amountMinor, note, paidDate, link.mode, link.transactionId, now, id);
      this.audit(options.actor ?? "user", "plan.complete", "plan", id, ["status", "amountMinor", "ledgerLink"]);
      return this.getPlan(id);
    });
  }

  deletePlan(id: string, options: IdempotencyOptions = {}, expectedUpdatedAt?: string): Plan {
    const current = this.getPlan(id, false);
    this.assertExpected(current.updatedAt, expectedUpdatedAt);
    return this.executeIdempotent(options, "plan.delete", { id, expectedUpdatedAt }, () => {
      const now = new Date().toISOString();
      this.database.prepare("UPDATE plans SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
      this.audit(options.actor ?? "user", "plan.delete", "plan", id);
      return this.getPlan(id);
    });
  }

  restorePlan(id: string, options: IdempotencyOptions = {}): Plan {
    return this.executeIdempotent(options, "plan.restore", { id }, () => {
      const current = this.getPlan(id, true);
      if (!current.deletedAt) return current;
      const now = new Date().toISOString();
      this.database.prepare("UPDATE plans SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      this.audit(options.actor ?? "user", "plan.restore", "plan", id);
      return this.getPlan(id);
    });
  }

  planSummary(today = todayInTimezone(this.timezone)): PlanSummary {
    const list = this.allPages((page) => this.listPlans({ page, pageSize: 100, status: "active" }, today));
    const openItems = list.filter((item) => item.status === "open");
    const dueItems = openItems.filter((item) => item.attentionState === "due");
    const overdueItems = openItems.filter((item) => item.attentionState === "overdue");
    const attention = [...overdueItems, ...dueItems];
    return {
      openCount: openItems.length,
      attentionCount: attention.length,
      dueCount: dueItems.length,
      overdueCount: overdueItems.length,
      openAmountMinor: openItems.reduce((sum, item) => sum + (item.amountMinor ?? 0), 0),
      upcoming: attention.slice(0, 10)
    };
  }

  exportPlansCsv(): string {
    const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [
      ["标题", "待付金额（元）", "到期日", "提醒天数", "状态", "完成日期", "关联账目", "备注"],
      ...this.allPages((page) => this.listPlans({ status: "all", page, pageSize: 100 })).map((plan) => [
        plan.title,
        plan.amountMinor == null ? "" : (plan.amountMinor / 100).toFixed(2),
        plan.dueDate,
        plan.reminderDays,
        plan.status,
        plan.completedAt,
        plan.ledgerLink.transactionId,
        plan.note
      ])
    ];
    return `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}`;
  }

  exportData(): Record<string, unknown> {
    return {
      borrowers: this.allPages((page) => this.listBorrowers({ status: "all", page, pageSize: 100 })),
      loans: this.allPages((page) => this.listLoans({ status: "all", page, pageSize: 100 })),
      subscriptions: this.allPages((page) => this.listSubscriptions({ status: "all", page, pageSize: 100 })),
      plans: this.allPages((page) => this.listPlans({ status: "all", page, pageSize: 100 }))
    };
  }

  private allPages<T>(fetchPage: (page: number) => { items: T[]; total: number; page: number; pageSize: number }): T[] {
    const items: T[] = [];
    let page = 1;
    while (true) {
      const result = fetchPage(page);
      items.push(...result.items);
      if (items.length >= result.total || result.items.length === 0) return items;
      page += 1;
    }
  }

  exportLoansCsv(): string {
    const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [
      ["借款人", "借出日期", "借出金额（元）", "已还金额（元）", "未还金额（元）", "状态", "用途", "备注"],
      ...this.allPages((page) => this.listLoans({ status: "all", page, pageSize: 100 })).map((loan) => [loan.borrowerName, loan.localDate, (loan.principalMinor / 100).toFixed(2), (loan.repaidMinor / 100).toFixed(2), (loan.outstandingMinor / 100).toFixed(2), loan.status, loan.purpose, loan.note])
    ];
    return `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}`;
  }

  exportSubscriptionsCsv(): string {
    const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows: unknown[][] = [["订阅名称", "套餐", "币种", "常规金额", "周期", "下次续费", "状态", "付款日期", "付款金额", "付款类型"]];
    for (const subscription of this.allPages((page) => this.listSubscriptions({ status: "all", page, pageSize: 100 }))) {
      if (subscription.payments.length === 0) rows.push([subscription.name, subscription.plan, subscription.currency, (subscription.recurringAmountMinor / 100).toFixed(2), subscription.cycle, subscription.nextBillingDate, subscription.status, "", "", ""]);
      else for (const payment of subscription.payments) rows.push([subscription.name, subscription.plan, payment.currency, (subscription.recurringAmountMinor / 100).toFixed(2), subscription.cycle, subscription.nextBillingDate, subscription.status, payment.localDate, (payment.amountMinor / 100).toFixed(2), payment.paymentType]);
    }
    return `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}`;
  }

  purgeExpiredTrash(now = new Date()): number {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = this.transaction(() => {
      let count = 0;
      count += Number(this.database.prepare("DELETE FROM loan_repayments WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
      count += Number(this.database.prepare("DELETE FROM subscription_payments WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
      count += Number(this.database.prepare("DELETE FROM loans WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
      count += Number(this.database.prepare("DELETE FROM subscriptions WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
      count += Number(this.database.prepare("DELETE FROM plans WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
      count += Number(this.database.prepare("DELETE FROM borrowers WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
      count += Number(this.database.prepare("DELETE FROM matter_idempotency WHERE created_at < ?").run(cutoff).changes);
      return count;
    });
    return result;
  }

  parseDeleteInput(raw: unknown): { expectedUpdatedAt?: string } {
    return matterDeleteSchema.parse(raw ?? {});
  }
}

export { addBillingPeriod };

function bodyWithoutRequestId(request: Request): Record<string, unknown> {
  const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  const { requestId: _requestId, ...rest } = body;
  return rest;
}

function normalizeLoanBody(request: Request): Record<string, unknown> {
  const body = bodyWithoutRequestId(request);
  if (body.principalMinor === undefined && body.amountMinor !== undefined) body.principalMinor = body.amountMinor;
  if (body.localDate === undefined && body.lentDate !== undefined) body.localDate = body.lentDate;
  delete body.amountMinor;
  delete body.lentDate;
  return body;
}

function normalizeSubscriptionBody(request: Request): Record<string, unknown> {
  const body = bodyWithoutRequestId(request);
  if (body.recurringAmountMinor === undefined && body.priceMinor !== undefined) body.recurringAmountMinor = body.priceMinor;
  if (body.customDays === undefined && body.cycleDays !== undefined) body.customDays = body.cycleDays;
  if (body.nextBillingDate === undefined && body.nextRenewalDate !== undefined) body.nextBillingDate = body.nextRenewalDate;
  if (body.website === undefined && body.url !== undefined) body.website = body.url;
  if (body.initialPayment === undefined && body.initialPriceMinor !== undefined && body.initialPriceMinor !== null) {
    body.initialPayment = { amountMinor: body.initialPriceMinor, currency: body.currency, localDate: body.startDate, paymentType: "initial" };
  }
  delete body.priceMinor;
  delete body.initialPriceMinor;
  delete body.cycleDays;
  delete body.nextRenewalDate;
  delete body.url;
  return body;
}

function normalizePlanBody(request: Request): Record<string, unknown> {
  const body = bodyWithoutRequestId(request);
  if (body.dueDate === "") body.dueDate = null;
  if (body.amountMinor === "") body.amountMinor = null;
  return body;
}

function normalizePaymentBody(request: Request): Record<string, unknown> {
  const body = bodyWithoutRequestId(request);
  if (body.localDate === undefined && body.paidDate !== undefined) body.localDate = body.paidDate;
  if (body.ledgerLink === undefined && body.actualCnyAmountMinor !== undefined) {
    // The UI may supply the real CNY debit without a category. Keep it as a
    // payment field; a ledger link can be selected separately when available.
    delete body.actualCnyAmountMinor;
  }
  delete body.paidDate;
  delete body.nextRenewalDate;
  return body;
}

function matterIdempotencyKey(request: Request): string | null {
  const header = request.header("Idempotency-Key")?.trim();
  if (header) return header;
  const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  return typeof body.requestId === "string" ? body.requestId.trim() || null : null;
}

function matterRoute(app: Express, method: "get" | "post" | "patch" | "delete", path: string, handler: (request: Request, response: Response, next: NextFunction) => unknown): void {
  app[method](path, (request, response, next) => {
    try { handler(request, response, next); } catch (error) { next(error); }
  });
}

export function attachMatterRoutes(app: Express, matters: MattersRepository): void {
  matterRoute(app, "get", "/api/v1/borrowers", (request, response) => {
    response.json({ data: matters.listBorrowers(request.query as Record<string, string>) });
  });
  matterRoute(app, "post", "/api/v1/borrowers", (request, response) => {
    response.status(201).json({ data: matters.createBorrower(bodyWithoutRequestId(request) as BorrowerInput, { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "patch", "/api/v1/borrowers/:id", (request, response) => {
    response.json({ data: matters.updateBorrower(String(request.params.id), bodyWithoutRequestId(request), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "delete", "/api/v1/borrowers/:id", (request, response) => {
    const body = matters.parseDeleteInput(bodyWithoutRequestId(request));
    response.json({ data: matters.deleteBorrower(String(request.params.id), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }, body.expectedUpdatedAt) });
  });
  matterRoute(app, "post", "/api/v1/borrowers/:id/restore", (request, response) => {
    response.json({ data: matters.restoreBorrower(String(request.params.id), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });

  matterRoute(app, "get", "/api/v1/loans/summary", (_request, response) => {
    response.json({ data: matters.loanSummary() });
  });
  matterRoute(app, "get", "/api/v1/loans", (request, response) => {
    const query = { ...(request.query as Record<string, string>), borrowerId: request.query.borrowerId as string | undefined };
    response.json({ data: matters.listLoans(query) });
  });
  matterRoute(app, "post", "/api/v1/loans", (request, response) => {
    response.status(201).json({ data: matters.createLoanForBorrowerSelection(normalizeLoanBody(request) as LoanCreateInput, { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "get", "/api/v1/loans/:id", (request, response) => {
    response.json({ data: matters.getLoan(String(request.params.id)) });
  });
  matterRoute(app, "patch", "/api/v1/loans/:id", (request, response) => {
    response.json({ data: matters.updateLoan(String(request.params.id), normalizeLoanBody(request), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "delete", "/api/v1/loans/:id", (request, response) => {
    const body = matters.parseDeleteInput(bodyWithoutRequestId(request));
    response.json({ data: matters.deleteLoan(String(request.params.id), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }, body.expectedUpdatedAt) });
  });
  matterRoute(app, "post", "/api/v1/loans/:id/restore", (request, response) => {
    response.json({ data: matters.restoreLoan(String(request.params.id), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "get", "/api/v1/loans/:id/repayments", (request, response) => {
    response.json({ data: matters.listRepayments(String(request.params.id), request.query.status === "trash") });
  });
  matterRoute(app, "post", "/api/v1/loans/:id/repayments", (request, response) => {
    response.status(201).json({ data: matters.createRepayment(String(request.params.id), bodyWithoutRequestId(request) as RepaymentInput, { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "patch", "/api/v1/loans/:id/repayments/:repaymentId", (request, response) => {
    response.json({ data: matters.updateRepayment(String(request.params.repaymentId), bodyWithoutRequestId(request), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "delete", "/api/v1/loans/:id/repayments/:repaymentId", (request, response) => {
    const body = matters.parseDeleteInput(bodyWithoutRequestId(request));
    response.json({ data: matters.deleteRepayment(String(request.params.repaymentId), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }, body.expectedUpdatedAt) });
  });
  matterRoute(app, "post", "/api/v1/loans/:id/repayments/:repaymentId/restore", (request, response) => {
    response.json({ data: matters.restoreRepayment(String(request.params.repaymentId), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });

  matterRoute(app, "get", "/api/v1/subscriptions/summary", (_request, response) => {
    response.json({ data: matters.subscriptionSummary() });
  });
  matterRoute(app, "get", "/api/v1/subscriptions", (request, response) => {
    response.json({ data: matters.listSubscriptions(request.query as Record<string, string>) });
  });
  matterRoute(app, "post", "/api/v1/subscriptions", (request, response) => {
    response.status(201).json({ data: matters.createSubscription(normalizeSubscriptionBody(request) as SubscriptionInput, { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "get", "/api/v1/subscriptions/:id", (request, response) => {
    response.json({ data: matters.getSubscription(String(request.params.id)) });
  });
  matterRoute(app, "patch", "/api/v1/subscriptions/:id", (request, response) => {
    response.json({ data: matters.updateSubscription(String(request.params.id), normalizeSubscriptionBody(request), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "delete", "/api/v1/subscriptions/:id", (request, response) => {
    const body = matters.parseDeleteInput(bodyWithoutRequestId(request));
    response.json({ data: matters.deleteSubscription(String(request.params.id), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }, body.expectedUpdatedAt) });
  });
  matterRoute(app, "post", "/api/v1/subscriptions/:id/restore", (request, response) => {
    response.json({ data: matters.restoreSubscription(String(request.params.id), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "get", "/api/v1/subscriptions/:id/payments", (request, response) => {
    response.json({ data: matters.listPayments(String(request.params.id), request.query.status === "trash") });
  });
  matterRoute(app, "post", "/api/v1/subscriptions/:id/payments", (request, response) => {
    response.status(201).json({ data: matters.createPayment(String(request.params.id), normalizePaymentBody(request) as PaymentInput, { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "patch", "/api/v1/subscriptions/:id/payments/:paymentId", (request, response) => {
    response.json({ data: matters.updatePayment(String(request.params.paymentId), normalizePaymentBody(request), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "delete", "/api/v1/subscriptions/:id/payments/:paymentId", (request, response) => {
    const body = matters.parseDeleteInput(bodyWithoutRequestId(request));
    response.json({ data: matters.deletePayment(String(request.params.paymentId), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }, body.expectedUpdatedAt) });
  });
  matterRoute(app, "post", "/api/v1/subscriptions/:id/payments/:paymentId/restore", (request, response) => {
    response.json({ data: matters.restorePayment(String(request.params.paymentId), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });

  matterRoute(app, "get", "/api/v1/plans/summary", (_request, response) => {
    response.json({ data: matters.planSummary() });
  });
  matterRoute(app, "get", "/api/v1/plans", (request, response) => {
    response.json({ data: matters.listPlans(request.query as Record<string, string>) });
  });
  matterRoute(app, "post", "/api/v1/plans", (request, response) => {
    response.status(201).json({ data: matters.createPlan(normalizePlanBody(request) as PlanInput, { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "get", "/api/v1/plans/:id", (request, response) => {
    response.json({ data: matters.getPlan(String(request.params.id)) });
  });
  matterRoute(app, "patch", "/api/v1/plans/:id", (request, response) => {
    response.json({ data: matters.updatePlan(String(request.params.id), normalizePlanBody(request), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "post", "/api/v1/plans/:id/complete", (request, response) => {
    response.json({ data: matters.completePlan(String(request.params.id), bodyWithoutRequestId(request), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });
  matterRoute(app, "delete", "/api/v1/plans/:id", (request, response) => {
    const body = matters.parseDeleteInput(bodyWithoutRequestId(request));
    response.json({ data: matters.deletePlan(String(request.params.id), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }, body.expectedUpdatedAt) });
  });
  matterRoute(app, "post", "/api/v1/plans/:id/restore", (request, response) => {
    response.json({ data: matters.restorePlan(String(request.params.id), { idempotencyKey: matterIdempotencyKey(request), actor: "user" }) });
  });

  matterRoute(app, "get", "/api/v1/export.loans.csv", (_request, response) => {
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", "attachment; filename=\"money-manager-loans.csv\"");
    response.send(matters.exportLoansCsv());
  });
  matterRoute(app, "get", "/api/v1/export.subscriptions.csv", (_request, response) => {
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", "attachment; filename=\"money-manager-subscriptions.csv\"");
    response.send(matters.exportSubscriptionsCsv());
  });
  matterRoute(app, "get", "/api/v1/export.plans.csv", (_request, response) => {
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", "attachment; filename=\"money-manager-plans.csv\"");
    response.send(matters.exportPlansCsv());
  });
}
