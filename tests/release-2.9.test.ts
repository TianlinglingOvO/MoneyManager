import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../server/app";
import { createLedgerMcpServer } from "../server/mcp";
import { BackupService } from "../server/backup";
import { BudgetService } from "../server/budgets";
import { HealthService } from "../server/health";
import { OpenClawControlService } from "../server/openclaw-control";
import type { HealthIssue } from "../shared/types";
import { createTestContext, expenseCategory, incomeCategory, transactionInput, type TestContext } from "./helpers";

describe("2.9.0 固定支出、预测与体检", () => {
  let context: TestContext;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Noon on 2026-08-12 in Asia/Shanghai: twelve days of August have passed.
    vi.setSystemTime(new Date("2026-08-12T04:00:00.000Z"));
    context = createTestContext();
  });

  afterEach(() => {
    context.cleanup();
    vi.useRealTimers();
  });

  function seedAugust(app: ReturnType<typeof createApp>["app"], fixed: boolean) {
    const rent = context.repository.createCategory({ kind: "expense", name: "居住", icon: "房", color: "#5963A6", isFixed: fixed });
    const food = context.repository.createCategory({ kind: "expense", name: "餐饮", icon: "餐", color: "#D66A4C" });
    context.repository.createTransaction(transactionInput(rent.id, { amountMinor: 320_000, localDate: "2026-08-05", note: "房租" }));
    context.repository.createTransaction(transactionInput(food.id, { amountMinor: 98_600, localDate: "2026-08-09", note: "日常" }));
    return { rent, food, put: request(app).put("/api/v1/budgets/2026-08").send({ totalMinor: 600_000, categories: [], expectedUpdatedAt: null }) };
  }

  it("只有支出分类可以标记为固定支出，接口可读写这个标记", async () => {
    const app = createApp(context.config, context.database).app;
    const created = await request(app).post("/api/v1/categories").send({ kind: "expense", name: "保险", icon: "保", color: "#2E7D61", isFixed: true }).expect(201);
    expect(created.body.data.isFixed).toBe(true);
    await request(app).post("/api/v1/categories").send({ kind: "income", name: "工资", icon: "薪", color: "#2E7D61", isFixed: true }).expect(409);
    const income = incomeCategory(context);
    await request(app).patch(`/api/v1/categories/${income.id}`).send({ isFixed: true }).expect(409);
    const cleared = await request(app).patch(`/api/v1/categories/${created.body.data.id}`).send({ isFixed: false }).expect(200);
    expect(cleared.body.data.isFixed).toBe(false);
  });

  it("固定支出按实际计入，其余支出才按天外推，月初交房租不再误报会超预算", async () => {
    const app = createApp(context.config, context.database).app;
    await seedAugust(app, true).put.expect(200);
    const budget = await request(app).get("/api/v1/budgets/2026-08").expect(200);
    expect(budget.body.data.fixedSpentMinor).toBe(320_000);
    // 3,200 as recorded plus 986 over 12 of 31 days.
    expect(budget.body.data.forecastMinor).toBe(320_000 + Math.round(98_600 / 12 * 31));
    const report = await request(app).get("/api/v1/reports/health?month=2026-08").expect(200);
    const titles = report.body.data.issues.map((issue: HealthIssue) => issue.title);
    expect(titles).not.toContain("预计月底会超出预算");
  });

  it("没有标记时仍按旧方式外推，提示里带上标记固定支出的建议和千分位金额", async () => {
    const app = createApp(context.config, context.database).app;
    await seedAugust(app, false).put.expect(200);
    const report = await request(app).get("/api/v1/reports/health?month=2026-08").expect(200);
    const issues = report.body.data.issues as HealthIssue[];
    const forecast = issues.find((issue) => issue.title === "预计月底会超出预算");
    expect(forecast?.detail).toContain(`¥${new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2 }).format(Math.round(418_600 / 12 * 31) / 100)}`);
    const large = issues.find((issue) => issue.type === "large_expense");
    expect(large?.detail).toContain("¥3,200.00");
    expect(large?.detail).toContain("标记为固定支出");
  });

  it("固定支出只在明显高于往常时才算大额", async () => {
    const app = createApp(context.config, context.database).app;
    const rent = context.repository.createCategory({ kind: "expense", name: "居住", icon: "房", color: "#5963A6", isFixed: true });
    context.repository.createTransaction(transactionInput(rent.id, { amountMinor: 320_000, localDate: "2026-07-05", note: "七月房租" }));
    const august = context.repository.createTransaction(transactionInput(rent.id, { amountMinor: 320_000, localDate: "2026-08-05", note: "八月房租" }));
    await request(app).put("/api/v1/budgets/2026-08").send({ totalMinor: 600_000, categories: [], expectedUpdatedAt: null }).expect(200);
    let report = await request(app).get("/api/v1/reports/health?month=2026-08").expect(200);
    expect(report.body.data.issues.some((issue: HealthIssue) => issue.type === "large_expense")).toBe(false);

    context.repository.updateTransaction(august.id, { amountMinor: 500_000 });
    report = await request(app).get("/api/v1/reports/health?month=2026-08").expect(200);
    const large = (report.body.data.issues as HealthIssue[]).find((issue) => issue.type === "large_expense");
    expect(large?.detail).toContain("高出 50% 以上");
  });

  it("OpenClaw 可以设置固定支出，撤销会恢复原标记", async () => {
    const budgets = new BudgetService(context.database, context.repository, () => context.config.timezone);
    const openclaw = new OpenClawControlService(context.database, context.repository, context.config, budgets);
    openclaw.setMode("direct");
    const server = createLedgerMcpServer(context.repository, context.config, {
      backup: new BackupService(context.database, context.repository, context.config),
      openclaw,
      budgets,
      health: new HealthService(context.database, context.repository, budgets)
    });
    const client = new Client({ name: "test-openclaw", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const category = expenseCategory(context);
      await client.callTool({ name: "direct_update_category", arguments: { requestId: "fixed-category-001", categoryId: category.id, expectedUpdatedAt: category.updatedAt, isFixed: true } });
      expect(context.repository.getCategory(category.id).isFixed).toBe(true);
      const operation = openclaw.listOperations(5).find((item) => item.action === "category.update")!;
      openclaw.undo(operation.id, "user");
      expect(context.repository.getCategory(category.id).isFixed).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe("2.9.0 接口修正与新能力", () => {
  let context: TestContext;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-23T04:00:00.000Z"));
    context = createTestContext();
  });

  afterEach(() => {
    context.cleanup();
    vi.useRealTimers();
  });

  async function activatedApp() {
    const current = createApp(context.config, context.database);
    context.repository.attachFundsService(current.services.funds);
    await request(current.app).post("/api/v1/funds/activate").set("Idempotency-Key", "funds-activate-29").send({
      accounts: [
        { name: "微信", icon: "微", openingBalanceMinor: 100_000 },
        { name: "支付宝", icon: "支", openingBalanceMinor: 0 }
      ],
      defaultExpenseAccountName: "微信",
      defaultIncomeAccountName: "微信"
    }).expect(201);
    return current;
  }

  it("includeArchived=false 和 includeDeleted=false 真的会隐藏停用账户和已删除转账", async () => {
    const { app } = await activatedApp();
    const created = await request(app).post("/api/v1/accounts").send({ name: "旧钱包", icon: "旧", openingBalanceMinor: 0, aliases: [] }).expect(201);
    await request(app).post(`/api/v1/accounts/${created.body.data.id}/archive`).send({ expectedUpdatedAt: created.body.data.updatedAt }).expect(200);
    const hidden = await request(app).get("/api/v1/accounts?includeArchived=false").expect(200);
    expect(hidden.body.data.map((item: { name: string }) => item.name)).not.toContain("旧钱包");
    const shown = await request(app).get("/api/v1/accounts?includeArchived=true").expect(200);
    expect(shown.body.data.map((item: { name: string }) => item.name)).toContain("旧钱包");

    const accounts = (await request(app).get("/api/v1/accounts").expect(200)).body.data as Array<{ id: string; name: string }>;
    const from = accounts.find((item) => item.name === "微信")!;
    const to = accounts.find((item) => item.name === "支付宝")!;
    const transfer = await request(app).post("/api/v1/transfers").send({ fromAccountId: from.id, toAccountId: to.id, debitedMinor: 1_000, creditedMinor: 1_000, localDate: "2026-08-23", requestId: "transfer-29-001" }).expect(201);
    await request(app).delete(`/api/v1/transfers/${transfer.body.data.id}`).send({ expectedUpdatedAt: transfer.body.data.updatedAt, requestId: "transfer-29-002" }).expect(200);
    expect((await request(app).get("/api/v1/transfers?includeDeleted=false").expect(200)).body.data).toHaveLength(0);
    expect((await request(app).get("/api/v1/transfers?includeDeleted=true").expect(200)).body.data).toHaveLength(1);
  });

  it("搜索同时匹配备注、分类名称和金额，导出当前视图只包含匹配的有效账目", async () => {
    const app = createApp(context.config, context.database).app;
    const food = expenseCategory(context);
    const salary = incomeCategory(context);
    context.repository.createTransaction(transactionInput(food.id, { amountMinor: 1_234, note: "早餐", localDate: "2026-08-03" }));
    context.repository.createTransaction(transactionInput(food.id, { amountMinor: 5_000, note: "聚餐", localDate: "2026-07-03" }));
    context.repository.createTransaction(transactionInput(salary.id, { kind: "income", amountMinor: 900_000, note: "八月", localDate: "2026-08-10" }));
    const deleted = context.repository.createTransaction(transactionInput(food.id, { amountMinor: 1_234, note: "记重了", localDate: "2026-08-04" }));
    context.repository.softDeleteTransaction(deleted.id);

    const byCategory = await request(app).get(`/api/v1/transactions?search=${encodeURIComponent(food.name)}`).expect(200);
    expect(byCategory.body.data.total).toBe(2);
    const byAmount = await request(app).get("/api/v1/transactions?search=12.34").expect(200);
    expect(byAmount.body.data.items.map((item: { note: string }) => item.note)).toEqual(["早餐"]);
    const totals = await request(app).get(`/api/v1/reports/daily-totals?start=1970-01-01&end=9999-12-31&search=${encodeURIComponent(food.name)}`).expect(200);
    expect(totals.body.data.reduce((sum: number, item: { expenseMinor: number }) => sum + item.expenseMinor, 0)).toBe(6_234);

    const csv = await request(app).get(`/api/v1/transactions.csv?start=2026-08-01&end=2026-08-31&search=${encodeURIComponent(food.name)}`).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("money-manager-view-2026-08-01_2026-08-31.csv");
    const lines = csv.text.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("早餐");
    expect(csv.text).not.toContain("记重了");
  });

  it("分类顺序一次性写入，列表不完整时拒绝", async () => {
    const app = createApp(context.config, context.database).app;
    const first = context.repository.createCategory({ kind: "expense", name: "餐饮", icon: "餐", color: "#D66A4C" });
    const second = context.repository.createCategory({ kind: "expense", name: "交通", icon: "车", color: "#4E87A6" });
    const third = context.repository.createCategory({ kind: "expense", name: "购物", icon: "购", color: "#B66A8C" });
    const reordered = await request(app).put("/api/v1/categories/order").send({ kind: "expense", categoryIds: [third.id, first.id, second.id] }).expect(200);
    expect(reordered.body.data.map((item: { name: string }) => item.name)).toEqual(["购物", "餐饮", "交通"]);
    await request(app).put("/api/v1/categories/order").send({ kind: "expense", categoryIds: [first.id, second.id] }).expect(409);
    await request(app).put("/api/v1/categories/order").send({ kind: "expense", categoryIds: [first.id, first.id, second.id] }).expect(400);
  });

  it("资金流水带来源说明，并标出修改差额、冲销和恢复", async () => {
    const { app } = await activatedApp();
    const food = expenseCategory(context);
    const created = await request(app).post("/api/v1/transactions").set("Idempotency-Key", "movement-29-001")
      .send(transactionInput(food.id, { amountMinor: 3_000, note: "早餐", localDate: "2026-08-23" })).expect(201);
    const updated = await request(app).patch(`/api/v1/transactions/${created.body.data.id}`).send({ amountMinor: 3_500, expectedUpdatedAt: created.body.data.updatedAt }).expect(200);
    await request(app).delete(`/api/v1/transactions/${created.body.data.id}`).send({ expectedUpdatedAt: updated.body.data.updatedAt }).expect(200);
    await request(app).post(`/api/v1/transactions/${created.body.data.id}/restore`).expect(200);

    const movements = await request(app).get("/api/v1/funds/movements?sort=oldest").expect(200);
    const items = movements.body.data.items as Array<{ deltaMinor: number; description: string; revision: string; sourceDeleted: boolean }>;
    expect(items.map((item) => [item.deltaMinor, item.revision])).toEqual([[-3_000, "original"], [-500, "change"], [3_500, "reversal"], [-3_500, "restore"]]);
    expect(items[0]!.description).toBe(`${food.icon} ${food.name} · 早餐`);
    expect(items.every((item) => item.sourceDeleted === false)).toBe(true);
  });

  it("订阅汇总区分待确认和即将续费，并给出折合每月花费", async () => {
    const { services } = createApp(context.config, context.database);
    services.matters.createSubscription({ name: "网盘", startDate: "2026-07-20", recurringAmountMinor: 2_100, currency: "CNY", cycle: "month", nextBillingDate: "2026-08-20", reminderDays: 3 });
    services.matters.createSubscription({ name: "Netflix", startDate: "2026-07-25", recurringAmountMinor: 1_549, currency: "USD", cycle: "month", nextBillingDate: "2026-08-25", reminderDays: 3 });
    services.matters.createSubscription({ name: "域名", startDate: "2025-11-02", recurringAmountMinor: 6_900, currency: "CNY", cycle: "year", nextBillingDate: "2026-11-02", reminderDays: 7 });
    const summary = services.matters.subscriptionSummary("2026-08-23");
    expect(summary.attentionCount).toBe(2);
    expect(summary.confirmCount).toBe(1);
    expect(summary.monthlyEquivalent).toEqual([{ currency: "CNY", amountMinor: 2_100 + 575 }, { currency: "USD", amountMinor: 1_549 }]);
  });

  it("迁移 12 为分类增加固定支出标记，旧接口 dashboard 已移除", async () => {
    const columns = context.database.prepare("PRAGMA table_info(categories)").all() as Array<{ name: string; dflt_value: string | null }>;
    expect(columns.find((column) => column.name === "is_fixed")?.dflt_value).toBe("0");
    expect(context.database.prepare("SELECT version, name FROM schema_migrations WHERE version = 12").get()).toEqual({ version: 12, name: "fixed_expense_categories" });
    const app = createApp(context.config, context.database).app;
    await request(app).get("/api/v1/dashboard").expect(404);
  });
});
