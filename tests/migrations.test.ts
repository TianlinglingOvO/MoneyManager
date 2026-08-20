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
    expect(upgraded.prepare("SELECT revision, updated_at FROM proposals WHERE id = 'old-proposal'").get())
      .toEqual({ revision: 1, updated_at: now });
    expect(readdirSync(backupLocalDir).some((name) => name.startsWith("money-pre-migration-"))).toBe(true);
    upgraded.close();
  });
});
