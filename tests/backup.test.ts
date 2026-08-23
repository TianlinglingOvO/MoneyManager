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
    expect(snapshot.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    snapshot.close();
    const status = service.status();
    expect(status.local).toMatchObject({ state: "success" });
    expect(status.local.lastAttemptAt).toBeTruthy();
    expect(status.local.lastSuccessAt).toBeTruthy();
    expect(status.remote).toMatchObject({ state: "not_configured" });
    expect(status).not.toHaveProperty("lastLocalPath");
    expect((context.database.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(2);
  });

  it("远端加密失败不会掩盖本地快照成功，并单独记录远端失败", async () => {
    context.config.backupAgeRecipient = "age1test";
    context.config.rcloneRemote = "gdrive:";
    const failedRunner = (() => ({ status: 1, stdout: "", stderr: "" })) as unknown as typeof import("node:child_process").spawnSync;
    const service = new BackupService(context.database, context.repository, context.config, failedRunner);
    const result = await service.createBackup();
    expect(result.success).toBe(true);
    expect(result.remoteUploaded).toBe(false);
    expect(service.status()).toMatchObject({
      local: { state: "success" },
      remote: { state: "failed" }
    });
  });
});
