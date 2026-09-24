import { z } from "zod";

export const transactionKindSchema = z.enum(["expense", "income"]);
export const accountCurrencySchema = z.enum(["CNY", "USD", "USDT"]);
export const reportGrainSchema = z.enum(["day", "week", "month", "year"]);
export const appearancePresetSchema = z.enum(["warm-paper", "porcelain", "sage-ledger", "ink-night"]);
export const appearanceDensitySchema = z.enum(["comfortable", "compact"]);
export const appearanceBackgroundPresetSchema = z.enum(["plain", "paper", "linen", "mist"]);
export const accentColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const appearancePatchSchema = z.object({
  preset: appearancePresetSchema.optional(),
  accent: accentColorSchema.optional(),
  density: appearanceDensitySchema.optional(),
  backgroundPreset: appearanceBackgroundPresetSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, "至少需要修改一项外观设置");

export const transactionInputSchema = z.object({
  kind: transactionKindSchema,
  amountMinor: z.number().int().positive().max(100_000_000_000),
  categoryId: z.string().uuid(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(240).optional().nullable(),
  accountId: z.string().uuid().optional().nullable(),
  accountAmountMinor: z.number().int().positive().max(100_000_000_000).optional().nullable()
});

export const transactionPatchSchema = transactionInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "至少需要修改一个字段"
);

export const transactionUpdateRequestSchema = transactionInputSchema.partial().extend({
  expectedUpdatedAt: z.string().datetime()
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"),
  "至少需要修改一个字段"
);

export const transactionDeleteSchema = z.object({
  expectedUpdatedAt: z.string().datetime()
}).strict();

export const categoryInputSchema = z.object({
  kind: transactionKindSchema,
  name: z.string().trim().min(1).max(16),
  icon: z.string().trim().min(1).max(8),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sortOrder: z.number().int().min(0).max(999).optional()
});

export const categoryPatchSchema = z.object({
  name: z.string().trim().min(1).max(16).optional(),
  icon: z.string().trim().min(1).max(8).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isArchived: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "至少需要修改一个字段");

export const categoryDispositionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("archive") }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("delete") }),
  z.object({ action: z.literal("migrate"), targetCategoryId: z.string().uuid() }),
  z.object({
    action: z.literal("purge"),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
    confirmName: z.string().trim().min(1).max(16)
  })
]);

export const permanentDeleteTransactionSchema = z.object({
  expectedUpdatedAt: z.string().min(1),
  confirmation: z.literal("PERMANENT_DELETE")
});

export const transactionQuerySchema = z.object({
  kind: transactionKindSchema.optional(),
  categoryId: z.string().uuid().optional(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().trim().max(80).optional(),
  deleted: z.enum(["active", "trash", "all"]).default("active"),
  sort: z.enum(["date", "recorded", "deleted"]).default("date"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30)
});

export const reportQuerySchema = z.object({
  grain: reportGrainSchema.default("month"),
  anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: transactionKindSchema.default("expense")
});

export const dailyTotalsQuerySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: transactionKindSchema.optional(),
  categoryId: z.string().uuid().optional(),
  search: z.string().trim().max(80).optional()
}).refine((value) => value.start <= value.end, "开始日期不能晚于结束日期");

export const proposalInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    payload: transactionInputSchema,
    reason: z.string().trim().max(240).optional().nullable()
  }),
  z.object({
    action: z.literal("update"),
    targetTransactionId: z.string().uuid(),
    payload: transactionPatchSchema,
    reason: z.string().trim().max(240).optional().nullable()
  }),
  z.object({
    action: z.literal("delete"),
    targetTransactionId: z.string().uuid(),
    payload: z.object({}).default({}),
    reason: z.string().trim().max(240).optional().nullable()
  })
]);

export const proposalRevisionInputSchema = transactionInputSchema.partial().extend({
  expectedRevision: z.number().int().positive()
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
  "至少需要修改一个账目字段"
);

export const proposalResolutionInputSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  expectedRevision: z.number().int().positive()
});

export const aiAnalysisInputSchema = z.object({
  mode: z.enum(["overview", "growth", "saving", "structure", "custom"]),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  question: z.string().trim().max(500).optional().nullable(),
  includeNotes: z.boolean().optional().default(false)
}).refine((value) => value.periodStart <= value.periodEnd, "开始日期不能晚于结束日期")
  .refine((value) => value.mode !== "custom" || Boolean(value.question), "自定义分析需要填写问题");

export const requestIdSchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const accountNameSchema = z.string().trim().min(1).max(40);
export const accountIconSchema = z.string().trim().min(1).max(8);

export const accountInputSchema = z.object({
  name: accountNameSchema,
  icon: accountIconSchema,
  currency: accountCurrencySchema.default("CNY"),
  openingBalanceMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000),
  aliases: z.array(accountNameSchema).max(20).optional().default([])
}).strict();

export const fundsActivationSchema = z.object({
  accounts: z.array(accountInputSchema).min(1).max(20),
  defaultExpenseAccountName: accountNameSchema,
  defaultIncomeAccountName: accountNameSchema,
  defaultFeeCategoryId: z.string().uuid().optional().nullable()
}).strict();

export const accountCreateSchema = accountInputSchema.extend({
  openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
}).strict();

export const accountPatchSchema = z.object({
  name: accountNameSchema.optional(),
  icon: accountIconSchema.optional(),
  currency: accountCurrencySchema.optional(),
  aliases: z.array(accountNameSchema).max(20).optional(),
  balanceChange: z.object({
    targetBalanceMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(240).optional().nullable(),
    requestId: requestIdSchema
  }).strict().optional(),
  expectedUpdatedAt: z.string().datetime()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"), "至少需要修改一个字段");

export const accountVersionSchema = z.object({
  expectedUpdatedAt: z.string().datetime()
}).strict();

export const fundsAssignTransactionsSchema = z.object({
  accountId: z.string().uuid(),
  transactions: z.array(z.object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime()
  }).strict()).min(1).max(100)
}).strict();

export const accountMovementQuerySchema = z.object({
  accountId: z.string().uuid().optional(),
  sourceType: z.enum(["transaction", "loan", "loan_repayment", "transfer", "adjustment"]).optional(),
  sort: z.enum(["recent", "oldest"]).default("recent"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});

export const accountAdjustmentQuerySchema = z.object({
  accountId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});

export const accountAdjustmentUndoSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  requestId: requestIdSchema
}).strict();

export const transferInputSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  debitedMinor: z.number().int().positive().max(100_000_000_000),
  creditedMinor: z.number().int().positive().max(100_000_000_000),
  feeCategoryId: z.string().uuid().optional().nullable(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(240).optional().nullable(),
  requestId: requestIdSchema
}).strict().superRefine((value, context) => {
  if (value.fromAccountId === value.toAccountId) {
    context.addIssue({ code: "custom", path: ["toAccountId"], message: "转出和转入账户不能相同" });
  }
  if (value.debitedMinor < value.creditedMinor) {
    context.addIssue({ code: "custom", path: ["creditedMinor"], message: "到账金额不能大于实际扣款金额" });
  }
});

export const transferPatchSchema = z.object({
  fromAccountId: z.string().uuid().optional(),
  toAccountId: z.string().uuid().optional(),
  debitedMinor: z.number().int().positive().max(100_000_000_000).optional(),
  creditedMinor: z.number().int().positive().max(100_000_000_000).optional(),
  feeCategoryId: z.string().uuid().optional().nullable(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(240).optional().nullable(),
  expectedUpdatedAt: z.string().datetime(),
  requestId: requestIdSchema
}).strict().superRefine((value, context) => {
  if (value.fromAccountId && value.toAccountId && value.fromAccountId === value.toAccountId) {
    context.addIssue({ code: "custom", path: ["toAccountId"], message: "转出和转入账户不能相同" });
  }
  if (value.debitedMinor !== undefined && value.creditedMinor !== undefined && value.debitedMinor < value.creditedMinor) {
    context.addIssue({ code: "custom", path: ["creditedMinor"], message: "到账金额不能大于实际扣款金额" });
  }
});

export const fundsMutationSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  requestId: requestIdSchema
}).strict();

export const adjustmentInputSchema = z.object({
  accountId: z.string().uuid(),
  targetBalanceMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(240).optional().nullable(),
  requestId: requestIdSchema
}).strict();

export const transactionRefundSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  requestId: requestIdSchema,
  accountId: z.string().uuid().optional().nullable()
}).strict();


export const openClawSettingsPatchSchema = z.object({
  mode: z.enum(["confirm", "direct"])
});

export const budgetMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const monthlyBudgetInputSchema = z.object({
  totalMinor: z.number().int().positive().max(100_000_000_000).nullable(),
  categories: z.array(z.object({
    categoryId: z.string().uuid(),
    amountMinor: z.number().int().positive().max(100_000_000_000)
  }).strict()).max(200),
  expectedUpdatedAt: z.string().datetime().nullable().optional()
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.categories.forEach((item, index) => {
    if (ids.has(item.categoryId)) {
      context.addIssue({ code: "custom", path: ["categories", index, "categoryId"], message: "同一分类不能重复设置预算" });
    }
    ids.add(item.categoryId);
  });
});

export const budgetDeleteSchema = z.object({
  expectedUpdatedAt: z.string().datetime()
}).strict();

export const healthReportQuerySchema = z.object({
  month: budgetMonthSchema
});

export const healthAcknowledgeSchema = z.object({
  month: budgetMonthSchema
}).strict();

export const healthExplainSchema = z.object({
  month: budgetMonthSchema
}).strict();

export const matterCurrencySchema = z.enum(["CNY", "USD"]);
export const matterStatusSchema = z.enum(["active", "paused", "cancelled"]);
export const subscriptionCycleSchema = z.enum(["month", "year", "custom"]);
export const ledgerLinkModeSchema = z.enum(["none", "existing", "create"]);
export const matterDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ledgerLinkInputBase = z.object({
  mode: ledgerLinkModeSchema.default("none"),
  transactionId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  ledgerAmountMinor: z.number().int().positive().max(100_000_000_000).optional(),
  accountId: z.string().uuid().optional(),
  accountAmountMinor: z.number().int().positive().max(100_000_000_000).optional()
}).strict();

export const ledgerLinkInputSchema = ledgerLinkInputBase.superRefine((value, context) => {
  if (value.mode === "existing" && !value.transactionId) {
    context.addIssue({ code: "custom", path: ["transactionId"], message: "请选择要关联的账目" });
  }
  if (value.mode === "create" && !value.categoryId) {
    context.addIssue({ code: "custom", path: ["categoryId"], message: "创建账目时必须选择分类" });
  }
  if (value.mode !== "create" && (value.categoryId !== undefined || value.ledgerAmountMinor !== undefined || value.accountId !== undefined || value.accountAmountMinor !== undefined)) {
    context.addIssue({ code: "custom", path: ["mode"], message: "只有同时创建账目时才能填写分类和实际金额" });
  }
});

export const borrowerInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  note: z.string().trim().max(240).optional().nullable()
}).strict();

export const borrowerPatchSchema = borrowerInputSchema.partial().extend({
  isArchived: z.boolean().optional(),
  expectedUpdatedAt: z.string().datetime().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "至少需要修改一个字段");

export const matterQuerySchema = z.object({
  status: z.enum(["active", "trash", "all"]).default("active"),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30)
});

export const loanInputSchema = z.object({
  borrowerId: z.string().uuid(),
  principalMinor: z.number().int().positive().max(100_000_000_000),
  localDate: matterDateSchema,
  purpose: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(240).optional().nullable(),
  ledgerLink: ledgerLinkInputSchema.optional(),
  accountId: z.string().uuid().optional().nullable()
}).strict();

export const loanCreateInputSchema = loanInputSchema.omit({ borrowerId: true }).extend({
  borrowerId: z.string().uuid().optional(),
  newBorrowerName: z.string().trim().min(1).max(80).optional()
}).strict().superRefine((value, context) => {
  if (Boolean(value.borrowerId) === Boolean(value.newBorrowerName)) {
    context.addIssue({ code: "custom", path: ["borrowerId"], message: "必须选择已有借款人或填写新借款人，且只能选择一种" });
  }
});

export const loanPatchSchema = loanInputSchema.omit({ borrowerId: true, ledgerLink: true }).partial().extend({
  expectedUpdatedAt: z.string().datetime().optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"), "至少需要修改一个字段");

export const repaymentInputSchema = z.object({
  amountMinor: z.number().int().positive().max(100_000_000_000),
  localDate: matterDateSchema,
  note: z.string().trim().max(240).optional().nullable(),
  ledgerLink: ledgerLinkInputSchema.optional(),
  accountId: z.string().uuid().optional().nullable()
}).strict();

export const repaymentPatchSchema = repaymentInputSchema.omit({ ledgerLink: true }).partial().extend({
  expectedUpdatedAt: z.string().datetime().optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"), "至少需要修改一个字段");

const subscriptionBaseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  plan: z.string().trim().max(100).optional().nullable(),
  startDate: matterDateSchema,
  recurringAmountMinor: z.number().int().positive().max(100_000_000_000),
  currency: matterCurrencySchema,
  cycle: subscriptionCycleSchema,
  customDays: z.number().int().min(1).max(366).optional().nullable(),
  nextBillingDate: matterDateSchema.optional().nullable(),
  reminderDays: z.number().int().min(0).max(60).default(3),
  website: z.string().trim().url().max(500).optional().nullable(),
  note: z.string().trim().max(240).optional().nullable(),
  initialPayment: z.object({
    amountMinor: z.number().int().positive().max(100_000_000_000),
    currency: matterCurrencySchema,
    localDate: matterDateSchema,
    note: z.string().trim().max(240).optional().nullable(),
    paymentType: z.literal("initial").default("initial"),
    ledgerLink: ledgerLinkInputSchema.optional()
  }).strict().optional()
}).strict();

export const subscriptionInputSchema = subscriptionBaseSchema.superRefine((value, context) => {
  if (value.cycle === "custom" && !value.customDays) {
    context.addIssue({ code: "custom", path: ["customDays"], message: "自定义周期需要填写天数" });
  }
  if (value.cycle !== "custom" && value.customDays !== undefined && value.customDays !== null) {
    context.addIssue({ code: "custom", path: ["customDays"], message: "月度或年度周期不需要填写自定义天数" });
  }
  if (value.initialPayment && value.initialPayment.amountMinor <= 0) {
    context.addIssue({ code: "custom", path: ["initialPayment", "amountMinor"], message: "首笔付款金额必须大于零" });
  }
});

export const subscriptionPatchSchema = subscriptionBaseSchema.omit({ initialPayment: true }).partial().extend({
  expectedUpdatedAt: z.string().datetime().optional(),
  status: matterStatusSchema.optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"), "至少需要修改一个字段");

export const subscriptionPaymentInputSchema = z.object({
  amountMinor: z.number().int().positive().max(100_000_000_000),
  currency: matterCurrencySchema,
  localDate: matterDateSchema,
  note: z.string().trim().max(240).optional().nullable(),
  paymentType: z.enum(["initial", "renewal", "manual"]).default("renewal"),
  ledgerLink: ledgerLinkInputSchema.optional()
}).strict();

export const subscriptionPaymentPatchSchema = subscriptionPaymentInputSchema.partial().extend({
  expectedUpdatedAt: z.string().datetime().optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"), "至少需要修改一个字段");

export const matterDeleteSchema = z.object({ expectedUpdatedAt: z.string().datetime().optional() }).strict();

export const planStatusSchema = z.enum(["open", "completed", "cancelled"]);

export const planInputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  amountMinor: z.number().int().positive().max(100_000_000_000).optional().nullable(),
  dueDate: matterDateSchema.optional().nullable(),
  reminderDays: z.number().int().min(0).max(60).default(3),
  note: z.string().trim().max(240).optional().nullable()
}).strict();

export const planPatchSchema = planInputSchema.partial().extend({
  expectedUpdatedAt: z.string().datetime().optional(),
  status: z.enum(["open", "cancelled"]).optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"), "至少需要修改一个字段");

export const planCompleteSchema = z.object({
  expectedUpdatedAt: z.string().datetime().optional(),
  amountMinor: z.number().int().positive().max(100_000_000_000).optional(),
  localDate: matterDateSchema.optional(),
  note: z.string().trim().max(240).optional().nullable(),
  ledgerLink: ledgerLinkInputSchema.optional()
}).strict();

export const planQuerySchema = matterQuerySchema.extend({
  planStatus: planStatusSchema.optional()
});
