import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z, ZodError } from "zod";
import {
  aiAnalysisInputSchema,
  appearancePatchSchema,
  categoryDispositionSchema,
  categoryInputSchema,
  categoryPatchSchema,
  budgetDeleteSchema,
  budgetMonthSchema,
  dailyTotalsQuerySchema,
  healthAcknowledgeSchema,
  healthExplainSchema,
  healthReportQuerySchema,
  monthlyBudgetInputSchema,
  proposalResolutionInputSchema,
  proposalRevisionInputSchema,
  openClawSettingsPatchSchema,
  permanentDeleteTransactionSchema,
  reportQuerySchema,
  transactionDeleteSchema,
  transactionInputSchema,
  transactionPatchSchema,
  transactionUpdateRequestSchema,
  transactionQuerySchema
} from "../shared/schemas";
import {
  accountAdjustmentQuerySchema,
  accountAdjustmentUndoSchema,
  accountCreateSchema,
  accountMovementQuerySchema,
  accountPatchSchema,
  accountVersionSchema,
  adjustmentInputSchema,
  fundsActivationSchema,
  fundsAssignTransactionsSchema,
  fundsMutationSchema,
  transferInputSchema,
  transferPatchSchema,
  transactionRefundSchema
} from "../shared/schemas";
import type { AppConfig } from "./config";
import { createUserAuth } from "./auth";
import { AppError } from "./errors";
import { LedgerRepository } from "./repository";
import { AiService } from "./ai";
import { BackupService } from "./backup";
import { attachMcpRoutes } from "./mcp";
import { OpenClawControlService } from "./openclaw-control";
import { AppearanceService } from "./appearance";
import { MattersRepository, attachMatterRoutes } from "./matters";
import { APP_VERSION } from "../shared/app-metadata";
import { BudgetService } from "./budgets";
import { HealthService } from "./health";
import { FundsService } from "./funds";

function localDate(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}


const internalSettingPrefixes = [
  "funds.account_balance_request.",
  "funds.adjustment_request.",
  "funds.adjustment_undo_request."
] as const;

function isInternalSettingKey(key: string): boolean {
  return internalSettingPrefixes.some((prefix) => key.startsWith(prefix));
}
function requestIdempotencyKey(request: Request): string | null {
  const key = request.header("Idempotency-Key")?.trim();
  if (!key) return null;
  if (key.length > 128) throw new AppError("幂等键过长");
  return key;
}

export interface AppServices {
  repository: LedgerRepository;
  ai: AiService;
  backup: BackupService;
  openclaw: OpenClawControlService;
  appearance: AppearanceService;
  matters: MattersRepository;
  budgets: BudgetService;
  health: HealthService;
  funds: FundsService;
}

export function createApp(config: AppConfig, database: DatabaseSync): { app: express.Express; services: AppServices } {
  const app = express();
  const repository = new LedgerRepository(database);
  const funds = new FundsService(database, repository, () => localDate(config.timezone));
  repository.attachFundsService(funds);
  repository.purgeExpiredTrash();
  const ai = new AiService(database, repository, config);
  const budgets = new BudgetService(database, repository, () => config.timezone);
  const health = new HealthService(database, repository, budgets, ai);
  const backup = new BackupService(database, repository, config);
  const openclaw = new OpenClawControlService(database, repository, config, budgets, funds);
  openclaw.reconcileStaleRunningOperations();
  const appearance = new AppearanceService(database, repository);
  const matters = new MattersRepository(database, repository, config.timezone, funds);
  const userAuth = createUserAuth(config);
  const distPath = path.resolve(process.cwd(), "dist");
  const indexPath = path.join(distPath, "index.html");

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Personal backgrounds are decoded locally and displayed from an
        // object URL. blob: permits that local image without allowing uploads.
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: "512kb" }));
  app.use((request, _response, next) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (!unsafe || !request.path.startsWith("/api/v1")) {
      next();
      return;
    }
    if (request.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") {
      next(new AppError("已拒绝跨站写入请求", 403, "CROSS_SITE_WRITE_BLOCKED"));
      return;
    }
    const origin = request.header("Origin");
    if (origin) {
      try {
        if (new URL(origin).host !== request.get("host")) {
          next(new AppError("请求来源与 SMB 不一致", 403, "ORIGIN_MISMATCH"));
          return;
        }
      } catch {
        next(new AppError("请求来源无效", 403, "ORIGIN_MISMATCH"));
        return;
      }
    }
    next();
  });

  app.get("/health", (_request, response) => {
    try {
      const row = database.prepare("SELECT 1 AS ok").get() as { ok: number };
      response.json({ status: row.ok === 1 ? "ok" : "error", version: APP_VERSION });
    } catch {
      response.status(503).json({ status: "error", version: APP_VERSION });
    }
  });

  app.get("/auth/refresh-boot.js", (_request, response) => {
    response
      .type("application/javascript")
      .set("Cache-Control", "no-store, no-cache, must-revalidate")
      .send(`(async () => {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  } finally {
    window.location.replace("/auth/complete?update=" + Date.now());
  }
})();`);
  });

  app.get("/auth/refresh", (_request, response) => {
    if (config.nodeEnv === "test" || !existsSync(indexPath)) {
      response.redirect(302, "/");
      return;
    }
    // This bootstrap is outside the service-worker navigation fallback. It
    // removes only the replaceable app shell, never cookies, localStorage or
    // IndexedDB, then loads the current build through another network-only URL.
    response
      .type("html")
      .set("Cache-Control", "no-store, no-cache, must-revalidate")
      .send(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在更新 SMB</title></head><body><main><h1>正在更新 SMB</h1><p>个人背景和登录状态会保留，请稍候。</p></main><script src="/auth/refresh-boot.js"></script></body></html>`);
  });

  app.get("/auth/complete", (_request, response) => {
    if (config.nodeEnv === "test" || !existsSync(indexPath)) {
      response.redirect(302, "/");
      return;
    }
    response.sendFile(indexPath, { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } });
  });

  attachMcpRoutes(app, repository, ai, backup, openclaw, config, matters, budgets, health, funds);

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.nodeEnv === "test" ? 10_000 : 600,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });
  const aiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.nodeEnv === "test" ? 10_000 : 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "AI 分析请求过于频繁，请稍后再试" } }
  });
  app.use("/api/v1", apiLimiter, userAuth);
  attachMatterRoutes(app, matters);

  app.get("/api/v1/dashboard", (request, response, next) => {
    try {
      const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(request.query.date ?? localDate(config.timezone));
      response.json({ data: repository.getDashboard(date) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/categories", (request, response, next) => {
    try {
      const kind = request.query.kind ? z.enum(["expense", "income"]).parse(request.query.kind) : undefined;
      const includeArchived = request.query.includeArchived === "true";
      response.json({ data: repository.listCategories(kind, includeArchived) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/categories", (request, response, next) => {
    try {
      response.status(201).json({ data: repository.createCategory(categoryInputSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/categories/:id", (request, response, next) => {
    try {
      response.json({ data: repository.updateCategory(String(request.params.id), categoryPatchSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/categories/:id/disposition", (request, response, next) => {
    try {
      response.json({ data: repository.manageCategory(String(request.params.id), categoryDispositionSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/categories/:id/deletion-impact", (request, response, next) => {
    try {
      response.json({ data: repository.categoryDeletionImpact(String(request.params.id)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/funds/activate", (request, response, next) => {
    try {
      const result = funds.activate(fundsActivationSchema.parse(request.body), requestIdempotencyKey(request));
      response.status(201).json({ data: result });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/funds/summary", (_request, response, next) => {
    try {
      response.json({ data: funds.summary() });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/funds/transactions/assign-account", (request, response, next) => {
    try {
      const input = fundsAssignTransactionsSchema.parse(request.body);
      response.json({ data: funds.assignTransactionsAccount(input) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/accounts", (request, response, next) => {
    try {
      const includeArchived = z.coerce.boolean().default(false).parse(request.query.includeArchived ?? false);
      response.json({ data: funds.listAccounts(includeArchived) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/accounts", (request, response, next) => {
    try {
      response.status(201).json({ data: funds.createAccount(accountCreateSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/accounts/:id", (request, response, next) => {
    try {
      response.json({ data: funds.updateAccount(String(request.params.id), accountPatchSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/accounts/:id/archive", (request, response, next) => {
    try {
      response.json({ data: funds.archiveAccount(String(request.params.id), accountVersionSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/accounts/:id/restore", (request, response, next) => {
    try {
      response.json({ data: funds.restoreAccount(String(request.params.id), accountVersionSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/accounts/:id", (request, response, next) => {
    try {
      funds.deleteUnusedAccount(String(request.params.id), accountVersionSchema.parse(request.body));
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/v1/funds/movements", (request, response, next) => {
    try {
      response.json({ data: funds.listMovements(accountMovementQuerySchema.parse(request.query)) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/funds/movements.csv", (_request, response, next) => {
    try {
      const exported = funds.exportData() as {
        funds: {
          accounts: Array<Record<string, unknown>>;
          movements: Array<Record<string, unknown>>;
        };
      };
      const names = new Map(exported.funds.accounts.map((account) => [String(account.id), String(account.name)]));
      const header = ["日期", "账户", "变化金额（元）", "来源类型", "来源 ID", "创建时间", "币种"];
      const lines = exported.funds.movements.filter((movement) => movement.sourceType !== "adjustment").map((movement) => [
        movement.localDate,
        names.get(String(movement.accountId)) ?? "",
        (Number(movement.deltaMinor) / 100).toFixed(2),
        movement.sourceType,
        movement.sourceId,
        movement.createdAt,
        movement.currency
      ].map(csvCell).join(","));
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="money-manager-funds-${localDate(config.timezone)}.csv"`);
      response.send(`\uFEFF${header.map(csvCell).join(",")}\r\n${lines.join("\r\n")}`);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/transfers.csv", (_request, response, next) => {
    try {
      const exported = funds.exportData() as {
        funds: {
          accounts: Array<Record<string, unknown>>;
          transfers: Array<Record<string, unknown>>;
        };
      };
      const names = new Map(exported.funds.accounts.map((account) => [String(account.id), String(account.name)]));
      const header = ["日期", "转出账户", "转入账户", "扣款金额（元）", "到账金额（元）", "手续费（元）", "备注", "删除时间", "币种"];
      const lines = exported.funds.transfers.map((transfer) => [
        transfer.localDate,
        names.get(String(transfer.fromAccountId)) ?? "",
        names.get(String(transfer.toAccountId)) ?? "",
        (Number(transfer.debitedMinor) / 100).toFixed(2),
        (Number(transfer.creditedMinor) / 100).toFixed(2),
        ((Number(transfer.debitedMinor) - Number(transfer.creditedMinor)) / 100).toFixed(2),
        transfer.note ?? "",
        transfer.deletedAt ?? "",
        transfer.currency
      ].map(csvCell).join(","));
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="money-manager-transfers-${localDate(config.timezone)}.csv"`);
      response.send(`\uFEFF${header.map(csvCell).join(",")}\r\n${lines.join("\r\n")}`);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/transfers", (request, response, next) => {
    try {
      const includeDeleted = z.coerce.boolean().default(false).parse(request.query.includeDeleted ?? false);
      response.json({ data: funds.listTransfers(includeDeleted) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/transfers", (request, response, next) => {
    try {
      response.status(201).json({ data: funds.createTransfer(transferInputSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/transfers/:id", (request, response, next) => {
    try {
      response.json({ data: funds.updateTransfer(String(request.params.id), transferPatchSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/transfers/:id", (request, response, next) => {
    try {
      response.json({ data: funds.deleteTransfer(String(request.params.id), fundsMutationSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/transfers/:id/restore", (request, response, next) => {
    try {
      response.json({ data: funds.restoreTransfer(String(request.params.id), fundsMutationSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/funds/adjustments", (request, response, next) => {
    try {
      response.json({ data: funds.listAdjustments(accountAdjustmentQuerySchema.parse(request.query)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/funds/adjustments", (request, response, next) => {
    try {
      response.status(201).json({ data: funds.adjustAccount(adjustmentInputSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/funds/adjustments/:id/undo", (request, response, next) => {
    try {
      response.json({ data: funds.undoLatestAdjustment(String(request.params.id), accountAdjustmentUndoSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/transactions/:id/refund", (request, response, next) => {
    try {
      response.json({ data: funds.refundTransaction(String(request.params.id), transactionRefundSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/transactions/:id/refund/undo", (request, response, next) => {
    try {
      response.json({ data: funds.undoTransactionRefund(String(request.params.id), transactionRefundSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });
  app.get("/api/v1/transactions", (request, response, next) => {
    try {
      const query = transactionQuerySchema.parse(request.query);
      response.json({ data: repository.listTransactions(query) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/transactions", (request, response, next) => {
    try {
      const transaction = repository.createTransaction(transactionInputSchema.parse(request.body), {
        idempotencyKey: requestIdempotencyKey(request),
        source: "user",
        actor: "user"
      });
      response.status(201).json({ data: transaction });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/transactions/:id", (request, response, next) => {
    try {
      response.json({ data: repository.getTransaction(String(request.params.id)) });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/transactions/:id", (request, response, next) => {
    try {
      const input = transactionUpdateRequestSchema.parse(request.body);
      const { expectedUpdatedAt, ...patch } = input;
      response.json({ data: repository.updateTransaction(
        String(request.params.id),
        transactionPatchSchema.parse(patch),
        "user",
        expectedUpdatedAt
      ) });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/transactions/:id", (request, response, next) => {
    try {
      const input = transactionDeleteSchema.parse(request.body);
      response.json({ data: repository.softDeleteTransaction(
        String(request.params.id),
        "user",
        input.expectedUpdatedAt
      ) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/transactions/:id/restore", (request, response, next) => {
    try {
      response.json({ data: repository.restoreTransaction(String(request.params.id)) });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/transactions/:id/permanent", (request, response, next) => {
    try {
      const input = permanentDeleteTransactionSchema.parse(request.body);
      response.json({ data: repository.permanentlyDeleteTransaction(
        String(request.params.id), input.expectedUpdatedAt, input.confirmation
      ) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/reports/finance", (request, response, next) => {
    try {
      const query = reportQuerySchema.parse(request.query);
      response.json({ data: repository.getFinanceReport(query.grain, query.anchor, query.kind) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/reports/daily-totals", (request, response, next) => {
    try {
      const query = dailyTotalsQuerySchema.parse(request.query);
      response.json({ data: repository.getDailyTotals(query) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/budgets/:month", (request, response, next) => {
    try {
      response.json({ data: budgets.get(budgetMonthSchema.parse(request.params.month)) });
    } catch (error) { next(error); }
  });

  app.put("/api/v1/budgets/:month", (request, response, next) => {
    try {
      const month = budgetMonthSchema.parse(request.params.month);
      response.json({ data: budgets.put(month, monthlyBudgetInputSchema.parse(request.body), {
        actor: "user",
        idempotencyKey: requestIdempotencyKey(request)
      }) });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/budgets/:month", (request, response, next) => {
    try {
      const month = budgetMonthSchema.parse(request.params.month);
      const input = budgetDeleteSchema.parse(request.body);
      response.json({ data: budgets.delete(month, input.expectedUpdatedAt, {
        actor: "user",
        idempotencyKey: requestIdempotencyKey(request)
      }) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/reports/health", (request, response, next) => {
    try {
      const input = healthReportQuerySchema.parse(request.query);
      response.json({ data: health.report(input.month) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/reports/health/:fingerprint/acknowledge", (request, response, next) => {
    try {
      const input = healthAcknowledgeSchema.parse(request.body);
      response.json({ data: health.acknowledge(input.month, String(request.params.fingerprint)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/reports/health/explain", aiLimiter, async (request, response, next) => {
    try {
      const input = healthExplainSchema.parse(request.body);
      response.json({ data: await health.explain(input.month) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/proposals", (request, response, next) => {
    try {
      const status = z.enum(["pending", "approved", "rejected", "expired"]).parse(request.query.status ?? "pending");
      response.json({ data: repository.listProposals(status) });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/proposals/:id", (request, response, next) => {
    try {
      const input = proposalRevisionInputSchema.parse(request.body);
      response.json({ data: repository.reviseProposal(String(request.params.id), input, "user") });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/proposals/:id/resolve", (request, response, next) => {
    try {
      const input = proposalResolutionInputSchema.parse(request.body);
      response.json({ data: repository.resolveProposal(String(request.params.id), input.decision, input.expectedRevision) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/ai/preview", (request, response, next) => {
    try {
      const periodStart = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(request.query.periodStart);
      const periodEnd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(request.query.periodEnd);
      response.json({ data: ai.preview(periodStart, periodEnd) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/ai/analyses", (_request, response, next) => {
    try {
      response.json({ data: ai.listRecent() });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/ai/analyze", aiLimiter, async (request, response, next) => {
    try {
      response.status(201).json({ data: await ai.analyze(aiAnalysisInputSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/export.json", (_request, response, next) => {
    try {
      const data = repository.exportData();
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="money-manager-${localDate(config.timezone)}.json"`);
      Object.assign(data, matters.exportData());
      Object.assign(data, { budgets: budgets.exportData() });
      Object.assign(data, funds.exportData());
      response.send(JSON.stringify(data, null, 2));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/export.csv", (_request, response, next) => {
    try {
      const data = repository.exportData() as { transactions: Array<Record<string, unknown>> };
      const header = ["日期", "类型", "金额（元）", "分类", "备注", "来源", "删除时间", "账户币种", "账本金额（CNY）", "账户实际金额"];
      const lines = data.transactions.map((item) => [
        item.localDate,
        item.kind === "income" ? "收入" : "支出",
        (Number(item.amountMinor) / 100).toFixed(2),
        (item.category as { name?: string } | undefined)?.name ?? "",
        item.note ?? "",
        item.source,
        item.deletedAt ?? "",
        (item.account as { currency?: string } | null)?.currency ?? "",
        (Number(item.amountMinor) / 100).toFixed(2),
        item.accountAmountMinor == null ? "" : (Number(item.accountAmountMinor) / 100).toFixed(2)
      ].map(csvCell).join(","));
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="money-manager-${localDate(config.timezone)}.csv"`);
      response.send(`\uFEFF${header.map(csvCell).join(",")}\r\n${lines.join("\r\n")}`);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/settings", (_request, response, next) => {
    try {
      const rows = (database.prepare("SELECT key, value, updated_at FROM settings ORDER BY key").all() as unknown as Array<{ key: string; value: string; updated_at: string }>).filter((row) => !isInternalSettingKey(row.key));
      response.json({ data: { currency: "CNY", timezone: config.timezone, today: localDate(config.timezone), rows } });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/appearance", (_request, response, next) => {
    try {
      response.json({ data: appearance.get() });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/appearance", (request, response, next) => {
    try {
      response.json({ data: appearance.update(appearancePatchSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/settings/timezone", (request, response, next) => {
    try {
      const timezone = z.string().min(1).max(64).parse(request.body?.timezone);
      try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(new Date()); }
      catch { throw new AppError("无效的时区"); }
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES ('timezone', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(timezone, now);
      database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES ('timezone.initialized', 'true', ?)
        ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(now);
      config.timezone = timezone;
      repository.audit("user", "settings.timezone", "settings", "timezone");
      response.json({ data: { timezone, updatedAt: now, restartRequiredForOpenClawDefaults: true } });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/status", (_request, response) => {
    let databaseStatus: "ok" | "error" = "ok";
    try { database.prepare("SELECT 1").get(); } catch { databaseStatus = "error"; }
    response.json({ data: {
      service: "ok",
      database: databaseStatus,
      deepseek: config.deepseekApiKey ? "configured" : "missing",
      backup: backup.status(),
      version: APP_VERSION
    } });
  });

  app.post("/api/v1/backups", async (_request, response, next) => {
    try {
      response.status(201).json({ data: await backup.createBackup() });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/openclaw/settings", (_request, response) => {
    response.json({ data: openclaw.settings() });
  });

  app.patch("/api/v1/openclaw/settings", (request, response, next) => {
    try {
      const input = openClawSettingsPatchSchema.parse(request.body);
      response.json({ data: openclaw.setMode(input.mode) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/openclaw/operations", (request, response, next) => {
    try {
      const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit ?? 50);
      response.json({ data: openclaw.listOperations(limit) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/openclaw/operations/:id", (request, response, next) => {
    try {
      response.json({ data: openclaw.getOperationDetail(String(request.params.id)) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/openclaw/operations/:id/undo", (request, response, next) => {
    try {
      response.json({ data: openclaw.undo(String(request.params.id), "user") });
    } catch (error) { next(error); }
  });

  if (existsSync(indexPath)) {
    app.use(express.static(distPath, {
      index: false,
      maxAge: "1y",
      immutable: true,
      setHeaders: (response, filePath) => {
        const filename = path.basename(filePath);
        if (["index.html", "sw.js", "manifest.webmanifest", "theme-boot.js"].includes(filename)) {
          response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        }
      }
    }));
    app.get(/.*/, (request, response, next) => {
      if (request.path.startsWith("/api/") || request.path.startsWith("/auth/") || request.path.startsWith("/cdn-cgi/") || request.path === "/mcp" || request.path === "/health") {
        next();
        return;
      }
      response.sendFile(indexPath, { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } });
    });
  }

  app.use((request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: `未找到 ${request.method} ${request.path}` } });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: error.issues[0]?.message ?? "输入内容有误", issues: error.issues } });
      return;
    }
    if (error instanceof AppError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    const message = error instanceof Error ? error.message : "未知错误";
    if (/UNIQUE constraint failed/i.test(message)) {
      response.status(409).json({ error: { code: "CONFLICT", message: "这条记录与已有内容重复" } });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务暂时无法完成请求" } });
  });

  return { app, services: { repository, ai, backup, openclaw, appearance, matters, budgets, health, funds } };
}
