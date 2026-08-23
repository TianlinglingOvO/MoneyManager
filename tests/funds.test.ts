import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { createTestContext, expenseCategory, incomeCategory, type TestContext, transactionInput } from "./helpers";

describe("轻量资金账户", () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestContext();
  });

  afterEach(() => {
    context.cleanup();
  });

  function app() {
    return createApp(context.config, context.database);
  }

  async function activate() {
    const current = app();
    context.repository.attachFundsService(current.services.funds);
    const response = await request(current.app)
      .post("/api/v1/funds/activate")
      .set("Idempotency-Key", "funds-activate-001")
      .send({
        accounts: [
          { name: "微信", icon: "微", openingBalanceMinor: 100_000 },
          { name: "支付宝", icon: "支", openingBalanceMinor: 50_000 }
        ],
        defaultExpenseAccountName: "微信",
        defaultIncomeAccountName: "微信"
      })
      .expect(201);
    return { current, summary: response.body.data };
  }

  it("迁移 9 建立资金表并保留旧账为未追踪历史", async () => {
    const expense = expenseCategory(context);
    const old = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-22",
      amountMinor: 1_000
    }));
    const { current, summary } = await activate();

    expect(summary.enabled).toBe(true);
    expect(summary.startedOn).toBe("2026-08-23");
    expect(summary.totalMinor).toBe(150_000);
    expect(context.repository.getTransaction(old.id).accountId).toBeNull();
    expect(Number((context.database.prepare("SELECT COUNT(*) AS count FROM account_movements").get() as { count: number }).count)).toBe(0);
    expect(current.services.funds.listAccounts()).toHaveLength(2);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version = 9").get()).toEqual({ version: 9 });
  });

  it("启用后的收支使用默认或指定账户，并随删除恢复追加补偿流水", async () => {
    const expense = expenseCategory(context);
    const income = incomeCategory(context);
    const { current } = await activate();
    const [wechat, alipay] = current.services.funds.listAccounts();

    const spent = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 12_300,
      note: null
    }));
    expect(spent.accountId).toBe(wechat!.id);
    expect(current.services.funds.getAccount(wechat!.id).balanceMinor).toBe(87_700);

    const earned = context.repository.createTransaction(transactionInput(income.id, {
      kind: "income",
      localDate: "2026-08-23",
      amountMinor: 8_800,
      accountId: alipay!.id,
      note: null
    }));
    expect(earned.accountId).toBe(alipay!.id);
    expect(current.services.funds.getAccount(alipay!.id).balanceMinor).toBe(58_800);

    const deleted = context.repository.softDeleteTransaction(spent.id);
    expect(current.services.funds.getAccount(wechat!.id).balanceMinor).toBe(100_000);
    context.repository.restoreTransaction(deleted.id);
    expect(current.services.funds.getAccount(wechat!.id).balanceMinor).toBe(87_700);
    expect(current.services.funds.listMovements({ accountId: wechat!.id }).items.map((item) => item.deltaMinor))
      .toEqual([-12_300, 12_300, -12_300]);
  });

  it("全额退款排除统计并恢复原账户，且可以撤销退款", async () => {
    const expense = expenseCategory(context);
    const { current } = await activate();
    const wechat = current.services.funds.listAccounts()[0]!;
    const transaction = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 2_400,
      accountId: wechat.id,
      note: null
    }));

    const refunded = current.services.funds.refundTransaction(transaction.id, {
      expectedUpdatedAt: transaction.updatedAt,
      requestId: "refund-transaction-001"
    });
    expect(refunded.refundedAt).not.toBeNull();
    expect(current.services.funds.getAccount(wechat.id).balanceMinor).toBe(100_000);
    expect(context.repository.getFinanceReport("month", "2026-08-01", "expense", "2026-08-23").expenseMinor).toBe(0);
    expect(() => current.services.funds.refundTransaction(transaction.id, {
      expectedUpdatedAt: refunded.updatedAt,
      requestId: "refund-transaction-002"
    })).toThrow("已经退款");

    const restored = current.services.funds.undoTransactionRefund(transaction.id, {
      expectedUpdatedAt: refunded.updatedAt,
      requestId: "refund-undo-001"
    });
    expect(restored.refundedAt).toBeNull();
    expect(current.services.funds.getAccount(wechat.id).balanceMinor).toBe(97_600);
  });

  it("转账本金不计收支，扣款与到账差额只形成一次手续费支出", async () => {
    const expense = expenseCategory(context);
    const { current } = await activate();
    const [wechat, alipay] = current.services.funds.listAccounts();
    const transfer = current.services.funds.createTransfer({
      fromAccountId: wechat!.id,
      toAccountId: alipay!.id,
      debitedMinor: 10_000,
      creditedMinor: 9_800,
      feeCategoryId: expense.id,
      localDate: "2026-08-23",
      note: null,
      requestId: "transfer-001"
    });

    expect(transfer.feeMinor).toBe(200);
    expect(current.services.funds.getAccount(wechat!.id).balanceMinor).toBe(90_000);
    expect(current.services.funds.getAccount(alipay!.id).balanceMinor).toBe(59_800);
    expect(context.repository.getFinanceReport("month", "2026-08-01", "expense", "2026-08-23").expenseMinor).toBe(200);

    const updated = current.services.funds.updateTransfer(transfer.id, {
      debitedMinor: 10_250,
      creditedMinor: 9_900,
      feeCategoryId: expense.id,
      expectedUpdatedAt: transfer.updatedAt,
      requestId: "transfer-update-001"
    });
    expect(updated.feeMinor).toBe(350);
    expect(current.services.funds.getAccount(wechat!.id).balanceMinor).toBe(89_750);
    expect(current.services.funds.getAccount(alipay!.id).balanceMinor).toBe(59_900);
    expect(context.repository.getFinanceReport("month", "2026-08-01", "expense", "2026-08-23").expenseMinor).toBe(350);

    const deleted = current.services.funds.deleteTransfer(transfer.id, {
      expectedUpdatedAt: updated.updatedAt,
      requestId: "transfer-delete-001"
    });
    expect(deleted.deletedAt).not.toBeNull();
    expect(current.services.funds.getAccount(wechat!.id).balanceMinor).toBe(100_000);
    expect(current.services.funds.getAccount(alipay!.id).balanceMinor).toBe(50_000);
  });

  it("余额校准只追加差额流水，不进入收支统计", async () => {
    const { current } = await activate();
    const wechat = current.services.funds.listAccounts()[0]!;
    const adjustment = current.services.funds.adjustAccount({
      accountId: wechat.id,
      targetBalanceMinor: 123_456,
      localDate: "2026-08-23",
      note: "现实余额核对",
      requestId: "adjustment-001"
    });
    expect(adjustment.deltaMinor).toBe(23_456);
    expect(current.services.funds.getAccount(wechat.id).balanceMinor).toBe(123_456);
    expect(context.repository.listTransactions().total).toBe(0);
  });

  it("启用后的借出和还款只改变资金与待收款，不创建普通收支", async () => {
    const { current } = await activate();
    const wechat = current.services.funds.listAccounts()[0]!;
    const borrower = current.services.matters.createBorrower({ name: "舍友" });
    const loan = current.services.matters.createLoan({
      borrowerId: borrower.id,
      principalMinor: 30_000,
      localDate: "2026-08-23",
      purpose: "生活费",
      accountId: wechat.id
    });
    expect(current.services.funds.getAccount(wechat.id).balanceMinor).toBe(70_000);
    expect(context.repository.listTransactions().total).toBe(0);

    current.services.matters.createRepayment(loan.id, {
      amountMinor: 6_500,
      localDate: "2026-08-23",
      accountId: wechat.id
    });
    expect(current.services.funds.getAccount(wechat.id).balanceMinor).toBe(76_500);
    expect(current.services.matters.getLoan(loan.id).outstandingMinor).toBe(23_500);
    expect(context.repository.listTransactions().total).toBe(0);
  });

  it("账户别名不能在有效账户间产生歧义，默认账户与非零余额阻止停用", async () => {
    const { current } = await activate();
    const [wechat, alipay] = current.services.funds.listAccounts();
    expect(() => current.services.funds.updateAccount(alipay!.id, {
      aliases: ["微信"],
      expectedUpdatedAt: alipay!.updatedAt
    })).toThrow("名称或别名");
    expect(() => current.services.funds.archiveAccount(wechat!.id, {
      expectedUpdatedAt: wechat!.updatedAt
    })).toThrow("默认账户");
    expect(() => current.services.funds.archiveAccount(alipay!.id, {
      expectedUpdatedAt: alipay!.updatedAt
    })).toThrow("余额归零");
  });
  it("订阅续费退款会回退付款状态和续费日期，撤销后完整恢复", async () => {
    const expense = expenseCategory(context);
    const { current } = await activate();
    const wechat = current.services.funds.listAccounts()[0]!;
    const subscription = current.services.matters.createSubscription({
      name: "测试订阅",
      startDate: "2026-07-23",
      recurringAmountMinor: 1_000,
      currency: "CNY",
      cycle: "month",
      nextBillingDate: "2026-08-23",
      reminderDays: 3
    });
    const payment = current.services.matters.createPayment(subscription.id, {
      amountMinor: 1_000,
      currency: "CNY",
      localDate: "2026-08-23",
      paymentType: "renewal",
      ledgerLink: { mode: "create", categoryId: expense.id, accountId: wechat.id }
    });
    const transactionId = payment.ledgerLink.transactionId!;
    const transaction = context.repository.getTransaction(transactionId);
    expect(current.services.matters.getSubscription(subscription.id).nextBillingDate).toBe("2026-09-23");

    const refunded = current.services.funds.refundTransaction(transactionId, {
      expectedUpdatedAt: transaction.updatedAt,
      requestId: "subscription-refund-001"
    });
    expect(current.services.matters.getPayment(payment.id).refundedAt).not.toBeNull();
    expect(current.services.matters.getSubscription(subscription.id).nextBillingDate).toBe("2026-08-23");
    expect(current.services.funds.getAccount(wechat.id).balanceMinor).toBe(100_000);

    current.services.funds.undoTransactionRefund(transactionId, {
      expectedUpdatedAt: refunded.updatedAt,
      requestId: "subscription-refund-undo-001"
    });
    expect(current.services.matters.getPayment(payment.id).refundedAt).toBeNull();
    expect(current.services.matters.getSubscription(subscription.id).nextBillingDate).toBe("2026-09-23");
    expect(current.services.funds.getAccount(wechat.id).balanceMinor).toBe(99_000);
  });

  it("资金体检发现不一致且导出包含完整账户、流水和转账数据", async () => {
    const expense = expenseCategory(context);
    const { current } = await activate();
    const wechat = current.services.funds.listAccounts()[0]!;
    const transaction = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 500,
      accountId: wechat.id,
      note: null
    }));
    context.database.prepare("DELETE FROM account_movements WHERE source_type = 'transaction' AND source_id = ?").run(transaction.id);

    const report = current.services.health.report("2026-08");
    expect(report.issues.some((issue) => issue.type === "funds_mismatch")).toBe(true);

    const json = await request(current.app).get("/api/v1/export.json").expect(200);
    expect(json.body.funds.accounts).toHaveLength(2);
    expect(json.body.funds.movements).toEqual([]);
    await request(current.app).get("/api/v1/funds/movements.csv").expect(200).expect("content-type", /text\/csv/);
    await request(current.app).get("/api/v1/transfers.csv").expect(200).expect("content-type", /text\/csv/);
  });

});
