import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const source = path.resolve(projectRoot, process.env.DATABASE_PATH ?? "./data/money.sqlite");
const backupDirectory = path.resolve(projectRoot, process.env.BACKUP_LOCAL_DIR ?? "./backups/local");
const label = (process.argv[2] ?? "manual").replace(/[^a-z0-9-]/gi, "-").slice(0, 48) || "manual";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(backupDirectory, `money-${label}-${stamp}.sqlite`);

mkdirSync(backupDirectory, { recursive: true });
const database = new DatabaseSync(source);
database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
database.close();

const snapshot = new DatabaseSync(target, { readOnly: true });
const integrity = snapshot.prepare("PRAGMA integrity_check").get().integrity_check;
const foreignKeyIssues = snapshot.prepare("PRAGMA foreign_key_check").all().length;
snapshot.close();

if (integrity !== "ok" || foreignKeyIssues !== 0) {
  rmSync(target, { force: true });
  throw new Error("SQLite snapshot integrity verification failed");
}

console.log(JSON.stringify({ target, integrity, foreignKeyIssues }));
