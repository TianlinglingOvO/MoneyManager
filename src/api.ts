import type {
  AiAnalysis,
  AppearancePreferences,
  Category,
  CategoryDeletionImpact,
  CategoryDispositionResult,
  DailyTransactionTotal,
  DashboardData,
  FinanceReport,
  OpenClawControlSettings,
  OpenClawOperation,
  PermanentDeletionResult,
  Proposal,
  SystemStatus,
  Transaction,
  TransactionList,
  Borrower,
  LedgerLink,
  LedgerLinkMode,
  Loan,
  LoanRepayment,
  LoanSummary,
  MatterCurrency,
  Subscription,
  SubscriptionPayment,
  SubscriptionSummary
} from "@shared/types";
import {
  clearConnectionIssue,
  isConnectionIssueCode,
  reportConnectionIssue,
  type ConnectionIssueCode
} from "./connection-status";

export class ApiError extends Error {
  constructor(message: string, public readonly code = "API_ERROR", public readonly status = 500) {
    super(message);
  }
}

export type MatterLedgerLink = LedgerLink;
export type MatterList<T> = { items: T[]; total: number; page: number; pageSize: number };

function connectionError(code: ConnectionIssueCode, message: string, status = 0): ApiError {
  const error = new ApiError(message, code, status);
  reportConnectionIssue({ code, message });
  return error;
}

function isAccessRedirect(response: Response): boolean {
  if (response.type === "opaqueredirect") return true;
  if (!response.redirected) return false;
  const url = response.url.toLowerCase();
  return url.includes("cloudflareaccess.com") || url.includes("/cdn-cgi/access/");
}

export function shouldRetryRequest(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && ["AUTH_EXPIRED", "FORBIDDEN", "OFFLINE"].includes(error.code)) return false;
  return failureCount < 1;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "manual",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });
  } catch {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw connectionError("OFFLINE", "设备当前没有网络连接");
    }
    throw connectionError("SERVICE_UNAVAILABLE", "暂时无法连接账本服务");
  }

  if (isAccessRedirect(response)) {
    throw connectionError("AUTH_EXPIRED", "Cloudflare 登录状态已过期", 401);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const code: ConnectionIssueCode = response.status === 401
      ? "AUTH_EXPIRED"
      : response.status === 403
        ? "FORBIDDEN"
        : response.status >= 500
          ? "SERVICE_UNAVAILABLE"
          : "INVALID_RESPONSE";
    const message = code === "AUTH_EXPIRED"
      ? "Cloudflare 登录状态已过期"
      : code === "FORBIDDEN"
        ? "当前账号没有访问权限"
        : code === "SERVICE_UNAVAILABLE"
          ? "账本服务或 Cloudflare Tunnel 暂时不可用"
          : "账本服务返回了无法识别的内容";
    throw connectionError(code, message, response.status);
  }

  let payload: { data?: T; error?: { code?: string; message?: string } } | null;
  try {
    payload = await response.json();
  } catch {
    throw connectionError("INVALID_RESPONSE", "账本服务返回了无法解析的内容", response.status);
  }

  if (!response.ok) {
    const error = payload?.error;
    if (response.status === 401 || error?.code === "UNAUTHORIZED") {
      throw connectionError("AUTH_EXPIRED", error?.message ?? "登录状态已过期", response.status);
    }
    if (response.status === 403 || error?.code === "FORBIDDEN") {
      throw connectionError("FORBIDDEN", error?.message ?? "当前账号没有访问权限", response.status);
    }
    if (response.status >= 500 || [502, 503, 504, 530].includes(response.status)) {
      throw connectionError("SERVICE_UNAVAILABLE", "账本服务或 Cloudflare Tunnel 暂时不可用", response.status);
    }
    clearConnectionIssue();
    throw new ApiError(error?.message ?? `请求失败（${response.status}）`, error?.code, response.status);
  }

  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw connectionError("INVALID_RESPONSE", "账本服务返回了不完整的内容", response.status);
  }

  clearConnectionIssue();
  return payload?.data as T;
}

export function isConnectionError(error: unknown): error is ApiError {
  return error instanceof ApiError && isConnectionIssueCode(error.code);
}

function queryString(values: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  });
  const result = params.toString();
  return result ? `?${result}` : "";
}

export const api = {
  dashboard: (date: string) => request<DashboardData>(`/api/v1/dashboard${queryString({ date })}`),
  categories: (kind?: "expense" | "income", includeArchived = false) =>
    request<Category[]>(`/api/v1/categories${queryString({ kind, includeArchived })}`),
  createCategory: (input: Pick<Category, "kind" | "name" | "icon" | "color">) =>
    request<Category>("/api/v1/categories", { method: "POST", body: JSON.stringify(input) }),
  updateCategory: (id: string, input: Partial<Pick<Category, "name" | "icon" | "color" | "sortOrder" | "isArchived">>) =>
    request<Category>(`/api/v1/categories/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  manageCategory: (id: string, input: { action: "archive" | "restore" | "delete" } | { action: "migrate"; targetCategoryId: string } | { action: "purge"; expectedRevision: string; confirmName: string }) =>
    request<CategoryDispositionResult>(`/api/v1/categories/${id}/disposition`, { method: "POST", body: JSON.stringify(input) }),
  categoryDeletionImpact: (id: string) => request<CategoryDeletionImpact>(`/api/v1/categories/${id}/deletion-impact`),
  transactions: (filters: Record<string, string | number | boolean | undefined>) =>
    request<TransactionList>(`/api/v1/transactions${queryString(filters)}`),
  createTransaction: (input: Record<string, unknown>, idempotencyKey: string) =>
    request<Transaction>("/api/v1/transactions", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input)
    }),
  updateTransaction: (id: string, input: Record<string, unknown>) =>
    request<Transaction>(`/api/v1/transactions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  transaction: (id: string) => request<Transaction>(`/api/v1/transactions/${id}`),
  deleteTransaction: (id: string) => request<Transaction>(`/api/v1/transactions/${id}`, { method: "DELETE" }),
  restoreTransaction: (id: string) => request<Transaction>(`/api/v1/transactions/${id}/restore`, { method: "POST" }),
  permanentlyDeleteTransaction: (id: string, expectedUpdatedAt: string) => request<PermanentDeletionResult>(`/api/v1/transactions/${id}/permanent`, {
    method: "DELETE",
    body: JSON.stringify({ expectedUpdatedAt, confirmation: "PERMANENT_DELETE" })
  }),
  report: (grain: "day" | "week" | "month" | "year", anchor: string, kind: "expense" | "income") =>
    request<FinanceReport>(`/api/v1/reports/finance${queryString({ grain, anchor, kind })}`),
  dailyTotals: (filters: { start: string; end: string; kind?: "expense" | "income"; categoryId?: string; search?: string }) =>
    request<DailyTransactionTotal[]>(`/api/v1/reports/daily-totals${queryString(filters)}`),
  proposals: (status = "pending") => request<Proposal[]>(`/api/v1/proposals${queryString({ status })}`),
  reviseProposal: (id: string, expectedRevision: number, changes: Record<string, unknown>) =>
    request<Proposal>(`/api/v1/proposals/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision, ...changes })
    }),
  resolveProposal: (id: string, decision: "approve" | "reject", expectedRevision: number) =>
    request<{ proposal: Proposal; transaction?: Transaction }>(`/api/v1/proposals/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision, expectedRevision })
    }),
  aiPreview: (periodStart: string, periodEnd: string) =>
    request<{ transactionCount: number; fields: string[] }>(`/api/v1/ai/preview${queryString({ periodStart, periodEnd })}`),
  aiAnalyses: () => request<AiAnalysis[]>("/api/v1/ai/analyses"),
  analyze: (input: Record<string, unknown>) =>
    request<AiAnalysis>("/api/v1/ai/analyze", { method: "POST", body: JSON.stringify(input) }),
  status: () => request<SystemStatus>("/api/v1/status"),
  settings: () => request<{
    currency: "CNY";
    timezone?: string;
    today?: string;
    rows: Array<{ key: string; value: string; updated_at: string }>;
  }>("/api/v1/settings"),
  appearance: () => request<AppearancePreferences>("/api/v1/appearance"),
  updateAppearance: (input: Partial<Pick<AppearancePreferences, "preset" | "accent" | "density" | "backgroundPreset">>) =>
    request<AppearancePreferences>("/api/v1/appearance", { method: "PATCH", body: JSON.stringify(input) }),
  updateTimezone: (timezone: string) => request<{ timezone: string }>("/api/v1/settings/timezone", {
    method: "PATCH",
    body: JSON.stringify({ timezone })
  }),
  backup: () => request<{ createdAt: string; localPath: string; remoteUploaded: boolean; remoteMessage: string }>("/api/v1/backups", { method: "POST" }),
  openClawSettings: () => request<OpenClawControlSettings>("/api/v1/openclaw/settings"),
  updateOpenClawSettings: (mode: "confirm" | "direct") => request<OpenClawControlSettings>("/api/v1/openclaw/settings", {
    method: "PATCH", body: JSON.stringify({ mode })
  }),
  openClawOperations: (limit = 50) => request<OpenClawOperation[]>(`/api/v1/openclaw/operations${queryString({ limit })}`),
  undoOpenClawOperation: (id: string) => request<OpenClawOperation>(`/api/v1/openclaw/operations/${id}/undo`, { method: "POST" }),

  borrowers: (includeArchived = false) =>
    request<Borrower[] | MatterList<Borrower>>(`/api/v1/borrowers${queryString({ includeArchived })}`),
  createBorrower: (input: { name: string }, requestId = crypto.randomUUID()) =>
    request<Borrower>("/api/v1/borrowers", { method: "POST", headers: { "Idempotency-Key": requestId }, body: JSON.stringify(input) }),
  updateBorrower: (id: string, input: { name?: string; isArchived?: boolean; expectedUpdatedAt?: string }) =>
    request<Borrower>(`/api/v1/borrowers/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  loanSummary: () => request<LoanSummary>("/api/v1/loans/summary"),
  loans: (filters: { borrowerId?: string; status?: string; loanStatus?: "active" | "settled"; includeDeleted?: boolean; page?: number; pageSize?: number } = {}) =>
    request<Loan[] | MatterList<Loan>>(`/api/v1/loans${queryString(filters)}`),
  loan: (id: string) => request<Loan>(`/api/v1/loans/${id}`),
  createLoan: (input: Record<string, unknown>, requestId = crypto.randomUUID()) =>
    request<Loan>("/api/v1/loans", { method: "POST", headers: { "Idempotency-Key": requestId }, body: JSON.stringify(input) }),
  updateLoan: (id: string, input: Record<string, unknown>) =>
    request<Loan>(`/api/v1/loans/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteLoan: (id: string, expectedUpdatedAt?: string) => request<Loan>(`/api/v1/loans/${id}`, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt }) }),
  restoreLoan: (id: string) => request<Loan>(`/api/v1/loans/${id}/restore`, { method: "POST" }),
  loanRepayments: (id: string, status: "active" | "trash" = "active") => request<LoanRepayment[]>(`/api/v1/loans/${id}/repayments${queryString({ status })}`),
  createLoanRepayment: (id: string, input: Record<string, unknown>, requestId = crypto.randomUUID()) =>
    request<LoanRepayment>(`/api/v1/loans/${id}/repayments`, { method: "POST", headers: { "Idempotency-Key": requestId }, body: JSON.stringify(input) }),
  deleteLoanRepayment: (loanId: string, repaymentId: string, expectedUpdatedAt?: string) => request<LoanRepayment>(`/api/v1/loans/${loanId}/repayments/${repaymentId}`, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt }) }),
  restoreLoanRepayment: (loanId: string, repaymentId: string) => request<LoanRepayment>(`/api/v1/loans/${loanId}/repayments/${repaymentId}/restore`, { method: "POST" }),
  subscriptionSummary: () => request<SubscriptionSummary>("/api/v1/subscriptions/summary"),
  subscriptions: (filters: { status?: string; subscriptionStatus?: "active" | "paused" | "cancelled"; includeDeleted?: boolean; page?: number; pageSize?: number } = {}) =>
    request<Subscription[] | MatterList<Subscription>>(`/api/v1/subscriptions${queryString(filters)}`),
  subscription: (id: string) => request<Subscription>(`/api/v1/subscriptions/${id}`),
  createSubscription: (input: Record<string, unknown>, requestId = crypto.randomUUID()) =>
    request<Subscription>("/api/v1/subscriptions", { method: "POST", headers: { "Idempotency-Key": requestId }, body: JSON.stringify(input) }),
  updateSubscription: (id: string, input: Record<string, unknown>) =>
    request<Subscription>(`/api/v1/subscriptions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteSubscription: (id: string, expectedUpdatedAt?: string) => request<Subscription>(`/api/v1/subscriptions/${id}`, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt }) }),
  restoreSubscription: (id: string) => request<Subscription>(`/api/v1/subscriptions/${id}/restore`, { method: "POST" }),
  subscriptionPayments: (id: string, status: "active" | "trash" = "active") => request<SubscriptionPayment[]>(`/api/v1/subscriptions/${id}/payments${queryString({ status })}`),
  createSubscriptionPayment: (id: string, input: Record<string, unknown>, requestId = crypto.randomUUID()) =>
    request<SubscriptionPayment>(`/api/v1/subscriptions/${id}/payments`, { method: "POST", headers: { "Idempotency-Key": requestId }, body: JSON.stringify(input) }),
  deleteSubscriptionPayment: (subscriptionId: string, paymentId: string, expectedUpdatedAt?: string) => request<SubscriptionPayment>(`/api/v1/subscriptions/${subscriptionId}/payments/${paymentId}`, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt }) }),
  restoreSubscriptionPayment: (subscriptionId: string, paymentId: string) => request<SubscriptionPayment>(`/api/v1/subscriptions/${subscriptionId}/payments/${paymentId}/restore`, { method: "POST" })
};
