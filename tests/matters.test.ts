import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { addBillingPeriod } from "../server/matters";
import { createTestContext, expenseCategory, incomeCategory, type TestContext, transactionInput } from "./helpers";

describe("财务事项 API", () => {
  let context: TestContext;
  beforeEach(() => { context = createTestContext(); });
  afterEach(() => { context.cleanup(); });

  it("支持借款、分次还款、结清和余额冲突保护", async () => {
    const app = createApp(context.config, context.database).app;
    const borrower = await request(app).post("/api/v1/borrowers").set("Idempotency-Key", "borrower-001").send({ name: "舍友" }).expect(201);
    const loan = await request(app).post("/api/v1/loans").set("Idempotency-Key", "loan-001").send({ borrowerId: borrower.body.data.id, principalMinor: 30_000, localDate: "2026-08-19", purpose: "生活费" }).expect(201);
    expect(loan.body.data.outstandingMinor).toBe(30_000);
    const duplicate = await request(app).post("/api/v1/loans").set("Idempotency-Key", "loan-001").send({ borrowerId: borrower.body.data.id, principalMinor: 30_000, localDate: "2026-08-19", purpose: "生活费" }).expect(201);
    expect(duplicate.body.data.id).toBe(loan.body.data.id);
    await request(app).post(`/api/v1/loans/${loan.body.data.id}/repayments`).send({ amountMinor: 6_500, localDate: "2026-08-20", note: "先还一部分" }).expect(201);
    await request(app).post(`/api/v1/loans/${loan.body.data.id}/repayments`).send({ amountMinor: 23_500, localDate: "2026-08-21" }).expect(201);
    const settled = await request(app).get(`/api/v1/loans/${loan.body.data.id}`).expect(200);
    expect(settled.body.data.status).toBe("settled");
    expect(settled.body.data.outstandingMinor).toBe(0);
    await request(app).post(`/api/v1/loans/${loan.body.data.id}/repayments`).send({ amountMinor: 1, localDate: "2026-08-22" }).expect(409);
    const summary = await request(app).get("/api/v1/loans/summary").expect(200);
    expect(summary.body.data.outstandingMinor).toBe(0);
  });

  it("支持修改版本保护、30 天回收站和恢复", async () => {
    const app = createApp(context.config, context.database).app;
    const created = await request(app).post("/api/v1/borrowers").send({ name: "同事" }).expect(201);
    const loan = await request(app).post("/api/v1/loans").send({ borrowerId: created.body.data.id, principalMinor: 10_000, localDate: "2026-08-19" }).expect(201);
    const stale = await request(app).patch(`/api/v1/loans/${loan.body.data.id}`).send({ expectedUpdatedAt: "2020-01-01T00:00:00.000Z", principalMinor: 9_000 });
    expect(stale.status).toBe(409);
    await request(app).delete(`/api/v1/loans/${loan.body.data.id}`).send({ expectedUpdatedAt: loan.body.data.updatedAt }).expect(200);
    expect((await request(app).get(`/api/v1/loans/${loan.body.data.id}`)).body.data.deletedAt).not.toBeNull();
    await request(app).post(`/api/v1/loans/${loan.body.data.id}/restore`).expect(200);
    expect((await request(app).get(`/api/v1/loans/${loan.body.data.id}`)).body.data.deletedAt).toBeNull();
  });

  it("支持月末锚点、首笔优惠付款和美元/人民币分开汇总", async () => {
    expect(addBillingPeriod("2026-01-31", "month", null, 31)).toBe("2026-02-28");
    expect(addBillingPeriod("2026-02-28", "month", null, 31)).toBe("2026-03-31");
    expect(addBillingPeriod("2024-02-29", "year", null, 29)).toBe("2025-02-28");
    expect(addBillingPeriod("2027-02-28", "year", null, 29)).toBe("2028-02-29");
    const app = createApp(context.config, context.database).app;
    const created = await request(app).post("/api/v1/subscriptions").send({ name: "OpenAI", plan: "Pro", startDate: "2026-01-31", recurringAmountMinor: 1_000, currency: "USD", cycle: "month", nextBillingDate: "2026-02-28", initialPayment: { amountMinor: 500, currency: "USD", localDate: "2026-01-31", paymentType: "initial" } }).expect(201);
    expect(created.body.data.initialPriceMinor).toBe(500);
    expect(created.body.data.nextRenewalDate).toBe("2026-02-28");
    const payment = await request(app).post(`/api/v1/subscriptions/${created.body.data.id}/payments`).send({ amountMinor: 1_000, currency: "USD", localDate: "2026-02-28", paymentType: "renewal" }).expect(201);
    expect(payment.body.data.paidDate).toBe("2026-02-28");
    expect((await request(app).get(`/api/v1/subscriptions/${created.body.data.id}`)).body.data.nextRenewalDate).toBe("2026-03-31");
    const summary = await request(app).get("/api/v1/subscriptions/summary").expect(200);
    expect(summary.body.data.currencies).toEqual([{ currency: "USD", amountMinor: 1_000 }]);
  });

  it("关联已有账目或同时创建账目时保持收支类型和金额校验", async () => {
    const expense = expenseCategory(context);
    const income = incomeCategory(context);
    const existingExpense = context.repository.createTransaction(transactionInput(expense.id, { amountMinor: 30_000 }));
    const app = createApp(context.config, context.database).app;
    const borrower = await request(app).post("/api/v1/borrowers").send({ name: "朋友" }).expect(201);
    const linked = await request(app).post("/api/v1/loans").send({ borrowerId: borrower.body.data.id, principalMinor: 30_000, localDate: "2026-08-19", ledgerLink: { mode: "existing", transactionId: existingExpense.id } }).expect(201);
    expect(linked.body.data.ledgerLink.transactionId).toBe(existingExpense.id);
    const bad = await request(app).post(`/api/v1/loans/${linked.body.data.id}/repayments`).send({ amountMinor: 1_000, localDate: "2026-08-20", ledgerLink: { mode: "existing", transactionId: existingExpense.id } });
    expect(bad.status).toBe(409);
    const created = await request(app).post(`/api/v1/loans/${linked.body.data.id}/repayments`).send({ amountMinor: 1_000, localDate: "2026-08-20", ledgerLink: { mode: "create", categoryId: income.id } }).expect(201);
    expect(created.body.data.ledgerLink.mode).toBe("create");
    expect(context.repository.listTransactions().total).toBe(2);
  });

  it("账本回收站自动清理不会删除关联事项", async () => {
    const expense = expenseCategory(context);
    const linkedTransaction = context.repository.createTransaction(transactionInput(expense.id, { amountMinor: 30_000 }));
    const app = createApp(context.config, context.database).app;
    const borrower = await request(app).post("/api/v1/borrowers").send({ name: "自动清理测试" }).expect(201);
    const loan = await request(app).post("/api/v1/loans").send({
      borrowerId: borrower.body.data.id,
      principalMinor: 30_000,
      localDate: "2026-08-19",
      ledgerLink: { mode: "existing", transactionId: linkedTransaction.id }
    }).expect(201);
    context.repository.softDeleteTransaction(linkedTransaction.id);
    context.database.prepare("UPDATE transactions SET deleted_at = ? WHERE id = ?")
      .run("2026-06-01T00:00:00.000Z", linkedTransaction.id);

    expect(context.repository.purgeExpiredTrash(new Date("2026-08-20T00:00:00.000Z"))).toBe(1);
    const preserved = await request(app).get(`/api/v1/loans/${loan.body.data.id}`).expect(200);
    expect(preserved.body.data.ledgerLink).toMatchObject({ mode: "none", transactionId: null });
  });

  it("美元订阅可关联实际人民币扣款，删除误记续费后恢复日期", async () => {
    const expense = expenseCategory(context);
    const charged = context.repository.createTransaction(transactionInput(expense.id, { amountMinor: 7_200, localDate: "2026-02-28" }));
    const app = createApp(context.config, context.database).app;
    const created = await request(app).post("/api/v1/subscriptions").send({
      name: "云服务",
      startDate: "2026-01-31",
      recurringAmountMinor: 1_000,
      currency: "USD",
      cycle: "month",
      nextBillingDate: "2026-02-28"
    }).expect(201);
    const payment = await request(app).post(`/api/v1/subscriptions/${created.body.data.id}/payments`).send({
      amountMinor: 1_000,
      currency: "USD",
      localDate: "2026-02-28",
      paymentType: "renewal",
      ledgerLink: { mode: "existing", transactionId: charged.id }
    }).expect(201);
    expect(payment.body.data.ledgerLink.transactionId).toBe(charged.id);
    expect((await request(app).get(`/api/v1/subscriptions/${created.body.data.id}`)).body.data.nextBillingDate).toBe("2026-03-31");
    await request(app).delete(`/api/v1/subscriptions/${created.body.data.id}/payments/${payment.body.data.id}`)
      .send({ expectedUpdatedAt: payment.body.data.updatedAt }).expect(200);
    expect((await request(app).get(`/api/v1/subscriptions/${created.body.data.id}`)).body.data.nextBillingDate).toBe("2026-02-28");
  });

  it("完整导出不会在 100 项处截断", () => {
    const { services } = createApp(context.config, context.database);
    for (let index = 0; index < 101; index += 1) {
      services.matters.createBorrower({ name: `借款人 ${index + 1}` });
    }
    const exported = services.matters.exportData() as { borrowers: unknown[] };
    expect(exported.borrowers).toHaveLength(101);
  });

  it("同时创建事项和账目失败时会整体回滚", async () => {
    const expense = expenseCategory(context);
    const app = createApp(context.config, context.database).app;
    const borrower = await request(app).post("/api/v1/borrowers").send({ name: "回滚测试" }).expect(201);
    context.database.exec("CREATE TRIGGER reject_test_loan BEFORE INSERT ON loans BEGIN SELECT RAISE(ABORT, 'reject test loan'); END");
    await request(app).post("/api/v1/loans").send({
      borrowerId: borrower.body.data.id,
      principalMinor: 12_300,
      localDate: "2026-08-19",
      ledgerLink: { mode: "create", categoryId: expense.id }
    }).expect(500);
    expect(context.repository.listTransactions().total).toBe(0);
  });
});
