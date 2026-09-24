import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { amountToMinor, createLedgerMcpServer } from "../server/mcp";
import { APP_VERSION } from "../shared/app-metadata";
import { AiService } from "../server/ai";
import { BackupService } from "../server/backup";
import { OpenClawControlService } from "../server/openclaw-control";
import { BudgetService } from "../server/budgets";
import { HealthService } from "../server/health";
import { FundsService } from "../server/funds";
import { MattersRepository } from "../server/matters";
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
    const budgets = new BudgetService(context.database, context.repository, () => context.config.timezone);
    const ai = new AiService(context.database, context.repository, context.config);
    const health = new HealthService(context.database, context.repository, budgets, ai);
    const openclaw = new OpenClawControlService(context.database, context.repository, context.config, budgets);
    const server = createLedgerMcpServer(context.repository, context.config, {
      ai,
      backup: new BackupService(context.database, context.repository, context.config),
      openclaw,
      budgets,
      health
    });
    const client = new Client({ name: "test-openclaw", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()).toEqual({ name: "sutady-money-manager", version: APP_VERSION });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "direct_add_transaction",
        "direct_add_transactions_batch",
        "direct_create_backup",
        "direct_create_category",
        "direct_delete_budget",
        "direct_delete_transaction",
        "direct_generate_ai_analysis",
        "direct_manage_category",
        "direct_permanently_delete_category",
        "direct_permanently_delete_transaction",
        "direct_restore_transaction",
        "direct_set_budget",
        "direct_update_category",
        "direct_update_timezone",
        "direct_update_transaction",
        "get_app_settings",
        "get_app_status",
        "get_budget_summary",
        "get_category_deletion_impact",
        "get_finance_summary",
        "get_ledger_health",
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
      const requestId = "proposal-add-test-001";
      const firstProposal = await client.callTool({
        name: "propose_add_transaction",
        arguments: {
          requestId,
          kind: "expense",
          amount: 8.8,
          categoryId: category.id,
          localDate: "2026-08-03",
          note: "饮料"
        }
      });
      const replayedProposal = await client.callTool({
        name: "propose_add_transaction",
        arguments: {
          requestId,
          kind: "expense",
          amount: 8.8,
          categoryId: category.id,
          localDate: "2026-08-03",
          note: "饮料"
        }
      });
      expect(firstProposal.content).toEqual(replayedProposal.content);
      expect(context.repository.listTransactions().total).toBe(0);
      const original = context.repository.listProposals("pending")[0]!;
      expect(context.repository.listProposals("pending")).toHaveLength(1);
      const conflict = await client.callTool({
        name: "propose_add_transaction",
        arguments: {
          requestId,
          kind: "expense",
          amount: 9,
          categoryId: category.id,
          localDate: "2026-08-03"
        }
      });
      expect(conflict.isError).toBe(true);
      expect(context.repository.listProposals("pending")).toHaveLength(1);
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
      const health = await client.callTool({ name: "get_ledger_health", arguments: { month: "2026-08" } });
      expect(JSON.stringify(health.content)).not.toContain("修正后的饮料");

      const byName = new Map(tools.tools.map((tool) => [tool.name, tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }]));
      for (const name of ["propose_add_transaction", "propose_update_transaction", "propose_delete_transaction"]) {
        expect(byName.get(name)?.properties).toHaveProperty("requestId");
        expect(byName.get(name)?.required).toContain("requestId");
      }
      for (const name of ["direct_update_transaction", "direct_delete_transaction"]) {
        expect(byName.get(name)?.properties).toHaveProperty("expectedUpdatedAt");
      }
      expect(byName.get("direct_permanently_delete_transaction")?.properties).toHaveProperty("confirmation");
      expect(byName.get("direct_permanently_delete_category")?.properties).toHaveProperty("confirmName");
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("资金工具使用精确账户解析、direct 权限和 requestId 幂等", async () => {
    const budgets = new BudgetService(context.database, context.repository, () => context.config.timezone);
    const ai = new AiService(context.database, context.repository, context.config);
    const funds = new FundsService(context.database, context.repository, () => "2026-08-23");
    context.repository.attachFundsService(funds);
    const matters = new MattersRepository(context.database, context.repository, context.config.timezone, funds);
    const health = new HealthService(context.database, context.repository, budgets, ai);
    const openclaw = new OpenClawControlService(context.database, context.repository, context.config, budgets, funds);
    openclaw.setMode("direct");
    funds.activate({
      accounts: [
        { name: "微信", icon: "微", currency: "CNY", openingBalanceMinor: 100_000, aliases: ["零钱"] },
        { name: "支付宝", icon: "支", currency: "CNY", openingBalanceMinor: 50_000, aliases: [] }
      ],
      defaultExpenseAccountName: "微信",
      defaultIncomeAccountName: "微信"
    }, "funds-mcp-activate");

    const server = createLedgerMcpServer(context.repository, context.config, {
      ai,
      backup: new BackupService(context.database, context.repository, context.config),
      openclaw,
      matters,
      budgets,
      health,
      funds
    });
    const client = new Client({ name: "test-funds", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      for (const name of [
        "list_accounts",
        "get_funds_summary",
        "direct_create_account",
        "direct_update_account",
        "direct_archive_account",
        "direct_restore_account",
        "direct_transfer_funds",
        "direct_adjust_account_balance",
        "direct_refund_transaction",
        "direct_undo_transaction_refund"
      ]) expect(names).toContain(name);

      const requestId = "funds-adjust-mcp-001";
      const first = await client.callTool({
        name: "direct_adjust_account_balance",
        arguments: { requestId, account: "零钱", targetBalance: 1200, localDate: "2026-08-23" }
      });
      const replay = await client.callTool({
        name: "direct_adjust_account_balance",
        arguments: { requestId, account: "零钱", targetBalance: 1200, localDate: "2026-08-23" }
      });
      const firstContent = (first as { content: Array<{ type: "text"; text: string }> }).content;
      const replayContent = (replay as { content: Array<{ type: "text"; text: string }> }).content;
      const firstPayload = JSON.parse(firstContent[0]!.text) as { duplicate: boolean };
      const replayPayload = JSON.parse(replayContent[0]!.text) as { duplicate: boolean };
      expect(firstPayload.duplicate).toBe(false);
      expect(replayPayload.duplicate).toBe(true);
      expect(Number((context.database.prepare("SELECT COUNT(*) AS count FROM account_adjustments").get() as { count: number }).count)).toBe(1);
      expect(funds.resolveAccountId("零钱")).toBe(funds.listAccounts()[0]!.id);

      const category = expenseCategory(context);
      await client.callTool({
        name: "direct_transfer_funds",
        arguments: {
          requestId: "funds-transfer-mcp-001",
          fromAccount: "微信",
          toAccount: "支付宝",
          debitedAmount: 100,
          creditedAmount: 99.5,
          feeCategoryId: category.id,
          localDate: "2026-08-23"
        }
      });
      expect(funds.getAccount(funds.resolveAccountId("微信")).balanceMinor).toBe(110_000);
      expect(funds.getAccount(funds.resolveAccountId("支付宝")).balanceMinor).toBe(59_950);

      const bybit = funds.createAccount({
        name: "Bybit虚拟卡",
        icon: "卡",
        currency: "USD",
        openingBalanceMinor: 10_000,
        aliases: ["Bybit"]
      });
      const foreignArgs = {
        requestId: "funds-foreign-expense-001",
        kind: "expense" as const,
        amount: 140,
        account: "Bybit",
        accountAmount: 20,
        categoryId: category.id,
        localDate: "2026-08-23"
      };
      const foreignResult = await client.callTool({ name: "direct_add_transaction", arguments: foreignArgs });
      const foreignReplay = await client.callTool({ name: "direct_add_transaction", arguments: foreignArgs });
      const foreignPayload = JSON.parse((foreignResult.content as Array<{ type: "text"; text: string }>)[0]!.text) as { result: { id: string; amountMinor: number; accountAmountMinor: number }; duplicate: boolean };
      const foreignReplayPayload = JSON.parse((foreignReplay.content as Array<{ type: "text"; text: string }>)[0]!.text) as { duplicate: boolean };
      expect(foreignPayload).toMatchObject({ duplicate: false, result: { amountMinor: 14_000, accountAmountMinor: 2_000 } });
      expect(foreignReplayPayload.duplicate).toBe(true);
      expect(funds.getAccount(bybit.id).balanceMinor).toBe(8_000);
      const movement = context.database.prepare("SELECT delta_minor FROM account_movements WHERE source_type = 'transaction' AND source_id = ?")
        .get(foreignPayload.result.id) as { delta_minor: number };
      expect(Number(movement.delta_minor)).toBe(-2_000);

      const missingActual = await client.callTool({ name: "direct_add_transaction", arguments: {
        ...foreignArgs,
        requestId: "funds-foreign-missing-001",
        accountAmount: undefined
      } });
      expect(missingActual.isError).toBe(true);
      const missingProposalActual = await client.callTool({ name: "propose_add_transaction", arguments: {
        ...foreignArgs,
        requestId: "funds-foreign-proposal-missing-001",
        accountAmount: undefined
      } });
      expect(missingProposalActual.isError).toBe(true);
      expect(JSON.stringify(missingProposalActual.content)).toContain("不得查询或猜测汇率");

      const borrower = matters.createBorrower({ name: "账户测试借款人" });
      await client.callTool({
        name: "direct_create_loan",
        arguments: {
          requestId: "funds-loan-mcp-001",
          borrowerId: borrower.id,
          amount: 10,
          localDate: "2026-08-23",
          account: "支付宝"
        }
      });
      expect(matters.listLoans({ borrowerId: borrower.id }).items[0]?.accountId).toBe(funds.resolveAccountId("支付宝"));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("direct 模式可以创建和完成计划，缺分类时拒绝且不推断", async () => {
    const category = expenseCategory(context);
    const funds = new FundsService(context.database, context.repository, () => "2026-08-26");
    context.repository.attachFundsService(funds);
    const matters = new MattersRepository(context.database, context.repository, context.config.timezone, funds);
    const budgets = new BudgetService(context.database, context.repository, () => context.config.timezone);
    const openclaw = new OpenClawControlService(context.database, context.repository, context.config, budgets, funds);
    openclaw.setMode("direct");
    const server = createLedgerMcpServer(context.repository, context.config, {
      ai: new AiService(context.database, context.repository, context.config),
      backup: new BackupService(context.database, context.repository, context.config),
      openclaw,
      matters,
      budgets,
      health: new HealthService(context.database, context.repository, budgets, new AiService(context.database, context.repository, context.config)),
      funds
    });
    const client = new Client({ name: "test-plans", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      for (const name of ["list_plans", "get_plan", "get_plan_summary", "direct_create_plan", "direct_complete_plan"]) {
        expect(tools.tools.map((tool) => tool.name)).toContain(name);
      }
      const created = await client.callTool({
        name: "direct_create_plan",
        arguments: { requestId: "plan-mcp-create-001", title: "预购尾款", amount: 88, dueDate: "2026-08-28" }
      });
      const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
      const createdPayload = JSON.parse(createdText ?? "{}") as { result: { id: string; updatedAt: string; amountMinor: number } };
      expect(createdPayload.result.amountMinor).toBe(8_800);
      expect(context.repository.listTransactions().total).toBe(0);

      const missing = await client.callTool({
        name: "direct_complete_plan",
        arguments: {
          requestId: "plan-mcp-complete-missing-001",
          planId: createdPayload.result.id,
          expectedUpdatedAt: createdPayload.result.updatedAt
        }
      });
      expect(missing.isError).toBe(true);

      const completed = await client.callTool({
        name: "direct_complete_plan",
        arguments: {
          requestId: "plan-mcp-complete-001",
          planId: createdPayload.result.id,
          expectedUpdatedAt: createdPayload.result.updatedAt,
          ledgerLink: { mode: "create", categoryId: category.id }
        }
      });
      expect(completed.isError).toBeUndefined();
      expect(context.repository.listTransactions().total).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

});
