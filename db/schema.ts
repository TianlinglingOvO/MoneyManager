import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["expense", "income"] }).notNull(),
  name: text("name").notNull(),
  icon: text("icon").notNull(),
  color: text("color").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("idx_categories_kind_name").on(table.kind, table.name),
  index("idx_categories_kind_order").on(table.kind, table.sortOrder)
]);

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["expense", "income"] }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull().default("CNY"),
  categoryId: text("category_id").notNull().references(() => categories.id),
  legacyOccurredDate: text("occurred_at").notNull(),
  localDate: text("local_date").notNull(),
  note: text("note"),
  source: text("source", { enum: ["user", "openclaw", "system"] }).notNull().default("user"),
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at")
}, (table) => [
  uniqueIndex("idx_transactions_idempotency").on(table.idempotencyKey),
  index("idx_transactions_active_date").on(table.deletedAt, table.localDate),
  index("idx_transactions_kind_date").on(table.kind, table.localDate),
  index("idx_transactions_category_date").on(table.categoryId, table.localDate)
]);

export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  action: text("action", { enum: ["create", "update", "delete"] }).notNull(),
  targetTransactionId: text("target_transaction_id"),
  payload: text("payload").notNull(),
  reason: text("reason"),
  source: text("source", { enum: ["openclaw", "system"] }).notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "expired"] }).notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  resolvedAt: text("resolved_at")
}, (table) => [
  index("idx_proposals_status_created").on(table.status, table.createdAt)
]);

export const aiReports = sqliteTable("ai_reports", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  question: text("question"),
  dataHash: text("data_hash").notNull(),
  transactionCount: integer("transaction_count").notNull(),
  model: text("model").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("idx_ai_reports_period").on(table.periodStart, table.periodEnd, table.createdAt)
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  actor: text("actor", { enum: ["user", "openclaw", "system"] }).notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("idx_audit_created").on(table.createdAt)
]);

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull()
});

export const openClawOperations = sqliteTable("openclaw_operations", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  status: text("status", { enum: ["running", "applied", "undone"] }).notNull(),
  undoable: integer("undoable", { mode: "boolean" }).notNull().default(true),
  summary: text("summary").notNull(),
  resultJson: text("result_json"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  undoneAt: text("undone_at")
}, (table) => [
  uniqueIndex("idx_openclaw_operations_request_id").on(table.requestId),
  index("idx_openclaw_operations_created").on(table.createdAt),
  index("idx_openclaw_operations_status_expires").on(table.status, table.expiresAt)
]);

export const openClawOperationItems = sqliteTable("openclaw_operation_items", {
  id: text("id").primaryKey(),
  operationId: text("operation_id").notNull().references(() => openClawOperations.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  entityType: text("entity_type", { enum: ["transaction", "category", "proposal", "setting", "borrower", "loan", "loan_repayment", "subscription", "subscription_payment"] }).notNull(),
  entityId: text("entity_id").notNull(),
  beforeJson: text("before_json"),
  afterJson: text("after_json")
}, (table) => [
  uniqueIndex("idx_openclaw_operation_items_sequence").on(table.operationId, table.sequence)
]);

export const borrowers = sqliteTable("borrowers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  note: text("note"),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at")
}, (table) => [
  index("idx_borrowers_active_name").on(table.deletedAt, table.name)
]);

export const loans = sqliteTable("loans", {
  id: text("id").primaryKey(),
  borrowerId: text("borrower_id").notNull().references(() => borrowers.id),
  principalMinor: integer("principal_minor").notNull(),
  localDate: text("local_date").notNull(),
  purpose: text("purpose"),
  note: text("note"),
  ledgerLinkMode: text("ledger_link_mode", { enum: ["none", "existing", "create"] }).notNull().default("none"),
  ledgerTransactionId: text("ledger_transaction_id").references(() => transactions.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at")
}, (table) => [
  index("idx_loans_borrower_date").on(table.borrowerId, table.localDate),
  index("idx_loans_deleted_date").on(table.deletedAt, table.localDate),
  uniqueIndex("idx_loans_ledger_transaction").on(table.ledgerTransactionId)
]);

export const loanRepayments = sqliteTable("loan_repayments", {
  id: text("id").primaryKey(),
  loanId: text("loan_id").notNull().references(() => loans.id, { onDelete: "cascade" }),
  amountMinor: integer("amount_minor").notNull(),
  localDate: text("local_date").notNull(),
  note: text("note"),
  ledgerLinkMode: text("ledger_link_mode", { enum: ["none", "existing", "create"] }).notNull().default("none"),
  ledgerTransactionId: text("ledger_transaction_id").references(() => transactions.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at")
}, (table) => [
  index("idx_loan_repayments_loan_date").on(table.loanId, table.localDate),
  uniqueIndex("idx_loan_repayments_ledger_transaction").on(table.ledgerTransactionId)
]);

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan"),
  startDate: text("start_date").notNull(),
  recurringAmountMinor: integer("recurring_amount_minor").notNull(),
  currency: text("currency", { enum: ["CNY", "USD"] }).notNull(),
  cycle: text("cycle", { enum: ["month", "year", "custom"] }).notNull(),
  customDays: integer("custom_days"),
  nextBillingDate: text("next_billing_date"),
  reminderDays: integer("reminder_days").notNull().default(3),
  status: text("status", { enum: ["active", "paused", "cancelled"] }).notNull().default("active"),
  website: text("website"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at")
}, (table) => [
  index("idx_subscriptions_status_next").on(table.deletedAt, table.status, table.nextBillingDate),
  index("idx_subscriptions_name").on(table.name)
]);

export const subscriptionPayments = sqliteTable("subscription_payments", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency", { enum: ["CNY", "USD"] }).notNull(),
  localDate: text("local_date").notNull(),
  note: text("note"),
  paymentType: text("payment_type", { enum: ["initial", "renewal", "manual"] }).notNull(),
  ledgerLinkMode: text("ledger_link_mode", { enum: ["none", "existing", "create"] }).notNull().default("none"),
  ledgerTransactionId: text("ledger_transaction_id").references(() => transactions.id),
  nextBillingDateBefore: text("next_billing_date_before"),
  nextBillingDateAfter: text("next_billing_date_after"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at")
}, (table) => [
  index("idx_subscription_payments_subscription_date").on(table.subscriptionId, table.localDate),
  uniqueIndex("idx_subscription_payments_ledger_transaction").on(table.ledgerTransactionId)
]);

export const matterIdempotency = sqliteTable("matter_idempotency", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  operation: text("operation").notNull(),
  requestHash: text("request_hash").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("idx_matter_idempotency_created").on(table.createdAt)]);
