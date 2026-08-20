import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { migrations } from "../db/migrations";
import type { AppConfig } from "./config";

let singleton: DatabaseSync | null = null;
let singletonPath = "";

function sqliteLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function createPreMigrationBackupIfNeeded(database: DatabaseSync, config: AppConfig): void {
  const applicationTables = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`).get() as { count: number };
  if (Number(applicationTables.count) === 0) return;

  const hasMigrationTable = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = hasMigrationTable
    ? new Set((database.prepare("SELECT version FROM schema_migrations").all() as unknown as Array<{ version: number }>).map((row) => Number(row.version)))
    : new Set<number>();
  if (!migrations.some((migration) => !applied.has(migration.version))) return;

  mkdirSync(config.backupLocalDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(config.backupLocalDir, `money-pre-migration-${stamp}.sqlite`);
  database.exec(`VACUUM INTO '${sqliteLiteral(backupPath)}'`);
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  const result = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  snapshot.close();
  if (result.integrity_check !== "ok") {
    rmSync(backupPath, { force: true });
    throw new Error("数据库升级前备份未通过完整性检查，已停止迁移");
  }
}

function applyMigrations(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  for (const migration of migrations) {
    const existing = database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version);
    if (existing) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) {
        database.exec(statement);
      }
      database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function seedSettings(database: DatabaseSync, timezone: string): void {
  database.prepare(`INSERT INTO settings(key, value, updated_at)
    VALUES ('timezone', ?, ?)
    ON CONFLICT(key) DO NOTHING`).run(timezone, new Date().toISOString());
  database.prepare(`INSERT INTO settings(key, value, updated_at)
    VALUES ('timezone.initialized', 'false', ?)
    ON CONFLICT(key) DO NOTHING`).run(new Date().toISOString());
}

export function createDatabase(config: AppConfig): DatabaseSync {
  mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const database = new DatabaseSync(config.databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA busy_timeout = 5000");
  createPreMigrationBackupIfNeeded(database, config);
  applyMigrations(database);
  seedSettings(database, config.timezone);
  database.exec("PRAGMA optimize");
  return database;
}

export function getDatabase(config: AppConfig): DatabaseSync {
  if (!singleton || singletonPath !== config.databasePath) {
    singleton?.close();
    singleton = createDatabase(config);
    singletonPath = config.databasePath;
  }
  return singleton;
}

export function closeDatabase(): void {
  singleton?.close();
  singleton = null;
  singletonPath = "";
}
