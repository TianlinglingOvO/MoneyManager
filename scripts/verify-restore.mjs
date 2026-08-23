import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const backupDirectory = path.resolve(projectRoot, process.env.BACKUP_LOCAL_DIR ?? "./backups/local");
const serverEntry = path.join(projectRoot, "dist-server", "index.js");
const sourceDatabase = path.resolve(projectRoot, process.env.DATABASE_PATH ?? "./data/money.sqlite");
const trackedTables = [
  "transactions",
  "categories",
  "proposals",
  "borrowers",
  "loans",
  "loan_repayments",
  "subscriptions",
  "accounts",
  "account_aliases",
  "account_movements",
  "transfers",
  "account_adjustments",
  "subscription_payments",
  "monthly_budgets",
  "category_monthly_budgets",
  "ai_reports",
  "openclaw_operations"
];

function newestSnapshot() {
  return readdirSync(backupDirectory)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => path.join(backupDirectory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function inspectDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    const foreignKeyIssues = database.prepare("PRAGMA foreign_key_check").all().length;
    const existing = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map((row) => row.name));
    const counts = Object.fromEntries(trackedTables
      .filter((table) => existing.has(table))
      .map((table) => [table, Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count)]));
    const summaries = Object.fromEntries(trackedTables
      .filter((table) => existing.has(table))
      .map((table) => {
        const primaryKeyColumns = database.prepare(`PRAGMA table_info("${table}")`).all()
          .filter((column) => Number(column.pk) > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => column.name);
        const identityColumns = primaryKeyColumns.length > 0 ? primaryKeyColumns : ["rowid"];
        const quotedColumns = identityColumns.map((column) => `"${column}"`).join(", ");
        const identities = database.prepare(
          `SELECT ${quotedColumns} FROM "${table}" ORDER BY ${quotedColumns}`
        ).all();
        return [table, createHash("sha256").update(JSON.stringify(identities)).digest("hex")];
      }));
    return { integrity, foreignKeyIssues, counts, summaries };
  } finally {
    database.close();
  }
}

function recordRestoreStatus(state, attemptedAt, successfulAt = null) {
  if (!existsSync(sourceDatabase)) return;
  const database = new DatabaseSync(sourceDatabase);
  try {
    const upsert = database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    upsert.run("backup.restore.lastAttemptAt", attemptedAt, new Date().toISOString());
    upsert.run("backup.restore.status", state, new Date().toISOString());
    if (successfulAt) upsert.run("backup.restore.lastSuccessAt", successfulAt, successfulAt);
  } finally {
    database.close();
  }
}

async function requestJson(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`临时服务接口 ${pathname} 返回 ${response.status}`);
  return body.data;
}

async function verifyTemporaryWrite(baseUrl) {
  let categories = await requestJson(baseUrl, "/api/v1/categories?includeArchived=false");
  let temporaryCategoryId = null;
  if (!Array.isArray(categories) || categories.length === 0) {
    const category = await requestJson(baseUrl, "/api/v1/categories", {
      method: "POST",
      headers: { "Idempotency-Key": `restore-category-${randomUUID()}` },
      body: JSON.stringify({ kind: "expense", name: "恢复演练临时分类", icon: "验", color: "#5963A6" })
    });
    categories = [category];
    temporaryCategoryId = category.id;
  }
  const category = categories[0];
  const settings = await requestJson(baseUrl, "/api/v1/settings");
  const transaction = await requestJson(baseUrl, "/api/v1/transactions", {
    method: "POST",
    headers: { "Idempotency-Key": `restore-transaction-${randomUUID()}` },
    body: JSON.stringify({ kind: category.kind, amountMinor: 1, categoryId: category.id, localDate: settings.today, note: null })
  });
  const readBack = await requestJson(baseUrl, `/api/v1/transactions/${transaction.id}`);
  if (readBack.id !== transaction.id || readBack.amountMinor !== 1) throw new Error("临时恢复服务未能读回测试账目");
  const deleted = await requestJson(baseUrl, `/api/v1/transactions/${transaction.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedUpdatedAt: transaction.updatedAt })
  });
  await requestJson(baseUrl, `/api/v1/transactions/${transaction.id}/permanent`, {
    method: "DELETE",
    body: JSON.stringify({ expectedUpdatedAt: deleted.updatedAt, confirmation: "PERMANENT_DELETE" })
  });
  if (temporaryCategoryId) {
    await requestJson(baseUrl, `/api/v1/categories/${temporaryCategoryId}/disposition`, {
      method: "POST",
      body: JSON.stringify({ action: "delete" })
    });
  }
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForService(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`临时服务提前退出，代码 ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // The isolated server may still be applying migrations.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("临时恢复服务未在 20 秒内就绪");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 9_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const selected = process.argv[2]
  ? path.resolve(projectRoot, process.argv[2])
  : newestSnapshot();
if (!selected || !existsSync(selected)) throw new Error("没有找到可用于恢复演练的 SQLite 快照");
if (!existsSync(serverEntry)) throw new Error("缺少 dist-server/index.js，请先运行 npm run build");
const attemptedAt = new Date().toISOString();
recordRestoreStatus("failed", attemptedAt);

const drillRoot = mkdtempSync(path.join(tmpdir(), "smb-restore-drill-"));
const restoredDatabase = path.join(drillRoot, "restored.sqlite");
const temporaryBackups = path.join(drillRoot, "backups");
mkdirSync(temporaryBackups, { recursive: true });
copyFileSync(selected, restoredDatabase);
const before = inspectDatabase(restoredDatabase);
if (before.integrity !== "ok" || before.foreignKeyIssues !== 0) {
  throw new Error("快照在恢复前未通过 SQLite 完整性检查");
}

const port = await availablePort();
const child = spawn(process.execPath, [serverEntry], {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "test",
    AUTH_MODE: "disabled",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_PATH: restoredDatabase,
    BACKUP_LOCAL_DIR: temporaryBackups,
    DEEPSEEK_API_KEY: "",
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
    CF_ACCESS_MCP_AUD: "",
    ALLOWED_EMAIL: "",
    MCP_API_TOKEN: "",
    RCLONE_REMOTE: "",
    BACKUP_AGE_RECIPIENT: ""
  }
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  const health = await waitForService(`http://127.0.0.1:${port}/health`, child);
  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
  if (!statusResponse.ok) throw new Error("临时服务状态接口不可用");
  const status = await statusResponse.json();
  const afterStartup = inspectDatabase(restoredDatabase);
  for (const [table, count] of Object.entries(before.counts)) {
    if (afterStartup.counts[table] !== count || afterStartup.summaries[table] !== before.summaries[table]) {
      throw new Error(`恢复服务启动后 ${table} 的数量或内容摘要发生变化`);
    }
  }
  await verifyTemporaryWrite(`http://127.0.0.1:${port}`);
  await stopChild(child);
  const after = inspectDatabase(restoredDatabase);
  if (after.integrity !== "ok" || after.foreignKeyIssues !== 0) {
    throw new Error("恢复后的数据库未通过 SQLite 完整性检查");
  }
  for (const [table, count] of Object.entries(before.counts)) {
    if (after.counts[table] !== count || after.summaries[table] !== before.summaries[table]) {
      throw new Error(`恢复演练改变了 ${table} 的数量或内容摘要`);
    }
  }
  const successfulAt = new Date().toISOString();
  recordRestoreStatus("success", attemptedAt, successfulAt);
  console.log(JSON.stringify({
    snapshot: selected,
    health,
    status: status.data,
    integrity: after.integrity,
    foreignKeyIssues: after.foreignKeyIssues,
    counts: after.counts
  }));
} catch (error) {
  recordRestoreStatus("failed", attemptedAt);
  await stopChild(child);
  if (stderr.trim()) process.stderr.write(stderr);
  throw error;
} finally {
  const resolved = path.resolve(drillRoot);
  if (path.basename(resolved).startsWith("smb-restore-drill-") && path.dirname(resolved) === path.resolve(tmpdir())) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
