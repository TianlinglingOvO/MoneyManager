import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory, transactionInput } from "./helpers";

describe("账本仓库", () => {
  let context: TestContext;

  beforeEach(() => { context = createTestContext(); });
  afterEach(() => { context.cleanup(); });

  it("新账本不预置任何收支分类", () => {
    expect(context.repository.listCategories(undefined, true)).toEqual([]);
  });

  it("重复提交同一个幂等键只创建一笔账", () => {
    const category = expenseCategory(context);
    const first = context.repository.createTransaction(transactionInput(category.id), { idempotencyKey: "same-click" });
    const second = context.repository.createTransaction(transactionInput(category.id), { idempotencyKey: "same-click" });
    expect(second.id).toBe(first.id);
    expect(context.repository.listTransactions().total).toBe(1);
  });

  it("停用分类后保留旧账，但不能用于新账", () => {
    const category = expenseCategory(context);
    const existing = context.repository.createTransaction(transactionInput(category.id));
    context.repository.updateCategory(category.id, { isArchived: true });
    expect(context.repository.getTransaction(existing.id).category?.name).toBe(category.name);
    expect(() => context.repository.createTransaction(transactionInput(category.id))).toThrow("停用的分类不能用于新账目");
  });

  it("支持调整分类顺序", () => {
    context.repository.createCategory({ kind: "expense", name: "吃饭", icon: "饭", color: "#D66A4C" });
    context.repository.createCategory({ kind: "expense", name: "交通", icon: "车", color: "#4E87A6" });
    const categories = context.repository.listCategories("expense");
    const first = categories[0]!;
    const second = categories[1]!;
    context.repository.updateCategory(first.id, { sortOrder: second.sortOrder });
    context.repository.updateCategory(second.id, { sortOrder: first.sortOrder });
    const reordered = context.repository.listCategories("expense");
    expect(reordered[0]?.id).toBe(second.id);
    expect(reordered[1]?.id).toBe(first.id);
  });

  it("可把历史账目迁移到同类型分类并删除原分类", () => {
    const source = expenseCategory(context);
    const target = context.repository.createCategory({ kind: "expense", name: "吃饭", icon: "饭", color: "#2E7D61" });
    const active = context.repository.createTransaction(transactionInput(source.id));
    const trashed = context.repository.createTransaction(transactionInput(source.id, { localDate: "2026-08-02" }));
    context.repository.softDeleteTransaction(trashed.id);
    const proposal = context.repository.createProposal({ action: "create", payload: transactionInput(source.id), reason: null });

    const result = context.repository.manageCategory(source.id, { action: "migrate", targetCategoryId: target.id });
    expect(result.migratedTransactionCount).toBe(2);
    expect(() => context.repository.getCategory(source.id)).toThrow("分类不存在");
    expect(context.repository.getTransaction(active.id).categoryId).toBe(target.id);
    expect(context.repository.getTransaction(trashed.id).categoryId).toBe(target.id);
    expect(context.repository.getProposal(proposal.id)).toMatchObject({ revision: 2, payload: { categoryId: target.id } });
    expect(() => context.repository.resolveProposal(proposal.id, "approve", proposal.revision)).toThrow("待确认内容已经更新");
  });

  it("有账目的分类不能直接删除，空分类可以删除", () => {
    const used = expenseCategory(context);
    context.repository.createTransaction(transactionInput(used.id));
    expect(() => context.repository.manageCategory(used.id, { action: "delete" })).toThrow("请先迁移或选择停用");
    const empty = context.repository.createCategory({ kind: "expense", name: "临时", icon: "空", color: "#7A7A73" });
    expect(context.repository.manageCategory(empty.id, { action: "delete" }).action).toBe("delete");
    expect(() => context.repository.getCategory(empty.id)).toThrow("分类不存在");
  });

  it("软删除进入回收站，并可在分类有效时恢复", () => {
    const category = expenseCategory(context);
    const created = context.repository.createTransaction(transactionInput(category.id));
    context.repository.softDeleteTransaction(created.id);
    expect(context.repository.listTransactions({ deleted: "active" }).total).toBe(0);
    expect(context.repository.listTransactions({ deleted: "trash" }).items[0]?.id).toBe(created.id);
    const restored = context.repository.restoreTransaction(created.id);
    expect(restored.deletedAt).toBeNull();
    expect(context.repository.listTransactions().total).toBe(1);
  });

  it("超过 30 天的回收站账目会被清理", () => {
    const category = expenseCategory(context);
    const created = context.repository.createTransaction(transactionInput(category.id));
    context.repository.softDeleteTransaction(created.id);
    context.database.prepare("UPDATE transactions SET deleted_at = ? WHERE id = ?")
      .run("2026-06-01T00:00:00.000Z", created.id);
    expect(context.repository.purgeExpiredTrash(new Date("2026-08-03T00:00:00.000Z"))).toBe(1);
    expect(context.repository.listTransactions({ deleted: "all" }).total).toBe(0);
  });

  it("永久删除只接受回收站账目并使用最新版本保护", () => {
    const category = expenseCategory(context);
    const active = context.repository.createTransaction(transactionInput(category.id));
    expect(() => context.repository.permanentlyDeleteTransaction(active.id, active.updatedAt, "PERMANENT_DELETE")).toThrow("只能永久删除");

    const deleted = context.repository.softDeleteTransaction(active.id);
    expect(() => context.repository.permanentlyDeleteTransaction(deleted.id, active.updatedAt, "PERMANENT_DELETE")).toThrow("已经变化");
    const result = context.repository.permanentlyDeleteTransaction(deleted.id, deleted.updatedAt, "PERMANENT_DELETE");
    expect(result).toMatchObject({ entityType: "transaction", permanentlyDeletedTransactionCount: 1 });
    expect(() => context.repository.getTransaction(deleted.id)).toThrow("账目不存在");
  });

  it("回收站按删除时间倒序而不是发生日期排序", () => {
    const category = expenseCategory(context);
    const olderOccurrence = context.repository.createTransaction(transactionInput(category.id, { localDate: "2025-01-01" }));
    const newerOccurrence = context.repository.createTransaction(transactionInput(category.id, { localDate: "2026-08-20" }));
    context.repository.softDeleteTransaction(olderOccurrence.id);
    context.repository.softDeleteTransaction(newerOccurrence.id);
    context.database.prepare("UPDATE transactions SET deleted_at = ? WHERE id = ?").run("2026-08-18T00:00:00.000Z", olderOccurrence.id);
    context.database.prepare("UPDATE transactions SET deleted_at = ? WHERE id = ?").run("2026-08-17T00:00:00.000Z", newerOccurrence.id);
    expect(context.repository.listTransactions({ deleted: "trash", sort: "deleted" }).items.map((item) => item.id)).toEqual([
      olderOccurrence.id,
      newerOccurrence.id
    ]);
  });

  it("分类永久删除会级联清除账目并拒绝相关待确认提案", () => {
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id));
    const trashed = context.repository.createTransaction(transactionInput(category.id, { localDate: "2026-08-04" }));
    context.repository.softDeleteTransaction(trashed.id);
    const proposal = context.repository.createProposal({ action: "create", payload: transactionInput(category.id), reason: null });
    const impact = context.repository.categoryDeletionImpact(category.id);
    expect(impact).toMatchObject({ activeTransactionCount: 1, trashedTransactionCount: 1, pendingProposalCount: 1 });

    expect(() => context.repository.permanentlyDeleteCategory(category.id, impact.revision, "错误名称")).toThrow("完整的分类名称");
    const result = context.repository.permanentlyDeleteCategory(category.id, impact.revision, category.name);
    expect(result).toMatchObject({ action: "purge", permanentlyDeletedTransactionCount: 2, rejectedProposalCount: 1 });
    expect(context.repository.listTransactions({ deleted: "all" }).total).toBe(0);
    expect(context.repository.getProposal(proposal.id).status).toBe("rejected");
    expect(() => context.repository.getCategory(category.id)).toThrow("分类不存在");
  });

  it("OpenClaw 提议在网页批准前不会改账", () => {
    const category = expenseCategory(context);
    const proposal = context.repository.createProposal({
      action: "create",
      payload: transactionInput(category.id, { amountMinor: 880 }),
      reason: "代记一杯饮料"
    });
    expect(context.repository.listTransactions().total).toBe(0);
    expect(context.repository.listProposals()).toHaveLength(1);
    const resolved = context.repository.resolveProposal(proposal.id, "approve", proposal.revision);
    expect(resolved.proposal.status).toBe("approved");
    expect(resolved.transaction?.source).toBe("openclaw");
    expect(context.repository.listTransactions().total).toBe(1);
  });

  it("拒绝 OpenClaw 提议不会产生账目", () => {
    const category = expenseCategory(context);
    const proposal = context.repository.createProposal({ action: "create", payload: transactionInput(category.id), reason: null });
    const result = context.repository.resolveProposal(proposal.id, "reject", proposal.revision);
    expect(result.proposal.status).toBe("rejected");
    expect(context.repository.listTransactions().total).toBe(0);
  });

  it("可修订新增提案并在重新确认后按最新内容入账", () => {
    const expense = expenseCategory(context);
    const income = context.repository.createCategory({ kind: "income", name: "报销", icon: "收", color: "#2E7D61" });
    const proposal = context.repository.createProposal({
      action: "create",
      payload: transactionInput(expense.id, { amountMinor: 2_440 }),
      reason: "金额需要核对"
    });

    const revised = context.repository.reviseProposal(proposal.id, {
      expectedRevision: proposal.revision,
      kind: "income",
      amountMinor: 2_420,
      categoryId: income.id,
      localDate: "2026-08-04",
      note: "修正后的报销"
    });
    expect(revised.revision).toBe(2);
    expect(revised.payload).toMatchObject({ kind: "income", amountMinor: 2_420, categoryId: income.id, localDate: "2026-08-04", note: "修正后的报销" });
    expect(() => context.repository.resolveProposal(proposal.id, "approve", proposal.revision)).toThrow("待确认内容已经更新");

    const approved = context.repository.resolveProposal(proposal.id, "approve", revised.revision);
    expect(approved.transaction).toMatchObject({ kind: "income", amountMinor: 2_420, categoryId: income.id, localDate: "2026-08-04", note: "修正后的报销" });
    const audit = context.database.prepare("SELECT metadata FROM audit_logs WHERE action = 'proposal.revise' ORDER BY created_at DESC LIMIT 1").get() as { metadata: string };
    expect(audit.metadata).toContain("changedFields");
    expect(audit.metadata).not.toContain("2420");
    expect(audit.metadata).not.toContain("修正后的报销");
  });

  it("可把修改提案展开为完整内容修订，保存后仍保持待确认", () => {
    const source = expenseCategory(context);
    const targetCategory = context.repository.createCategory({ kind: "expense", name: "晚餐", icon: "饭", color: "#4E87A6" });
    const transaction = context.repository.createTransaction(transactionInput(source.id, { amountMinor: 2_440 }));
    const proposal = context.repository.createProposal({
      action: "update",
      targetTransactionId: transaction.id,
      payload: { amountMinor: 2_420 },
      reason: null
    });

    const revised = context.repository.reviseProposal(proposal.id, {
      expectedRevision: 1,
      categoryId: targetCategory.id,
      localDate: "2026-08-05",
      note: null
    });
    expect(revised.status).toBe("pending");
    expect(revised.payload).toEqual({
      kind: "expense",
      amountMinor: 2_420,
      accountId: null,
      accountAmountMinor: null,
      categoryId: targetCategory.id,
      localDate: "2026-08-05",
      note: null
    });
    expect(context.repository.getTransaction(transaction.id).amountMinor).toBe(2_440);
    const approved = context.repository.resolveProposal(proposal.id, "approve", revised.revision);
    expect(approved.transaction).toMatchObject({ amountMinor: 2_420, categoryId: targetCategory.id, localDate: "2026-08-05", note: null });
  });

  it("无实际变化不增加版本，并拒绝修订删除或已处理提案", () => {
    const category = expenseCategory(context);
    const transaction = context.repository.createTransaction(transactionInput(category.id));
    const create = context.repository.createProposal({ action: "create", payload: transactionInput(category.id), reason: null });
    const unchanged = context.repository.reviseProposal(create.id, { expectedRevision: 1, amountMinor: 1_234 });
    expect(unchanged.revision).toBe(1);

    const deletion = context.repository.createProposal({ action: "delete", targetTransactionId: transaction.id, payload: {}, reason: null });
    expect(() => context.repository.reviseProposal(deletion.id, { expectedRevision: 1, amountMinor: 99 })).toThrow("删除提案不能编辑");

    context.repository.resolveProposal(create.id, "reject", create.revision);
    expect(() => context.repository.reviseProposal(create.id, { expectedRevision: 1, amountMinor: 99 })).toThrow("已经处理过了");

    const expired = context.repository.createProposal({ action: "create", payload: transactionInput(category.id), reason: null });
    context.database.prepare("UPDATE proposals SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(expired.id);
    expect(() => context.repository.reviseProposal(expired.id, { expectedRevision: 1, amountMinor: 99 })).toThrow("已经处理过了");
    expect(context.repository.getProposal(expired.id).status).toBe("expired");

    const system = context.repository.createProposal({ action: "create", payload: transactionInput(category.id), reason: null }, "system");
    expect(() => context.repository.reviseProposal(system.id, { expectedRevision: 1, amountMinor: 99 }, "openclaw")).toThrow("只能修订自己创建");
  });

  it("修订时拒绝停用、类型不匹配的分类和已删除目标账目", () => {
    const expense = expenseCategory(context);
    const archived = context.repository.createCategory({ kind: "expense", name: "旧分类", icon: "旧", color: "#7A7A73" });
    const income = context.repository.createCategory({ kind: "income", name: "工资", icon: "收", color: "#2E7D61" });
    const create = context.repository.createProposal({ action: "create", payload: transactionInput(expense.id), reason: null });
    context.repository.updateCategory(archived.id, { isArchived: true });
    expect(() => context.repository.reviseProposal(create.id, { expectedRevision: 1, categoryId: archived.id })).toThrow("停用");
    expect(() => context.repository.reviseProposal(create.id, { expectedRevision: 1, categoryId: income.id })).toThrow("不一致");

    const transaction = context.repository.createTransaction(transactionInput(expense.id));
    const update = context.repository.createProposal({ action: "update", targetTransactionId: transaction.id, payload: { amountMinor: 999 }, reason: null });
    context.repository.softDeleteTransaction(transaction.id);
    expect(() => context.repository.reviseProposal(update.id, { expectedRevision: 1, amountMinor: 888 })).toThrow("不存在");
  });
});
