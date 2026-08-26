import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrations } from "../db/migrations";
import { createDatabase } from "../server/database";
import { loadConfig } from "../server/config";

describe("数据库升级", () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it("升级旧账本前先备份，并移除消费时分和内置分类", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "money-manager-migration-"));
    directories.push(directory);
    const databasePath = path.join(directory, "ledger.sqlite");
    const backupLocalDir = path.join(directory, "backups");
    const old = new DatabaseSync(databasePath);
    for (const statement of migrations[0]!.statements) old.exec(statement);
    old.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, 'initial_ledger', ?)").run(new Date().toISOString());
    const now = new Date().toISOString();
    const insertCategory = old.prepare(`INSERT INTO categories(id, kind, name, icon, color, sort_order, is_archived, created_at, updated_at)
      VALUES (?, 'expense', ?, ?, ?, ?, 0, ?, ?)`);
    insertCategory.run("used-default", "餐饮", "🍚", "#D66A4C", 0, now, now);
    insertCategory.run("unused-default", "饮料", "🥤", "#B66A8C", 1, now, now);
    insertCategory.run("custom", "吃饭", "饭", "#2E7D61", 2, now, now);
    old.prepare(`INSERT INTO transactions(id, kind, amount_minor, currency, category_id, occurred_at, local_date, note, source, created_at, updated_at)
      VALUES ('old-transaction', 'expense', 1234, 'CNY', 'used-default', '2026-08-03T08:30:00+08:00', '2026-08-03', NULL, 'user', ?, ?)`)
      .run(now, now);
    old.prepare(`INSERT INTO proposals(id, action, target_transaction_id, payload, reason, source, status, created_at, resolved_at)
      VALUES ('old-proposal', 'create', NULL, '{}', NULL, 'openclaw', 'pending', ?, NULL)`).run(now);
    old.close();

    const upgraded = createDatabase(loadConfig({ nodeEnv: "test", databasePath, backupLocalDir }));
    const transaction = upgraded.prepare("SELECT occurred_at, local_date FROM transactions WHERE id = 'old-transaction'").get() as { occurred_at: string; local_date: string };
    expect(transaction).toEqual({ occurred_at: "2026-08-03", local_date: "2026-08-03" });
    expect(upgraded.prepare("SELECT is_archived FROM categories WHERE id = 'used-default'").get()).toEqual({ is_archived: 1 });
    expect(upgraded.prepare("SELECT id FROM categories WHERE id = 'unused-default'").get()).toBeUndefined();
    expect(upgraded.prepare("SELECT id FROM categories WHERE id = 'custom'").get()).toEqual({ id: "custom" });
    expect(upgraded.prepare("SELECT revision, updated_at, request_id, request_hash FROM proposals WHERE id = 'old-proposal'").get())
      .toEqual({ revision: 1, updated_at: now, request_id: null, request_hash: null });
    expect((upgraded.prepare("SELECT include_notes FROM ai_reports LIMIT 1").get() as { include_notes?: number } | undefined)).toBeUndefined();
    expect((upgraded.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(2);
    expect(upgraded.prepare("SELECT version, name FROM schema_migrations WHERE version = 9").get())
      .toEqual({ version: 9, name: "lightweight_funds" });
    expect(upgraded.prepare("PRAGMA table_info(transactions)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "account_id" }),
        expect.objectContaining({ name: "refunded_at" }),
        expect.objectContaining({ name: "refund_account_id" })
      ]));
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts', 'account_aliases', 'account_movements', 'transfers', 'account_adjustments') ORDER BY name").all())
      .toEqual([
        { name: "account_adjustments" }, { name: "account_aliases" }, { name: "account_movements" }, { name: "accounts" }, { name: "transfers" }
      ]);
    upgraded.prepare(`INSERT INTO openclaw_operations(
      id, request_id, request_hash, action, entity_type, status, undoable, summary, created_at, expires_at, failed_at
    ) VALUES ('failed-operation', 'failed-request', 'hash', 'test', 'database', 'failed', 0, '测试失败状态', ?, ?, ?)`)
      .run(now, "2099-01-01T00:00:00.000Z", now);
    expect(upgraded.prepare("SELECT status, failed_at FROM openclaw_operations WHERE id = 'failed-operation'").get())
      .toEqual({ status: "failed", failed_at: now });
    expect(readdirSync(backupLocalDir).some((name) => name.startsWith("money-pre-migration-"))).toBe(true);
    upgraded.close();
  });
  it("从 v9 升级会为旧账户补 CNY，并按激活时间安全回填历史基线", () => {
    const database = new DatabaseSync(":memory:");
    migrations.slice(0, 9).forEach((migration) => migration.statements.forEach((statement) => database.exec(statement)));
    const createdBefore = "2026-08-23T03:00:00.000Z";
    const activatedAt = "2026-08-23T04:00:00.000Z";
    const createdAfter = "2026-08-23T05:00:00.000Z";
    database.prepare(`INSERT INTO categories(id, kind, name, icon, color, sort_order, is_archived, created_at, updated_at)
      VALUES ('expense', 'expense', '测试', '测', '#123456', 0, 0, ?, ?)`).run(createdBefore, createdBefore);
    database.prepare(`INSERT INTO accounts(
      id, name, normalized_name, icon, opening_balance_minor, opened_on, is_archived, created_at, updated_at
    ) VALUES ('legacy-account', '旧账户', '旧账户', '旧', 0, '2026-08-23', 0, ?, ?)`).run(createdBefore, createdBefore);
    const insert = database.prepare(`INSERT INTO transactions(
      id, kind, amount_minor, currency, category_id, occurred_at, local_date, note, source,
      created_at, updated_at, account_id
    ) VALUES (?, 'expense', 100, 'CNY', 'expense', '2026-08-23', '2026-08-23', NULL, 'user', ?, ?, ?)`);
    insert.run("before-null", createdBefore, createdBefore, null);
    insert.run("after-null", createdAfter, createdAfter, null);
    insert.run("before-linked", createdBefore, createdBefore, "legacy-account");
    database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES ('funds.started_on', '2026-08-23', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(activatedAt);

    migrations[9]!.statements.forEach((statement) => database.exec(statement));

    expect(database.prepare("SELECT currency FROM accounts WHERE id = 'legacy-account'").get()).toEqual({ currency: "CNY" });
    expect(database.prepare("SELECT account_amount_minor FROM transactions WHERE id = 'before-null'").get())
      .toEqual({ account_amount_minor: null });
    expect(database.prepare("SELECT transaction_id, captured_at FROM funds_baseline_transactions ORDER BY transaction_id").all())
      .toEqual([{ transaction_id: "before-null", captured_at: activatedAt }]);
    database.close();
  });

});
