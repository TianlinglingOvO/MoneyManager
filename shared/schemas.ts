import { z } from "zod";

export const transactionKindSchema = z.enum(["expense", "income"]);
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
  note: z.string().trim().max(240).optional().nullable()
});

export const transactionPatchSchema = transactionInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "至少需要修改一个字段"
);

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
  question: z.string().trim().max(500).optional().nullable()
}).refine((value) => value.periodStart <= value.periodEnd, "开始日期不能晚于结束日期")
  .refine((value) => value.mode !== "custom" || Boolean(value.question), "自定义分析需要填写问题");

export const requestIdSchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const openClawSettingsPatchSchema = z.object({
  mode: z.enum(["confirm", "direct"])
});

export const matterCurrencySchema = z.enum(["CNY", "USD"]);
export const matterStatusSchema = z.enum(["active", "paused", "cancelled"]);
export const subscriptionCycleSchema = z.enum(["month", "year", "custom"]);
export const ledgerLinkModeSchema = z.enum(["none", "existing", "create"]);
export const matterDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ledgerLinkInputBase = z.object({
  mode: ledgerLinkModeSchema.default("none"),
  transactionId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  ledgerAmountMinor: z.number().int().positive().max(100_000_000_000).optional()
}).strict();

export const ledgerLinkInputSchema = ledgerLinkInputBase.superRefine((value, context) => {
  if (value.mode === "existing" && !value.transactionId) {
    context.addIssue({ code: "custom", path: ["transactionId"], message: "请选择要关联的账目" });
  }
  if (value.mode === "create" && !value.categoryId) {
    context.addIssue({ code: "custom", path: ["categoryId"], message: "创建账目时必须选择分类" });
  }
  if (value.mode !== "create" && (value.categoryId !== undefined || value.ledgerAmountMinor !== undefined)) {
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
  ledgerLink: ledgerLinkInputSchema.optional()
}).strict();

export const loanPatchSchema = loanInputSchema.omit({ borrowerId: true, ledgerLink: true }).partial().extend({
  expectedUpdatedAt: z.string().datetime().optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"), "至少需要修改一个字段");

export const repaymentInputSchema = z.object({
  amountMinor: z.number().int().positive().max(100_000_000_000),
  localDate: matterDateSchema,
  note: z.string().trim().max(240).optional().nullable(),
  ledgerLink: ledgerLinkInputSchema.optional()
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
