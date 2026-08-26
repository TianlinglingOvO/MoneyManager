import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { createTestContext, expenseCategory, incomeCategory, type TestContext, transactionInput } from "./helpers";

describe("轻量资金账户", () => {
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

  it("美元订阅分别使用 CNY、USD 和其他外币账户时保持人民币账本金额与账户实扣独立", async () => {
    const expense = expenseCategory(context);
    const { current } = await activate();
    const wechat = current.services.funds.listAccounts()[0]!;
    const bybit = current.services.funds.createAccount({
      name: "Bybit虚拟卡",
      icon: "卡",
      currency: "USD",
      openingBalanceMinor: 10_000,
      aliases: []
    });
    const usdt = current.services.funds.createAccount({
      name: "USDT钱包",
      icon: "U",
      currency: "USDT",
      openingBalanceMinor: 10_000,
      aliases: []
    });
    const subscription = current.services.matters.createSubscription({
      name: "外币订阅",
      startDate: "2026-08-23",
      recurringAmountMinor: 2_000,
      currency: "USD",
      cycle: "month",
      nextBillingDate: "2026-09-23",
      reminderDays: 3
    });

    const paidByUsd = current.services.matters.createPayment(subscription.id, {
      amountMinor: 2_000,
      currency: "USD",
      localDate: "2026-08-23",
      paymentType: "manual",
      ledgerLink: { mode: "create", categoryId: expense.id, ledgerAmountMinor: 14_000, accountId: bybit.id }
    });
    expect(paidByUsd).toMatchObject({
      actualCnyAmountMinor: 14_000,
      ledgerLink: { amountMinor: 14_000, accountAmountMinor: 2_000 }
    });
    expect(current.services.funds.getAccount(bybit.id).balanceMinor).toBe(8_000);

    const paidByCny = current.services.matters.createPayment(subscription.id, {
      amountMinor: 2_000,
      currency: "USD",
      localDate: "2026-08-24",
      paymentType: "manual",
      ledgerLink: { mode: "create", categoryId: expense.id, ledgerAmountMinor: 14_000, accountId: wechat.id }
    });
    expect(paidByCny.ledgerLink.accountAmountMinor).toBeNull();
    expect(current.services.funds.getAccount(wechat.id).balanceMinor).toBe(86_000);

    const paidByUsdt = current.services.matters.createPayment(subscription.id, {
      amountMinor: 2_000,
      currency: "USD",
      localDate: "2026-08-24",
      paymentType: "manual",
      ledgerLink: { mode: "create", categoryId: expense.id, ledgerAmountMinor: 14_100, accountId: usdt.id, accountAmountMinor: 1_990 }
    });
    expect(paidByUsdt.ledgerLink.accountAmountMinor).toBe(1_990);
    expect(current.services.funds.getAccount(usdt.id).balanceMinor).toBe(8_010);
    expect(context.repository.getFinanceReport("month", "2026-08-01", "expense", "2026-08-24").expenseMinor).toBe(42_100);
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
    const movementsCsv = await request(current.app).get("/api/v1/funds/movements.csv").expect(200).expect("content-type", /text\/csv/);
    expect(movementsCsv.text.split("\r\n")[0]).toBe('﻿"日期","账户","变化金额（元）","来源类型","来源 ID","创建时间","币种"');
    const transfersCsv = await request(current.app).get("/api/v1/transfers.csv").expect(200).expect("content-type", /text\/csv/);
    expect(transfersCsv.text.split("\r\n")[0])
      .toBe('﻿"日期","转出账户","转入账户","扣款金额（元）","到账金额（元）","手续费（元）","备注","删除时间","币种"');
    const transactionsCsv = await request(current.app).get("/api/v1/export.csv").expect(200).expect("content-type", /text\/csv/);
    expect(transactionsCsv.text.split("\r\n")[0])
      .toBe('﻿"日期","类型","金额（元）","分类","备注","来源","删除时间","账户币种","账本金额（CNY）","账户实际金额"');
  });
  it("启用瞬间快照同日旧账为历史基线，而同日新账仍正常追踪", async () => {
    const expense = expenseCategory(context);
    const existing = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 3_000,
      note: null
    }));
    const { current } = await activate();
    expect(context.repository.getTransaction(existing.id)).toMatchObject({
      accountId: null,
      accountAmountMinor: null,
      fundsBaseline: true
    });

    const edited = context.repository.updateTransaction(existing.id, { note: "仅修改备注" });
    expect(edited.accountId).toBeNull();
    expect(current.services.funds.listMovements().items).toEqual([]);
    expect(current.services.health.report("2026-08").issues
      .filter((issue) => issue.type === "funds_missing_account")
      .flatMap((issue) => issue.relatedTransactionIds)).not.toContain(existing.id);

    const created = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 1_200,
      note: null
    }));
    expect(created.fundsBaseline).toBe(false);
    expect(created.accountId).not.toBeNull();
    expect(current.services.funds.listMovements().items.map((movement) => movement.deltaMinor)).toEqual([-1_200]);
  });

  it("普通外币交易独立保存账本金额和账户实扣，并完整支持切换、删除与退款", async () => {
    const expense = expenseCategory(context);
    const { current } = await activate();
    const usd = current.services.funds.createAccount({
      name: "美元卡",
      icon: "$",
      currency: "USD",
      openingBalanceMinor: 10_000,
      aliases: []
    });
    const usdt = current.services.funds.createAccount({
      name: "USDT 钱包",
      icon: "U",
      currency: "USDT",
      openingBalanceMinor: 10_000,
      aliases: []
    });
    expect(() => context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 14_000,
      accountId: usd.id,
      note: null
    }))).toThrow("实际账户金额");

    let transaction = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 14_000,
      accountId: usd.id,
      accountAmountMinor: 2_000,
      note: null
    }));
    expect(transaction).toMatchObject({
      amountMinor: 14_000,
      accountAmountMinor: 2_000,
      account: { currency: "USD" }
    });
    expect(current.services.funds.getAccount(usd.id).balanceMinor).toBe(8_000);

    transaction = context.repository.updateTransaction(transaction.id, { amountMinor: 15_000 });
    expect(current.services.funds.getAccount(usd.id).balanceMinor).toBe(8_000);
    expect(() => context.repository.updateTransaction(transaction.id, { accountId: usdt.id }))
      .toThrow("切换到外币账户");

    transaction = context.repository.updateTransaction(transaction.id, {
      accountId: usdt.id,
      accountAmountMinor: 1_900
    });
    expect(current.services.funds.getAccount(usd.id).balanceMinor).toBe(10_000);
    expect(current.services.funds.getAccount(usdt.id).balanceMinor).toBe(8_100);

    const deleted = context.repository.softDeleteTransaction(transaction.id);
    expect(current.services.funds.getAccount(usdt.id).balanceMinor).toBe(10_000);
    const restored = context.repository.restoreTransaction(deleted.id);
    expect(current.services.funds.getAccount(usdt.id).balanceMinor).toBe(8_100);
    const refunded = current.services.funds.refundTransaction(restored.id, {
      expectedUpdatedAt: restored.updatedAt,
      requestId: "foreign-refund-001"
    });
    expect(current.services.funds.getAccount(usdt.id).balanceMinor).toBe(10_000);
    current.services.funds.undoTransactionRefund(refunded.id, {
      expectedUpdatedAt: refunded.updatedAt,
      requestId: "foreign-refund-undo-001"
    });
    expect(current.services.funds.getAccount(usdt.id).balanceMinor).toBe(8_100);

    expect(current.services.funds.summary()).toMatchObject({
      totalMinor: 150_000,
      currencyTotals: { CNY: 150_000, USD: 10_000, USDT: 8_100 }
    });
    const cny = current.services.funds.listAccounts().find((account) => account.currency === "CNY")!;
    expect(() => current.services.funds.createTransfer({
      fromAccountId: cny.id,
      toAccountId: usd.id,
      debitedMinor: 100,
      creditedMinor: 100,
      localDate: "2026-08-23",
      note: null,
      requestId: "cross-currency-transfer"
    })).toThrow("币种必须相同");
  });

  it("批量补账户先全量校验并原子提交，健康报告只返回一条聚合问题", async () => {
    const expense = expenseCategory(context);
    const baseline = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 500,
      note: null
    }));
    const { current } = await activate();
    const account = current.services.funds.listAccounts()[0]!;
    const first = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 1_000,
      note: null
    }));
    const second = context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 2_000,
      note: null
    }));
    context.database.prepare("DELETE FROM account_movements WHERE source_type = 'transaction' AND source_id IN (?, ?)")
      .run(first.id, second.id);
    context.database.prepare("UPDATE transactions SET account_id = NULL, updated_at = ? WHERE id = ?")
      .run("2026-08-23T05:00:00.000Z", first.id);
    context.database.prepare("UPDATE transactions SET account_id = NULL, updated_at = ? WHERE id = ?")
      .run("2026-08-23T05:00:01.000Z", second.id);

    const issue = current.services.health.report("2026-08").issues
      .filter((item) => item.type === "funds_missing_account");
    expect(issue).toHaveLength(1);
    expect(new Set(issue[0]!.relatedTransactionIds)).toEqual(new Set([first.id, second.id]));

    await request(current.app).post("/api/v1/funds/transactions/assign-account").send({
      accountId: account.id,
      transactions: [
        { id: first.id, expectedUpdatedAt: "2026-08-23T05:00:00.000Z" },
        { id: baseline.id, expectedUpdatedAt: baseline.updatedAt }
      ]
    }).expect(409);
    expect(context.repository.getTransaction(first.id).accountId).toBeNull();

    const response = await request(current.app).post("/api/v1/funds/transactions/assign-account").send({
      accountId: account.id,
      transactions: [
        { id: first.id, expectedUpdatedAt: "2026-08-23T05:00:00.000Z" },
        { id: second.id, expectedUpdatedAt: "2026-08-23T05:00:01.000Z" }
      ]
    }).expect(200);
    expect(response.body.data.transactions).toHaveLength(2);
    expect(current.services.funds.getAccount(account.id).balanceMinor).toBe(97_000);
    expect(current.services.health.report("2026-08").issues
      .filter((item) => item.type === "funds_missing_account")).toEqual([]);
  });
  it("未使用账户可直接修改初始余额和币种，并可丢弃非零初始余额后永久删除", async () => {
    const { current } = await activate();
    const account = current.services.funds.createAccount({
      name: "临时美元卡",
      icon: "$",
      currency: "USD",
      openingBalanceMinor: 755,
      aliases: []
    });
    expect(account).toMatchObject({ isUnused: true, openingBalanceMinor: 755, balanceMinor: 755 });

    const updated = current.services.funds.updateAccount(account.id, {
      currency: "USDT",
      balanceChange: {
        targetBalanceMinor: 112,
        localDate: "2026-08-23",
        note: null,
        requestId: "unused-balance-edit-001"
      },
      expectedUpdatedAt: account.updatedAt
    });
    expect(updated).toMatchObject({
      currency: "USDT",
      openingBalanceMinor: 112,
      balanceMinor: 112,
      isUnused: true
    });
    expect(current.services.funds.listMovements({ accountId: account.id }).items).toEqual([]);

    current.services.funds.deleteUnusedAccount(account.id, { expectedUpdatedAt: updated.updatedAt });
    expect(() => current.services.funds.getAccount(account.id)).toThrow("不存在");
  });

  it("账户余额编辑生成独立校准记录，默认流水和 CSV 排除校准且只允许撤销最新一条", async () => {
    const expense = expenseCategory(context);
    const { current } = await activate();
    let account = current.services.funds.listAccounts()[0]!;
    context.repository.createTransaction(transactionInput(expense.id, {
      localDate: "2026-08-23",
      amountMinor: 1_000,
      accountId: account.id,
      note: null
    }));
    account = current.services.funds.getAccount(account.id);
    expect(account).toMatchObject({ balanceMinor: 99_000, isUnused: false });

    account = current.services.funds.updateAccount(account.id, {
      balanceChange: {
        targetBalanceMinor: 90_000,
        localDate: "2026-08-23",
        note: "编辑账户余额",
        requestId: "balance-edit-adjustment-001"
      },
      expectedUpdatedAt: account.updatedAt
    });
    expect(account.balanceMinor).toBe(90_000);

    const replayed = current.services.funds.adjustAccount({
      accountId: account.id,
      targetBalanceMinor: 90_000,
      localDate: "2026-08-23",
      note: "编辑账户余额",
      requestId: "balance-edit-adjustment-001"
    });
    expect(() => current.services.funds.adjustAccount({
      accountId: account.id,
      targetBalanceMinor: 89_000,
      localDate: "2026-08-23",
      note: "不同内容",
      requestId: "balance-edit-adjustment-001"
    })).toThrow("requestId");

    const second = current.services.funds.adjustAccount({
      accountId: account.id,
      targetBalanceMinor: 88_000,
      localDate: "2026-08-23",
      note: "第二次校准",
      requestId: "balance-edit-adjustment-002"
    });
    const listed = current.services.funds.listAdjustments({ accountId: account.id });
    expect(listed.items).toHaveLength(2);
    expect(listed.items[0]).toMatchObject({
      id: second.id,
      accountName: account.name,
      currency: "CNY",
      balanceBeforeMinor: 90_000,
      canUndo: true
    });
    expect(listed.items[1]).toMatchObject({ id: replayed.id, canUndo: false });
    expect(() => current.services.funds.undoAdjustment(replayed.id)).toThrow("最新");

    const defaultMovements = current.services.funds.listMovements({ accountId: account.id });
    expect(defaultMovements.items.every((movement) => movement.sourceType !== "adjustment")).toBe(true);
    expect(current.services.funds.listMovements({ accountId: account.id, sourceType: "adjustment" }).items).toHaveLength(2);

    const undone = await request(current.app)
      .post(`/api/v1/funds/adjustments/${second.id}/undo`)
      .send({ expectedUpdatedAt: second.updatedAt, requestId: "balance-adjustment-undo-001" })
      .expect(200);
    expect(undone.body.data.balanceMinor).toBe(90_000);
    const undoReplay = await request(current.app)
      .post(`/api/v1/funds/adjustments/${second.id}/undo`)
      .send({ expectedUpdatedAt: second.updatedAt, requestId: "balance-adjustment-undo-001" })
      .expect(200);
    expect(undoReplay.body.data).toEqual(undone.body.data);
    const createReplay = current.services.funds.adjustAccount({
      accountId: account.id,
      targetBalanceMinor: 88_000,
      localDate: "2026-08-23",
      note: "第二次校准",
      requestId: "balance-edit-adjustment-002"
    });
    expect(createReplay).toMatchObject({ id: second.id, canUndo: false });
    expect(current.services.funds.getAccount(account.id).balanceMinor).toBe(90_000);
    expect(() => current.services.funds.adjustAccount({
      accountId: account.id,
      targetBalanceMinor: 87_000,
      localDate: "2026-08-23",
      note: "不同目标",
      requestId: "balance-edit-adjustment-002"
    })).toThrow("requestId");
    expect(current.services.funds.listMovements({ accountId: account.id, sourceType: "adjustment" }).items).toHaveLength(3);
    expect(current.services.health.report("2026-08").issues
      .filter((issue) => issue.type === "funds_orphan")).toEqual([]);

    const csv = await request(current.app).get("/api/v1/funds/movements.csv").expect(200);
    expect(csv.text).not.toContain(',"adjustment",');
    const json = await request(current.app).get("/api/v1/export.json").expect(200);
    expect(json.body.funds.movements.some((movement: { sourceType: string }) => movement.sourceType === "adjustment")).toBe(true);
    expect(json.body.funds.adjustments).toHaveLength(1);

    current.services.funds.undoAdjustment(replayed.id);
    expect(current.services.funds.listAdjustments({ accountId: account.id }).items).toEqual([]);
    expect(current.services.health.report("2026-08").issues
      .filter((issue) => issue.type === "funds_orphan")).toEqual([]);
  });
  it("账户版本在同一毫秒内仍严格递增，余额修改 requestId 只能重放相同请求", async () => {
    const { current } = await activate();
    const created = current.services.funds.createAccount({
      name: "版本测试",
      icon: "版",
      currency: "CNY",
      openingBalanceMinor: 100,
      aliases: []
    });
    const renamed = current.services.funds.updateAccount(created.id, {
      name: "版本测试一",
      expectedUpdatedAt: created.updatedAt
    });
    expect(renamed.updatedAt > created.updatedAt).toBe(true);
    await request(current.app).patch(`/api/v1/accounts/${created.id}`).send({
      name: "版本测试二",
      expectedUpdatedAt: created.updatedAt
    }).expect(409);

    const balanced = current.services.funds.updateAccount(created.id, {
      balanceChange: {
        targetBalanceMinor: 250,
        localDate: "2026-08-23",
        requestId: "persistent-balance-edit-001"
      },
      expectedUpdatedAt: renamed.updatedAt
    });
    expect(balanced).toMatchObject({ openingBalanceMinor: 250, balanceMinor: 250 });
    const replay = current.services.funds.updateAccount(created.id, {
      balanceChange: {
        targetBalanceMinor: 250,
        localDate: "2026-08-23",
        requestId: "persistent-balance-edit-001"
      },
      expectedUpdatedAt: renamed.updatedAt
    });
    expect(replay).toEqual(balanced);
    expect(() => current.services.funds.updateAccount(created.id, {
      balanceChange: {
        targetBalanceMinor: 300,
        localDate: "2026-08-23",
        requestId: "persistent-balance-edit-001"
      },
      expectedUpdatedAt: balanced.updatedAt
    })).toThrow("requestId");
    expect(current.services.funds.getAccount(created.id).balanceMinor).toBe(250);
    const lifecycle = current.services.funds.createAccount({
      name: "生命周期版本",
      icon: "时",
      currency: "CNY",
      openingBalanceMinor: 0,
      aliases: []
    });
    const lifecycleUpdated = current.services.funds.updateAccount(lifecycle.id, {
      name: "生命周期版本一",
      expectedUpdatedAt: lifecycle.updatedAt
    });
    expect(lifecycleUpdated.updatedAt > lifecycle.updatedAt).toBe(true);
    await request(current.app).post(`/api/v1/accounts/${lifecycle.id}/archive`).send({
      expectedUpdatedAt: lifecycle.updatedAt
    }).expect(409);
    const lifecycleArchived = current.services.funds.archiveAccount(lifecycle.id, {
      expectedUpdatedAt: lifecycleUpdated.updatedAt
    });
    expect(lifecycleArchived.updatedAt > lifecycleUpdated.updatedAt).toBe(true);
    await request(current.app).post(`/api/v1/accounts/${lifecycle.id}/restore`).send({
      expectedUpdatedAt: lifecycleUpdated.updatedAt
    }).expect(409);
    const lifecycleRestored = current.services.funds.restoreAccount(lifecycle.id, {
      expectedUpdatedAt: lifecycleArchived.updatedAt
    });
    expect(lifecycleRestored.updatedAt > lifecycleArchived.updatedAt).toBe(true);
  });


  it("停用账户拒绝余额修改，待处理提案中的账户引用也阻止删除", async () => {
    const { current } = await activate();
    const archived = current.services.funds.createAccount({
      name: "停用测试",
      icon: "停",
      currency: "CNY",
      openingBalanceMinor: 0,
      aliases: []
    });
    const stopped = current.services.funds.archiveAccount(archived.id, { expectedUpdatedAt: archived.updatedAt });
    expect(() => current.services.funds.updateAccount(stopped.id, {
      balanceChange: {
        targetBalanceMinor: 100,
        localDate: "2026-08-23",
        requestId: "archived-balance-edit-001"
      },
      expectedUpdatedAt: stopped.updatedAt
    })).toThrow("停用账户");

    const referenced = current.services.funds.createAccount({
      name: "提案引用",
      icon: "提",
      currency: "CNY",
      openingBalanceMinor: 0,
      aliases: []
    });
    const now = new Date().toISOString();
    const insertProposal = context.database.prepare(`INSERT INTO proposals(
      id, action, target_transaction_id, payload, reason, source, status, revision,
      request_id, request_hash, created_at, updated_at, resolved_at
    ) VALUES (?, 'create', NULL, ?, NULL, 'openclaw', 'pending', 1, NULL, NULL, ?, ?, NULL)`);
    insertProposal.run(
      "00000000-0000-4000-8000-000000000240",
      "{",
      now,
      now
    );
    await request(current.app).get("/api/v1/accounts").expect(200);
    expect(current.services.funds.getAccount(referenced.id).isUnused).toBe(true);
    expect(() => current.services.funds.assertAccountUnused(referenced.id)).not.toThrow();
    insertProposal.run(
      "00000000-0000-4000-8000-000000000241",
      JSON.stringify({ accountId: referenced.id }),
      now,
      now
    );
    expect(current.services.funds.getAccount(referenced.id).isUnused).toBe(false);
    expect(() => current.services.funds.deleteUnusedAccount(referenced.id, {
      expectedUpdatedAt: referenced.updatedAt
    })).toThrow("业务引用");
    expect(() => current.services.funds.assertAccountUnused(referenced.id)).toThrow("业务引用");
  });



});
