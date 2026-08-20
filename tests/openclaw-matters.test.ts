import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLedgerMcpServer } from "../server/mcp";
import { AiService } from "../server/ai";
import { BackupService } from "../server/backup";
import { MattersRepository } from "../server/matters";
import { OpenClawControlService } from "../server/openclaw-control";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory } from "./helpers";

function parsed(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((item) => item.type === "text")?.text ?? "null");
}

describe("OpenClaw 财务事项 MCP", () => {
  let context: TestContext;
  let client: Client;
  let server: ReturnType<typeof createLedgerMcpServer>;
  let control: OpenClawControlService;

  beforeEach(async () => {
    context = createTestContext();
    control = new OpenClawControlService(context.database, context.repository, context.config);
    control.setMode("direct");
    const matters = new MattersRepository(context.database, context.repository, context.config.timezone);
    server = createLedgerMcpServer(context.repository, context.config, {
      ai: new AiService(context.database, context.repository, context.config),
      backup: new BackupService(context.database, context.repository, context.config),
      openclaw: control,
      matters
    });
    client = new Client({ name: "matters-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    context.cleanup();
  });

  it("提供事项查询工具，直接新增借款、还款和订阅付款且重复请求不重复写入", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_borrowers", "list_loans", "get_loan_summary", "list_subscriptions", "get_subscription_summary",
      "direct_create_borrower", "direct_create_loan", "direct_record_loan_repayment", "direct_create_subscription",
      "direct_record_subscription_payment"
    ]));

    const borrower = parsed(await client.callTool({ name: "direct_create_borrower", arguments: { requestId: "matter-borrower-001", name: "室友" } })).result;
    const loan = parsed(await client.callTool({ name: "direct_create_loan", arguments: {
      requestId: "matter-loan-001", borrowerId: borrower.id, amount: 300, localDate: "2026-08-19", purpose: "生活费"
    } })).result;
    const repaymentArgs = { requestId: "matter-repayment-001", loanId: loan.id, amount: 65, localDate: "2026-08-19", note: "部分归还" };
    const repayment = parsed(await client.callTool({ name: "direct_record_loan_repayment", arguments: repaymentArgs })).result;
    const duplicate = parsed(await client.callTool({ name: "direct_record_loan_repayment", arguments: repaymentArgs }));
    expect(duplicate.duplicate).toBe(true);
    expect(parsed(await client.callTool({ name: "get_loan_summary", arguments: {} })).outstandingMinor).toBe(23_500);

    const category = expenseCategory(context);
    const subscriptionPayload = parsed(await client.callTool({ name: "direct_create_subscription", arguments: {
      requestId: "matter-subscription-001", name: "OpenAI", plan: "基础", startDate: "2026-08-19", amount: 5,
      currency: "USD", cycle: "month", initialPayment: { amount: 5, localDate: "2026-08-19" }
    } }));
    expect(subscriptionPayload).toHaveProperty("result");
    const subscription = subscriptionPayload.result;
    const payment = parsed(await client.callTool({ name: "direct_record_subscription_payment", arguments: {
      requestId: "matter-payment-001", subscriptionId: subscription.id, amount: 10, currency: "USD", localDate: "2026-09-19",
      ledgerLink: { mode: "create", categoryId: category.id, ledgerAmountMinor: 72 }
    } })).result;
    expect(payment.amountMinor).toBe(1_000);
    expect(parsed(await client.callTool({ name: "get_subscription_summary", arguments: {} })).activeCount).toBe(1);
    expect(context.repository.listTransactions().total).toBe(1);
  });

  it("confirm 模式拒绝事项直接写入，并且借款操作可通过现有撤销工具恢复", async () => {
    control.setMode("confirm");
    const rejected = await client.callTool({ name: "direct_create_borrower", arguments: { requestId: "matter-confirm-001", name: "不会写入" } });
    expect(rejected.isError).toBe(true);

    control.setMode("direct");
    const created = parsed(await client.callTool({ name: "direct_create_borrower", arguments: { requestId: "matter-undo-001", name: "可撤销" } }));
    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: created.operation.id } });
    expect(parsed(await client.callTool({ name: "list_borrowers", arguments: {} })).total).toBe(0);

    const subscription = parsed(await client.callTool({ name: "direct_create_subscription", arguments: {
      requestId: "matter-subscription-undo-001",
      name: "可撤销订阅",
      startDate: "2026-08-19",
      amount: 10,
      currency: "USD",
      cycle: "month",
      initialPayment: { amount: 5, localDate: "2026-08-19" }
    } }));
    await client.callTool({ name: "undo_openclaw_operation", arguments: { operationId: subscription.operation.id } });
    expect(parsed(await client.callTool({ name: "list_subscriptions", arguments: {} })).total).toBe(0);
  });
});
