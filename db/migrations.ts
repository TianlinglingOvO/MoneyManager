export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_ledger",
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
        name TEXT NOT NULL,
        icon TEXT NOT NULL,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_kind_name ON categories(kind, name COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_categories_kind_order ON categories(kind, sort_order)",
      `CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
        category_id TEXT NOT NULL REFERENCES categories(id),
        occurred_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        note TEXT,
        source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'openclaw', 'system')),
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_transactions_active_date ON transactions(deleted_at, local_date)",
      "CREATE INDEX IF NOT EXISTS idx_transactions_kind_date ON transactions(kind, local_date)",
      "CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions(category_id, local_date)",
      `CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
        target_transaction_id TEXT,
        payload TEXT NOT NULL,
        reason TEXT,
        source TEXT NOT NULL CHECK (source IN ('openclaw', 'system')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS idx_proposals_status_created ON proposals(status, created_at)",
      `CREATE TABLE IF NOT EXISTS ai_reports (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        question TEXT,
        data_hash TEXT NOT NULL,
        transaction_count INTEGER NOT NULL,
        model TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_ai_reports_period ON ai_reports(period_start, period_end, created_at)",
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL CHECK (actor IN ('user', 'openclaw', 'system')),
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)"
    ]
  },
  {
    version: 2,
    name: "date_only_and_remove_seeded_categories",
    statements: [
      "UPDATE transactions SET occurred_at = local_date WHERE occurred_at != local_date",
      `DELETE FROM categories
        WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE transactions.category_id = categories.id)
          AND (kind, name, icon, color) IN (
            ('expense','餐饮','🍚','#D66A4C'), ('expense','饮料','🥤','#B66A8C'),
            ('expense','日用','🧴','#6B8E7C'), ('expense','购物','🛍️','#9A6FB0'),
            ('expense','零食','🍪','#D49B45'), ('expense','交通','🚌','#4E87A6'),
            ('expense','住房','🏠','#8A745D'), ('expense','游戏','🎮','#5963A6'),
            ('expense','医疗','🩺','#C55462'), ('expense','教育','📚','#4D8A82'),
            ('expense','其他','✦','#7A7A73'), ('income','工资','💼','#2E7D61'),
            ('income','奖金','🧧','#B85B48'), ('income','兼职','🧑‍💻','#4F7D96'),
            ('income','理财','📈','#768B3F'), ('income','退款','↩️','#6B7F9A'),
            ('income','其他','✦','#7A7A73')
          )`,
      `UPDATE categories SET is_archived = 1, updated_at = CURRENT_TIMESTAMP
        WHERE EXISTS (SELECT 1 FROM transactions WHERE transactions.category_id = categories.id)
          AND (kind, name, icon, color) IN (
            ('expense','餐饮','🍚','#D66A4C'), ('expense','饮料','🥤','#B66A8C'),
            ('expense','日用','🧴','#6B8E7C'), ('expense','购物','🛍️','#9A6FB0'),
            ('expense','零食','🍪','#D49B45'), ('expense','交通','🚌','#4E87A6'),
            ('expense','住房','🏠','#8A745D'), ('expense','游戏','🎮','#5963A6'),
            ('expense','医疗','🩺','#C55462'), ('expense','教育','📚','#4D8A82'),
            ('expense','其他','✦','#7A7A73'), ('income','工资','💼','#2E7D61'),
            ('income','奖金','🧧','#B85B48'), ('income','兼职','🧑‍💻','#4F7D96'),
            ('income','理财','📈','#768B3F'), ('income','退款','↩️','#6B7F9A'),
            ('income','其他','✦','#7A7A73')
          )`
    ]
  },
  {
    version: 3,
    name: "proposal_revisions",
    statements: [
      "ALTER TABLE proposals ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)",
      "ALTER TABLE proposals ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
      "UPDATE proposals SET updated_at = created_at WHERE updated_at = ''"
    ]
  },
  {
    version: 4,
    name: "openclaw_direct_operations",
    statements: [
      `CREATE TABLE IF NOT EXISTS openclaw_operations (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'applied', 'undone')),
        undoable INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        undone_at TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS idx_openclaw_operations_created ON openclaw_operations(created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_openclaw_operations_status_expires ON openclaw_operations(status, expires_at)",
      `CREATE TABLE IF NOT EXISTS openclaw_operation_items (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES openclaw_operations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('transaction', 'category', 'proposal', 'setting')),
        entity_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_openclaw_operation_items_sequence ON openclaw_operation_items(operation_id, sequence)",
      `INSERT INTO settings(key, value, updated_at)
        VALUES ('openclaw.mode', 'confirm', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO NOTHING`
    ]
  },
  {
    version: 5,
    name: "financial_matters",
    statements: [
      `CREATE TABLE IF NOT EXISTS matter_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_matter_idempotency_created ON matter_idempotency(created_at)",
      `CREATE TABLE IF NOT EXISTS borrowers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        note TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS idx_borrowers_active_name ON borrowers(deleted_at, name)",
      `CREATE TABLE IF NOT EXISTS loans (
        id TEXT PRIMARY KEY,
        borrower_id TEXT NOT NULL REFERENCES borrowers(id),
        principal_minor INTEGER NOT NULL CHECK (principal_minor > 0),
        local_date TEXT NOT NULL,
        purpose TEXT,
        note TEXT,
        ledger_link_mode TEXT NOT NULL DEFAULT 'none' CHECK (ledger_link_mode IN ('none', 'existing', 'create')),
        ledger_transaction_id TEXT REFERENCES transactions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS idx_loans_borrower_date ON loans(borrower_id, local_date)",
      "CREATE INDEX IF NOT EXISTS idx_loans_deleted_date ON loans(deleted_at, local_date)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_loans_ledger_transaction ON loans(ledger_transaction_id) WHERE ledger_transaction_id IS NOT NULL",
      `CREATE TABLE IF NOT EXISTS loan_repayments (
        id TEXT PRIMARY KEY,
        loan_id TEXT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        local_date TEXT NOT NULL,
        note TEXT,
        ledger_link_mode TEXT NOT NULL DEFAULT 'none' CHECK (ledger_link_mode IN ('none', 'existing', 'create')),
        ledger_transaction_id TEXT REFERENCES transactions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan_date ON loan_repayments(loan_id, local_date)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_repayments_ledger_transaction ON loan_repayments(ledger_transaction_id) WHERE ledger_transaction_id IS NOT NULL",
      `CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plan TEXT,
        start_date TEXT NOT NULL,
        recurring_amount_minor INTEGER NOT NULL CHECK (recurring_amount_minor > 0),
        currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD')),
        cycle TEXT NOT NULL CHECK (cycle IN ('month', 'year', 'custom')),
        custom_days INTEGER CHECK (custom_days IS NULL OR (custom_days > 0 AND custom_days <= 366)),
        next_billing_date TEXT,
        reminder_days INTEGER NOT NULL DEFAULT 3 CHECK (reminder_days >= 0 AND reminder_days <= 60),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
        website TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        CHECK ((cycle = 'custom' AND custom_days IS NOT NULL) OR (cycle IN ('month', 'year') AND custom_days IS NULL))
      )`,
      "CREATE INDEX IF NOT EXISTS idx_subscriptions_status_next ON subscriptions(deleted_at, status, next_billing_date)",
      "CREATE INDEX IF NOT EXISTS idx_subscriptions_name ON subscriptions(name)",
      `CREATE TABLE IF NOT EXISTS subscription_payments (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD')),
        local_date TEXT NOT NULL,
        note TEXT,
        payment_type TEXT NOT NULL CHECK (payment_type IN ('initial', 'renewal', 'manual')),
        ledger_link_mode TEXT NOT NULL DEFAULT 'none' CHECK (ledger_link_mode IN ('none', 'existing', 'create')),
        ledger_transaction_id TEXT REFERENCES transactions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscription_date ON subscription_payments(subscription_id, local_date)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_ledger_transaction ON subscription_payments(ledger_transaction_id) WHERE ledger_transaction_id IS NOT NULL",
      `ALTER TABLE openclaw_operation_items RENAME TO openclaw_operation_items_legacy`,
      `CREATE TABLE openclaw_operation_items (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES openclaw_operations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('transaction', 'category', 'proposal', 'setting', 'borrower', 'loan', 'loan_repayment', 'subscription', 'subscription_payment')),
        entity_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT
      )`,
      `INSERT INTO openclaw_operation_items(id, operation_id, sequence, entity_type, entity_id, before_json, after_json)
        SELECT id, operation_id, sequence, entity_type, entity_id, before_json, after_json FROM openclaw_operation_items_legacy`,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_openclaw_operation_items_sequence ON openclaw_operation_items(operation_id, sequence)",
      "DROP TABLE openclaw_operation_items_legacy"
    ]
  },
  {
    version: 6,
    name: "subscription_payment_schedule_history",
    statements: [
      "ALTER TABLE subscription_payments ADD COLUMN next_billing_date_before TEXT",
      "ALTER TABLE subscription_payments ADD COLUMN next_billing_date_after TEXT"
    ]
  },
  {
    version: 7,
    name: "budgets_health_and_batch_operations",
    statements: [
      `CREATE TABLE IF NOT EXISTS monthly_budgets (
        month TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
        total_minor INTEGER CHECK (total_minor IS NULL OR total_minor > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS category_monthly_budgets (
        month TEXT NOT NULL REFERENCES monthly_budgets(month) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(month, category_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_category_monthly_budgets_category ON category_monthly_budgets(category_id, month)",
      `CREATE TABLE IF NOT EXISTS health_acknowledgements (
        fingerprint TEXT PRIMARY KEY,
        issue_type TEXT NOT NULL,
        acknowledged_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_health_acknowledgements_time ON health_acknowledgements(acknowledged_at)",
      "ALTER TABLE openclaw_operation_items RENAME TO openclaw_operation_items_legacy_v7",
      `CREATE TABLE openclaw_operation_items (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES openclaw_operations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('transaction', 'category', 'proposal', 'setting', 'borrower', 'loan', 'loan_repayment', 'subscription', 'subscription_payment', 'budget')),
        entity_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT
      )`,
      `INSERT INTO openclaw_operation_items(id, operation_id, sequence, entity_type, entity_id, before_json, after_json)
        SELECT id, operation_id, sequence, entity_type, entity_id, before_json, after_json
        FROM openclaw_operation_items_legacy_v7`,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_openclaw_operation_items_sequence ON openclaw_operation_items(operation_id, sequence)",
      "DROP TABLE openclaw_operation_items_legacy_v7"
    ]
  },
  {
    version: 8,
    name: "trust_closure",
    statements: [
      "ALTER TABLE ai_reports ADD COLUMN include_notes INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE proposals ADD COLUMN request_id TEXT",
      "ALTER TABLE proposals ADD COLUMN request_hash TEXT",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_request_id ON proposals(request_id) WHERE request_id IS NOT NULL",
      "ALTER TABLE openclaw_operation_items RENAME TO openclaw_operation_items_legacy_v8",
      "ALTER TABLE openclaw_operations RENAME TO openclaw_operations_legacy_v8",
      `CREATE TABLE openclaw_operations (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'applied', 'undone', 'failed')),
        undoable INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        undone_at TEXT,
        failed_at TEXT
      )`,
      `CREATE TABLE openclaw_operation_items (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES openclaw_operations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('transaction', 'category', 'proposal', 'setting', 'borrower', 'loan', 'loan_repayment', 'subscription', 'subscription_payment', 'budget')),
        entity_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT
      )`,
      `INSERT INTO openclaw_operations(
        id, request_id, request_hash, action, entity_type, entity_id, status, undoable,
        summary, result_json, created_at, expires_at, undone_at, failed_at
      ) SELECT id, request_id, request_hash, action, entity_type, entity_id, status, undoable,
        summary, result_json, created_at, expires_at, undone_at, NULL
        FROM openclaw_operations_legacy_v8`,
      `INSERT INTO openclaw_operation_items(id, operation_id, sequence, entity_type, entity_id, before_json, after_json)
        SELECT id, operation_id, sequence, entity_type, entity_id, before_json, after_json
        FROM openclaw_operation_items_legacy_v8`,
      "DROP TABLE openclaw_operation_items_legacy_v8",
      "DROP TABLE openclaw_operations_legacy_v8",
      "CREATE INDEX IF NOT EXISTS idx_openclaw_operations_created ON openclaw_operations(created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_openclaw_operations_status_expires ON openclaw_operations(status, expires_at)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_openclaw_operation_items_sequence ON openclaw_operation_items(operation_id, sequence)"
    ]
  },
  {
    version: 9,
    name: "lightweight_funds",
    statements: [
      `CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        icon TEXT NOT NULL,
        opening_balance_minor INTEGER NOT NULL,
        opened_on TEXT NOT NULL,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      "CREATE UNIQUE INDEX idx_accounts_active_name ON accounts(normalized_name) WHERE is_archived = 0",
      "CREATE INDEX idx_accounts_archived_name ON accounts(is_archived, name)",
      `CREATE TABLE account_aliases (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(account_id, normalized_alias)
      )`,
      "CREATE INDEX idx_account_aliases_normalized ON account_aliases(normalized_alias)",
      "ALTER TABLE transactions ADD COLUMN account_id TEXT REFERENCES accounts(id)",
      "ALTER TABLE transactions ADD COLUMN refunded_at TEXT",
      "ALTER TABLE transactions ADD COLUMN refund_account_id TEXT REFERENCES accounts(id)",
      "ALTER TABLE loans ADD COLUMN account_id TEXT REFERENCES accounts(id)",
      "ALTER TABLE loan_repayments ADD COLUMN account_id TEXT REFERENCES accounts(id)",
      "ALTER TABLE subscription_payments ADD COLUMN refunded_at TEXT",
      `CREATE TABLE transfers (
        id TEXT PRIMARY KEY,
        from_account_id TEXT NOT NULL REFERENCES accounts(id),
        to_account_id TEXT NOT NULL REFERENCES accounts(id),
        debited_minor INTEGER NOT NULL CHECK (debited_minor > 0),
        credited_minor INTEGER NOT NULL CHECK (credited_minor > 0),
        fee_transaction_id TEXT REFERENCES transactions(id),
        local_date TEXT NOT NULL,
        note TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        CHECK (from_account_id != to_account_id),
        CHECK (debited_minor >= credited_minor)
      )`,
      "CREATE UNIQUE INDEX idx_transfers_request_id ON transfers(request_id) WHERE request_id IS NOT NULL",
      "CREATE INDEX idx_transfers_date ON transfers(deleted_at, local_date)",
      `CREATE TABLE account_adjustments (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        target_balance_minor INTEGER NOT NULL,
        delta_minor INTEGER NOT NULL,
        local_date TEXT NOT NULL,
        note TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      "CREATE UNIQUE INDEX idx_account_adjustments_request_id ON account_adjustments(request_id) WHERE request_id IS NOT NULL",
      "CREATE INDEX idx_account_adjustments_account_date ON account_adjustments(account_id, local_date)",
      `CREATE TABLE account_movements (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        delta_minor INTEGER NOT NULL CHECK (delta_minor != 0),
        source_type TEXT NOT NULL CHECK (source_type IN ('transaction', 'loan', 'loan_repayment', 'transfer', 'adjustment')),
        source_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        request_id TEXT,
        operation_id TEXT REFERENCES openclaw_operations(id),
        reversal_of_id TEXT REFERENCES account_movements(id),
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX idx_account_movements_account_date ON account_movements(account_id, local_date, created_at)",
      "CREATE INDEX idx_account_movements_source ON account_movements(source_type, source_id)",
      "ALTER TABLE openclaw_operation_items RENAME TO openclaw_operation_items_legacy_v9",
      `CREATE TABLE openclaw_operation_items (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES openclaw_operations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('transaction', 'category', 'proposal', 'setting', 'borrower', 'loan', 'loan_repayment', 'subscription', 'subscription_payment', 'budget', 'account', 'transfer', 'account_adjustment')),
        entity_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT
      )`,
      `INSERT INTO openclaw_operation_items(id, operation_id, sequence, entity_type, entity_id, before_json, after_json)
        SELECT id, operation_id, sequence, entity_type, entity_id, before_json, after_json
        FROM openclaw_operation_items_legacy_v9`,
      "DROP TABLE openclaw_operation_items_legacy_v9",
      "CREATE UNIQUE INDEX idx_openclaw_operation_items_sequence ON openclaw_operation_items(operation_id, sequence)"
    ]
  }
];
