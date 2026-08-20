import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../server/database";
import { loadConfig, type AppConfig } from "../server/config";
import { LedgerRepository } from "../server/repository";

export interface TestContext {
  database: DatabaseSync;
  repository: LedgerRepository;
  config: AppConfig;
  cleanup: () => void;
}

export function createTestContext(overrides: Partial<AppConfig> = {}): TestContext {
  const directory = mkdtempSync(path.join(tmpdir(), "money-manager-test-"));
  const config = loadConfig({
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    databasePath: path.join(directory, "ledger.sqlite"),
    backupLocalDir: path.join(directory, "backups"),
    authMode: "disabled",
    timezone: "Asia/Shanghai",
    deepseekApiKey: "",
    deepseekThinking: "disabled",
    mcpApiToken: "",
    ...overrides
  });
  const database = createDatabase(config);
  return {
    database,
    repository: new LedgerRepository(database),
    config,
    cleanup: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

export function expenseCategory(context: TestContext) {
  return context.repository.listCategories("expense")[0] ?? context.repository.createCategory({
    kind: "expense", name: "餐饮", icon: "餐", color: "#D66A4C"
  });
}

export function incomeCategory(context: TestContext) {
  return context.repository.listCategories("income")[0] ?? context.repository.createCategory({
    kind: "income", name: "工资", icon: "收", color: "#2E7D61"
  });
}

export function transactionInput(categoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "expense" as const,
    amountMinor: 1_234,
    categoryId,
    localDate: "2026-08-03",
    note: "早餐",
    ...overrides
  };
}
