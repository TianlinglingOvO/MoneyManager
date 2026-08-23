import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory, transactionInput } from "./helpers";

describe("月度预算与账本体检", () => {
  let context: TestContext;

  beforeEach(() => { context = createTestContext(); });
  afterEach(() => {
    vi.unstubAllGlobals();
    context.cleanup();
  });

  it("保存独立月份预算、计算支出并保护并发版本", async () => {
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id, {
      amountMinor: 3_000,
      localDate: "2026-08-03"
    }));
    const app = createApp(context.config, context.database).app;

    const empty = await request(app).get("/api/v1/budgets/2026-08").expect(200);
    expect(empty.body.data).toMatchObject({ totalMinor: null, spentMinor: 3_000, updatedAt: null });

    const created = await request(app).put("/api/v1/budgets/2026-08")
      .set("Idempotency-Key", "budget-august")
      .send({
        totalMinor: 10_000,
        categories: [{ categoryId: category.id, amountMinor: 5_000 }],
        expectedUpdatedAt: null
      }).expect(200);
    expect(created.body.data).toMatchObject({
      totalMinor: 10_000,
      spentMinor: 3_000,
      remainingMinor: 7_000
    });
    expect(created.body.data.categories[0]).toMatchObject({
      categoryId: category.id,
      budgetMinor: 5_000,
      spentMinor: 3_000,
      progressPercent: 60
    });

    const duplicate = await request(app).put("/api/v1/budgets/2026-08")
      .set("Idempotency-Key", "budget-august")
      .send({
        totalMinor: 10_000,
        categories: [{ categoryId: category.id, amountMinor: 5_000 }],
        expectedUpdatedAt: null
      }).expect(200);
    expect(duplicate.body.data.updatedAt).toBe(created.body.data.updatedAt);

    await request(app).put("/api/v1/budgets/2026-08").send({
      totalMinor: 12_000,
      categories: [],
      expectedUpdatedAt: null
    }).expect(409);

    const leap = await request(app).get("/api/v1/budgets/2024-02").expect(200);
    expect(leap.body.data.daysInMonth).toBe(29);
  });

  it("分类停用保留既有预算，迁移时同月预算相加", async () => {
    const source = expenseCategory(context);
    const target = context.repository.createCategory({
      kind: "expense", name: "吃饭", icon: "饭", color: "#2E7D61"
    });
    const app = createApp(context.config, context.database).app;
    const sourceBudget = await request(app).put("/api/v1/budgets/2026-09").send({
      totalMinor: null,
      categories: [
        { categoryId: source.id, amountMinor: 1_000 },
        { categoryId: target.id, amountMinor: 2_000 }
      ],
      expectedUpdatedAt: null
    }).expect(200);

    context.repository.manageCategory(source.id, { action: "archive" });
    await request(app).put("/api/v1/budgets/2026-09").send({
      totalMinor: 8_000,
      categories: [
        { categoryId: source.id, amountMinor: 1_100 },
        { categoryId: target.id, amountMinor: 2_000 }
      ],
      expectedUpdatedAt: sourceBudget.body.data.updatedAt
    }).expect(409);

    context.repository.manageCategory(source.id, { action: "migrate", targetCategoryId: target.id });
    const migrated = await request(app).get("/api/v1/budgets/2026-09").expect(200);
    expect(migrated.body.data.categories).toHaveLength(1);
    expect(migrated.body.data.categories[0]).toMatchObject({
      categoryId: target.id,
      budgetMinor: 3_000
    });
  });

  it("删除唯一的分类预算时不会留下空预算外壳", async () => {
    const category = expenseCategory(context);
    const app = createApp(context.config, context.database).app;
    await request(app).put("/api/v1/budgets/2026-10").send({
      totalMinor: null,
      categories: [{ categoryId: category.id, amountMinor: 2_000 }],
      expectedUpdatedAt: null
    }).expect(200);
    context.repository.manageCategory(category.id, { action: "delete" });
    const row = context.database.prepare("SELECT month FROM monthly_budgets WHERE month = ?").get("2026-10");
    expect(row).toBeUndefined();
  });

  it("体检识别重复与预算风险，核对后不会自动改账", async () => {
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id, {
      amountMinor: 6_000,
      localDate: "2026-08-03",
      note: "仅本机敏感备注"
    }));
    context.repository.createTransaction(transactionInput(category.id, {
      amountMinor: 6_000,
      localDate: "2026-08-03",
      note: "仅本机敏感备注"
    }));
    const app = createApp(context.config, context.database).app;
    await request(app).put("/api/v1/budgets/2026-08").send({
      totalMinor: 10_000,
      categories: [{ categoryId: category.id, amountMinor: 8_000 }],
      expectedUpdatedAt: null
    }).expect(200);

    const report = await request(app).get("/api/v1/reports/health?month=2026-08").expect(200);
    expect(report.body.data.issues.some((issue: { type: string }) => issue.type === "duplicate")).toBe(true);
    expect(report.body.data.issues.some((issue: { type: string }) => issue.type === "budget_warning")).toBe(true);
    const duplicate = report.body.data.issues.find((issue: { type: string }) => issue.type === "duplicate");
    const beforeCount = context.repository.listTransactions().total;
    const acknowledged = await request(app)
      .post(`/api/v1/reports/health/${duplicate.fingerprint}/acknowledge`)
      .send({ month: "2026-08" })
      .expect(200);
    expect(acknowledged.body.data.issues.find((issue: { fingerprint: string }) =>
      issue.fingerprint === duplicate.fingerprint).acknowledged).toBe(true);
    expect(context.repository.listTransactions().total).toBe(beforeCount);
  });

  it("AI 只接收程序体检事实，不发送账目备注", async () => {
    context.cleanup();
    context = createTestContext({ deepseekApiKey: "test-key" });
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id, {
      localDate: "2026-08-03",
      note: "绝不能发送的备注"
    }));
    context.repository.createTransaction(transactionInput(category.id, {
      localDate: "2026-08-03",
      note: "绝不能发送的备注"
    }));
    let body = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ overview: "请先核对重复记录。", suggestions: ["查看相关账目"] }) } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const app = createApp(context.config, context.database).app;
    await request(app).post("/api/v1/reports/health/explain").send({ month: "2026-08" }).expect(200);
    expect(body).not.toContain("绝不能发送的备注");
  });

  it("当前月体检包含更早已到期但仍未确认的订阅", async () => {
    const createdApp = createApp(context.config, context.database);
    const today = createdApp.services.budgets.today();
    const firstOfMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    firstOfMonth.setUTCDate(0);
    const overdueDate = firstOfMonth.toISOString().slice(0, 8) + "15";
    const now = new Date().toISOString();
    context.database.prepare(`INSERT INTO subscriptions(
      id, name, plan, start_date, recurring_amount_minor, currency, cycle, custom_days,
      next_billing_date, reminder_days, status, website, note, created_at, updated_at, deleted_at
    ) VALUES (?, ?, NULL, ?, ?, 'CNY', 'month', NULL, ?, 3, 'active', NULL, NULL, ?, ?, NULL)`)
      .run("88888888-8888-4888-8888-888888888888", "跨月待确认订阅", overdueDate, 1_000, overdueDate, now, now);
    const report = await request(createdApp.app)
      .get(`/api/v1/reports/health?month=${today.slice(0, 7)}`)
      .expect(200);
    expect(report.body.data.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "subscription_due", title: "跨月待确认订阅续费待确认" })
    ]));
  });

  it("体检识别未来日期与 OpenClaw 十分钟内近重复，但不会自动改账", async () => {
    const category = expenseCategory(context);
    const createdApp = createApp(context.config, context.database);
    const today = createdApp.services.budgets.today();
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    context.repository.createTransaction(transactionInput(category.id, {
      localDate: tomorrow.toISOString().slice(0, 10),
      amountMinor: 8_800,
      note: "未来日期测试"
    }), { source: "user", actor: "user" });
    context.repository.createTransaction(transactionInput(category.id, {
      localDate: today,
      amountMinor: 2_420,
      note: "第一条不同备注"
    }), { source: "openclaw", actor: "openclaw" });
    context.repository.createTransaction(transactionInput(category.id, {
      localDate: today,
      amountMinor: 2_420,
      note: "第二条不同备注"
    }), { source: "openclaw", actor: "openclaw" });
    const before = context.repository.listTransactions().total;
    const report = await request(createdApp.app).get(`/api/v1/reports/health?month=${today.slice(0, 7)}`).expect(200);
    expect(report.body.data.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "future_date" }),
      expect.objectContaining({ type: "openclaw_duplicate" })
    ]));
    expect(context.repository.listTransactions().total).toBe(before);
  });
});
