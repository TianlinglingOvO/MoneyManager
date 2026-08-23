import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory, incomeCategory, transactionInput } from "./helpers";

describe("HTTP API", () => {
  let context: TestContext;

  beforeEach(() => { context = createTestContext(); });
  afterEach(() => { context.cleanup(); });

  it("支持账目增删改查、分页、搜索和重复提交保护", async () => {
    const category = expenseCategory(context);
    const app = createApp(context.config, context.database).app;
    const createResponse = await request(app).post("/api/v1/transactions")
      .set("Idempotency-Key", "mobile-save-1")
      .send(transactionInput(category.id));
    expect(createResponse.status).toBe(201);
    const id = createResponse.body.data.id as string;

    const duplicate = await request(app).post("/api/v1/transactions")
      .set("Idempotency-Key", "mobile-save-1")
      .send(transactionInput(category.id));
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.data.id).toBe(id);

    await request(app).post("/api/v1/transactions").send(transactionInput(category.id, {
      amountMinor: 990,
      localDate: "2026-08-04",
      note: "午餐"
    })).expect(201);

    const list = await request(app).get("/api/v1/transactions?page=1&pageSize=1&search=午餐").expect(200);
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0].note).toBe("午餐");

    const updateResponse = await request(app).patch(`/api/v1/transactions/${id}`).send({
      amountMinor: 2_500,
      expectedUpdatedAt: createResponse.body.data.updatedAt
    }).expect(200);
    const updated = await request(app).get(`/api/v1/transactions/${id}`).expect(200);
    expect(updated.body.data.amountMinor).toBe(2_500);
    expect(updated.body.data.occurredAt).toBeUndefined();
    const stored = context.database.prepare("SELECT occurred_at, local_date FROM transactions WHERE id = ?").get(id) as { occurred_at: string; local_date: string };
    expect(stored).toEqual({ occurred_at: "2026-08-03", local_date: "2026-08-03" });
    await request(app).delete(`/api/v1/transactions/${id}`).send({
      expectedUpdatedAt: updateResponse.body.data.updatedAt
    }).expect(200);
    const trash = await request(app).get("/api/v1/transactions?deleted=trash").expect(200);
    expect(trash.body.data.items[0].id).toBe(id);
    await request(app).post(`/api/v1/transactions/${id}/restore`).expect(200);
  });

  it("支持停用、迁移和安全删除分类", async () => {
    const source = expenseCategory(context);
    const target = context.repository.createCategory({ kind: "expense", name: "吃饭", icon: "饭", color: "#2E7D61" });
    context.repository.createTransaction(transactionInput(source.id));
    const app = createApp(context.config, context.database).app;

    await request(app).post(`/api/v1/categories/${source.id}/disposition`).send({ action: "delete" }).expect(409);
    const migrated = await request(app).post(`/api/v1/categories/${source.id}/disposition`)
      .send({ action: "migrate", targetCategoryId: target.id }).expect(200);
    expect(migrated.body.data.migratedTransactionCount).toBe(1);
    expect(context.repository.listTransactions().items[0]?.categoryId).toBe(target.id);
  });

  it("永久删除回收站账目时保留事项并解除账本关联", async () => {
    const category = expenseCategory(context);
    const transaction = context.repository.createTransaction(transactionInput(category.id, { amountMinor: 30_000 }));
    const app = createApp(context.config, context.database).app;
    const borrower = await request(app).post("/api/v1/borrowers").send({ name: "舍友" }).expect(201);
    const loan = await request(app).post("/api/v1/loans").send({
      borrowerId: borrower.body.data.id,
      principalMinor: 30_000,
      localDate: "2026-08-19",
      ledgerLink: { mode: "existing", transactionId: transaction.id }
    }).expect(201);

    await request(app).delete(`/api/v1/transactions/${transaction.id}/permanent`).send({
      expectedUpdatedAt: transaction.updatedAt,
      confirmation: "PERMANENT_DELETE"
    }).expect(409);
    const deleted = context.repository.softDeleteTransaction(transaction.id);
    const purged = await request(app).delete(`/api/v1/transactions/${transaction.id}/permanent`).send({
      expectedUpdatedAt: deleted.updatedAt,
      confirmation: "PERMANENT_DELETE"
    }).expect(200);
    expect(purged.body.data).toMatchObject({ permanentlyDeletedTransactionCount: 1, detachedLedgerLinkCount: 1 });
    const preserved = await request(app).get(`/api/v1/loans/${loan.body.data.id}`).expect(200);
    expect(preserved.body.data.ledgerLink).toMatchObject({ mode: "none", transactionId: null });
    await request(app).get(`/api/v1/transactions/${transaction.id}`).expect(404);
  });

  it("分类永久删除先返回影响并拒绝过期版本", async () => {
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id));
    const app = createApp(context.config, context.database).app;
    const impact = await request(app).get(`/api/v1/categories/${category.id}/deletion-impact`).expect(200);
    context.repository.createTransaction(transactionInput(category.id, { localDate: "2026-08-04" }));
    await request(app).post(`/api/v1/categories/${category.id}/disposition`).send({
      action: "purge",
      expectedRevision: impact.body.data.revision,
      confirmName: category.name
    }).expect(409);
    const current = await request(app).get(`/api/v1/categories/${category.id}/deletion-impact`).expect(200);
    const purged = await request(app).post(`/api/v1/categories/${category.id}/disposition`).send({
      action: "purge",
      expectedRevision: current.body.data.revision,
      confirmName: category.name
    }).expect(200);
    expect(purged.body.data.permanentlyDeletedTransactionCount).toBe(2);
  });

  it("按账单筛选条件返回完整的每日收入与支出汇总", async () => {
    const expense = expenseCategory(context);
    const income = incomeCategory(context);
    context.repository.createTransaction(transactionInput(expense.id, { amountMinor: 1_250, localDate: "2026-08-03", note: "午餐" }));
    context.repository.createTransaction(transactionInput(expense.id, { amountMinor: 750, localDate: "2026-08-03", note: "饮料" }));
    context.repository.createTransaction(transactionInput(income.id, { kind: "income", amountMinor: 5_000, localDate: "2026-08-03", note: "报销" }));
    context.repository.createTransaction(transactionInput(expense.id, { amountMinor: 300, localDate: "2026-08-04", note: "午餐" }));
    const app = createApp(context.config, context.database).app;

    const all = await request(app).get("/api/v1/reports/daily-totals?start=2026-08-01&end=2026-08-31").expect(200);
    expect(all.body.data).toEqual([
      { localDate: "2026-08-04", incomeMinor: 0, expenseMinor: 300, transactionCount: 1 },
      { localDate: "2026-08-03", incomeMinor: 5_000, expenseMinor: 2_000, transactionCount: 3 }
    ]);

    const filtered = await request(app).get(`/api/v1/reports/daily-totals?start=2026-08-01&end=2026-08-31&kind=expense&categoryId=${expense.id}&search=午餐`).expect(200);
    expect(filtered.body.data).toEqual([
      { localDate: "2026-08-04", incomeMinor: 0, expenseMinor: 300, transactionCount: 1 },
      { localDate: "2026-08-03", incomeMinor: 0, expenseMinor: 1_250, transactionCount: 1 }
    ]);
  });

  it("账单超过一百笔时可继续读取后续页面", async () => {
    const category = expenseCategory(context);
    for (let index = 0; index < 101; index += 1) {
      context.repository.createTransaction(transactionInput(category.id, { amountMinor: index + 1, note: `分页测试 ${index + 1}` }));
    }
    const app = createApp(context.config, context.database).app;
    const first = await request(app).get("/api/v1/transactions?page=1&pageSize=100").expect(200);
    const second = await request(app).get("/api/v1/transactions?page=2&pageSize=100").expect(200);
    expect(first.body.data.total).toBe(101);
    expect(first.body.data.items).toHaveLength(100);
    expect(second.body.data.items).toHaveLength(1);
  });

  it("待确认修订接口使用版本保护，保存后仍需单独批准", async () => {
    const category = expenseCategory(context);
    const proposal = context.repository.createProposal({
      action: "create",
      payload: transactionInput(category.id, { amountMinor: 2_440 }),
      reason: "修正金额"
    });
    const app = createApp(context.config, context.database).app;

    const revised = await request(app).patch(`/api/v1/proposals/${proposal.id}`).send({
      expectedRevision: proposal.revision,
      amountMinor: 2_420,
      note: "正确金额"
    }).expect(200);
    expect(revised.body.data).toMatchObject({ status: "pending", revision: 2 });
    expect(context.repository.listTransactions().total).toBe(0);

    const staleSave = await request(app).patch(`/api/v1/proposals/${proposal.id}`).send({
      expectedRevision: 1,
      amountMinor: 2_400
    }).expect(409);
    expect(staleSave.body.error.code).toBe("PROPOSAL_REVISION_CONFLICT");

    const stale = await request(app).post(`/api/v1/proposals/${proposal.id}/resolve`).send({
      decision: "approve",
      expectedRevision: 1
    }).expect(409);
    expect(stale.body.error.code).toBe("PROPOSAL_REVISION_CONFLICT");
    expect(context.repository.listTransactions().total).toBe(0);

    const approved = await request(app).post(`/api/v1/proposals/${proposal.id}/resolve`).send({
      decision: "approve",
      expectedRevision: 2
    }).expect(200);
    expect(approved.body.data.transaction.amountMinor).toBe(2_420);
  });

  it("待确认修订接口拒绝空修改和删除提案", async () => {
    const category = expenseCategory(context);
    const transaction = context.repository.createTransaction(transactionInput(category.id));
    const deletion = context.repository.createProposal({ action: "delete", targetTransactionId: transaction.id, payload: {}, reason: null });
    const app = createApp(context.config, context.database).app;

    await request(app).patch(`/api/v1/proposals/${deletion.id}`).send({ expectedRevision: 1 }).expect(400);
    await request(app).patch(`/api/v1/proposals/${deletion.id}`).send({ expectedRevision: 1, amountMinor: 500 }).expect(409);
  });

  it("Cloudflare Access 模式下拒绝缺少身份的请求", async () => {
    const protectedContext = createTestContext({
      authMode: "cloudflare",
      cloudflareTeamDomain: "example.cloudflareaccess.com",
      cloudflareAudience: "test-audience",
      allowedEmail: "owner@example.com"
    });
    try {
      const app = createApp(protectedContext.config, protectedContext.database).app;
      const response = await request(app).get("/api/v1/categories");
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    } finally {
      protectedContext.cleanup();
    }
  });

  it("认证刷新入口不读取账本并返回首页", async () => {
    const app = createApp(context.config, context.database).app;
    const response = await request(app).get("/auth/refresh");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/");
    const bootstrap = await request(app).get("/auth/refresh-boot.js").expect(200);
    expect(bootstrap.headers["cache-control"]).toContain("no-store");
    expect(bootstrap.text).toContain("serviceWorker.getRegistrations");
    expect(bootstrap.text).toContain("caches.delete");
    expect(bootstrap.text).not.toContain("indexedDB.deleteDatabase");
    expect(bootstrap.text).not.toContain("localStorage.clear");
    expect(context.repository.listTransactions().total).toBe(0);
  });

  it("允许浏览器显示仅保存在本机的 blob 背景图片", async () => {
    const app = createApp(context.config, context.database).app;
    const response = await request(app).get("/health").expect(200);
    expect(response.body).toMatchObject({ status: "ok", version: "2.2.1" });
    expect(response.headers["content-security-policy"]).toContain("img-src 'self' data: blob:");

    const status = await request(app).get("/api/v1/status").expect(200);
    expect(status.body.data.version).toBe("2.2.1");
  });

  it("网页账目修改和删除拒绝旧版本，并拒绝跨站写请求", async () => {
    const category = expenseCategory(context);
    const transaction = context.repository.createTransaction(transactionInput(category.id));
    const app = createApp(context.config, context.database).app;

    await request(app).patch(`/api/v1/transactions/${transaction.id}`).send({
      amountMinor: 2_000,
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z"
    }).expect(409);
    await request(app).delete(`/api/v1/transactions/${transaction.id}`).send({
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z"
    }).expect(409);
    expect(context.repository.getTransaction(transaction.id).deletedAt).toBeNull();

    await request(app).post("/api/v1/transactions")
      .set("Sec-Fetch-Site", "cross-site")
      .send(transactionInput(category.id, { localDate: "2026-08-04" }))
      .expect(403);
    await request(app).post("/api/v1/transactions")
      .set("Origin", "https://attacker.example")
      .set("Host", "money.sutady.top")
      .send(transactionInput(category.id, { localDate: "2026-08-04" }))
      .expect(403);
  });

  it("只有网页接口能切换 OpenClaw 模式，并可查询与撤销直接操作", async () => {
    const category = expenseCategory(context);
    const created = context.repository.createTransaction(transactionInput(category.id), { source: "openclaw", actor: "openclaw" });
    const appWithServices = createApp(context.config, context.database);
    const settings = await request(appWithServices.app).patch("/api/v1/openclaw/settings").send({ mode: "direct" }).expect(200);
    expect(settings.body.data).toMatchObject({ mode: "direct", credentialsExposed: false });

    const operation = appWithServices.services.openclaw.execute({
      requestId: "api-undo-001", action: "transaction.delete", entityType: "transaction", summary: "测试删除", request: { id: created.id },
      run: () => {
        const before = context.repository.getTransaction(created.id, false);
        const deleted = context.repository.softDeleteTransaction(created.id, "openclaw");
        return { result: deleted, entityId: created.id, snapshots: [{ entityType: "transaction" as const, entityId: created.id, before: appWithServices.services.openclaw.transactionSnapshot(before), after: appWithServices.services.openclaw.transactionSnapshot(deleted) }] };
      }
    });
    const listed = await request(appWithServices.app).get("/api/v1/openclaw/operations").expect(200);
    expect(listed.body.data[0].id).toBe(operation.operation.id);
    await request(appWithServices.app).post(`/api/v1/openclaw/operations/${operation.operation.id}/undo`).expect(200);
    expect(context.repository.getTransaction(created.id).deletedAt).toBeNull();
  });

  it("MCP 使用独立令牌并拒绝未授权请求", async () => {
    const securedContext = createTestContext({ mcpApiToken: "a".repeat(40) });
    try {
      const app = createApp(securedContext.config, securedContext.database).app;
      const response = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(response.status).toBe(401);
    } finally {
      securedContext.cleanup();
    }
  });

  it("可导出 UTF-8 CSV 和完整 JSON", async () => {
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id));
    const app = createApp(context.config, context.database).app;
    const csv = await request(app).get("/api/v1/export.csv").expect(200);
    expect(csv.text).toContain("日期");
    expect(csv.text).toContain("早餐");
    const json = await request(app).get("/api/v1/export.json").expect(200);
    expect(json.body.format).toBe("sutady-money-manager");
    expect(json.body.transactions).toHaveLength(1);
  });

  it("首次可保存浏览器时区，并立即更新服务运行时规则", async () => {
    const app = createApp(context.config, context.database).app;
    const initial = await request(app).get("/api/v1/settings").expect(200);
    expect(initial.body.data.timezone).toBe(context.config.timezone);
    expect(initial.body.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(initial.body.data.rows.find((row: { key: string }) => row.key === "timezone.initialized")?.value).toBe("false");
    await request(app).patch("/api/v1/settings/timezone").send({ timezone: "Asia/Singapore" }).expect(200);
    expect(context.config.timezone).toBe("Asia/Singapore");
    const updated = await request(app).get("/api/v1/settings").expect(200);
    expect(updated.body.data.timezone).toBe("Asia/Singapore");
    expect(updated.body.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(updated.body.data.rows.find((row: { key: string }) => row.key === "timezone.initialized")?.value).toBe("true");
  });
});
