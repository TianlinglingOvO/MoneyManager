import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config";
import type { LedgerRepository } from "./repository";
import { APP_VERSION } from "../shared/app-metadata";
import type { AiService } from "./ai";
import type { BackupService } from "./backup";
import { hashOpenClawRequest, type OpenClawControlService } from "./openclaw-control";
import type { MattersRepository } from "./matters";
import type { BudgetService } from "./budgets";
import type { HealthService } from "./health";
import type { FundsService } from "./funds";
import { createMcpAuth } from "./auth";
import { categoryDispositionSchema, categoryInputSchema, categoryPatchSchema, requestIdSchema, transactionPatchSchema } from "../shared/schemas";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
  };
}

export function isBodyJsonParseError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;
  const parseError = error as SyntaxError & { type?: string; status?: number };
  return parseError.type === "entity.parse.failed" || parseError.status === 400;
}

export function logSafeRequestError(request: { method: string; path: string }, error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(`${request.method} ${request.path} ${name}`);
}

function sendMcpJsonRpcError(response: Response, status: number, code: number, message: string): void {
  if (response.headersSent) return;
  response.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function currentLocalDate(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function amountToMinor(amount: number): number {
  const minor = Math.round(amount * 100);
  if (Math.abs(amount * 100 - minor) > 0.000001) throw new Error("金额最多保留两位小数");
  return minor;
}

function resolveTransactionAccount(funds: FundsService | undefined, value?: string | null): string | null | undefined {
  if (value === undefined || value === null || value.trim() === "") return value ?? undefined;
  if (!funds) throw new Error("资金服务尚未启用");
  return z.string().uuid().safeParse(value).success ? value : funds.resolveAccountId(value);
}

function normalizeAccountAmount(
  funds: FundsService | undefined,
  accountId: string | null | undefined,
  accountAmount: number | undefined,
  accountWasExplicit: boolean
): number | null | undefined {
  if (!accountId) {
    if (accountAmount !== undefined) throw new Error("填写 accountAmount 时必须同时明确资金账户");
    return undefined;
  }
  if (!funds) throw new Error("资金服务尚未启用");
  const account = funds.getAccount(accountId, false);
  if (account.currency === "CNY") return accountWasExplicit ? null : undefined;
  if (accountAmount === undefined) {
    if (accountWasExplicit) throw new Error(`外币账户 ${account.name} 必须提供 accountAmount；若只有外币金额，必须向用户询问人民币等值，不得查询或猜测汇率`);
    return undefined;
  }
  return amountToMinor(accountAmount);
}

export function createLedgerMcpServer(
  repository: LedgerRepository,
  config: AppConfig,
  services?: {
    ai: AiService;
    backup: BackupService;
    openclaw: OpenClawControlService;
    matters?: MattersRepository;
    budgets?: BudgetService;
    health?: HealthService;
    funds?: FundsService;
  }
): McpServer {
  const server = new McpServer({ name: "sutady-money-manager", version: APP_VERSION });

  server.registerTool("list_categories", {
    description: "列出可用于记账的收入或支出分类。",
    inputSchema: {
      kind: z.enum(["expense", "income"]).optional().describe("expense=支出，income=收入"),
      includeArchived: z.boolean().optional().default(false)
    }
  }, async ({ kind, includeArchived }) => {
    const result = repository.listCategories(kind, includeArchived);
    repository.audit("openclaw", "mcp.list_categories", "category", null, { count: result.length });
    return textResult(result);
  });

  server.registerTool("get_category_deletion_impact", {
    description: "永久删除分类前查看会被删除的正常账目、回收站账目及受影响关联，并取得最新版影响版本。只查询，不删除。",
    inputSchema: { categoryId: z.string().uuid() }
  }, async ({ categoryId }) => {
    const result = repository.categoryDeletionImpact(categoryId);
    repository.audit("openclaw", "mcp.category_deletion_impact", "category", categoryId, {
      transactionCount: result.activeTransactionCount + result.trashedTransactionCount,
      linkedMatterCount: result.linkedMatterCount,
      pendingProposalCount: result.pendingProposalCount
    });
    return textResult(result);
  });

  server.registerTool("list_transactions", {
    description: "按日期、分类或关键词查询账目。默认查询正常账目，也可查看 30 天回收站；默认最多返回最近 50 条。",
    inputSchema: {
      kind: z.enum(["expense", "income"]).optional(),
      categoryId: z.string().uuid().optional(),
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      search: z.string().max(80).optional(),
      deleted: z.enum(["active", "trash", "all"]).optional().default("active"),
      page: z.number().int().positive().optional().default(1),
      pageSize: z.number().int().min(1).max(100).optional().default(50)
    }
  }, async (input) => {
    const result = repository.listTransactions(input);
    repository.audit("openclaw", "mcp.list_transactions", "transaction", null, { count: result.items.length });
    return textResult(result);
  });

  server.registerTool("get_finance_summary", {
    description: "获取某日、周、月或年的确定性收支汇总、趋势、分类排行和上一周期同进度对比。进行中的月份对比上月同一段日期（例如 9 月 1 日对 8 月 1 日），不是上月整月；分类排行的涨跌相对该同进度金额。",
    inputSchema: {
      grain: z.enum(["day", "week", "month", "year"]),
      anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      kind: z.enum(["expense", "income"]).default("expense")
    }
  }, async ({ grain, anchor, kind }) => {
    const result = repository.getFinanceReport(grain, anchor, kind, currentLocalDate(config.timezone));
    repository.audit("openclaw", "mcp.get_finance_summary", "report", null, { grain, kind });
    return textResult(result);
  });

  if (services?.health) {
    server.registerTool("get_ledger_health", {
      description: "读取指定月份的确定性账本体检结果。只返回结构化问题和统计，不包含账目备注，不修改账本。",
      inputSchema: { month: z.string().regex(/^\\d{4}-(0[1-9]|1[0-2])$/).optional() }
    }, async ({ month }) => {
      const result = services.health!.report(month ?? services.health!.currentMonth());
      repository.audit("openclaw", "mcp.get_ledger_health", "health_report", result.month, {
        issueCount: result.issueCount
      });
      return textResult({
        month: result.month,
        score: result.score,
        issueCount: result.issueCount,
        acknowledgedCount: result.acknowledgedCount,
        dataHash: result.dataHash,
        generatedAt: result.generatedAt,
        issues: result.issues.map((issue) => ({
          fingerprint: issue.fingerprint,
          type: issue.type,
          severity: issue.severity,
          title: issue.title,
          detail: issue.detail,
          relatedTransactionIds: issue.relatedTransactionIds,
          href: issue.href,
          acknowledged: issue.acknowledged
        }))
      });
    });
  }

  server.registerTool("propose_add_transaction", {
    description: "仅当用户明确要求‘先让我确认’时提出一笔新账。amount 始终是人民币账本金额；选择 USD/USDT 账户时必须另传 accountAmount。只有外币金额时必须先询问人民币等值，不得查询或猜测汇率。",
    inputSchema: {
      requestId: requestIdSchema,
      kind: z.enum(["expense", "income"]),
      amount: z.number().positive().max(1_000_000_000).describe("人民币元，最多两位小数"),
      account: z.string().trim().min(1).max(80).optional().describe("资金账户 ID、名称或别名"),
      accountAmount: z.number().positive().max(1_000_000_000).optional().describe("所选外币账户的实际扣款或到账金额，最多两位小数"),
      categoryId: z.string().uuid(),
      localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(240).optional(),
      reason: z.string().max(240).optional()
    }
  }, async ({ requestId, ...input }) => {
    const localDate = input.localDate ?? currentLocalDate(config.timezone);
    const accountId = resolveTransactionAccount(services?.funds, input.account);
    const accountAmountMinor = normalizeAccountAmount(services?.funds, accountId, input.accountAmount, input.account !== undefined);
    const proposal = repository.createProposal({
      action: "create",
      payload: {
        kind: input.kind,
        amountMinor: amountToMinor(input.amount),
        categoryId: input.categoryId,
        localDate,
        note: input.note ?? null,
        accountId,
        accountAmountMinor
      },
      reason: input.reason ?? null
    }, "openclaw", {
      requestId,
      requestHash: hashOpenClawRequest("proposal.create", input)
    });
    return textResult({ message: "已提交待确认，尚未写入正式账本。", proposal });
  });

  server.registerTool("propose_update_transaction", {
    description: "仅当用户明确要求‘先让我确认’时提出修改请求。amount 始终是人民币账本金额；显式选择 USD/USDT 账户时必须另传 accountAmount，不得猜测汇率。",
    inputSchema: {
      requestId: requestIdSchema,
      transactionId: z.string().uuid(),
      kind: z.enum(["expense", "income"]).optional(),
      amount: z.number().positive().max(1_000_000_000).optional(),
      account: z.string().trim().min(1).max(80).optional(),
      accountAmount: z.number().positive().max(1_000_000_000).optional(),
      categoryId: z.string().uuid().optional(),
      localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(240).nullable().optional(),
      reason: z.string().max(240).optional()
    }
  }, async ({ requestId, transactionId, amount, account, accountAmount, reason, ...changes }) => {
    const request = { transactionId, amount, account, accountAmount, reason, ...changes };
    const payload: Record<string, unknown> = { ...changes };
    if (amount !== undefined) payload.amountMinor = amountToMinor(amount);
    if (account !== undefined) payload.accountId = resolveTransactionAccount(services?.funds, account);
    if (account !== undefined || accountAmount !== undefined) {
      const current = repository.getTransaction(transactionId, false);
      const accountId = account === undefined ? current.accountId : payload.accountId as string | null | undefined;
      payload.accountAmountMinor = normalizeAccountAmount(services?.funds, accountId, accountAmount, account !== undefined);
    }
    const proposal = repository.createProposal({
      action: "update",
      targetTransactionId: transactionId,
      payload,
      reason: reason ?? null
    }, "openclaw", {
      requestId,
      requestHash: hashOpenClawRequest("proposal.update", request)
    });
    return textResult({ message: "修改请求已提交待确认，原账目尚未改变。", proposal });
  });

  server.registerTool("propose_delete_transaction", {
    description: "仅当用户明确要求‘先让我确认’时提出删除请求；direct 模式请优先使用 direct_delete_transaction。批准后账目会进入可恢复的回收站。",
    inputSchema: {
      requestId: requestIdSchema,
      transactionId: z.string().uuid(),
      reason: z.string().max(240).optional()
    }
  }, async ({ requestId, transactionId, reason }) => {
    const proposal = repository.createProposal({
      action: "delete",
      targetTransactionId: transactionId,
      payload: {},
      reason: reason ?? null
    }, "openclaw", {
      requestId,
      requestHash: hashOpenClawRequest("proposal.delete", { transactionId, reason })
    });
    return textResult({ message: "删除请求已提交待确认，账目尚未删除。", proposal });
  });

  server.registerTool("revise_pending_proposal", {
    description: "修订 OpenClaw 自己创建且仍在等待确认的新增或修改提案。只更新待确认内容，不会写入正式账本，也不能批准提案。",
    inputSchema: {
      proposalId: z.string().uuid(),
      expectedRevision: z.number().int().positive().describe("先通过 list_pending_proposals 读取到的当前版本号"),
      kind: z.enum(["expense", "income"]).optional(),
      amount: z.number().positive().max(1_000_000_000).optional().describe("人民币元，最多两位小数"),
      account: z.string().trim().min(1).max(80).optional(),
      accountAmount: z.number().positive().max(1_000_000_000).optional(),
      categoryId: z.string().uuid().optional(),
      localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(240).nullable().optional()
    }
  }, async ({ proposalId, expectedRevision, amount, account, accountAmount, ...fields }) => {
    const changes: Record<string, unknown> = {};
    if (fields.kind !== undefined) changes.kind = fields.kind;
    if (amount !== undefined) changes.amountMinor = amountToMinor(amount);
    if (account !== undefined) changes.accountId = resolveTransactionAccount(services?.funds, account);
    if (account !== undefined || accountAmount !== undefined) {
      const currentProposal = repository.getProposal(proposalId);
      let accountId = account === undefined ? currentProposal.payload.accountId as string | null | undefined : changes.accountId as string | null | undefined;
      if (account === undefined && accountId === undefined && currentProposal.targetTransactionId) {
        accountId = repository.getTransaction(currentProposal.targetTransactionId, false).accountId;
      }
      changes.accountAmountMinor = normalizeAccountAmount(
        services?.funds,
        accountId,
        accountAmount,
        account !== undefined
      );
    }
    if (fields.categoryId !== undefined) changes.categoryId = fields.categoryId;
    if (fields.localDate !== undefined) changes.localDate = fields.localDate;
    if (fields.note !== undefined) changes.note = fields.note;
    const proposal = repository.reviseProposal(proposalId, { expectedRevision, ...changes }, "openclaw");
    return textResult({ message: "待确认内容已修订，尚未写入正式账本，仍需用户在网页中批准。", proposal });
  });

  server.registerTool("list_pending_proposals", {
    description: "查看 OpenClaw 已提交但仍等待用户确认的操作。",
    inputSchema: {}
  }, async () => {
    const result = repository.listProposals("pending");
    repository.audit("openclaw", "mcp.list_pending_proposals", "proposal", null, { count: result.length });
    return textResult(result);
  });

  if (services) {
    registerDirectTools(server, repository, config, services);
    if (services.matters) registerMatterTools(server, repository, config, services.openclaw, services.matters, services.funds);
  }

  return server;
}

function registerDirectTools(
  server: McpServer,
  repository: LedgerRepository,
  config: AppConfig,
  services: {
    ai: AiService;
    backup: BackupService;
    openclaw: OpenClawControlService;
    matters?: MattersRepository;
    budgets?: BudgetService;
    funds?: FundsService;
  }
): void {
  const { ai, backup, openclaw, matters, budgets, funds } = services;
  const requestId = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

  const resolveRequestedAccount = (value?: string | null): string | null | undefined => {
    if (value === undefined || value === null || value.trim() === "") return value ?? undefined;
    if (!funds) throw new Error("资金服务尚未启用");
    return z.string().uuid().safeParse(value).success ? value : funds.resolveAccountId(value);
  };
  server.registerTool("get_openclaw_control_status", {
    description: "查看 SMB 当前是需要网页确认还是允许 OpenClaw 直接操作。只返回能力和状态，永不返回密钥。",
    inputSchema: {}
  }, async () => textResult({ ...openclaw.settings(), deepseekConfigured: Boolean(config.deepseekApiKey), backupRemoteConfigured: Boolean(config.backupAgeRecipient && config.rcloneRemote) }));

  if (funds) {
    const accountReference = z.string().trim().min(1).max(80);
    const resolveAccount = (value: string): string => (
      z.string().uuid().safeParse(value).success ? value : funds.resolveAccountId(value)
    );

    server.registerTool("list_accounts", {
      description: "列出 SMB 各币种资金账户、余额和版本。账户名称或别名存在歧义时，后续写入必须使用账户 ID。",
      inputSchema: { includeArchived: z.boolean().optional().default(false) }
    }, async ({ includeArchived }) => {
      const result = funds.listAccounts(includeArchived);
      repository.audit("openclaw", "mcp.list_accounts", "account", null, { count: result.length });
      return textResult(result);
    });

    server.registerTool("get_funds_summary", {
      description: "读取资金追踪状态、人民币总资金、默认账户和账户余额，不会修改资金。",
      inputSchema: {}
    }, async () => {
      const result = funds.summary();
      repository.audit("openclaw", "mcp.get_funds_summary", "funds", "primary", { accountCount: result.accountCount });
      return textResult(result);
    });

    server.registerTool("direct_create_account", {
      description: "direct 模式下新建 CNY、USD 或 USDT 资金账户。名称与别名必须明确且不能与有效账户冲突。",
      inputSchema: {
        requestId,
        name: z.string().trim().min(1).max(40),
        icon: z.string().trim().min(1).max(8),
        currency: z.enum(["CNY", "USD", "USDT"]).optional().default("CNY"),
        openingBalance: z.number().min(-1_000_000_000).max(1_000_000_000).default(0),
        aliases: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([])
      }
    }, async ({ requestId: idempotency, name, icon, currency, openingBalance, aliases }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "account.create",
      entityType: "account",
      summary: "OpenClaw 新建资金账户",
      request: { name, icon, currency, openingBalance, aliases },
      run: () => {
        const account = funds.createAccount({
          name,
          icon,
          currency,
          openingBalanceMinor: amountToMinor(openingBalance),
          aliases
        });
        return {
          result: account,
          entityId: account.id,
          snapshots: [{ entityType: "account" as const, entityId: account.id, before: null, after: openclaw.accountSnapshot(account) }]
        };
      }
    })));

    server.registerTool("direct_update_account", {
      description: "direct 模式下修改资金账户名称、图标或别名。必须传入最近查询到的 updatedAt。",
      inputSchema: {
        requestId,
        account: accountReference,
        expectedUpdatedAt: z.string().datetime(),
        name: z.string().trim().min(1).max(40).optional(),
        icon: z.string().trim().min(1).max(8).optional(),
        currency: z.enum(["CNY", "USD", "USDT"]).optional(),
        aliases: z.array(z.string().trim().min(1).max(40)).max(20).optional()
      }
    }, async ({ requestId: idempotency, account: reference, expectedUpdatedAt, ...changes }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "account.update",
      entityType: "account",
      summary: "OpenClaw 修改资金账户",
      request: { account: reference, expectedUpdatedAt, ...changes },
      run: () => {
        const accountId = resolveAccount(reference);
        const before = funds.getAccount(accountId);
        const after = funds.updateAccount(accountId, { ...changes, expectedUpdatedAt });
        return {
          result: after,
          entityId: accountId,
          snapshots: [{ entityType: "account" as const, entityId: accountId, before: openclaw.accountSnapshot(before), after: openclaw.accountSnapshot(after) }]
        };
      }
    })));

    server.registerTool("direct_archive_account", {
      description: "direct 模式下停用余额为零、非默认且没有未处理关联的账户。必须传入最新版 updatedAt。",
      inputSchema: { requestId, account: accountReference, expectedUpdatedAt: z.string().datetime() }
    }, async ({ requestId: idempotency, account: reference, expectedUpdatedAt }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "account.archive",
      entityType: "account",
      summary: "OpenClaw 停用资金账户",
      request: { account: reference, expectedUpdatedAt },
      run: () => {
        const accountId = resolveAccount(reference);
        const before = funds.getAccount(accountId);
        const after = funds.archiveAccount(accountId, { expectedUpdatedAt });
        return {
          result: after,
          entityId: accountId,
          snapshots: [{ entityType: "account" as const, entityId: accountId, before: openclaw.accountSnapshot(before), after: openclaw.accountSnapshot(after) }]
        };
      }
    })));

    server.registerTool("direct_restore_account", {
      description: "direct 模式下恢复停用账户。停用账户必须使用 ID 精确指定，并传入最新版 updatedAt。",
      inputSchema: { requestId, accountId: z.string().uuid(), expectedUpdatedAt: z.string().datetime() }
    }, async ({ requestId: idempotency, accountId, expectedUpdatedAt }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "account.restore",
      entityType: "account",
      summary: "OpenClaw 恢复资金账户",
      request: { accountId, expectedUpdatedAt },
      run: () => {
        const before = funds.getAccount(accountId);
        const after = funds.restoreAccount(accountId, { expectedUpdatedAt });
        return {
          result: after,
          entityId: accountId,
          snapshots: [{ entityType: "account" as const, entityId: accountId, before: openclaw.accountSnapshot(before), after: openclaw.accountSnapshot(after) }]
        };
      }
    })));

    server.registerTool("direct_transfer_funds", {
      description: "direct 模式下在两个人民币账户间转账。实际扣款不得小于到账金额，差额记作手续费支出；没有默认手续费分类时必须先询问用户。",
      inputSchema: {
        requestId,
        fromAccount: accountReference,
        toAccount: accountReference,
        debitedAmount: z.number().positive().max(1_000_000_000),
        creditedAmount: z.number().positive().max(1_000_000_000),
        feeCategoryId: z.string().uuid().optional().nullable(),
        localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        note: z.string().trim().max(240).optional().nullable()
      }
    }, async ({ requestId: idempotency, fromAccount, toAccount, debitedAmount, creditedAmount, feeCategoryId, localDate, note }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "transfer.create",
      entityType: "transfer",
      summary: "OpenClaw 账户转账",
      request: { fromAccount, toAccount, debitedAmount, creditedAmount, feeCategoryId, localDate, note },
      run: () => {
        const transfer = funds.createTransfer({
          fromAccountId: resolveAccount(fromAccount),
          toAccountId: resolveAccount(toAccount),
          debitedMinor: amountToMinor(debitedAmount),
          creditedMinor: amountToMinor(creditedAmount),
          feeCategoryId,
          localDate: localDate ?? currentLocalDate(config.timezone),
          note,
          requestId: idempotency
        });
        return {
          result: { transfer, accounts: funds.listAccounts() },
          entityId: transfer.id,
          snapshots: [{ entityType: "transfer" as const, entityId: transfer.id, before: null, after: openclaw.transferSnapshot(transfer) }]
        };
      }
    })));

    server.registerTool("direct_adjust_account_balance", {
      description: "direct 模式下按用户明确提供的现实余额校准账户。校准只产生资金调整，不计入收入、支出或预算。",
      inputSchema: {
        requestId,
        account: accountReference,
        targetBalance: z.number().min(-1_000_000_000).max(1_000_000_000),
        localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        note: z.string().trim().max(240).optional().nullable()
      }
    }, async ({ requestId: idempotency, account: reference, targetBalance, localDate, note }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "account.adjust",
      entityType: "account_adjustment",
      summary: "OpenClaw 校准账户余额",
      request: { account: reference, targetBalance, localDate, note },
      run: () => {
        const adjustment = funds.adjustAccount({
          accountId: resolveAccount(reference),
          targetBalanceMinor: amountToMinor(targetBalance),
          localDate: localDate ?? currentLocalDate(config.timezone),
          note,
          requestId: idempotency
        });
        return {
          result: { adjustment, account: funds.getAccount(adjustment.accountId) },
          entityId: adjustment.id,
          snapshots: [{ entityType: "account_adjustment" as const, entityId: adjustment.id, before: null, after: openclaw.adjustmentSnapshot(adjustment) }]
        };
      }
    })));

    server.registerTool("direct_refund_transaction", {
      description: "direct 模式下对一笔账执行全额退款。旧账没有原账户时必须明确提供实际收退款账户；不能重复退款。",
      inputSchema: {
        requestId,
        transactionId: z.string().uuid(),
        expectedUpdatedAt: z.string().datetime(),
        account: accountReference.optional()
      }
    }, async ({ requestId: idempotency, transactionId, expectedUpdatedAt, account: reference }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "transaction.refund",
      entityType: "transaction",
      summary: "OpenClaw 全额退款账目",
      request: { transactionId, expectedUpdatedAt, account: reference },
      run: () => {
        const before = repository.getTransaction(transactionId, false);
        const beforePayment = matters?.getPaymentByTransactionId(transactionId) ?? null;
        const beforeSubscription = beforePayment ? matters?.getSubscription(beforePayment.subscriptionId) ?? null : null;
        const after = funds.refundTransaction(transactionId, {
          expectedUpdatedAt,
          requestId: idempotency,
          accountId: reference ? resolveAccount(reference) : null
        });
        const afterPayment = matters?.getPaymentByTransactionId(transactionId) ?? null;
        const afterSubscription = afterPayment ? matters?.getSubscription(afterPayment.subscriptionId) ?? null : null;
        const snapshots: Array<{
          entityType: "transaction" | "subscription_payment" | "subscription";
          entityId: string;
          before: Record<string, unknown> | null;
          after: Record<string, unknown> | null;
        }> = [{
          entityType: "transaction",
          entityId: transactionId,
          before: openclaw.transactionSnapshot(before),
          after: openclaw.transactionSnapshot(after)
        }];
        if (beforePayment && afterPayment) snapshots.push({
          entityType: "subscription_payment",
          entityId: beforePayment.id,
          before: openclaw.paymentSnapshot(beforePayment),
          after: openclaw.paymentSnapshot(afterPayment)
        });
        if (beforeSubscription && afterSubscription) snapshots.push({
          entityType: "subscription",
          entityId: beforeSubscription.id,
          before: openclaw.subscriptionSnapshot(beforeSubscription),
          after: openclaw.subscriptionSnapshot(afterSubscription)
        });
        return {
          result: { transaction: after, funds: funds.summary() },
          entityId: transactionId,
          snapshots
        };
      }
    })));

    server.registerTool("direct_undo_transaction_refund", {
      description: "direct 模式下撤销一笔全额退款。必须传入退款后账目的最新版 updatedAt。",
      inputSchema: { requestId, transactionId: z.string().uuid(), expectedUpdatedAt: z.string().datetime() }
    }, async ({ requestId: idempotency, transactionId, expectedUpdatedAt }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "transaction.refund.undo",
      entityType: "transaction",
      summary: "OpenClaw 撤销账目退款",
      request: { transactionId, expectedUpdatedAt },
      run: () => {
        const before = repository.getTransaction(transactionId, false);
        const beforePayment = matters?.getPaymentByTransactionId(transactionId) ?? null;
        const beforeSubscription = beforePayment ? matters?.getSubscription(beforePayment.subscriptionId) ?? null : null;
        const after = funds.undoTransactionRefund(transactionId, { expectedUpdatedAt, requestId: idempotency, accountId: null });
        const afterPayment = matters?.getPaymentByTransactionId(transactionId) ?? null;
        const afterSubscription = afterPayment ? matters?.getSubscription(afterPayment.subscriptionId) ?? null : null;
        const snapshots: Array<{
          entityType: "transaction" | "subscription_payment" | "subscription";
          entityId: string;
          before: Record<string, unknown> | null;
          after: Record<string, unknown> | null;
        }> = [{
          entityType: "transaction",
          entityId: transactionId,
          before: openclaw.transactionSnapshot(before),
          after: openclaw.transactionSnapshot(after)
        }];
        if (beforePayment && afterPayment) snapshots.push({
          entityType: "subscription_payment",
          entityId: beforePayment.id,
          before: openclaw.paymentSnapshot(beforePayment),
          after: openclaw.paymentSnapshot(afterPayment)
        });
        if (beforeSubscription && afterSubscription) snapshots.push({
          entityType: "subscription",
          entityId: beforeSubscription.id,
          before: openclaw.subscriptionSnapshot(beforeSubscription),
          after: openclaw.subscriptionSnapshot(afterSubscription)
        });
        return {
          result: { transaction: after, funds: funds.summary() },
          entityId: transactionId,
          snapshots
        };
      }
    })));
  }

  server.registerTool("direct_add_transaction", {
    description: "在 direct 模式下立即新增账目。amount 始终是人民币账本金额；选择 USD/USDT 账户时必须另传 accountAmount。只有外币金额时必须询问人民币等值，不得查询或猜测汇率。",
    inputSchema: {
      requestId,
      kind: z.enum(["expense", "income"]),
      amount: z.number().positive().max(1_000_000_000),
      accountAmount: z.number().positive().max(1_000_000_000).optional().describe("所选外币账户实际扣款或到账金额"),
      categoryId: z.string().uuid(),
      localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(240).optional(),
      account: z.string().trim().min(1).max(80).optional()
    }
  }, async (input) => {
    const request = { ...input, localDate: input.localDate ?? currentLocalDate(config.timezone) };
    const output = openclaw.execute({
      requestId: input.requestId, action: "transaction.create", entityType: "transaction", summary: "OpenClaw 新增账目", request,
      run: () => {
        const transaction = repository.createTransaction({
          kind: input.kind, amountMinor: amountToMinor(input.amount), categoryId: input.categoryId,
          localDate: request.localDate, note: input.note ?? null,
          accountId: resolveRequestedAccount(input.account),
          accountAmountMinor: input.accountAmount === undefined ? undefined : amountToMinor(input.accountAmount)
        }, { source: "openclaw", actor: "openclaw", idempotencyKey: `openclaw:${input.requestId}` });
        return { result: transaction, entityId: transaction.id, snapshots: [{ entityType: "transaction" as const, entityId: transaction.id, before: null, after: openclaw.transactionSnapshot(transaction) }] };
      }
    });
    return textResult(output);
  });

  server.registerTool("direct_add_transactions_batch", {
    description: "direct 模式下一次原子新增 1–20 笔账目。每笔 amount 都是明确的人民币账本金额；USD/USDT 账户还必须明确 accountAmount。缺少人民币等值时必须询问用户，不得查询或猜测汇率。",
    inputSchema: {
      requestId,
      transactions: z.array(z.object({
        kind: z.enum(["expense", "income"]),
        amount: z.number().positive().max(1_000_000_000),
        accountAmount: z.number().positive().max(1_000_000_000).optional(),
        categoryId: z.string().uuid(),
        localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().max(240).nullable().optional(),
        account: z.string().trim().min(1).max(80).optional()
      }).strict()).min(1).max(20)
    }
  }, async ({ requestId: idempotency, transactions }) => {
    const output = openclaw.execute({
      requestId: idempotency,
      action: "transaction.batch.create",
      entityType: "transaction",
      summary: "OpenClaw 批量新增账目",
      request: { transactions },
      run: () => {
        const created = transactions.map((item, index) => repository.createTransaction({
          kind: item.kind,
          amountMinor: amountToMinor(item.amount),
          categoryId: item.categoryId,
          localDate: item.localDate,
          note: item.note ?? null,
          accountId: resolveRequestedAccount(item.account),
          accountAmountMinor: item.accountAmount === undefined ? undefined : amountToMinor(item.accountAmount)
        }, {
          source: "openclaw",
          actor: "openclaw",
          idempotencyKey: "openclaw:" + idempotency + ":" + index
        }));
        return {
          result: { transactions: created, count: created.length },
          entityId: created[0]?.id ?? null,
          snapshots: created.map((transaction) => ({
            entityType: "transaction" as const,
            entityId: transaction.id,
            before: null,
            after: openclaw.transactionSnapshot(transaction)
          }))
        };
      }
    });
    return textResult(output);
  });

  server.registerTool("direct_update_transaction", {
    description: "立即修改账目。必须先查询并传入目标账目的 updatedAt；版本不一致时拒绝覆盖。",
    inputSchema: {
      requestId, transactionId: z.string().uuid(), expectedUpdatedAt: z.string().min(1),
      kind: z.enum(["expense", "income"]).optional(), amount: z.number().positive().max(1_000_000_000).optional(),
      accountAmount: z.number().positive().max(1_000_000_000).optional(),
      categoryId: z.string().uuid().optional(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(240).nullable().optional(),
      account: z.string().trim().min(1).max(80).optional()
    }
  }, async ({ requestId: idempotency, transactionId, expectedUpdatedAt, amount, accountAmount, ...fields }) => {
    const changes: Record<string, unknown> = { ...fields };
    if (fields.account !== undefined) {
      changes.accountId = resolveRequestedAccount(fields.account);
      delete changes.account;
    }
    if (amount !== undefined) changes.amountMinor = amountToMinor(amount);
    if (accountAmount !== undefined) changes.accountAmountMinor = amountToMinor(accountAmount);
    const output = openclaw.execute({
      requestId: idempotency, action: "transaction.update", entityType: "transaction", summary: "OpenClaw 修改账目",
      request: { transactionId, expectedUpdatedAt, ...changes },
      run: () => {
        const before = repository.getTransaction(transactionId, false);
        if (before.updatedAt !== expectedUpdatedAt) throw new Error("账目已经变化，请重新查询后再修改");
        const transaction = repository.updateTransaction(transactionId, transactionPatchSchema.parse(changes), "openclaw");
        return { result: transaction, entityId: transaction.id, snapshots: [{ entityType: "transaction" as const, entityId: transaction.id, before: openclaw.transactionSnapshot(before), after: openclaw.transactionSnapshot(transaction) }] };
      }
    });
    return textResult(output);
  });

  server.registerTool("direct_delete_transaction", {
    description: "立即软删除账目并移入 30 天回收站。必须传入最近查询到的 updatedAt。",
    inputSchema: { requestId, transactionId: z.string().uuid(), expectedUpdatedAt: z.string().min(1) }
  }, async ({ requestId: idempotency, transactionId, expectedUpdatedAt }) => {
    const output = openclaw.execute({
      requestId: idempotency, action: "transaction.delete", entityType: "transaction", summary: "OpenClaw 删除账目",
      request: { transactionId, expectedUpdatedAt },
      run: () => {
        const before = repository.getTransaction(transactionId, false);
        if (before.updatedAt !== expectedUpdatedAt) throw new Error("账目已经变化，请重新查询后再删除");
        const transaction = repository.softDeleteTransaction(transactionId, "openclaw");
        return { result: transaction, entityId: transaction.id, snapshots: [{ entityType: "transaction" as const, entityId: transaction.id, before: openclaw.transactionSnapshot(before), after: openclaw.transactionSnapshot(transaction) }] };
      }
    });
    return textResult(output);
  });

  server.registerTool("direct_permanently_delete_transaction", {
    description: "不可撤销地永久删除回收站中的一笔账目。仅在用户明确要求永久删除时使用；普通删除必须继续使用 direct_delete_transaction。",
    inputSchema: {
      requestId,
      transactionId: z.string().uuid(),
      expectedUpdatedAt: z.string().min(1),
      confirmation: z.literal("PERMANENT_DELETE")
    }
  }, async ({ requestId: idempotency, transactionId, expectedUpdatedAt, confirmation }) => {
    const output = openclaw.execute({
      requestId: idempotency,
      action: "transaction.purge",
      entityType: "transaction",
      summary: "OpenClaw 永久删除账目",
      undoable: false,
      request: { transactionId, expectedUpdatedAt, confirmation },
      run: () => {
        const result = repository.permanentlyDeleteTransaction(transactionId, expectedUpdatedAt, confirmation, "openclaw", true);
        return { result, entityId: transactionId };
      }
    });
    return textResult(output);
  });

  server.registerTool("direct_restore_transaction", {
    description: "立即从回收站恢复账目。必须传入已删除账目的 updatedAt。",
    inputSchema: { requestId, transactionId: z.string().uuid(), expectedUpdatedAt: z.string().min(1) }
  }, async ({ requestId: idempotency, transactionId, expectedUpdatedAt }) => {
    const output = openclaw.execute({
      requestId: idempotency, action: "transaction.restore", entityType: "transaction", summary: "OpenClaw 恢复账目",
      request: { transactionId, expectedUpdatedAt },
      run: () => {
        const before = repository.getTransaction(transactionId, true);
        if (!before.deletedAt || before.updatedAt !== expectedUpdatedAt) throw new Error("回收站账目已经变化，请重新查询");
        const transaction = repository.restoreTransaction(transactionId, "openclaw");
        return { result: transaction, entityId: transaction.id, snapshots: [{ entityType: "transaction" as const, entityId: transaction.id, before: openclaw.transactionSnapshot(before), after: openclaw.transactionSnapshot(transaction) }] };
      }
    });
    return textResult(output);
  });

  if (budgets) {
    server.registerTool("get_budget_summary", {
      description: "读取指定月份的月总预算、分类预算、已使用、剩余和当前月预测。不会修改预算。",
      inputSchema: { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }
    }, async ({ month }) => {
      const result = budgets.get(month);
      repository.audit("openclaw", "mcp.get_budget_summary", "budget", month, {
        categoryCount: result.categories.length
      });
      return textResult(result);
    });

    server.registerTool("direct_set_budget", {
      description: "direct 模式下设置一个月的总预算和分类预算。金额单位为元；已有预算必须传入最新版 updatedAt，新预算传 null。可在 30 天内撤销。",
      inputSchema: {
        requestId,
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        totalAmount: z.number().positive().max(1_000_000_000).nullable(),
        categories: z.array(z.object({
          categoryId: z.string().uuid(),
          amount: z.number().positive().max(1_000_000_000)
        }).strict()).max(200),
        expectedUpdatedAt: z.string().datetime().nullable()
      }
    }, async ({ requestId: idempotency, month, totalAmount, categories, expectedUpdatedAt }) => {
      const request = { month, totalAmount, categories, expectedUpdatedAt };
      return textResult(openclaw.execute({
        requestId: idempotency,
        action: "budget.set",
        entityType: "budget",
        summary: "OpenClaw 设置月度预算",
        request,
        run: () => {
          const before = budgets.snapshot(month);
          const result = budgets.put(month, {
            totalMinor: totalAmount === null ? null : amountToMinor(totalAmount),
            categories: categories.map((item) => ({
              categoryId: item.categoryId,
              amountMinor: amountToMinor(item.amount)
            })),
            expectedUpdatedAt
          }, { actor: "openclaw", withinTransaction: true });
          const after = budgets.snapshot(month);
          return {
            result,
            entityId: month,
            snapshots: [{ entityType: "budget" as const, entityId: month, before, after }]
          };
        }
      }));
    });

    server.registerTool("direct_delete_budget", {
      description: "direct 模式下删除指定月份的全部预算设置。必须传入最新版 updatedAt，可在 30 天内撤销。",
      inputSchema: {
        requestId,
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        expectedUpdatedAt: z.string().datetime()
      }
    }, async ({ requestId: idempotency, month, expectedUpdatedAt }) => textResult(openclaw.execute({
      requestId: idempotency,
      action: "budget.delete",
      entityType: "budget",
      summary: "OpenClaw 删除月度预算",
      request: { month, expectedUpdatedAt },
      run: () => {
        const before = budgets.snapshot(month);
        const result = budgets.delete(month, expectedUpdatedAt, {
          actor: "openclaw",
          withinTransaction: true
        });
        return {
          result,
          entityId: month,
          snapshots: [{ entityType: "budget" as const, entityId: month, before, after: null }]
        };
      }
    })));
  }

  server.registerTool("direct_create_category", {
    description: "立即新增收支分类。",
    inputSchema: { requestId, kind: z.enum(["expense", "income"]), name: z.string().min(1).max(16), icon: z.string().min(1).max(8), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }
  }, async (input) => textResult(openclaw.execute({
    requestId: input.requestId, action: "category.create", entityType: "category", summary: "OpenClaw 新增分类", request: input,
    run: () => {
      const category = repository.createCategory(categoryInputSchema.parse(input), "openclaw");
      return { result: category, entityId: category.id, snapshots: [{ entityType: "category" as const, entityId: category.id, before: null, after: openclaw.categorySnapshot(category) }] };
    }
  })));

  server.registerTool("direct_update_category", {
    description: "立即修改分类名称、图标、颜色、排序或停用状态。必须传入最近查询到的 updatedAt。",
    inputSchema: {
      requestId, categoryId: z.string().uuid(), expectedUpdatedAt: z.string().min(1), name: z.string().min(1).max(16).optional(),
      icon: z.string().min(1).max(8).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), sortOrder: z.number().int().min(0).max(999).optional(), isArchived: z.boolean().optional()
    }
  }, async ({ requestId: idempotency, categoryId, expectedUpdatedAt, ...changes }) => textResult(openclaw.execute({
    requestId: idempotency, action: "category.update", entityType: "category", summary: "OpenClaw 修改分类", request: { categoryId, expectedUpdatedAt, ...changes },
    run: () => {
      const before = repository.getCategory(categoryId);
      if (before.updatedAt !== expectedUpdatedAt) throw new Error("分类已经变化，请重新查询后再修改");
      const category = repository.updateCategory(categoryId, categoryPatchSchema.parse(changes), "openclaw");
      return { result: category, entityId: category.id, snapshots: [{ entityType: "category" as const, entityId: category.id, before: openclaw.categorySnapshot(before), after: openclaw.categorySnapshot(category) }] };
    }
  })));

  server.registerTool("direct_manage_category", {
    description: "立即停用、恢复、迁移或安全删除分类。迁移会整体记录并可撤销。",
    inputSchema: { requestId, categoryId: z.string().uuid(), expectedUpdatedAt: z.string().min(1), action: z.enum(["archive", "restore", "delete", "migrate"]), targetCategoryId: z.string().uuid().optional() }
  }, async ({ requestId: idempotency, categoryId, expectedUpdatedAt, action, targetCategoryId }) => {
    const disposition = categoryDispositionSchema.parse(action === "migrate" ? { action, targetCategoryId } : { action });
    const output = openclaw.execute({
      requestId: idempotency, action: `category.${action}`, entityType: "category", summary: `OpenClaw ${action} 分类`, request: { categoryId, expectedUpdatedAt, action, targetCategoryId },
      run: () => {
        const beforeCategory = repository.getCategory(categoryId);
        if (beforeCategory.updatedAt !== expectedUpdatedAt) throw new Error("分类已经变化，请重新查询");
        const { transactions, proposals } = repository.categoryDependencies(categoryId);
        const budgetSnapshots = budgets?.snapshotsForCategory(categoryId) ?? [];
        const result = repository.manageCategory(categoryId, disposition, "openclaw", true);
        const snapshots = [
          ...transactions.map((before) => ({ entityType: "transaction" as const, entityId: before.id, before: openclaw.transactionSnapshot(before), after: openclaw.transactionSnapshot(repository.getTransaction(before.id, true)) })),
          ...proposals.map((before) => ({ entityType: "proposal" as const, entityId: before.id, before: openclaw.proposalSnapshot(before), after: openclaw.proposalSnapshot(repository.getProposal(before.id)) })),
          ...budgetSnapshots.map((before) => ({
            entityType: "budget" as const,
            entityId: before.month,
            before,
            after: budgets?.snapshot(before.month) ?? null
          })),
          { entityType: "category" as const, entityId: categoryId, before: openclaw.categorySnapshot(beforeCategory), after: action === "archive" || action === "restore" ? openclaw.categorySnapshot(repository.getCategory(categoryId)) : null }
        ];
        return { result, entityId: categoryId, snapshots };
      }
    });
    return textResult(output);
  });

  server.registerTool("direct_permanently_delete_category", {
    description: "不可撤销地永久删除分类及其全部正常/回收站账目。必须先调用 get_category_deletion_impact，并由用户明确说出要永久删除的分类。",
    inputSchema: {
      requestId,
      categoryId: z.string().uuid(),
      expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
      confirmName: z.string().trim().min(1).max(16),
      confirmation: z.literal("PERMANENT_DELETE")
    }
  }, async ({ requestId: idempotency, categoryId, expectedRevision, confirmName, confirmation }) => {
    const output = openclaw.execute({
      requestId: idempotency,
      action: "category.purge",
      entityType: "category",
      summary: "OpenClaw 永久删除分类及账目",
      undoable: false,
      request: { categoryId, expectedRevision, confirmName, confirmation },
      run: () => {
        const result = repository.permanentlyDeleteCategory(categoryId, expectedRevision, confirmName, "openclaw", true);
        return { result, entityId: categoryId };
      }
    });
    return textResult(output);
  });

  server.registerTool("direct_generate_ai_analysis", {
    description: "立即使用 DeepSeek 生成分析。每小时最多 20 次；不会返回 API Key。",
    inputSchema: { requestId, mode: z.enum(["overview", "growth", "saving", "structure", "custom"]), periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), question: z.string().max(500).optional() }
  }, async ({ requestId: idempotency, ...input }) => textResult(await openclaw.executeExternal({
    requestId: idempotency, action: "ai.analyze", entityType: "ai_report", summary: "OpenClaw 生成 AI 分析", request: input,
    maxPerWindow: { count: 20, windowMs: 60 * 60 * 1000 }, run: () => ai.analyze(input, "openclaw")
  })));

  server.registerTool("list_ai_analyses", {
    description: "读取最近的 AI 分析历史。",
    inputSchema: { limit: z.number().int().min(1).max(20).optional().default(12) }
  }, async ({ limit }) => textResult(ai.listRecent(limit)));

  server.registerTool("direct_create_backup", {
    description: "立即创建一致性备份。MCP 两次备份至少间隔 10 分钟，不返回凭据。",
    inputSchema: { requestId }
  }, async ({ requestId: idempotency }) => textResult(await openclaw.executeExternal({
    requestId: idempotency, action: "backup.create", entityType: "database", summary: "OpenClaw 创建备份", request: {}, cooldownMs: 10 * 60 * 1000,
    run: async () => {
      const result = await backup.createBackup();
      return { createdAt: result.createdAt, remoteUploaded: result.remoteUploaded, remoteMessage: result.remoteMessage };
    }
  })));

  server.registerTool("get_app_status", {
    description: "查看服务、数据库、DeepSeek 和备份配置状态，不返回真实密钥或本机路径。",
    inputSchema: {}
  }, async () => textResult({ service: "ok", database: "ok", deepseekConfigured: Boolean(config.deepseekApiKey), backup: { lastSuccessAt: backup.status().lastSuccessAt, remoteConfigured: backup.status().remoteConfigured }, timezone: config.timezone, openclaw: openclaw.settings() }));

  server.registerTool("get_app_settings", {
    description: "读取可公开给 OpenClaw 的应用设置。只返回人民币、时区、AI 模型/思考模式和接管模式，不返回任何密钥或令牌。",
    inputSchema: {}
  }, async () => textResult({
    currency: "CNY",
    timezone: config.timezone,
    deepseek: { configured: Boolean(config.deepseekApiKey), model: config.deepseekModel, thinking: config.deepseekThinking },
    openclaw: openclaw.settings(),
    credentialsExposed: false
  }));

  server.registerTool("direct_update_timezone", {
    description: "立即修改账本时区。必须先通过 get_app_status 读取当前时区。",
    inputSchema: { requestId, timezone: z.string().min(1).max(64), expectedTimezone: z.string().min(1).max(64) }
  }, async ({ requestId: idempotency, timezone, expectedTimezone }) => {
    try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(new Date()); } catch { throw new Error("无效的 IANA 时区"); }
    return textResult(openclaw.execute({
      requestId: idempotency, action: "settings.timezone", entityType: "setting", summary: "OpenClaw 修改时区", request: { timezone, expectedTimezone },
      run: () => {
        const before = openclaw.settingSnapshot("timezone");
        if (before?.value !== expectedTimezone) throw new Error("时区已经变化，请重新查询");
        const after = openclaw.updateSetting("timezone", timezone);
        return { result: { timezone }, entityId: "timezone", snapshots: [{ entityType: "setting" as const, entityId: "timezone", before, after }] };
      }
    }));
  });

  server.registerTool("list_openclaw_operations", {
    description: "列出最近的 OpenClaw 直接操作及 30 天撤销状态。",
    inputSchema: { limit: z.number().int().min(1).max(100).optional().default(30) }
  }, async ({ limit }) => textResult(openclaw.listOperations(limit)));

  server.registerTool("undo_openclaw_operation", {
    description: "撤销 OpenClaw 自己最近 30 天内的可撤销操作；不会覆盖后来发生的新修改。",
    inputSchema: { operationId: z.string().uuid() }
  }, async ({ operationId }) => textResult(openclaw.undo(operationId, "openclaw")));
}

type MatterSnapshotEntity = "borrower" | "loan" | "loan_repayment" | "subscription" | "subscription_payment" | "transaction" | "plan";
type MatterSnapshot = { entityType: MatterSnapshotEntity; entityId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null };

function appendLinkedTransaction(
  snapshots: MatterSnapshot[],
  repository: LedgerRepository,
  openclaw: OpenClawControlService,
  link: { mode: string; transactionId: string | null } | null | undefined,
  seen: Set<string>
): void {
  if (link?.mode !== "create" || !link.transactionId || seen.has(link.transactionId)) return;
  const transaction = repository.getTransaction(link.transactionId, true);
  seen.add(transaction.id);
  snapshots.push({ entityType: "transaction", entityId: transaction.id, before: null, after: openclaw.transactionSnapshot(transaction) });
}

function registerMatterTools(
  server: McpServer,
  repository: LedgerRepository,
  _config: AppConfig,
  openclaw: OpenClawControlService,
  matters: MattersRepository,
  funds?: FundsService
): void {
  const requestId = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
  const expectedUpdatedAt = z.string().datetime();
  const amount = z.number().positive().max(1_000_000_000).describe("金额，元，最多两位小数");
  const accountReference = z.string().trim().min(1).max(100).optional();
  const resolveAccount = (reference: string | undefined): string | undefined => {
    if (!reference) return undefined;
    if (!funds) throw new Error("资金服务未启用");
    return funds.resolveAccountId(reference);
  };
  const matterPage = { status: z.enum(["active", "trash", "all"]).optional().default("active"), search: z.string().max(80).optional(), page: z.number().int().positive().optional().default(1), pageSize: z.number().int().min(1).max(100).optional().default(30) };

  // Read-only tools are intentionally available in both confirm and direct
  // modes.  They return the same public shapes as the REST endpoints.
  server.registerTool("list_borrowers", {
    description: "查询借款人、已借出、已归还和当前未还金额。不会修改数据。",
    inputSchema: matterPage
  }, async (input) => {
    const result = matters.listBorrowers(input);
    repository.audit("openclaw", "mcp.list_borrowers", "borrower", null, { count: result.items.length });
    return textResult(result);
  });

  server.registerTool("list_loans", {
    description: "查询借款及还款流水。可按借款人、状态、关键词和分页查询。",
    inputSchema: { ...matterPage, borrowerId: z.string().uuid().optional(), loanStatus: z.enum(["active", "settled"]).optional() }
  }, async (input) => {
    const result = matters.listLoans(input);
    repository.audit("openclaw", "mcp.list_loans", "loan", null, { count: result.items.length });
    return textResult(result);
  });

  server.registerTool("get_loan", {
    description: "读取一笔借款和其全部还款流水。",
    inputSchema: { loanId: z.string().uuid() }
  }, async ({ loanId }) => {
    const result = matters.getLoan(loanId, true);
    repository.audit("openclaw", "mcp.get_loan", "loan", loanId);
    return textResult(result);
  });

  server.registerTool("get_loan_summary", {
    description: "获取总借出、总归还、未还余额和未结清借款数量。",
    inputSchema: {}
  }, async () => {
    const result = matters.loanSummary();
    repository.audit("openclaw", "mcp.get_loan_summary", "loan", null);
    return textResult(result);
  });

  server.registerTool("list_loan_repayments", {
    description: "查询指定借款的还款流水。",
    inputSchema: { loanId: z.string().uuid(), includeDeleted: z.boolean().optional().default(false) }
  }, async ({ loanId, includeDeleted }) => {
    const result = matters.listRepayments(loanId, includeDeleted);
    repository.audit("openclaw", "mcp.list_loan_repayments", "loan_repayment", loanId, { count: result.length });
    return textResult(result);
  });

  server.registerTool("list_subscriptions", {
    description: "查询订阅、下次续费日、到期状态和付款历史。",
    inputSchema: { ...matterPage, subscriptionStatus: z.enum(["active", "paused", "cancelled"]).optional() }
  }, async (input) => {
    const result = matters.listSubscriptions(input);
    repository.audit("openclaw", "mcp.list_subscriptions", "subscription", null, { count: result.items.length });
    return textResult(result);
  });

  server.registerTool("get_subscription", {
    description: "读取一项订阅和其付款历史。",
    inputSchema: { subscriptionId: z.string().uuid() }
  }, async ({ subscriptionId }) => {
    const result = matters.getSubscription(subscriptionId, true);
    repository.audit("openclaw", "mcp.get_subscription", "subscription", subscriptionId);
    return textResult(result);
  });

  server.registerTool("get_subscription_summary", {
    description: "获取启用中的订阅、近期需要处理的续费和按币种汇总。",
    inputSchema: {}
  }, async () => {
    const result = matters.subscriptionSummary();
    repository.audit("openclaw", "mcp.get_subscription_summary", "subscription", null);
    return textResult(result);
  });

  server.registerTool("list_subscription_payments", {
    description: "查询指定订阅的付款历史。",
    inputSchema: { subscriptionId: z.string().uuid(), includeDeleted: z.boolean().optional().default(false) }
  }, async ({ subscriptionId, includeDeleted }) => {
    const result = matters.listPayments(subscriptionId, includeDeleted);
    repository.audit("openclaw", "mcp.list_subscription_payments", "subscription_payment", subscriptionId, { count: result.length });
    return textResult(result);
  });

  server.registerTool("list_plans", {
    description: "查询一次性财务计划。日期和金额都可选；无到期日的计划不会进入提醒。",
    inputSchema: { ...matterPage, planStatus: z.enum(["open", "completed", "cancelled"]).optional() }
  }, async (input) => {
    const result = matters.listPlans(input);
    repository.audit("openclaw", "mcp.list_plans", "plan", null, { count: result.items.length });
    return textResult(result);
  });

  server.registerTool("get_plan", {
    description: "读取一项财务计划。",
    inputSchema: { planId: z.string().uuid() }
  }, async ({ planId }) => {
    const result = matters.getPlan(planId, true);
    repository.audit("openclaw", "mcp.get_plan", "plan", planId);
    return textResult(result);
  });

  server.registerTool("get_plan_summary", {
    description: "获取未完成计划数量、提醒数量和近期到期项。",
    inputSchema: {}
  }, async () => {
    const result = matters.planSummary();
    repository.audit("openclaw", "mcp.get_plan_summary", "plan", null);
    return textResult(result);
  });

  server.registerTool("direct_create_borrower", {
    description: "direct 模式下立即新增借款人；必须提供 requestId。",
    inputSchema: { requestId, name: z.string().min(1).max(80), note: z.string().max(240).nullable().optional() }
  }, async (input) => textResult(openclaw.execute({
    requestId: input.requestId, action: "borrower.create", entityType: "borrower", summary: "OpenClaw 新增借款人", request: input,
    run: () => {
      const result = matters.createBorrower({ name: input.name, note: input.note }, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "borrower" as const, entityId: result.id, before: null, after: openclaw.borrowerSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_update_borrower", {
    description: "direct 模式下修改借款人。必须传入最近查询到的 updatedAt。",
    inputSchema: { requestId, borrowerId: z.string().uuid(), expectedUpdatedAt, name: z.string().min(1).max(80).optional(), note: z.string().max(240).nullable().optional(), isArchived: z.boolean().optional() }
  }, async ({ requestId: idempotency, borrowerId, expectedUpdatedAt: expected, ...changes }) => textResult(openclaw.execute({
    requestId: idempotency, action: "borrower.update", entityType: "borrower", summary: "OpenClaw 修改借款人", request: { borrowerId, expectedUpdatedAt: expected, ...changes },
    run: () => {
      const before = matters.getBorrower(borrowerId, false);
      if (before.updatedAt !== expected) throw new Error("借款人已经变化，请重新查询后再修改");
      const result = matters.updateBorrower(borrowerId, { ...changes, expectedUpdatedAt: expected }, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "borrower" as const, entityId: result.id, before: openclaw.borrowerSnapshot(before), after: openclaw.borrowerSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_delete_borrower", {
    description: "direct 模式下将借款人移入 30 天回收站。借款人必须没有未删除的借款。",
    inputSchema: { requestId, borrowerId: z.string().uuid(), expectedUpdatedAt }
  }, async ({ requestId: idempotency, borrowerId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
    requestId: idempotency, action: "borrower.delete", entityType: "borrower", summary: "OpenClaw 删除借款人", request: { borrowerId, expectedUpdatedAt: expected },
    run: () => {
      const before = matters.getBorrower(borrowerId, false);
      if (before.updatedAt !== expected) throw new Error("借款人已经变化，请重新查询后再删除");
      const result = matters.deleteBorrower(borrowerId, { actor: "openclaw" }, expected);
      return { result, entityId: result.id, snapshots: [{ entityType: "borrower" as const, entityId: result.id, before: openclaw.borrowerSnapshot(before), after: openclaw.borrowerSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_restore_borrower", {
    description: "direct 模式下从回收站恢复借款人。",
    inputSchema: { requestId, borrowerId: z.string().uuid(), expectedUpdatedAt: expectedUpdatedAt.optional() }
  }, async ({ requestId: idempotency, borrowerId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
    requestId: idempotency, action: "borrower.restore", entityType: "borrower", summary: "OpenClaw 恢复借款人", request: { borrowerId, expectedUpdatedAt: expected },
    run: () => {
      const before = matters.getBorrower(borrowerId, true);
      if (expected && before.updatedAt !== expected) throw new Error("借款人已经变化，请重新查询后再恢复");
      const result = matters.restoreBorrower(borrowerId, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "borrower" as const, entityId: result.id, before: openclaw.borrowerSnapshot(before), after: openclaw.borrowerSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_create_loan", {
    description: "direct 模式下立即新增一笔别人欠你的借款。可选关联或同时创建支出账目。",
    inputSchema: { requestId, borrowerId: z.string().uuid(), amount, localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), purpose: z.string().max(120).nullable().optional(), note: z.string().max(240).nullable().optional(), account: accountReference, ledgerLink: z.record(z.string(), z.unknown()).optional() }
  }, async ({ requestId: idempotency, amount: value, account, ...input }) => textResult(openclaw.execute({
    requestId: idempotency, action: "loan.create", entityType: "loan", summary: "OpenClaw 新增借款", request: { amount: value, ...input },
    run: () => {
      const result = matters.createLoan({ ...input, principalMinor: amountToMinor(value), accountId: resolveAccount(account) } as never, { actor: "openclaw" });
      const snapshots: MatterSnapshot[] = [{ entityType: "loan", entityId: result.id, before: null, after: openclaw.loanSnapshot(result) }];
      appendLinkedTransaction(snapshots, repository, openclaw, result.ledgerLink, new Set());
      return { result, entityId: result.id, snapshots };
    }
  })));

  server.registerTool("direct_update_loan", {
    description: "direct 模式下修改借款金额、日期、用途或备注；金额不能低于已还金额。",
    inputSchema: { requestId, loanId: z.string().uuid(), expectedUpdatedAt, amount: amount.optional(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), purpose: z.string().max(120).nullable().optional(), note: z.string().max(240).nullable().optional(), account: accountReference }
  }, async ({ requestId: idempotency, loanId, expectedUpdatedAt: expected, amount: value, account, ...changes }) => textResult(openclaw.execute({
    requestId: idempotency, action: "loan.update", entityType: "loan", summary: "OpenClaw 修改借款", request: { loanId, expectedUpdatedAt: expected, amount: value, ...changes },
    run: () => {
      const before = matters.getLoan(loanId, false);
      if (before.updatedAt !== expected) throw new Error("借款已经变化，请重新查询后再修改");
      const patch = { ...changes, expectedUpdatedAt: expected, ...(value === undefined ? {} : { principalMinor: amountToMinor(value) }), ...(account === undefined ? {} : { accountId: resolveAccount(account) }) };
      const result = matters.updateLoan(loanId, patch as never, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "loan" as const, entityId: result.id, before: openclaw.loanSnapshot(before), after: openclaw.loanSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_delete_loan", {
    description: "direct 模式下将借款移入 30 天回收站。",
    inputSchema: { requestId, loanId: z.string().uuid(), expectedUpdatedAt }
  }, async ({ requestId: idempotency, loanId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
    requestId: idempotency, action: "loan.delete", entityType: "loan", summary: "OpenClaw 删除借款", request: { loanId, expectedUpdatedAt: expected },
    run: () => {
      const before = matters.getLoan(loanId, false);
      if (before.updatedAt !== expected) throw new Error("借款已经变化，请重新查询后再删除");
      const result = matters.deleteLoan(loanId, { actor: "openclaw" }, expected);
      return { result, entityId: result.id, snapshots: [{ entityType: "loan" as const, entityId: result.id, before: openclaw.loanSnapshot(before), after: openclaw.loanSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_restore_loan", {
    description: "direct 模式下从回收站恢复借款。",
    inputSchema: { requestId, loanId: z.string().uuid(), expectedUpdatedAt: expectedUpdatedAt.optional() }
  }, async ({ requestId: idempotency, loanId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
    requestId: idempotency, action: "loan.restore", entityType: "loan", summary: "OpenClaw 恢复借款", request: { loanId, expectedUpdatedAt: expected },
    run: () => {
      const before = matters.getLoan(loanId, true);
      if (expected && before.updatedAt !== expected) throw new Error("借款已经变化，请重新查询后再恢复");
      const result = matters.restoreLoan(loanId, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "loan" as const, entityId: result.id, before: openclaw.loanSnapshot(before), after: openclaw.loanSnapshot(result) }] };
    }
  })));

  const repaymentInput = { requestId, loanId: z.string().uuid(), amount, localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(240).nullable().optional(), account: accountReference, ledgerLink: z.record(z.string(), z.unknown()).optional() };
  server.registerTool("direct_record_loan_repayment", {
    description: "direct 模式下记录一笔还款，不能超过该借款剩余金额，可选创建收入账目。",
    inputSchema: repaymentInput
  }, async ({ requestId: idempotency, loanId, amount: value, account, ...input }) => textResult(openclaw.execute({
    requestId: idempotency, action: "loan.repayment.create", entityType: "loan_repayment", summary: "OpenClaw 记录借款还款", request: { loanId, amount: value, ...input },
    run: () => {
      const beforeLoan = matters.getLoan(loanId, false);
      const result = matters.createRepayment(loanId, { ...input, amountMinor: amountToMinor(value), accountId: resolveAccount(account) } as never, { actor: "openclaw" });
      const afterLoan = matters.getLoan(loanId, false);
      const snapshots: MatterSnapshot[] = [
        { entityType: "loan", entityId: loanId, before: openclaw.loanSnapshot(beforeLoan), after: openclaw.loanSnapshot(afterLoan) },
        { entityType: "loan_repayment", entityId: result.id, before: null, after: openclaw.repaymentSnapshot(result) }
      ];
      appendLinkedTransaction(snapshots, repository, openclaw, result.ledgerLink, new Set());
      return { result, entityId: result.id, snapshots };
    }
  })));

  server.registerTool("direct_update_loan_repayment", {
    description: "direct 模式下修改还款金额、日期或备注；必须传入当前 updatedAt。",
    inputSchema: { requestId, repaymentId: z.string().uuid(), expectedUpdatedAt, amount: amount.optional(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(240).nullable().optional(), account: accountReference }
  }, async ({ requestId: idempotency, repaymentId, expectedUpdatedAt: expected, amount: value, account, ...changes }) => textResult(openclaw.execute({
    requestId: idempotency, action: "loan.repayment.update", entityType: "loan_repayment", summary: "OpenClaw 修改还款", request: { repaymentId, expectedUpdatedAt: expected, amount: value, ...changes },
    run: () => {
      const before = matters.getRepayment(repaymentId, false);
      if (before.updatedAt !== expected) throw new Error("还款记录已经变化，请重新查询后再修改");
      const beforeLoan = matters.getLoan(before.loanId, false);
      const patch = { ...changes, expectedUpdatedAt: expected, ...(value === undefined ? {} : { amountMinor: amountToMinor(value) }), ...(account === undefined ? {} : { accountId: resolveAccount(account) }) };
      const result = matters.updateRepayment(repaymentId, patch as never, { actor: "openclaw" });
      const afterLoan = matters.getLoan(before.loanId, false);
      return { result, entityId: result.id, snapshots: [
        { entityType: "loan_repayment" as const, entityId: result.id, before: openclaw.repaymentSnapshot(before), after: openclaw.repaymentSnapshot(result) },
        { entityType: "loan" as const, entityId: before.loanId, before: openclaw.loanSnapshot(beforeLoan), after: openclaw.loanSnapshot(afterLoan) }
      ] };
    }
  })));

  server.registerTool("direct_delete_loan_repayment", {
    description: "direct 模式下将还款记录移入 30 天回收站。",
    inputSchema: { requestId, repaymentId: z.string().uuid(), expectedUpdatedAt }
  }, async ({ requestId: idempotency, repaymentId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
    requestId: idempotency, action: "loan.repayment.delete", entityType: "loan_repayment", summary: "OpenClaw 删除借款还款", request: { repaymentId, expectedUpdatedAt: expected },
    run: () => {
      const before = matters.getRepayment(repaymentId, false);
      if (before.updatedAt !== expected) throw new Error("还款记录已经变化，请重新查询后再删除");
      const beforeLoan = matters.getLoan(before.loanId, false);
      const result = matters.deleteRepayment(repaymentId, { actor: "openclaw" }, expected);
      const afterLoan = matters.getLoan(before.loanId, false);
      return { result, entityId: result.id, snapshots: [
        { entityType: "loan_repayment" as const, entityId: result.id, before: openclaw.repaymentSnapshot(before), after: openclaw.repaymentSnapshot(result) },
        { entityType: "loan" as const, entityId: before.loanId, before: openclaw.loanSnapshot(beforeLoan), after: openclaw.loanSnapshot(afterLoan) }
      ] };
    }
  })));

  server.registerTool("direct_restore_loan_repayment", {
    description: "direct 模式下从回收站恢复还款记录。",
    inputSchema: { requestId, repaymentId: z.string().uuid(), expectedUpdatedAt: expectedUpdatedAt.optional() }
  }, async ({ requestId: idempotency, repaymentId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
    requestId: idempotency, action: "loan.repayment.restore", entityType: "loan_repayment", summary: "OpenClaw 恢复借款还款", request: { repaymentId, expectedUpdatedAt: expected },
    run: () => {
      const before = matters.getRepayment(repaymentId, true);
      if (expected && before.updatedAt !== expected) throw new Error("还款记录已经变化，请重新查询后再恢复");
      const beforeLoan = matters.getLoan(before.loanId, false);
      const result = matters.restoreRepayment(repaymentId, { actor: "openclaw" });
      const afterLoan = matters.getLoan(before.loanId, false);
      return { result, entityId: result.id, snapshots: [
        { entityType: "loan_repayment" as const, entityId: result.id, before: openclaw.repaymentSnapshot(before), after: openclaw.repaymentSnapshot(result) },
        { entityType: "loan" as const, entityId: before.loanId, before: openclaw.loanSnapshot(beforeLoan), after: openclaw.loanSnapshot(afterLoan) }
      ] };
    }
  })));

  server.registerTool("direct_create_subscription", {
    description: "direct 模式下新增订阅，可指定月/年/自定义周期和首笔付款。",
    inputSchema: { requestId, name: z.string().min(1).max(100), plan: z.string().max(100).nullable().optional(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount, currency: z.enum(["CNY", "USD"]), cycle: z.enum(["month", "year", "custom"]), customDays: z.number().int().min(1).max(366).optional().nullable(), nextBillingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), reminderDays: z.number().int().min(0).max(60).optional(), website: z.string().url().max(500).nullable().optional(), note: z.string().max(240).nullable().optional(), initialPayment: z.object({ amount, localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(240).nullable().optional(), ledgerLink: z.record(z.string(), z.unknown()).optional() }).optional() }
  }, async ({ requestId: idempotency, amount: value, initialPayment, ...input }) => textResult(openclaw.execute({
    requestId: idempotency, action: "subscription.create", entityType: "subscription", summary: "OpenClaw 新增订阅", request: { amount: value, initialPayment, ...input },
    run: () => {
      const result = matters.createSubscription({ ...input, recurringAmountMinor: amountToMinor(value), initialPayment: initialPayment ? {
        amountMinor: amountToMinor(initialPayment.amount), currency: input.currency, localDate: initialPayment.localDate,
        note: initialPayment.note ?? null, paymentType: "initial", ledgerLink: initialPayment.ledgerLink
      } : undefined } as never, { actor: "openclaw" });
      const snapshots: MatterSnapshot[] = [{ entityType: "subscription", entityId: result.id, before: null, after: openclaw.subscriptionSnapshot(result) }];
      const seen = new Set<string>();
      for (const payment of result.payments) {
        snapshots.push({ entityType: "subscription_payment", entityId: payment.id, before: null, after: openclaw.paymentSnapshot(payment) });
        appendLinkedTransaction(snapshots, repository, openclaw, payment.ledgerLink, seen);
      }
      return { result, entityId: result.id, snapshots };
    }
  })));

  server.registerTool("direct_update_subscription", {
    description: "direct 模式下修改订阅信息、价格、周期、续费日期、提醒或状态；必须传入当前 updatedAt。",
    inputSchema: { requestId, subscriptionId: z.string().uuid(), expectedUpdatedAt, name: z.string().min(1).max(100).optional(), plan: z.string().max(100).nullable().optional(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), amount: amount.optional(), currency: z.enum(["CNY", "USD"]).optional(), cycle: z.enum(["month", "year", "custom"]).optional(), customDays: z.number().int().min(1).max(366).nullable().optional(), nextBillingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), reminderDays: z.number().int().min(0).max(60).optional(), status: z.enum(["active", "paused", "cancelled"]).optional(), website: z.string().url().max(500).nullable().optional(), note: z.string().max(240).nullable().optional() }
  }, async ({ requestId: idempotency, subscriptionId, expectedUpdatedAt: expected, amount: value, ...changes }) => textResult(openclaw.execute({
    requestId: idempotency, action: "subscription.update", entityType: "subscription", summary: "OpenClaw 修改订阅", request: { subscriptionId, expectedUpdatedAt: expected, amount: value, ...changes },
    run: () => {
      const before = matters.getSubscription(subscriptionId, false);
      if (before.updatedAt !== expected) throw new Error("订阅已经变化，请重新查询后再修改");
      const patch = { ...changes, expectedUpdatedAt: expected, ...(value === undefined ? {} : { recurringAmountMinor: amountToMinor(value) }) };
      const result = matters.updateSubscription(subscriptionId, patch as never, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "subscription" as const, entityId: result.id, before: openclaw.subscriptionSnapshot(before), after: openclaw.subscriptionSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_delete_subscription", {
    description: "direct 模式下将订阅移入 30 天回收站。",
    inputSchema: { requestId, subscriptionId: z.string().uuid(), expectedUpdatedAt }
  }, async ({ requestId: idempotency, subscriptionId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
    requestId: idempotency, action: "subscription.delete", entityType: "subscription", summary: "OpenClaw 删除订阅", request: { subscriptionId, expectedUpdatedAt: expected },
    run: () => {
      const before = matters.getSubscription(subscriptionId, false);
      if (before.updatedAt !== expected) throw new Error("订阅已经变化，请重新查询后再删除");
      const result = matters.deleteSubscription(subscriptionId, { actor: "openclaw" }, expected);
      return { result, entityId: result.id, snapshots: [{ entityType: "subscription" as const, entityId: result.id, before: openclaw.subscriptionSnapshot(before), after: openclaw.subscriptionSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_restore_subscription", {
    description: "direct 模式下从回收站恢复订阅。",
    inputSchema: { requestId, subscriptionId: z.string().uuid(), expectedUpdatedAt: expectedUpdatedAt.optional() }
  }, async ({ requestId: idempotency, subscriptionId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
    requestId: idempotency, action: "subscription.restore", entityType: "subscription", summary: "OpenClaw 恢复订阅", request: { subscriptionId, expectedUpdatedAt: expected },
    run: () => {
      const before = matters.getSubscription(subscriptionId, true);
      if (expected && before.updatedAt !== expected) throw new Error("订阅已经变化，请重新查询后再恢复");
      const result = matters.restoreSubscription(subscriptionId, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "subscription" as const, entityId: result.id, before: openclaw.subscriptionSnapshot(before), after: openclaw.subscriptionSnapshot(result) }] };
    }
  })));

  const paymentInput = { requestId, subscriptionId: z.string().uuid(), amount, currency: z.enum(["CNY", "USD"]), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(240).nullable().optional(), paymentType: z.enum(["initial", "renewal", "manual"]).optional(), ledgerLink: z.record(z.string(), z.unknown()).optional() };
  server.registerTool("direct_record_subscription_payment", {
    description: "direct 模式下记录订阅续费/付款，更新下次续费日，可选创建人民币支出账目。",
    inputSchema: paymentInput
  }, async ({ requestId: idempotency, subscriptionId, amount: value, ...input }) => textResult(openclaw.execute({
    requestId: idempotency, action: "subscription.payment.create", entityType: "subscription_payment", summary: "OpenClaw 记录订阅付款", request: { subscriptionId, amount: value, ...input },
    run: () => {
      const beforeSubscription = matters.getSubscription(subscriptionId, false);
      const result = matters.createPayment(subscriptionId, { ...input, amountMinor: amountToMinor(value), paymentType: input.paymentType ?? "renewal" } as never, { actor: "openclaw" });
      const afterSubscription = matters.getSubscription(subscriptionId, false);
      const snapshots: MatterSnapshot[] = [
        { entityType: "subscription", entityId: subscriptionId, before: openclaw.subscriptionSnapshot(beforeSubscription), after: openclaw.subscriptionSnapshot(afterSubscription) },
        { entityType: "subscription_payment", entityId: result.id, before: null, after: openclaw.paymentSnapshot(result) }
      ];
      appendLinkedTransaction(snapshots, repository, openclaw, result.ledgerLink, new Set());
      return { result, entityId: result.id, snapshots };
    }
  })));

  server.registerTool("direct_update_subscription_payment", {
    description: "direct 模式下修改订阅付款记录；必须传入当前 updatedAt。",
    inputSchema: { requestId, paymentId: z.string().uuid(), expectedUpdatedAt, amount: amount.optional(), currency: z.enum(["CNY", "USD"]).optional(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(240).nullable().optional(), paymentType: z.enum(["initial", "renewal", "manual"]).optional() }
  }, async ({ requestId: idempotency, paymentId, expectedUpdatedAt: expected, amount: value, ...changes }) => textResult(openclaw.execute({
    requestId: idempotency, action: "subscription.payment.update", entityType: "subscription_payment", summary: "OpenClaw 修改订阅付款", request: { paymentId, expectedUpdatedAt: expected, amount: value, ...changes },
    run: () => {
      const before = matters.getPayment(paymentId, false);
      if (before.updatedAt !== expected) throw new Error("付款记录已经变化，请重新查询后再修改");
      const beforeSubscription = matters.getSubscription(before.subscriptionId, false);
      const patch = { ...changes, expectedUpdatedAt: expected, ...(value === undefined ? {} : { amountMinor: amountToMinor(value) }) };
      const result = matters.updatePayment(paymentId, patch as never, { actor: "openclaw" });
      const afterSubscription = matters.getSubscription(before.subscriptionId, false);
      return { result, entityId: result.id, snapshots: [
        { entityType: "subscription_payment" as const, entityId: result.id, before: openclaw.paymentSnapshot(before), after: openclaw.paymentSnapshot(result) },
        { entityType: "subscription" as const, entityId: before.subscriptionId, before: openclaw.subscriptionSnapshot(beforeSubscription), after: openclaw.subscriptionSnapshot(afterSubscription) }
      ] };
    }
  })));

  for (const [name, action, summary, operation] of [
    ["direct_delete_subscription_payment", "subscription.payment.delete", "OpenClaw 删除订阅付款", "delete"],
    ["direct_restore_subscription_payment", "subscription.payment.restore", "OpenClaw 恢复订阅付款", "restore"]
  ] as const) {
    server.registerTool(name, {
      description: operation === "delete" ? "direct 模式下将订阅付款移入 30 天回收站。" : "direct 模式下从回收站恢复订阅付款。",
      inputSchema: { requestId, paymentId: z.string().uuid(), expectedUpdatedAt: expectedUpdatedAt.optional() }
    }, async ({ requestId: idempotency, paymentId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
      requestId: idempotency, action, entityType: "subscription_payment", summary, request: { paymentId, expectedUpdatedAt: expected },
      run: () => {
        const before = matters.getPayment(paymentId, operation === "restore");
        if (expected && before.updatedAt !== expected) throw new Error("订阅付款已经变化，请重新查询");
        const beforeSubscription = matters.getSubscription(before.subscriptionId, false);
        const result = operation === "delete"
          ? matters.deletePayment(paymentId, { actor: "openclaw" }, expected)
          : matters.restorePayment(paymentId, { actor: "openclaw" });
        const afterSubscription = matters.getSubscription(before.subscriptionId, false);
        return { result, entityId: result.id, snapshots: [
          { entityType: "subscription_payment" as const, entityId: result.id, before: openclaw.paymentSnapshot(before), after: openclaw.paymentSnapshot(result) },
          { entityType: "subscription" as const, entityId: before.subscriptionId, before: openclaw.subscriptionSnapshot(beforeSubscription), after: openclaw.subscriptionSnapshot(afterSubscription) }
        ] };
      }
    })));
  }

  server.registerTool("direct_create_plan", {
    description: "direct 模式下新增一次性财务计划。只需标题；日期、金额可选。不要推断日期或金额，也不要绑定账户。",
    inputSchema: {
      requestId,
      title: z.string().min(1).max(100),
      amount: amount.optional().nullable(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      reminderDays: z.number().int().min(0).max(60).optional(),
      note: z.string().max(240).nullable().optional()
    }
  }, async ({ requestId: idempotency, amount: value, ...input }) => textResult(openclaw.execute({
    requestId: idempotency, action: "plan.create", entityType: "plan", summary: "OpenClaw 新增计划", request: { amount: value, ...input },
    run: () => {
      const result = matters.createPlan({
        ...input,
        amountMinor: value == null ? null : amountToMinor(value)
      }, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "plan" as const, entityId: result.id, before: null, after: openclaw.planSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_update_plan", {
    description: "direct 模式下修改未完成且未入账的计划；必须传入当前 updatedAt。不能用此工具完成入账。",
    inputSchema: {
      requestId,
      planId: z.string().uuid(),
      expectedUpdatedAt,
      title: z.string().min(1).max(100).optional(),
      amount: amount.optional().nullable(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      reminderDays: z.number().int().min(0).max(60).optional(),
      status: z.enum(["open", "cancelled"]).optional(),
      note: z.string().max(240).nullable().optional()
    }
  }, async ({ requestId: idempotency, planId, expectedUpdatedAt: expected, amount: value, ...changes }) => textResult(openclaw.execute({
    requestId: idempotency, action: "plan.update", entityType: "plan", summary: "OpenClaw 修改计划", request: { planId, expectedUpdatedAt: expected, amount: value, ...changes },
    run: () => {
      const before = matters.getPlan(planId, false);
      if (before.updatedAt !== expected) throw new Error("计划已经变化，请重新查询后再修改");
      const patch = { ...changes, expectedUpdatedAt: expected, ...(value === undefined ? {} : { amountMinor: value == null ? null : amountToMinor(value) }) };
      const result = matters.updatePlan(planId, patch, { actor: "openclaw" });
      return { result, entityId: result.id, snapshots: [{ entityType: "plan" as const, entityId: result.id, before: openclaw.planSnapshot(before), after: openclaw.planSnapshot(result) }] };
    }
  })));

  server.registerTool("direct_complete_plan", {
    description: "direct 模式下完成一项计划。无金额只改状态；有金额必须创建或关联支出（资金启用后还要支付账户），不要推断分类或账户。",
    inputSchema: {
      requestId,
      planId: z.string().uuid(),
      expectedUpdatedAt,
      amount: amount.optional(),
      localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(240).nullable().optional(),
      ledgerLink: z.record(z.string(), z.unknown()).optional(),
      account: accountReference
    }
  }, async ({ requestId: idempotency, planId, expectedUpdatedAt: expected, amount: value, account, ledgerLink, ...input }) => textResult(openclaw.execute({
    requestId: idempotency, action: "plan.complete", entityType: "plan", summary: "OpenClaw 完成计划", request: { planId, expectedUpdatedAt: expected, amount: value, account, ledgerLink, ...input },
    run: () => {
      const before = matters.getPlan(planId, false);
      if (before.updatedAt !== expected) throw new Error("计划已经变化，请重新查询后再完成");
      const accountId = resolveAccount(account);
      const link = ledgerLink
        ? { ...ledgerLink, ...(accountId ? { accountId } : {}) }
        : undefined;
      const result = matters.completePlan(planId, {
        ...input,
        expectedUpdatedAt: expected,
        amountMinor: value == null ? undefined : amountToMinor(value),
        ledgerLink: link
      } as never, { actor: "openclaw" });
      const snapshots: MatterSnapshot[] = [
        { entityType: "plan", entityId: result.id, before: openclaw.planSnapshot(before), after: openclaw.planSnapshot(result) }
      ];
      appendLinkedTransaction(snapshots, repository, openclaw, result.ledgerLink, new Set());
      return { result, entityId: result.id, snapshots };
    }
  })));

  for (const [name, action, summary, operation] of [
    ["direct_delete_plan", "plan.delete", "OpenClaw 删除计划", "delete"],
    ["direct_restore_plan", "plan.restore", "OpenClaw 恢复计划", "restore"]
  ] as const) {
    server.registerTool(name, {
      description: operation === "delete" ? "direct 模式下将计划移入 30 天回收站。不会删除已入账的支出。" : "direct 模式下从回收站恢复计划。",
      inputSchema: { requestId, planId: z.string().uuid(), expectedUpdatedAt: expectedUpdatedAt.optional() }
    }, async ({ requestId: idempotency, planId, expectedUpdatedAt: expected }) => textResult(openclaw.execute({
      requestId: idempotency, action, entityType: "plan", summary, request: { planId, expectedUpdatedAt: expected },
      run: () => {
        const before = matters.getPlan(planId, operation === "restore");
        if (expected && before.updatedAt !== expected) throw new Error("计划已经变化，请重新查询");
        const result = operation === "delete"
          ? matters.deletePlan(planId, { actor: "openclaw" }, expected)
          : matters.restorePlan(planId, { actor: "openclaw" });
        return { result, entityId: result.id, snapshots: [{ entityType: "plan" as const, entityId: result.id, before: openclaw.planSnapshot(before), after: openclaw.planSnapshot(result) }] };
      }
    })));
  }
}

export function attachMcpRoutes(
  app: Express,
  repository: LedgerRepository,
  ai: AiService,
  backup: BackupService,
  openclaw: OpenClawControlService,
  config: AppConfig,
  matters?: MattersRepository,
  budgets?: BudgetService,
  health?: HealthService,
  funds?: FundsService
): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const auth = createMcpAuth(config);

  app.post("/mcp", auth, async (request: Request, response: Response) => {
    try {
      const sessionId = request.header("mcp-session-id");
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport && !sessionId && isInitializeRequest(request.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport!);
          }
        });
        const server = createLedgerMcpServer(repository, config, { ai, backup, openclaw, matters, budgets, health, funds });
        server.server.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        await server.connect(transport);
      }
      if (!transport) {
        sendMcpJsonRpcError(response, 400, -32000, "无效或缺少 MCP 会话");
        return;
      }
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logSafeRequestError(request, error);
      sendMcpJsonRpcError(response, 500, -32603, "MCP 内部错误");
    }
  });

  app.get("/mcp", auth, async (request: Request, response: Response) => {
    try {
      const sessionId = request.header("mcp-session-id");
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        sendMcpJsonRpcError(response, 400, -32000, "无效或缺少 MCP 会话");
        return;
      }
      await transport.handleRequest(request, response);
    } catch (error) {
      logSafeRequestError(request, error);
      sendMcpJsonRpcError(response, 500, -32603, "MCP 内部错误");
    }
  });

  app.delete("/mcp", auth, async (request: Request, response: Response) => {
    try {
      const sessionId = request.header("mcp-session-id");
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        sendMcpJsonRpcError(response, 400, -32000, "无效或缺少 MCP 会话");
        return;
      }
      await transport.handleRequest(request, response);
      transports.delete(sessionId!);
    } catch (error) {
      logSafeRequestError(request, error);
      sendMcpJsonRpcError(response, 500, -32603, "MCP 内部错误");
    }
  });
}
