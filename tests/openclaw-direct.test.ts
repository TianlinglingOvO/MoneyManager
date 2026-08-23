import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLedgerMcpServer } from "../server/mcp";
import { AiService } from "../server/ai";
import { BackupService } from "../server/backup";
import { OpenClawControlService } from "../server/openclaw-control";
import { BudgetService } from "../server/budgets";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory, transactionInput } from "./helpers";

function parsed(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((item) => item.type === "text")?.text ?? "null");
}

describe("OpenClaw 直接接管", () => {
  let context: TestContext;
  let client: Client;
  let server: ReturnType<typeof createLedgerMcpServer>;
  let control: OpenClawControlService;

  beforeEach(async () => {
    context = createTestContext();
    const ai = new AiService(context.database, context.repository, context.config);
    const backup = new BackupService(context.database, context.repository, context.config);
    const budgets = new BudgetService(context.database, context.repository, () => context.config.timezone);
    control = new OpenClawControlService(context.database, context.repository, context.config, budgets);
    control.setMode("direct");
    server = createLedgerMcpServer(context.repository, context.config, { ai, backup, openclaw: control, budgets });
    client = new Client({ name: "direct-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    context.cleanup();
  });

  it("直接新增立即入账、重复 requestId 不重复写入，并可通过 MCP 撤销", async () => {
    const category = expenseCategory(context);
    const args = { requestId: "direct-create-001", kind: "expense", amount: 24.2, categoryId: category.id, localDate: "2026-08-12", note: "晚餐" };
    const first = parsed(await client.callTool({ name: "direct_add_transaction", arguments: args }));
    const duplicate = parsed(await client.callTool({ name: "direct_add_transaction", arguments: args }));

    expect(context.repository.listTransactions().total).toBe(1);
    expect(context.repository.listProposals("pending")).toHaveLength(0);
    expect(first.result.amountMinor).toBe(2_420);
    expect(duplicate.duplicate).toBe(true);

    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: first.operation.id } });
    expect(context.repository.listTransactions().total).toBe(0);
    expect(context.repository.listTransactions({ deleted: "trash" }).total).toBe(1);
  });

  it("拒绝相同 requestId 的不同内容及过期版本修改", async () => {
    const category = expenseCategory(context);
    await client.callTool({ name: "direct_add_transaction", arguments: { requestId: "same-request-001", kind: "expense", amount: 10, categoryId: category.id } });
    const conflict = await client.callTool({ name: "direct_add_transaction", arguments: { requestId: "same-request-001", kind: "expense", amount: 11, categoryId: category.id } });
    expect(conflict.isError).toBe(true);

    const target = context.repository.listTransactions().items[0]!;
    context.repository.updateTransaction(target.id, { note: "用户后来修改" });
    const stale = await client.callTool({ name: "direct_update_transaction", arguments: {
      requestId: "stale-update-001", transactionId: target.id, expectedUpdatedAt: target.updatedAt, amount: 12
    } });
    expect(stale.isError).toBe(true);
  });

  it("修改和删除可撤销，但后续新修改会阻止撤销覆盖", async () => {
    const category = expenseCategory(context);
    const target = context.repository.createTransaction(transactionInput(category.id));
    const changed = parsed(await client.callTool({ name: "direct_update_transaction", arguments: {
      requestId: "update-undo-001", transactionId: target.id, expectedUpdatedAt: target.updatedAt, amount: 20
    } }));
    expect(context.repository.getTransaction(target.id).amountMinor).toBe(2_000);
    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: changed.operation.id } });
    expect(context.repository.getTransaction(target.id).amountMinor).toBe(1_234);

    const fresh = context.repository.getTransaction(target.id);
    const deletion = parsed(await client.callTool({ name: "direct_delete_transaction", arguments: {
      requestId: "delete-undo-001", transactionId: target.id, expectedUpdatedAt: fresh.updatedAt
    } }));
    context.database.prepare("UPDATE transactions SET updated_at = ? WHERE id = ?").run("2099-01-01T00:00:00.000Z", target.id);
    const blocked = await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: deletion.operation.id } });
    expect(blocked.isError).toBe(true);
  });

  it("分类迁移连同账目一起撤销，并且状态工具不泄露凭据", async () => {
    const source = expenseCategory(context);
    const target = context.repository.createCategory({ kind: "expense", name: "吃饭", icon: "饭", color: "#2E7D61" });
    const transaction = context.repository.createTransaction(transactionInput(source.id));
    const migration = parsed(await client.callTool({ name: "direct_manage_category", arguments: {
      requestId: "category-migrate-001", categoryId: source.id, expectedUpdatedAt: source.updatedAt,
      action: "migrate", targetCategoryId: target.id
    } }));
    expect(context.repository.getTransaction(transaction.id).categoryId).toBe(target.id);
    expect(() => context.repository.getCategory(source.id)).toThrow();

    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: migration.operation.id } });
    expect(context.repository.getCategory(source.id).name).toBe(source.name);
    expect(context.repository.getTransaction(transaction.id).categoryId).toBe(source.id);

    const status = parsed(await client.callTool({ name: "get_app_status", arguments: {} }));
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(context.config.deepseekApiKey || "never-present");
    expect(serialized).not.toMatch(/clientSecret|apiKey|mcpApiToken|token/i);
  });

  it("确认模式会拒绝直接工具，但保留原提案工具", async () => {
    control.setMode("confirm");
    const category = expenseCategory(context);
    const result = await client.callTool({ name: "direct_add_transaction", arguments: {
      requestId: "confirm-block-001", kind: "expense", amount: 5, categoryId: category.id
    } });
    expect(result.isError).toBe(true);
    expect(context.repository.listTransactions().total).toBe(0);
  });

  it("批量记账整批原子写入、幂等并可整批撤销", async () => {
    const category = expenseCategory(context);
    const args = {
      requestId: "batch-create-001",
      transactions: [
        { kind: "expense", amount: 12.5, categoryId: category.id, localDate: "2026-08-20", note: "早餐" },
        { kind: "expense", amount: 24.2, categoryId: category.id, localDate: "2026-08-20", note: "晚餐" }
      ]
    };
    const first = parsed(await client.callTool({ name: "direct_add_transactions_batch", arguments: args }));
    const duplicate = parsed(await client.callTool({ name: "direct_add_transactions_batch", arguments: args }));
    expect(first.result.count).toBe(2);
    expect(duplicate.duplicate).toBe(true);
    expect(context.repository.listTransactions().total).toBe(2);
    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: first.operation.id } });
    expect(context.repository.listTransactions().total).toBe(0);
    expect(context.repository.listTransactions({ deleted: "trash" }).total).toBe(2);

    const invalid = await client.callTool({
      name: "direct_add_transactions_batch",
      arguments: {
        requestId: "batch-invalid-001",
        transactions: [
          { kind: "expense", amount: 10, categoryId: category.id, localDate: "2026-08-20" },
          { kind: "income", amount: 10, categoryId: category.id, localDate: "2026-08-20" }
        ]
      }
    });
    expect(invalid.isError).toBe(true);
    expect(context.repository.listTransactions({ deleted: "all" }).total).toBe(2);
  });

  it("OpenClaw 可设置和删除预算，并分别撤销", async () => {
    const category = expenseCategory(context);
    const created = parsed(await client.callTool({
      name: "direct_set_budget",
      arguments: {
        requestId: "budget-set-001",
        month: "2026-08",
        totalAmount: 3000,
        categories: [{ categoryId: category.id, amount: 1000 }],
        expectedUpdatedAt: null
      }
    }));
    expect(created.result.totalMinor).toBe(300_000);
    const summary = parsed(await client.callTool({
      name: "get_budget_summary",
      arguments: { month: "2026-08" }
    }));
    expect(summary.categories[0].budgetMinor).toBe(100_000);

    const deleted = parsed(await client.callTool({
      name: "direct_delete_budget",
      arguments: {
        requestId: "budget-delete-001",
        month: "2026-08",
        expectedUpdatedAt: created.result.updatedAt
      }
    }));
    expect(deleted.result.deleted).toBe(true);
    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: deleted.operation.id } });
    const restored = parsed(await client.callTool({
      name: "get_budget_summary",
      arguments: { month: "2026-08" }
    }));
    expect(restored.totalMinor).toBe(300_000);
  });

  it("可恢复回收站账目并撤销恢复，也可撤销时区修改", async () => {
    const category = expenseCategory(context);
    const active = context.repository.createTransaction(transactionInput(category.id));
    const deleted = context.repository.softDeleteTransaction(active.id);
    const restored = parsed(await client.callTool({ name: "direct_restore_transaction", arguments: {
      requestId: "restore-undo-001", transactionId: deleted.id, expectedUpdatedAt: deleted.updatedAt
    } }));
    expect(context.repository.getTransaction(active.id).deletedAt).toBeNull();
    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: restored.operation.id } });
    expect(context.repository.getTransaction(active.id, true).deletedAt).not.toBeNull();

    const timezone = parsed(await client.callTool({ name: "direct_update_timezone", arguments: {
      requestId: "timezone-undo-001", timezone: "Asia/Singapore", expectedTimezone: "Asia/Shanghai"
    } }));
    expect(context.config.timezone).toBe("Asia/Singapore");
    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: timezone.operation.id } });
    expect(context.config.timezone).toBe("Asia/Shanghai");
  });

  it("永久删除需要专用工具、保持幂等且不可撤销", async () => {
    const category = expenseCategory(context);
    const active = context.repository.createTransaction(transactionInput(category.id));
    const changed = parsed(await client.callTool({ name: "direct_update_transaction", arguments: {
      requestId: "before-permanent-delete-001",
      transactionId: active.id,
      expectedUpdatedAt: active.updatedAt,
      amount: 20
    } }));
    const deleted = context.repository.softDeleteTransaction(active.id);
    const args = {
      requestId: "permanent-delete-001",
      transactionId: deleted.id,
      expectedUpdatedAt: deleted.updatedAt,
      confirmation: "PERMANENT_DELETE"
    };
    const first = parsed(await client.callTool({ name: "direct_permanently_delete_transaction", arguments: args }));
    const duplicate = parsed(await client.callTool({ name: "direct_permanently_delete_transaction", arguments: args }));
    expect(first.result.permanentlyDeletedTransactionCount).toBe(1);
    expect(duplicate.duplicate).toBe(true);
    expect(() => context.repository.getTransaction(deleted.id)).toThrow("账目不存在");
    expect(control.getOperation(changed.operation.id).undoable).toBe(false);
    const oldSnapshots = context.database.prepare("SELECT COUNT(*) AS count FROM openclaw_operation_items WHERE operation_id = ?")
      .get(changed.operation.id) as { count: number };
    expect(Number(oldSnapshots.count)).toBe(0);
    const undo = await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: first.operation.id } });
    expect(undo.isError).toBe(true);
  });

  it("永久删除分类必须先读取最新影响并确认完整名称", async () => {
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id));
    const impact = parsed(await client.callTool({ name: "get_category_deletion_impact", arguments: { categoryId: category.id } }));
    const purged = parsed(await client.callTool({ name: "direct_permanently_delete_category", arguments: {
      requestId: "category-purge-001",
      categoryId: category.id,
      expectedRevision: impact.revision,
      confirmName: category.name,
      confirmation: "PERMANENT_DELETE"
    } }));
    expect(purged.result.permanentlyDeletedTransactionCount).toBe(1);
    expect(() => context.repository.getCategory(category.id)).toThrow("分类不存在");
    const undo = await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: purged.operation.id } });
    expect(undo.isError).toBe(true);
  });

  it("30 天过期后不可撤销且恢复快照会被清理", async () => {
    const category = expenseCategory(context);
    const created = parsed(await client.callTool({ name: "direct_add_transaction", arguments: {
      requestId: "expired-undo-001", kind: "expense", amount: 6, categoryId: category.id
    } }));
    context.database.prepare("UPDATE openclaw_operations SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", created.operation.id);

    const undo = await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: created.operation.id } });
    expect(undo.isError).toBe(true);
    expect(control.listOperations()).toHaveLength(0);
    const snapshots = context.database.prepare("SELECT COUNT(*) AS count FROM openclaw_operation_items WHERE operation_id = ?")
      .get(created.operation.id) as { count: number };
    expect(Number(snapshots.count)).toBe(0);
    const operation = context.database.prepare("SELECT COUNT(*) AS count FROM openclaw_operations WHERE id = ?")
      .get(created.operation.id) as { count: number };
    expect(Number(operation.count)).toBe(0);
  });

  it("AI 每小时最多 20 次，备份操作至少间隔 10 分钟", async () => {
    for (let index = 0; index < 20; index += 1) {
      await control.executeExternal({
        requestId: `ai-limit-${String(index).padStart(3, "0")}`,
        action: "ai.analyze",
        entityType: "ai_report",
        summary: "测试 AI 限流",
        request: { index },
        maxPerWindow: { count: 20, windowMs: 60 * 60 * 1000 },
        run: async () => ({ index })
      });
    }
    await expect(control.executeExternal({
      requestId: "ai-limit-overflow",
      action: "ai.analyze",
      entityType: "ai_report",
      summary: "测试 AI 限流",
      request: { index: 20 },
      maxPerWindow: { count: 20, windowMs: 60 * 60 * 1000 },
      run: async () => ({ index: 20 })
    })).rejects.toMatchObject({ code: "RATE_LIMITED" });

    const first = await client.callTool({ name: "direct_create_backup", arguments: { requestId: "backup-cooldown-001" } });
    const second = await client.callTool({ name: "direct_create_backup", arguments: { requestId: "backup-cooldown-002" } });
    expect(first.isError).not.toBe(true);
    expect(second.isError).toBe(true);
  });

  it("分类迁移失败会原子回滚，不留下半成品操作", async () => {
    const source = expenseCategory(context);
    const beforeCount = control.listOperations().length;
    const result = await client.callTool({ name: "direct_manage_category", arguments: {
      requestId: "migration-rollback-001",
      categoryId: source.id,
      expectedUpdatedAt: source.updatedAt,
      action: "migrate",
      targetCategoryId: "00000000-0000-4000-8000-000000000001"
    } });
    expect(result.isError).toBe(true);
    expect(context.repository.getCategory(source.id).name).toBe(source.name);
    expect(control.listOperations()).toHaveLength(beforeCount);
  });

  it("外部操作失败与超时中断会收敛为失败，详情按需返回快照", async () => {
    await expect(control.executeExternal({
      requestId: "external-failure-001",
      action: "backup.create",
      entityType: "database",
      summary: "测试外部失败",
      request: { mode: "test" },
      run: async () => { throw new Error("test failure"); }
    })).rejects.toThrow("test failure");
    const failed = control.listOperations().find((item) => item.requestId === "external-failure-001");
    expect(failed).toMatchObject({ status: "failed", undoable: false });
    expect(failed?.failedAt).toBeTruthy();

    const oldId = "11111111-2222-4333-8444-555555555555";
    context.database.prepare(`INSERT INTO openclaw_operations(
      id, request_id, request_hash, action, entity_type, entity_id, status, undoable,
      summary, result_json, created_at, expires_at, undone_at, failed_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'running', 0, ?, NULL, ?, ?, NULL, NULL)`)
      .run(oldId, "stale-running-001", "hash", "ai.analyze", "ai_report", "测试中断操作", "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
    expect(control.reconcileStaleRunningOperations(15 * 60 * 1000, new Date("2026-01-01T01:00:00.000Z"))).toBe(1);
    expect(control.getOperationDetail(oldId)).toMatchObject({ status: "failed", items: [] });
  });
});
