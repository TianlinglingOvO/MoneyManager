import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BackupService } from "../server/backup";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory, transactionInput } from "./helpers";

describe("SQLite 备份", () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestContext({ backupRetentionCount: 2 });
    context.repository.createTransaction(transactionInput(expenseCategory(context).id));
  });
  afterEach(() => { context.cleanup(); });

  it("生成一致性快照并只保留配置的最近份数", async () => {
    const service = new BackupService(context.database, context.repository, context.config);
    let latestPath = "";
    for (let index = 0; index < 3; index += 1) {
      const result = await service.createBackup();
      latestPath = result.localPath;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(existsSync(latestPath)).toBe(true);
    expect(readdirSync(context.config.backupLocalDir).filter((name) => name.endsWith(".sqlite"))).toHaveLength(2);
    const snapshot = new DatabaseSync(latestPath, { readOnly: true });
    expect((snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    snapshot.close();
  });
});
