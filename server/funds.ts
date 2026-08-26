import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type {
  Account,
  AccountCurrency,
  AccountAdjustment,
  AccountAdjustmentList,
  AccountMovement,
  AccountMovementList,
  FundsSummary,
  Transaction,
  TransactionKind,
  Transfer
} from "../shared/types";
import {
  accountCreateSchema,
  accountAdjustmentQuerySchema,
  accountMovementQuerySchema,
  accountPatchSchema,
  adjustmentInputSchema,
  fundsActivationSchema,
  transferInputSchema,
  transferPatchSchema,
  transactionRefundSchema
} from "../shared/schemas";
import { ConflictError, NotFoundError } from "./errors";
import type { LedgerRepository } from "./repository";

type ActivationInput = z.infer<typeof fundsActivationSchema>;
type AccountCreateInput = z.infer<typeof accountCreateSchema>;
type AccountPatchInput = z.infer<typeof accountPatchSchema>;
type AdjustmentQuery = z.infer<typeof accountAdjustmentQuerySchema>;
type MovementQuery = z.infer<typeof accountMovementQuerySchema>;
type TransferInput = z.infer<typeof transferInputSchema>;
type TransferPatch = z.infer<typeof transferPatchSchema>;
type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;
type RefundInput = z.infer<typeof transactionRefundSchema>;
type SourceType = AccountMovement["sourceType"];

interface AccountRow {
  id: string;
  name: string;
  icon: string;
  currency: AccountCurrency;
  opening_balance_minor: number;
  opened_on: string;
  is_archived: number;
  created_at: string;
  updated_at: string;
  balance_minor?: number;
}

interface MovementRow {
  id: string;
  account_id: string;
  account_name?: string;
  currency: AccountCurrency;
  delta_minor: number;
  source_type: SourceType;
  source_id: string;
  local_date: string;
  request_id: string | null;
  operation_id: string | null;
  reversal_of_id: string | null;
  created_at: string;
}

interface TransferRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  currency: AccountCurrency;
  debited_minor: number;
  credited_minor: number;
  fee_transaction_id: string | null;
  local_date: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface AdjustmentRow {
  id: string;
  account_id: string;
  account_name: string;
  currency: AccountCurrency;
  can_undo: number;
  request_id: string | null;
  target_balance_minor: number;
  delta_minor: number;
  local_date: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface TransactionFundingInput {
  transactionId?: string;
  kind: TransactionKind;
  localDate: string;
  amountMinor: number;
  accountId?: string | null;
  accountAmountMinor?: number | null;
}

interface TransactionAssignmentInput {
  accountId: string;
  transactions: Array<{ id: string; expectedUpdatedAt: string }>;
}

interface AssignableTransactionRow {
  id: string;
  local_date: string;
  account_id: string | null;
  refunded_at: string | null;
  deleted_at: string | null;
  updated_at: string;
}

type DesiredImpact = Map<string, number>;

function normalizeAccountName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

interface PersistentRequestRecord<T> {
  hash: string;
  result: T;
  status?: "applied" | "undone";
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nextIsoAfter(current: string): string {
  const currentMs = Date.parse(current);
  const minimum = Number.isFinite(currentMs) ? currentMs + 1 : Date.now();
  return new Date(Math.max(Date.now(), minimum)).toISOString();
}

function isoNow(): string {
  return new Date().toISOString();
}

export class FundsService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly ledger: LedgerRepository,
    private readonly today: () => string
  ) {}

  private savepoint<T>(work: () => T): T {
    const name = `funds_${randomUUID().replaceAll("-", "")}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      this.database.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.database.exec(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }

  private setting(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string, now = isoNow()): void {
    this.database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now);
  }

  // These records are intentionally retained: expiring them would make an old
  // requestId reusable and could apply the same balance effect again.
  private persistentRequest<T>(key: string): PersistentRequestRecord<T> | null {
    const value = this.setting(key);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as PersistentRequestRecord<T>;
      if (!parsed || typeof parsed.hash !== "string" || !("result" in parsed)) throw new Error("invalid");
      return parsed;
    } catch {
      throw new ConflictError("资金请求记录损坏，请检查账本健康状态");
    }
  }

  private setPersistentRequest<T>(key: string, record: PersistentRequestRecord<T>, now = isoNow()): void {
    this.setSetting(key, JSON.stringify(record), now);
  }

  isEnabled(): boolean {
    return Boolean(this.setting("funds.started_on"));
  }

  startedOn(): string | null {
    return this.setting("funds.started_on");
  }

  private aliases(accountId: string): string[] {
    return (this.database.prepare("SELECT alias FROM account_aliases WHERE account_id = ? ORDER BY alias").all(accountId) as unknown as Array<{ alias: string }>)
      .map((row) => row.alias);
  }


  private isAccountUnused(accountId: string): boolean {
    const related = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM account_movements WHERE account_id = ?) +
      (SELECT COUNT(*) FROM transactions WHERE account_id = ? OR refund_account_id = ?) +
      (SELECT COUNT(*) FROM loans WHERE account_id = ?) +
      (SELECT COUNT(*) FROM loan_repayments WHERE account_id = ?) +
      (SELECT COUNT(*) FROM transfers WHERE from_account_id = ? OR to_account_id = ?) +
      (SELECT COUNT(*) FROM account_adjustments WHERE account_id = ?) +
      (SELECT COUNT(*) FROM proposals WHERE status = 'pending' AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.accountId') END = ?) AS count`).get(
        accountId, accountId, accountId, accountId, accountId, accountId, accountId, accountId, accountId
      ) as { count: number };
    return Number(related.count) === 0;
  }

  assertAccountUnused(accountId: string): void {
    if (!this.isAccountUnused(accountId)) throw new ConflictError("账户后来已经产生资金记录或业务引用，不能撤销创建");
  }
  private accountFromRow(row: AccountRow): Account {
    return {
      id: row.id,
      name: row.name,
      icon: row.icon,
      currency: row.currency,
      aliases: this.aliases(row.id),
      openingBalanceMinor: Number(row.opening_balance_minor),
      balanceMinor: Number(row.balance_minor ?? row.opening_balance_minor),
      openedOn: row.opened_on,
      isArchived: Boolean(row.is_archived),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isUnused: this.isAccountUnused(row.id)
    };
  }

  listAccounts(includeArchived = false): Account[] {
    const where = includeArchived ? "" : "WHERE a.is_archived = 0";
    const rows = this.database.prepare(`SELECT a.*,
      a.opening_balance_minor + COALESCE((SELECT SUM(m.delta_minor) FROM account_movements m WHERE m.account_id = a.id), 0) AS balance_minor
      FROM accounts a ${where} ORDER BY a.is_archived, a.created_at, a.name`).all() as unknown as AccountRow[];
    return rows.map((row) => this.accountFromRow(row));
  }

  getAccount(id: string, includeArchived = true): Account {
    const archived = includeArchived ? "" : " AND a.is_archived = 0";
    const row = this.database.prepare(`SELECT a.*,
      a.opening_balance_minor + COALESCE((SELECT SUM(m.delta_minor) FROM account_movements m WHERE m.account_id = a.id), 0) AS balance_minor
      FROM accounts a WHERE a.id = ?${archived}`).get(id) as AccountRow | undefined;
    if (!row) throw new NotFoundError("资金账户不存在");
    return this.accountFromRow(row);
  }

  private assertAccountIdentityAvailable(name: string, aliases: string[], excludeId?: string): void {
    const candidates = new Set([name, ...aliases].map(normalizeAccountName));
    if (candidates.size !== 1 + aliases.length) throw new ConflictError("账户名称或别名不能重复");
    const rows = this.database.prepare(`SELECT a.id, a.normalized_name AS normalized
      FROM accounts a WHERE a.is_archived = 0
      UNION ALL
      SELECT a.id, x.normalized_alias AS normalized
      FROM account_aliases x JOIN accounts a ON a.id = x.account_id WHERE a.is_archived = 0`).all() as unknown as Array<{ id: string; normalized: string }>;
    if (rows.some((row) => row.id !== excludeId && candidates.has(row.normalized))) {
      throw new ConflictError("账户名称或别名与现有账户冲突");
    }
  }

  private insertAccount(input: AccountCreateInput, openedOn: string, now = isoNow()): Account {
    this.assertAccountIdentityAvailable(input.name, input.aliases);
    const id = randomUUID();
    this.database.prepare(`INSERT INTO accounts(
      id, name, normalized_name, icon, currency, opening_balance_minor, opened_on, is_archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
      id, input.name, normalizeAccountName(input.name), input.icon, input.currency, input.openingBalanceMinor, openedOn, now, now
    );
    const insertAlias = this.database.prepare("INSERT INTO account_aliases(id, account_id, alias, normalized_alias, created_at) VALUES (?, ?, ?, ?, ?)");
    input.aliases.forEach((alias) => insertAlias.run(randomUUID(), id, alias, normalizeAccountName(alias), now));
    return this.getAccount(id);
  }

  activate(rawInput: ActivationInput, requestId?: string | null): FundsSummary {
    const input = fundsActivationSchema.parse(rawInput);
    const existing = this.setting("funds.started_on");
    if (existing) {
      const previousId = this.setting("funds.activation_request_id");
      const previousHash = this.setting("funds.activation_request_hash");
      if (requestId && previousId === requestId && previousHash === hashRequest(input)) return this.summary();
      throw new ConflictError("资金追踪已经启用");
    }
    return this.savepoint(() => {
      const startedOn = this.today();
      const now = isoNow();
      this.database.prepare(`INSERT OR IGNORE INTO funds_baseline_transactions(transaction_id, captured_at)
        SELECT id, ? FROM transactions`).run(now);
      const accounts = input.accounts.map((account) => this.insertAccount(account, startedOn, now));
      const byName = (name: string) => {
        const normalized = normalizeAccountName(name);
        const found = accounts.find((account) =>
          normalizeAccountName(account.name) === normalized || account.aliases.some((alias) => normalizeAccountName(alias) === normalized)
        );
        if (!found) throw new ConflictError("默认账户必须来自本次启用的账户");
        return found;
      };
      const expense = byName(input.defaultExpenseAccountName);
      const income = byName(input.defaultIncomeAccountName);
      if (expense.currency !== "CNY" || income.currency !== "CNY") throw new ConflictError("默认收支账户必须是人民币账户");
      if (input.defaultFeeCategoryId) {
        const category = this.ledger.getCategory(input.defaultFeeCategoryId);
        if (category.kind !== "expense" || category.isArchived) throw new ConflictError("手续费分类必须是可用的支出分类");
      }
      this.setSetting("funds.started_on", startedOn, now);
      this.setSetting("funds.default_expense_account_id", expense.id, now);
      this.setSetting("funds.default_income_account_id", income.id, now);
      if (input.defaultFeeCategoryId) this.setSetting("funds.default_fee_category_id", input.defaultFeeCategoryId, now);
      if (requestId) {
        this.setSetting("funds.activation_request_id", requestId, now);
        this.setSetting("funds.activation_request_hash", hashRequest(input), now);
      }
      this.ledger.audit("user", "funds.activate", "funds", "primary", { accountCount: accounts.length });
      return this.summary();
    });
  }

  summary(): FundsSummary {
    const accounts = this.listAccounts();
    const currencyTotals: FundsSummary["currencyTotals"] = { CNY: 0, USD: 0, USDT: 0 };
    accounts.forEach((account) => {
      currencyTotals[account.currency] += account.balanceMinor;
    });
    return {
      enabled: this.isEnabled(),
      startedOn: this.startedOn(),
      totalMinor: currencyTotals.CNY,
      accountCount: accounts.length,
      defaultExpenseAccountId: this.setting("funds.default_expense_account_id"),
      defaultIncomeAccountId: this.setting("funds.default_income_account_id"),
      defaultFeeCategoryId: this.setting("funds.default_fee_category_id"),
      currencyTotals,
      accounts
    };
  }

  createAccount(rawInput: AccountCreateInput): Account {
    if (!this.isEnabled()) throw new ConflictError("请先完成资金追踪启用向导");
    const input = accountCreateSchema.parse(rawInput);
    return this.savepoint(() => {
      const account = this.insertAccount(input, input.openedOn ?? this.today());
      this.ledger.audit("user", "account.create", "account", account.id);
      return account;
    });
  }

  updateAccount(id: string, rawInput: AccountPatchInput): Account {
    const input = accountPatchSchema.parse(rawInput);
    const balanceRequestKey = input.balanceChange
      ? `funds.account_balance_request.${input.balanceChange.requestId}`
      : null;
    const balanceRequestHash = input.balanceChange ? hashRequest({
      accountId: id,
      name: input.name,
      icon: input.icon,
      currency: input.currency,
      aliases: input.aliases,
      balanceChange: input.balanceChange
    }) : null;
    if (balanceRequestKey && balanceRequestHash) {
      const replay = this.persistentRequest<Account>(balanceRequestKey);
      if (replay) {
        if (replay.hash !== balanceRequestHash) throw new ConflictError("requestId 已用于另一笔账户余额修改");
        return replay.result;
      }
    }
    return this.savepoint(() => {
      const current = this.getAccount(id);
      if (current.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("账户已经更新，请刷新后重试");

      const name = input.name ?? current.name;
      const aliases = input.aliases ?? current.aliases;
      const currency = input.currency ?? current.currency;
      const isUnused = this.isAccountUnused(id);
      const isDefault = [
        this.setting("funds.default_expense_account_id"),
        this.setting("funds.default_income_account_id")
      ].includes(id);

      if (currency !== current.currency) {
        if (isDefault) throw new ConflictError("默认账户不能修改币种，请先更换默认账户");
        if (!isUnused) throw new ConflictError("已有资金流水或业务引用的账户不能修改币种");
      }
      if (input.balanceChange && current.isArchived) {
        throw new ConflictError("停用账户不能校准余额");
      }

      this.assertAccountIdentityAvailable(name, aliases, id);
      const openingBalanceMinor = input.balanceChange && isUnused
        ? input.balanceChange.targetBalanceMinor
        : current.openingBalanceMinor;
      const now = nextIsoAfter(current.updatedAt);
      const result = this.database.prepare(`UPDATE accounts SET name = ?, normalized_name = ?, icon = ?, currency = ?,
        opening_balance_minor = ?, updated_at = ? WHERE id = ? AND updated_at = ?`).run(
          name, normalizeAccountName(name), input.icon ?? current.icon, currency,
          openingBalanceMinor, now, id, input.expectedUpdatedAt
        );
      if (Number(result.changes) !== 1) throw new ConflictError("账户已经更新，请刷新后重试");

      if (input.aliases) {
        this.database.prepare("DELETE FROM account_aliases WHERE account_id = ?").run(id);
        const insert = this.database.prepare("INSERT INTO account_aliases(id, account_id, alias, normalized_alias, created_at) VALUES (?, ?, ?, ?, ?)");
        aliases.forEach((alias) => insert.run(randomUUID(), id, alias, normalizeAccountName(alias), now));
      }

      if (input.balanceChange && !isUnused && input.balanceChange.targetBalanceMinor !== current.balanceMinor) {
        this.createAdjustment({
          accountId: id,
          targetBalanceMinor: input.balanceChange.targetBalanceMinor,
          localDate: input.balanceChange.localDate,
          note: input.balanceChange.note,
          requestId: input.balanceChange.requestId
        }, "user");
      }

      this.ledger.audit("user", "account.update", "account", id, {
        changedFields: Object.keys(input).filter((key) => key !== "expectedUpdatedAt")
      });
      const updated = this.getAccount(id);
      if (balanceRequestKey && balanceRequestHash) {
        this.setPersistentRequest(balanceRequestKey, {
          hash: balanceRequestHash, result: updated, status: "applied"
        }, now);
      }
      return updated;
    });
  }

  archiveAccount(id: string, input: { expectedUpdatedAt: string }): Account {
    const account = this.getAccount(id, false);
    if (account.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("账户已经更新，请刷新后重试");
    const summary = this.summary();
    if ([summary.defaultExpenseAccountId, summary.defaultIncomeAccountId].includes(id)) throw new ConflictError("默认账户不能停用，请先更换默认账户");
    if (account.balanceMinor !== 0) throw new ConflictError("账户余额归零后才能停用");
    const related = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM transactions WHERE (account_id = ? OR refund_account_id = ?) AND deleted_at IS NULL) +
      (SELECT COUNT(*) FROM loans WHERE account_id = ? AND deleted_at IS NULL) +
      (SELECT COUNT(*) FROM loan_repayments WHERE account_id = ? AND deleted_at IS NULL) +
      (SELECT COUNT(*) FROM transfers WHERE (from_account_id = ? OR to_account_id = ?) AND deleted_at IS NULL) +
      (SELECT COUNT(*) FROM account_adjustments WHERE account_id = ?) AS count`).get(
        id, id, id, id, id, id, id
      ) as { count: number };
    if (Number(related.count) > 0) throw new ConflictError("账户仍有关联记录，不能停用");
    const now = nextIsoAfter(account.updatedAt);
    this.database.prepare("UPDATE accounts SET is_archived = 1, updated_at = ? WHERE id = ?").run(now, id);
    this.ledger.audit("user", "account.archive", "account", id);
    return this.getAccount(id);
  }

  restoreAccount(id: string, input?: { expectedUpdatedAt?: string }): Account {
    const account = this.getAccount(id);
    if (input?.expectedUpdatedAt && account.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("账户已经更新，请刷新后重试");
    if (!account.isArchived) return account;
    this.assertAccountIdentityAvailable(account.name, account.aliases, id);
    const now = nextIsoAfter(account.updatedAt);
    this.database.prepare("UPDATE accounts SET is_archived = 0, updated_at = ? WHERE id = ?").run(now, id);
    this.ledger.audit("user", "account.restore", "account", id);
    return this.getAccount(id);
  }

  restoreHistoricalAccount(id: string): Account {
    const account = this.getAccount(id);
    if (!account.isArchived) return account;
    return this.restoreAccount(id, { expectedUpdatedAt: account.updatedAt });
  }

  deleteUnusedAccount(id: string, input: { expectedUpdatedAt: string }): void {
    this.savepoint(() => {
      const account = this.getAccount(id);
      if (account.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("账户已经更新，请刷新后重试");
      if ([
        this.setting("funds.default_expense_account_id"),
        this.setting("funds.default_income_account_id")
      ].includes(id)) throw new ConflictError("默认账户不能删除");
      if (!this.isAccountUnused(id)) throw new ConflictError("只有未产生任何资金记录或业务引用的账户才能删除");
      this.database.prepare(`UPDATE openclaw_operations SET undoable = 0
        WHERE entity_type = 'account' AND entity_id = ? AND status = 'applied'`).run(id);
      this.database.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      this.ledger.audit("user", "account.delete", "account", id);
    });
  }

  resolveAccountId(value: string): string {
    const normalized = normalizeAccountName(value);
    const rows = this.database.prepare(`SELECT a.id FROM accounts a WHERE a.is_archived = 0 AND a.normalized_name = ?
      UNION
      SELECT a.id FROM account_aliases x JOIN accounts a ON a.id = x.account_id
      WHERE a.is_archived = 0 AND x.normalized_alias = ?`).all(normalized, normalized) as unknown as Array<{ id: string }>;
    if (rows.length === 0) throw new NotFoundError("没有找到这个资金账户");
    if (rows.length > 1) throw new ConflictError("账户名称或别名存在歧义，请提供账户 ID");
    return rows[0]!.id;
  }

  private activeAccount(id: string): Account {
    const account = this.getAccount(id, false);
    if (account.isArchived) throw new ConflictError("停用的账户不能用于新的资金变化");
    return account;
  }

  private isBaselineTransaction(id: string | undefined): boolean {
    if (!id) return false;
    return Boolean(this.database.prepare("SELECT 1 FROM funds_baseline_transactions WHERE transaction_id = ?").get(id));
  }

  private shouldTrackTransaction(id: string | undefined, localDate: string): boolean {
    const startedOn = this.startedOn();
    return Boolean(startedOn && localDate >= startedOn && !this.isBaselineTransaction(id));
  }

  resolveTransactionFunding(input: TransactionFundingInput): { accountId: string | null; accountAmountMinor: number | null } {
    if (!this.shouldTrackTransaction(input.transactionId, input.localDate)) {
      return { accountId: null, accountAmountMinor: null };
    }
    const accountId = input.accountId
      || this.setting(input.kind === "expense" ? "funds.default_expense_account_id" : "funds.default_income_account_id");
    if (!accountId) throw new ConflictError("请先设置默认资金账户");
    const account = this.activeAccount(accountId);
    if (account.currency === "CNY") return { accountId, accountAmountMinor: null };
    if (!Number.isSafeInteger(input.accountAmountMinor) || Number(input.accountAmountMinor) <= 0) {
      throw new ConflictError("外币账户需要填写实际账户金额");
    }
    return { accountId, accountAmountMinor: Number(input.accountAmountMinor) };
  }

  resolveTransactionAccount(kind: TransactionKind, localDate: string, requested?: string | null): string | null {
    const startedOn = this.startedOn();
    if (!startedOn || localDate < startedOn) return null;
    const accountId = requested
      || this.setting(kind === "expense" ? "funds.default_expense_account_id" : "funds.default_income_account_id");
    if (!accountId) throw new ConflictError("请先设置默认资金账户");
    if (this.activeAccount(accountId).currency !== "CNY") throw new ConflictError("这类资金变化只能使用人民币账户");
    return accountId;
  }
  assignTransactionsAccount(input: TransactionAssignmentInput): { transactions: Transaction[] } {
    if (new Set(input.transactions.map((transaction) => transaction.id)).size !== input.transactions.length) {
      throw new ConflictError("批量补录中不能包含重复账目");
    }
    const account = this.activeAccount(input.accountId);
    if (account.currency !== "CNY") throw new ConflictError("批量补录只能使用人民币账户");
    if (!this.startedOn()) throw new ConflictError("请先启用资金追踪");
    return this.savepoint(() => {
      const rows = input.transactions.map((transaction) => {
        const row = this.database.prepare(`SELECT id, local_date, account_id, refunded_at, deleted_at, updated_at
          FROM transactions WHERE id = ?`).get(transaction.id) as AssignableTransactionRow | undefined;
        if (!row) throw new NotFoundError("批量补录中的账目不存在");
        if (row.deleted_at) throw new ConflictError("已删除账目不能补录资金账户");
        if (row.refunded_at) throw new ConflictError("已退款账目不能补录资金账户");
        if (row.account_id) throw new ConflictError("已有资金账户的账目不能重复补录");
        if (!this.shouldTrackTransaction(row.id, row.local_date)) throw new ConflictError("历史基线或启用前账目不能补录资金账户");
        if (row.updated_at !== transaction.expectedUpdatedAt) throw new ConflictError("批量补录中的账目已经更新，请刷新后重试");
        return row;
      });
      const now = isoNow();
      const update = this.database.prepare(`UPDATE transactions SET account_id = ?, account_amount_minor = NULL, updated_at = ?
        WHERE id = ? AND updated_at = ? AND account_id IS NULL AND deleted_at IS NULL AND refunded_at IS NULL`);
      rows.forEach((row) => {
        const result = update.run(input.accountId, now, row.id, row.updated_at);
        if (Number(result.changes) !== 1) throw new ConflictError("批量补录中的账目已经更新，请刷新后重试");
      });
      rows.forEach((row) => this.reconcileTransaction(row.id));
      this.ledger.audit("user", "transaction.assign_account.batch", "account", input.accountId, { transactionCount: rows.length });
      return { transactions: rows.map((row) => this.ledger.getTransaction(row.id)) };
    });
  }


  private currentImpact(sourceType: SourceType, sourceId: string): DesiredImpact {
    const rows = this.database.prepare(`SELECT account_id, SUM(delta_minor) AS total FROM account_movements
      WHERE source_type = ? AND source_id = ? GROUP BY account_id`).all(sourceType, sourceId) as unknown as Array<{ account_id: string; total: number }>;
    return new Map(rows.map((row) => [row.account_id, Number(row.total)]));
  }

  reconcileSource(sourceType: SourceType, sourceId: string, desired: DesiredImpact, localDate: string, requestId?: string | null, operationId?: string | null): void {
    const current = this.currentImpact(sourceType, sourceId);
    const accountIds = new Set([...current.keys(), ...desired.keys()]);
    const now = isoNow();
    const insert = this.database.prepare(`INSERT INTO account_movements(
      id, account_id, delta_minor, source_type, source_id, local_date, request_id, operation_id, reversal_of_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
    accountIds.forEach((accountId) => {
      const difference = (desired.get(accountId) ?? 0) - (current.get(accountId) ?? 0);
      if (difference !== 0) insert.run(randomUUID(), accountId, difference, sourceType, sourceId, localDate, requestId ?? null, operationId ?? null, now);
    });
  }

  reconcileTransaction(id: string, requestId?: string | null, operationId?: string | null): void {
    const row = this.database.prepare(`SELECT id, kind, amount_minor, account_amount_minor, local_date,
      account_id, refunded_at, refund_account_id, deleted_at FROM transactions WHERE id = ?`).get(id) as {
        id: string; kind: TransactionKind; amount_minor: number; account_amount_minor: number | null;
        local_date: string; account_id: string | null; refunded_at: string | null;
        refund_account_id: string | null; deleted_at: string | null;
      } | undefined;
    if (!row) {
      this.reconcileSource("transaction", id, new Map(), this.today(), requestId, operationId);
      return;
    }
    const desired = new Map<string, number>();
    const tracked = this.shouldTrackTransaction(row.id, row.local_date);
    if (!row.deleted_at && this.isEnabled()) {
      if (!row.refunded_at && tracked && row.account_id) {
        const account = this.getAccount(row.account_id);
        const amount = account.currency === "CNY" ? Number(row.amount_minor) : Number(row.account_amount_minor);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new ConflictError("外币账户交易缺少实际账户金额");
        desired.set(row.account_id, row.kind === "expense" ? -amount : amount);
      } else if (row.refunded_at && (!tracked || !row.account_id) && row.refund_account_id) {
        const account = this.getAccount(row.refund_account_id);
        if (account.currency !== "CNY") throw new ConflictError("旧账退款只能使用人民币账户");
        desired.set(row.refund_account_id, row.kind === "expense" ? Number(row.amount_minor) : -Number(row.amount_minor));
      }
    }
    this.reconcileSource("transaction", id, desired, row.local_date, requestId, operationId);
  }

  reconcileAllSources(operationId?: string | null): void {
    const refs = new Map<string, { sourceType: SourceType; sourceId: string }>();
    const remember = (sourceType: SourceType, sourceId: string) => refs.set(`${sourceType}:${sourceId}`, { sourceType, sourceId });
    (this.database.prepare("SELECT DISTINCT source_type, source_id FROM account_movements").all() as unknown as Array<{ source_type: SourceType; source_id: string }>)
      .forEach((row) => remember(row.source_type, row.source_id));
    (this.database.prepare(`SELECT 'transaction' AS source_type, id AS source_id FROM transactions
      UNION ALL SELECT 'loan', id FROM loans
      UNION ALL SELECT 'loan_repayment', id FROM loan_repayments
      UNION ALL SELECT 'transfer', id FROM transfers
      UNION ALL SELECT 'adjustment', id FROM account_adjustments`).all() as unknown as Array<{ source_type: SourceType; source_id: string }>)
      .forEach((row) => remember(row.source_type, row.source_id));

    refs.forEach(({ sourceType, sourceId }) => {
      if (sourceType === "transaction") {
        this.reconcileTransaction(sourceId, null, operationId);
        return;
      }
      if (sourceType === "transfer") {
        const row = this.database.prepare("SELECT id FROM transfers WHERE id = ?").get(sourceId);
        if (row) this.reconcileTransfer(sourceId, null);
        else this.reconcileSource(sourceType, sourceId, new Map(), this.today(), null, operationId);
        return;
      }
      if (sourceType === "loan") {
        const row = this.database.prepare("SELECT account_id, principal_minor, local_date, deleted_at FROM loans WHERE id = ?").get(sourceId) as { account_id: string | null; principal_minor: number; local_date: string; deleted_at: string | null } | undefined;
        const active = Boolean(row && !row.deleted_at && this.startedOn() && row.local_date >= this.startedOn()!);
        this.reconcileSource(sourceType, sourceId, row ? this.desiredLoanImpact(row.account_id, Number(row.principal_minor), active) : new Map(), row?.local_date ?? this.today(), null, operationId);
        return;
      }
      if (sourceType === "loan_repayment") {
        const row = this.database.prepare("SELECT account_id, amount_minor, local_date, deleted_at FROM loan_repayments WHERE id = ?").get(sourceId) as { account_id: string | null; amount_minor: number; local_date: string; deleted_at: string | null } | undefined;
        const active = Boolean(row && !row.deleted_at && this.startedOn() && row.local_date >= this.startedOn()!);
        this.reconcileSource(sourceType, sourceId, row ? this.desiredRepaymentImpact(row.account_id, Number(row.amount_minor), active) : new Map(), row?.local_date ?? this.today(), null, operationId);
        return;
      }
      const row = this.database.prepare("SELECT account_id, delta_minor, local_date FROM account_adjustments WHERE id = ?").get(sourceId) as { account_id: string; delta_minor: number; local_date: string } | undefined;
      this.reconcileSource(sourceType, sourceId, row ? new Map([[row.account_id, Number(row.delta_minor)]]) : new Map(), row?.local_date ?? this.today(), null, operationId);
    });
  }

  preparePermanentTransactionDeletion(id: string): void {
    this.reconcileSource("transaction", id, new Map(), this.today());
    const net = this.database.prepare("SELECT COALESCE(SUM(delta_minor), 0) AS total FROM account_movements WHERE source_type = 'transaction' AND source_id = ?").get(id) as { total: number };
    if (Number(net.total) !== 0) throw new ConflictError("账目资金流水尚未归零，不能永久删除");
    this.database.prepare("DELETE FROM account_movements WHERE source_type = 'transaction' AND source_id = ?").run(id);
  }

  private movementFromRow(row: MovementRow): AccountMovement {
    return {
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      currency: row.currency,
      deltaMinor: Number(row.delta_minor),
      sourceType: row.source_type,
      sourceId: row.source_id,
      localDate: row.local_date,
      requestId: row.request_id,
      operationId: row.operation_id,
      reversalOfId: row.reversal_of_id,
      createdAt: row.created_at
    };
  }

  listMovements(rawQuery: Partial<MovementQuery> = {}): AccountMovementList {
    const query = accountMovementQuerySchema.parse(rawQuery);
    const clauses: string[] = [];
    if (!query.sourceType) clauses.push("m.source_type <> 'adjustment'");
    const values: Array<string | number> = [];
    if (query.accountId) { clauses.push("m.account_id = ?"); values.push(query.accountId); }
    if (query.sourceType) { clauses.push("m.source_type = ?"); values.push(query.sourceType); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = this.database.prepare(`SELECT COUNT(*) AS count FROM account_movements m ${where}`).get(...values) as { count: number };
    const rows = this.database.prepare(`SELECT m.*, a.name AS account_name, a.currency FROM account_movements m
      JOIN accounts a ON a.id = m.account_id ${where} ORDER BY m.created_at, m.rowid LIMIT ? OFFSET ?`)
      .all(...values, query.pageSize, (query.page - 1) * query.pageSize) as unknown as MovementRow[];
    return { items: rows.map((row) => this.movementFromRow(row)), total: Number(total.count), page: query.page, pageSize: query.pageSize };
  }

  private transferFromRow(row: TransferRow): Transfer {
    return {
      id: row.id,
      fromAccountId: row.from_account_id,
      toAccountId: row.to_account_id,
      currency: row.currency,
      debitedMinor: Number(row.debited_minor),
      creditedMinor: Number(row.credited_minor),
      feeMinor: Number(row.debited_minor) - Number(row.credited_minor),
      feeTransactionId: row.fee_transaction_id,
      localDate: row.local_date,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  getTransfer(id: string): Transfer {
    const row = this.database.prepare(`SELECT t.*, a.currency FROM transfers t
      JOIN accounts a ON a.id = t.from_account_id WHERE t.id = ?`).get(id) as TransferRow | undefined;
    if (!row) throw new NotFoundError("转账不存在");
    return this.transferFromRow(row);
  }

  listTransfers(includeDeleted = false): Transfer[] {
    const where = includeDeleted ? "" : "WHERE t.deleted_at IS NULL";
    return (this.database.prepare(`SELECT t.*, a.currency FROM transfers t JOIN accounts a ON a.id = t.from_account_id
      ${where} ORDER BY t.local_date DESC, t.created_at DESC`).all() as unknown as TransferRow[])
      .map((row) => this.transferFromRow(row));
  }

  private reconcileTransfer(id: string, requestId?: string | null): void {
    const transfer = this.getTransfer(id);
    const desired = new Map<string, number>();
    if (!transfer.deletedAt) {
      desired.set(transfer.fromAccountId, -transfer.creditedMinor);
      desired.set(transfer.toAccountId, transfer.creditedMinor);
    }
    this.reconcileSource("transfer", id, desired, transfer.localDate, requestId);
  }

  private validateTransferAccounts(fromId: string, toId: string, debitedMinor: number, creditedMinor: number): AccountCurrency {
    const from = this.activeAccount(fromId);
    const to = this.activeAccount(toId);
    if (from.currency !== to.currency) throw new ConflictError("转账账户币种必须相同");
    if (from.currency !== "CNY" && debitedMinor !== creditedMinor) {
      throw new ConflictError("外币账户转账暂不支持手续费，扣款与到账金额必须相同");
    }
    return from.currency;
  }


  createTransfer(rawInput: TransferInput): Transfer {
    const input = transferInputSchema.parse(rawInput);
    const existing = this.database.prepare("SELECT id FROM transfers WHERE request_id = ?").get(input.requestId) as { id: string } | undefined;
    if (existing) return this.getTransfer(existing.id);
    if (!this.isEnabled()) throw new ConflictError("请先启用资金追踪");
    this.validateTransferAccounts(input.fromAccountId, input.toAccountId, input.debitedMinor, input.creditedMinor);
    return this.savepoint(() => {
      const feeMinor = input.debitedMinor - input.creditedMinor;
      let feeTransactionId: string | null = null;
      if (feeMinor > 0) {
        const categoryId = input.feeCategoryId ?? this.setting("funds.default_fee_category_id");
        if (!categoryId) throw new ConflictError("请先选择手续费支出分类");
        const category = this.ledger.getCategory(categoryId);
        if (category.kind !== "expense" || category.isArchived) throw new ConflictError("手续费分类必须是可用的支出分类");
        const fee = this.ledger.createTransaction({
          kind: "expense",
          amountMinor: feeMinor,
          categoryId,
          localDate: input.localDate,
          note: input.note ? `转账手续费：${input.note}` : "转账手续费",
          accountId: input.fromAccountId
        }, { source: "user", actor: "user", idempotencyKey: `transfer-fee:${input.requestId}` });
        feeTransactionId = fee.id;
      }
      const now = isoNow();
      const id = randomUUID();
      this.database.prepare(`INSERT INTO transfers(
        id, from_account_id, to_account_id, debited_minor, credited_minor, fee_transaction_id,
        local_date, note, request_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        id, input.fromAccountId, input.toAccountId, input.debitedMinor, input.creditedMinor,
        feeTransactionId, input.localDate, input.note?.trim() || null, input.requestId, now, now
      );
      this.reconcileTransfer(id, input.requestId);
      this.ledger.audit("user", "transfer.create", "transfer", id, { hasFee: feeMinor > 0 });
      return this.getTransfer(id);
    });
  }

  updateTransfer(id: string, rawPatch: TransferPatch): Transfer {
    const input = transferPatchSchema.parse(rawPatch);
    const current = this.getTransfer(id);
    if (current.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("转账已经更新，请刷新后重试");
    if (current.deletedAt) throw new ConflictError("请先恢复这笔转账再修改");
    const merged = transferInputSchema.parse({
      fromAccountId: input.fromAccountId ?? current.fromAccountId,
      toAccountId: input.toAccountId ?? current.toAccountId,
      debitedMinor: input.debitedMinor ?? current.debitedMinor,
      creditedMinor: input.creditedMinor ?? current.creditedMinor,
      feeCategoryId: input.feeCategoryId,
      localDate: input.localDate ?? current.localDate,
      note: input.note === undefined ? current.note : input.note,
      requestId: input.requestId
    });
    this.validateTransferAccounts(merged.fromAccountId, merged.toAccountId, merged.debitedMinor, merged.creditedMinor);
    return this.savepoint(() => {
      const feeMinor = merged.debitedMinor - merged.creditedMinor;
      let feeTransactionId = current.feeTransactionId;
      if (feeMinor === 0 && feeTransactionId) {
        const fee = this.ledger.getTransaction(feeTransactionId, true);
        if (!fee.deletedAt) this.ledger.softDeleteTransaction(fee.id, "user", fee.updatedAt);
      } else if (feeMinor > 0) {
        let categoryId = merged.feeCategoryId ?? this.setting("funds.default_fee_category_id");
        if (!categoryId && feeTransactionId) {
          categoryId = this.ledger.getTransaction(feeTransactionId, true).categoryId;
        }
        if (!categoryId) throw new ConflictError("请先选择手续费支出分类");
        const category = this.ledger.getCategory(categoryId);
        if (category.kind !== "expense" || category.isArchived) throw new ConflictError("手续费分类必须是可用的支出分类");
        if (feeTransactionId) {
          let fee = this.ledger.getTransaction(feeTransactionId, true);
          if (fee.deletedAt) fee = this.ledger.restoreTransaction(fee.id);
          this.ledger.updateTransaction(fee.id, {
            amountMinor: feeMinor,
            categoryId,
            localDate: merged.localDate,
            accountId: merged.fromAccountId,
            note: merged.note ? `转账手续费：${merged.note}` : "转账手续费"
          }, "user");
        } else {
          feeTransactionId = this.ledger.createTransaction({
            kind: "expense",
            amountMinor: feeMinor,
            categoryId,
            localDate: merged.localDate,
            note: merged.note ? `转账手续费：${merged.note}` : "转账手续费",
            accountId: merged.fromAccountId
          }, { source: "user", actor: "user", idempotencyKey: `transfer-fee:${input.requestId}` }).id;
        }
      }
      const now = isoNow();
      this.database.prepare(`UPDATE transfers SET from_account_id = ?, to_account_id = ?, debited_minor = ?,
        credited_minor = ?, fee_transaction_id = ?, local_date = ?, note = ?, updated_at = ? WHERE id = ?`).run(
        merged.fromAccountId, merged.toAccountId, merged.debitedMinor, merged.creditedMinor,
        feeTransactionId, merged.localDate, merged.note?.trim() || null, now, id
      );
      this.reconcileTransfer(id, input.requestId);
      this.ledger.audit("user", "transfer.update", "transfer", id, { hasFee: feeMinor > 0 });
      return this.getTransfer(id);
    });
  }

  deleteTransfer(id: string, input: { expectedUpdatedAt: string; requestId: string }): Transfer {
    const transfer = this.getTransfer(id);
    if (transfer.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("转账已经更新，请刷新后重试");
    if (transfer.deletedAt) return transfer;
    return this.savepoint(() => {
      const now = isoNow();
      if (transfer.feeTransactionId) {
        const fee = this.ledger.getTransaction(transfer.feeTransactionId, false);
        this.ledger.softDeleteTransaction(fee.id, "user", fee.updatedAt);
      }
      this.database.prepare("UPDATE transfers SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      this.reconcileTransfer(id, input.requestId);
      this.ledger.audit("user", "transfer.delete", "transfer", id);
      return this.getTransfer(id);
    });
  }

  restoreTransfer(id: string, input: { expectedUpdatedAt: string; requestId: string }): Transfer {
    const transfer = this.getTransfer(id);
    if (transfer.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("转账已经更新，请刷新后重试");
    if (!transfer.deletedAt) return transfer;
    return this.savepoint(() => {
      if (transfer.feeTransactionId) this.ledger.restoreTransaction(transfer.feeTransactionId);
      const now = isoNow();
      this.database.prepare("UPDATE transfers SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      this.reconcileTransfer(id, input.requestId);

      this.ledger.audit("user", "transfer.restore", "transfer", id);
      return this.getTransfer(id);
    });
  }

  private adjustmentRow(id: string): AdjustmentRow | undefined {
    return this.database.prepare(`SELECT x.*, a.name AS account_name, a.currency,
      CASE WHEN x.rowid = (
        SELECT latest.rowid FROM account_adjustments latest
        WHERE latest.account_id = x.account_id
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
      ) THEN 1 ELSE 0 END AS can_undo
      FROM account_adjustments x JOIN accounts a ON a.id = x.account_id WHERE x.id = ?`)
      .get(id) as AdjustmentRow | undefined;
  }

  private adjustmentFromRow(row: AdjustmentRow): AccountAdjustment {
    return {
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      currency: row.currency,
      targetBalanceMinor: Number(row.target_balance_minor),
      deltaMinor: Number(row.delta_minor),
      balanceBeforeMinor: Number(row.target_balance_minor) - Number(row.delta_minor),
      localDate: row.local_date,
      note: row.note,
      canUndo: Boolean(row.can_undo),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listAdjustments(rawQuery: Partial<AdjustmentQuery> = {}): AccountAdjustmentList {
    const query = accountAdjustmentQuerySchema.parse(rawQuery);
    const where = query.accountId ? "WHERE x.account_id = ?" : "";
    const values = query.accountId ? [query.accountId] : [];
    const total = this.database.prepare(`SELECT COUNT(*) AS count FROM account_adjustments x ${where}`)
      .get(...values) as { count: number };
    const rows = this.database.prepare(`SELECT x.*, a.name AS account_name, a.currency,
      CASE WHEN x.rowid = (
        SELECT latest.rowid FROM account_adjustments latest
        WHERE latest.account_id = x.account_id
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
      ) THEN 1 ELSE 0 END AS can_undo
      FROM account_adjustments x JOIN accounts a ON a.id = x.account_id
      ${where} ORDER BY x.created_at DESC, x.rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, query.pageSize, (query.page - 1) * query.pageSize) as unknown as AdjustmentRow[];
    return {
      items: rows.map((row) => this.adjustmentFromRow(row)),
      total: Number(total.count),
      page: query.page,
      pageSize: query.pageSize
    };
  }

  private createAdjustment(input: AdjustmentInput, actor: "user" | "openclaw"): AccountAdjustment {
    const normalizedNote = input.note?.trim() || null;
    const requestKey = `funds.adjustment_request.${input.requestId}`;
    const requestHash = hashRequest({
      accountId: input.accountId,
      targetBalanceMinor: input.targetBalanceMinor,
      localDate: input.localDate,
      note: normalizedNote,
      requestId: input.requestId
    });
    const recorded = this.persistentRequest<AccountAdjustment>(requestKey);
    if (recorded) {
      if (recorded.hash !== requestHash) throw new ConflictError("requestId 已用于另一笔余额校准");
      if (recorded.status === "undone") return { ...recorded.result, canUndo: false };
      const live = this.adjustmentRow(recorded.result.id);
      if (!live) throw new ConflictError("余额校准幂等记录与账本状态不一致");
      return this.adjustmentFromRow(live);
    }

    const existing = this.database.prepare("SELECT id FROM account_adjustments WHERE request_id = ?")
      .get(input.requestId) as { id: string } | undefined;
    if (existing) {
      const row = this.adjustmentRow(existing.id)!;
      if (row.account_id !== input.accountId
        || Number(row.target_balance_minor) !== input.targetBalanceMinor
        || row.local_date !== input.localDate
        || row.note !== normalizedNote) {
        throw new ConflictError("requestId 已用于另一笔余额校准");
      }
      const result = this.adjustmentFromRow(row);
      this.setPersistentRequest(requestKey, { hash: requestHash, result, status: "applied" });
      return result;
    }

    const account = this.activeAccount(input.accountId);
    const delta = input.targetBalanceMinor - account.balanceMinor;
    if (delta === 0) throw new ConflictError("实际余额与当前余额相同，无需校准");
    const now = isoNow();
    const id = randomUUID();
    this.database.prepare(`INSERT INTO account_adjustments(
      id, account_id, target_balance_minor, delta_minor, local_date, note, request_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.accountId, input.targetBalanceMinor, delta, input.localDate, normalizedNote, input.requestId, now, now
    );
    this.reconcileSource("adjustment", id, new Map([[input.accountId, delta]]), input.localDate, input.requestId);
    this.ledger.audit(actor, "account.adjust", "account_adjustment", id);
    const result = this.adjustmentFromRow(this.adjustmentRow(id)!);
    this.setPersistentRequest(requestKey, { hash: requestHash, result, status: "applied" }, now);
    return result;
  }

  adjustAccount(rawInput: AdjustmentInput): AccountAdjustment {
    const input = adjustmentInputSchema.parse(rawInput);
    return this.savepoint(() => this.createAdjustment(input, "user"));
  }

  private undoAdjustmentInternal(id: string, actor: "user" | "openclaw", requestId?: string): Account {
    const current = this.adjustmentRow(id);
    if (!current) throw new NotFoundError("余额校准不存在");
    if (!current.can_undo) throw new ConflictError("只能撤销该账户最新的一条余额校准");

    const adjustmentSnapshot = this.adjustmentFromRow(current);
    const createRequestKey = current.request_id ? `funds.adjustment_request.${current.request_id}` : null;
    const createRequestHash = current.request_id ? hashRequest({
      accountId: current.account_id,
      targetBalanceMinor: Number(current.target_balance_minor),
      localDate: current.local_date,
      note: current.note,
      requestId: current.request_id
    }) : null;
    if (createRequestKey && createRequestHash) {
      const recorded = this.persistentRequest<AccountAdjustment>(createRequestKey);
      if (recorded && recorded.hash !== createRequestHash) {
        throw new ConflictError("余额校准幂等记录与账本状态不一致");
      }
    }

    this.reconcileSource("adjustment", id, new Map(), current.local_date, requestId);
    this.database.prepare("DELETE FROM account_adjustments WHERE id = ?").run(id);
    if (actor === "user") {
      this.database.prepare(`UPDATE openclaw_operations SET undoable = 0
        WHERE entity_type = 'account_adjustment' AND entity_id = ? AND status = 'applied'`).run(id);
    }
    if (createRequestKey && createRequestHash) {
      this.setPersistentRequest(createRequestKey, {
        hash: createRequestHash,
        result: { ...adjustmentSnapshot, canUndo: false },
        status: "undone"
      });
    }
    this.ledger.audit(actor, "account.adjust.undo", "account_adjustment", id, {
      accountId: current.account_id,
      requestId: requestId ?? null
    });
    return this.getAccount(current.account_id);
  }

  undoLatestAdjustment(id: string, input: { expectedUpdatedAt: string; requestId: string }): Account {
    const requestKey = `funds.adjustment_undo_request.${input.requestId}`;
    const requestHash = hashRequest({ adjustmentId: id, expectedUpdatedAt: input.expectedUpdatedAt });
    const replay = this.persistentRequest<Account>(requestKey);
    if (replay) {
      if (replay.hash !== requestHash) throw new ConflictError("requestId 已用于撤销另一笔余额校准");
      return replay.result;
    }
    return this.savepoint(() => {
      const current = this.adjustmentRow(id);
      if (!current) throw new NotFoundError("余额校准不存在");
      if (current.updated_at !== input.expectedUpdatedAt) throw new ConflictError("余额校准已经更新，请刷新后重试");
      const account = this.undoAdjustmentInternal(id, "user", input.requestId);
      this.setPersistentRequest(requestKey, { hash: requestHash, result: account, status: "applied" });
      return account;
    });
  }

  undoAdjustment(id: string): void {
    this.savepoint(() => {
      this.undoAdjustmentInternal(id, "openclaw");
    });
  }


  refundTransaction(id: string, rawInput: RefundInput): Transaction {
    const input = transactionRefundSchema.parse(rawInput);
    const transaction = this.ledger.getTransaction(id, false);
    if (transaction.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("这笔账已经更新，请刷新后重试");
    if (transaction.refundedAt) throw new ConflictError("这笔账已经退款");
    const linkedPayment = this.database.prepare(`SELECT p.id, p.subscription_id, p.created_at,
      p.next_billing_date_before, p.next_billing_date_after, s.next_billing_date AS subscription_next
      FROM subscription_payments p JOIN subscriptions s ON s.id = p.subscription_id
      WHERE p.ledger_transaction_id = ? AND p.deleted_at IS NULL AND p.refunded_at IS NULL`).get(id) as {
        id: string; subscription_id: string; created_at: string; next_billing_date_before: string | null;
        next_billing_date_after: string | null; subscription_next: string | null;
      } | undefined;
    if (linkedPayment) {
      const later = this.database.prepare(`SELECT COUNT(*) AS count FROM subscription_payments
        WHERE subscription_id = ? AND id <> ? AND deleted_at IS NULL AND refunded_at IS NULL AND created_at > ?`)
        .get(linkedPayment.subscription_id, linkedPayment.id, linkedPayment.created_at) as { count: number };
      if (Number(later.count) > 0) throw new ConflictError("这笔订阅付款之后已有新续费，不能直接退款");
      if (linkedPayment.next_billing_date_before !== linkedPayment.next_billing_date_after
        && linkedPayment.subscription_next !== linkedPayment.next_billing_date_after) {
        throw new ConflictError("订阅续费日期后来已经改变，不能覆盖新状态");
      }
    }
    let refundAccountId = transaction.accountId;
    if (!transaction.accountId || !this.shouldTrackTransaction(transaction.id, transaction.localDate)) {
      if (!input.accountId) throw new ConflictError("这笔旧账退款时需要选择实际收款账户");
      const refundAccount = this.activeAccount(input.accountId);
      if (refundAccount.currency !== "CNY") throw new ConflictError("旧账退款只能使用人民币账户");
      refundAccountId = refundAccount.id;
    }
    return this.savepoint(() => {
      const now = isoNow();
      const result = this.database.prepare(`UPDATE transactions SET refunded_at = ?, refund_account_id = ?, updated_at = ?
        WHERE id = ? AND updated_at = ? AND refunded_at IS NULL AND deleted_at IS NULL`).run(
        now, refundAccountId, now, id, input.expectedUpdatedAt
      );
      if (Number(result.changes) !== 1) throw new ConflictError("这笔账已经更新，请刷新后重试");
      if (linkedPayment) {
        this.database.prepare("UPDATE subscription_payments SET refunded_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, linkedPayment.id);
        if (linkedPayment.next_billing_date_before !== linkedPayment.next_billing_date_after) {
          this.database.prepare("UPDATE subscriptions SET next_billing_date = ?, updated_at = ? WHERE id = ?")
            .run(linkedPayment.next_billing_date_before, now, linkedPayment.subscription_id);
        }
      }
      this.reconcileTransaction(id, input.requestId);
      this.ledger.audit("user", "transaction.refund", "transaction", id);
      return this.ledger.getTransaction(id);
    });
  }

  undoTransactionRefund(id: string, rawInput: RefundInput): Transaction {
    const input = transactionRefundSchema.parse(rawInput);
    const transaction = this.ledger.getTransaction(id, false);
    if (transaction.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("这笔账已经更新，请刷新后重试");
    if (!transaction.refundedAt) throw new ConflictError("这笔账尚未退款");
    const linkedPayment = this.database.prepare(`SELECT p.id, p.subscription_id,
      p.next_billing_date_before, p.next_billing_date_after, s.next_billing_date AS subscription_next
      FROM subscription_payments p JOIN subscriptions s ON s.id = p.subscription_id
      WHERE p.ledger_transaction_id = ? AND p.deleted_at IS NULL AND p.refunded_at IS NOT NULL`).get(id) as {
        id: string; subscription_id: string; next_billing_date_before: string | null;
        next_billing_date_after: string | null; subscription_next: string | null;
      } | undefined;
    if (linkedPayment && linkedPayment.next_billing_date_before !== linkedPayment.next_billing_date_after
      && linkedPayment.subscription_next !== linkedPayment.next_billing_date_before) {
      throw new ConflictError("订阅续费日期后来已经改变，不能撤销退款");
    }
    return this.savepoint(() => {
      const now = isoNow();
      const result = this.database.prepare(`UPDATE transactions SET refunded_at = NULL, refund_account_id = NULL, updated_at = ?
        WHERE id = ? AND updated_at = ? AND refunded_at IS NOT NULL AND deleted_at IS NULL`).run(now, id, input.expectedUpdatedAt);
      if (Number(result.changes) !== 1) throw new ConflictError("这笔账已经更新，请刷新后重试");
      if (linkedPayment) {
        this.database.prepare("UPDATE subscription_payments SET refunded_at = NULL, updated_at = ? WHERE id = ?")
          .run(now, linkedPayment.id);
        if (linkedPayment.next_billing_date_before !== linkedPayment.next_billing_date_after) {
          this.database.prepare("UPDATE subscriptions SET next_billing_date = ?, updated_at = ? WHERE id = ?")
            .run(linkedPayment.next_billing_date_after, now, linkedPayment.subscription_id);
        }
      }
      this.reconcileTransaction(id, input.requestId);
      this.ledger.audit("user", "transaction.refund.undo", "transaction", id);
      return this.ledger.getTransaction(id);
    });
  }
  exportData(): Record<string, unknown> {
    const accounts = this.database.prepare(`SELECT id, name, icon, currency, opening_balance_minor AS openingBalanceMinor,
      opened_on AS openedOn, is_archived AS isArchived, created_at AS createdAt, updated_at AS updatedAt
      FROM accounts ORDER BY created_at, id`).all();
    const aliases = this.database.prepare(`SELECT account_id AS accountId, alias, created_at AS createdAt
      FROM account_aliases ORDER BY account_id, created_at, id`).all();
    const movements = this.database.prepare(`SELECT m.id, m.account_id AS accountId, a.currency,
      m.delta_minor AS deltaMinor, m.source_type AS sourceType, m.source_id AS sourceId,
      m.local_date AS localDate, m.request_id AS requestId, m.operation_id AS operationId,
      m.reversal_of_id AS reversalOfId, m.created_at AS createdAt
      FROM account_movements m JOIN accounts a ON a.id = m.account_id ORDER BY m.created_at, m.rowid`).all();
    const transfers = this.database.prepare(`SELECT t.id, t.from_account_id AS fromAccountId,
      t.to_account_id AS toAccountId, a.currency, t.debited_minor AS debitedMinor,
      t.credited_minor AS creditedMinor, t.fee_transaction_id AS feeTransactionId,
      t.local_date AS localDate, t.note, t.request_id AS requestId, t.created_at AS createdAt,
      t.updated_at AS updatedAt, t.deleted_at AS deletedAt FROM transfers t
      JOIN accounts a ON a.id = t.from_account_id ORDER BY t.created_at, t.id`).all();
    const adjustments = this.database.prepare(`SELECT x.id, x.account_id AS accountId, a.currency,
      x.target_balance_minor AS targetBalanceMinor, x.delta_minor AS deltaMinor, x.local_date AS localDate,
      x.note, x.request_id AS requestId, x.created_at AS createdAt, x.updated_at AS updatedAt
      FROM account_adjustments x JOIN accounts a ON a.id = x.account_id ORDER BY x.created_at, x.id`).all();
    const baselineTransactions = this.database.prepare(`SELECT transaction_id AS transactionId, captured_at AS capturedAt
      FROM funds_baseline_transactions ORDER BY captured_at, transaction_id`).all();
    return {
      funds: {
        enabled: this.isEnabled(),
        startedOn: this.startedOn(),
        accounts,
        aliases,
        movements,
        transfers,
        adjustments,
        baselineTransactions
      }
    };
  }


  desiredLoanImpact(accountId: string | null, amountMinor: number, active: boolean): DesiredImpact {
    return active && accountId ? new Map([[accountId, -amountMinor]]) : new Map();
  }

  desiredRepaymentImpact(accountId: string | null, amountMinor: number, active: boolean): DesiredImpact {
    return active && accountId ? new Map([[accountId, amountMinor]]) : new Map();
  }
}
