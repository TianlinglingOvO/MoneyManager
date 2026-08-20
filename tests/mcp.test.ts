import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { amountToMinor, createLedgerMcpServer } from "../server/mcp";
import { AiService } from "../server/ai";
import { BackupService } from "../server/backup";
import { OpenClawControlService } from "../server/openclaw-control";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory } from "./helpers";

describe("OpenClaw MCP", () => {
  let context: TestContext;

  beforeEach(() => { context = createTestContext(); });
  afterEach(() => { context.cleanup(); });

  it("人民币元只接受最多两位小数并准确换算为分", () => {
    expect(amountToMinor(12.34)).toBe(1_234);
    expect(() => amountToMinor(12.345)).toThrow("金额最多保留两位小数");
  });

  it("同时保留直接工具和提议工具，提议仍不会直接写账", async () => {
    const server = createLedgerMcpServer(context.repository, context.config, {
      ai: new AiService(context.database, context.repository, context.config),
      backup: new BackupService(context.database, context.repository, context.config),
      openclaw: new OpenClawControlService(context.database, context.repository, context.config)
    });
    const client = new Client({ name: "test-openclaw", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()).toEqual({ name: "sutady-money-manager", version: "2.0.0" });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "direct_add_transaction",
        "direct_create_backup",
        "direct_create_category",
        "direct_delete_transaction",
        "direct_generate_ai_analysis",
        "direct_manage_category",
        "direct_permanently_delete_category",
        "direct_permanently_delete_transaction",
        "direct_restore_transaction",
        "direct_update_category",
        "direct_update_timezone",
        "direct_update_transaction",
        "get_app_settings",
        "get_app_status",
        "get_category_deletion_impact",
        "get_finance_summary",
        "get_openclaw_control_status",
        "list_ai_analyses",
        "list_categories",
        "list_openclaw_operations",
        "list_pending_proposals",
        "list_transactions",
        "propose_add_transaction",
        "propose_delete_transaction",
        "propose_update_transaction",
        "revise_pending_proposal",
        "undo_openclaw_operation"
      ]);
      expect(tools.tools.some((tool) => /approve/i.test(tool.name))).toBe(false);

      const category = expenseCategory(context);
      await client.callTool({
        name: "propose_add_transaction",
        arguments: {
          kind: "expense",
          amount: 8.8,
          categoryId: category.id,
          localDate: "2026-08-03",
          note: "饮料"
        }
      });
      expect(context.repository.listTransactions().total).toBe(0);
      const original = context.repository.listProposals("pending")[0]!;
      await client.callTool({
        name: "revise_pending_proposal",
        arguments: {
          proposalId: original.id,
          expectedRevision: original.revision,
          amount: 8.6,
          note: "修正后的饮料"
        }
      });
      const pending = context.repository.listProposals("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ revision: 2, payload: { amountMinor: 860, note: "修正后的饮料" } });
      expect(context.repository.listTransactions().total).toBe(0);

      const listed = await client.callTool({ name: "list_pending_proposals", arguments: {} });
      const listedContent = listed.content as Array<{ type: string; text?: string }>;
      const listedText = listedContent.find((item) => item.type === "text");
      expect(listedText?.text ? JSON.parse(listedText.text)[0].revision : null).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
