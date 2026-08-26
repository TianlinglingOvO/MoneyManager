export type TransactionKind = "expense" | "income";
export type ReportGrain = "day" | "week" | "month" | "year";
export type ProposalAction = "create" | "update" | "delete";
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired";
export type OpenClawMode = "confirm" | "direct";
export type OpenClawOperationStatus = "running" | "applied" | "undone" | "failed";
export type AccountCurrency = "CNY" | "USD" | "USDT";
export type MatterCurrency = "CNY" | "USD";
export type MatterStatus = "active" | "paused" | "cancelled";
export type SubscriptionCycle = "month" | "year" | "custom";
export type LedgerLinkMode = "none" | "existing" | "create";
export type AppearancePreset = "warm-paper" | "porcelain" | "sage-ledger" | "ink-night";
export type AppearanceDensity = "comfortable" | "compact";
export type AppearanceBackgroundPreset = "plain" | "paper" | "linen" | "mist";

export interface AppearanceColorDerivatives {
  accent: `#${string}`;
  onAccent: "#000000" | "#FFFFFF";
  accentTextOnLight: `#${string}`;
  accentTextOnDark: `#${string}`;
}

export interface AppearancePreferences {
  preset: AppearancePreset;
  accent: `#${string}`;
  density: AppearanceDensity;
  backgroundPreset: AppearanceBackgroundPreset;
  updatedAt: string;
}

export interface Category {
  id: string;
  kind: TransactionKind;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  isArchived: boolean;
  transactionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  id: string;
  kind: TransactionKind;
  amountMinor: number;
  accountAmountMinor: number | null;
  currency: "CNY";
  categoryId: string;
  category?: Pick<Category, "id" | "name" | "icon" | "color">;
  accountId: string | null;
  account?: Pick<Account, "id" | "name" | "icon" | "currency"> | null;
  fundsBaseline: boolean;
  refundedAt: string | null;
  refundAccountId: string | null;
  localDate: string;
  note: string | null;
  source: "user" | "openclaw" | "system";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Account {
  id: string;
  name: string;
  icon: string;
  currency: AccountCurrency;
  aliases: string[];
  openingBalanceMinor: number;
  balanceMinor: number;
  openedOn: string;
  isArchived: boolean;
  isUnused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountMovement {
  id: string;
  accountId: string;
  accountName?: string;
  currency: AccountCurrency;
  deltaMinor: number;
  sourceType: "transaction" | "loan" | "loan_repayment" | "transfer" | "adjustment";
  sourceId: string;
  localDate: string;
  requestId: string | null;
  operationId: string | null;
  reversalOfId: string | null;
  createdAt: string;
}

export interface AccountMovementList {
  items: AccountMovement[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FundsSummary {
  enabled: boolean;
  startedOn: string | null;
  totalMinor: number;
  currencyTotals: Record<AccountCurrency, number>;
  accountCount: number;
  defaultExpenseAccountId: string | null;
  defaultIncomeAccountId: string | null;
  defaultFeeCategoryId: string | null;
  accounts: Account[];
}

export interface Transfer {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  currency: AccountCurrency;
  debitedMinor: number;
  creditedMinor: number;
  feeMinor: number;
  feeTransactionId: string | null;
  localDate: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AccountAdjustment {
  id: string;
  accountId: string;
  accountName: string;
  currency: AccountCurrency;
  targetBalanceMinor: number;
  deltaMinor: number;
  localDate: string;
  balanceBeforeMinor: number;
  note: string | null;
  createdAt: string;
  canUndo: boolean;
  updatedAt: string;
}

export interface AccountAdjustmentList {
  items: AccountAdjustment[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TransactionList {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DailyTransactionTotal {
  localDate: string;
  incomeMinor: number;
  expenseMinor: number;
  transactionCount: number;
}

export interface Proposal {
  id: string;
  action: ProposalAction;
  targetTransactionId: string | null;
  payload: Record<string, unknown>;
  reason: string | null;
  source: "openclaw" | "system";
  status: ProposalStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface PeriodRange {
  start: string;
  end: string;
  label: string;
}

export interface ComparisonValue {
  current: number;
  previous: number;
  delta: number;
  percent: number | null;
  state: "up" | "down" | "same" | "new";
}

export interface TrendPoint {
  key: string;
  label: string;
  amountMinor: number;
}

export interface CategoryMetric {
  categoryId: string;
  name: string;
  icon: string;
  color: string;
  amountMinor: number;
  percent: number;
  previousAmountMinor: number;
  deltaMinor: number;
  changePercent: number | null;
  changeState: "up" | "down" | "same" | "new";
}

export interface FinanceReport {
  grain: ReportGrain;
  anchor: string;
  kind: TransactionKind;
  range: PeriodRange;
  previousRange: PeriodRange;
  incomeMinor: number;
  expenseMinor: number;
  balanceMinor: number;
  selectedTotalMinor: number;
  selectedAverageMinor: number;
  averageDivisor: number;
  averageUnit: "day" | "month";
  selectedComparison: ComparisonValue;
  transactionCount: number;
  trend: TrendPoint[];
  categories: CategoryMetric[];
  generatedAt: string;
}

export interface MonthlyBudgetCategory {
  categoryId: string;
  name: string;
  icon: string;
  color: string;
  isArchived: boolean;
  budgetMinor: number;
  spentMinor: number;
  remainingMinor: number;
  progressPercent: number;
}

export interface MonthlyBudget {
  month: string;
  totalMinor: number | null;
  spentMinor: number;
  remainingMinor: number | null;
  forecastMinor: number;
  elapsedDays: number;
  daysInMonth: number;
  remainingDays: number;
  recommendedDailyMinor: number | null;
  categories: MonthlyBudgetCategory[];
  updatedAt: string | null;
}

export interface MonthlyBudgetInput {
  totalMinor: number | null;
  categories: Array<{ categoryId: string; amountMinor: number }>;
  expectedUpdatedAt?: string | null;
}

export type HealthIssueType =
  | "duplicate"
  | "openclaw_duplicate"
  | "future_date"
  | "large_expense"
  | "budget_warning"
  | "subscription_due"
  | "foreign_key"
  | "funds_negative"
  | "funds_missing_account"
  | "funds_mismatch"
  | "funds_orphan"
  | "subscription_funds";

export interface HealthIssue {
  fingerprint: string;
  type: HealthIssueType;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  relatedTransactionIds: string[];
  href: string | null;
  acknowledged: boolean;
}

export interface HealthReport {
  month: string;
  score: number;
  issueCount: number;
  acknowledgedCount: number;
  issues: HealthIssue[];
  dataHash: string;
  generatedAt: string;
}

export interface HealthExplanation {
  month: string;
  reportHash: string;
  overview: string;
  suggestions: string[];
  model: string;
}

export interface CategoryDispositionResult {
  action: "archive" | "restore" | "migrate" | "delete" | "purge";
  category?: Category;
  migratedTransactionCount: number;
  permanentlyDeletedTransactionCount?: number;
  detachedLedgerLinkCount?: number;
  rejectedProposalCount?: number;
  invalidatedOperationCount?: number;
}

export interface CategoryDeletionImpact {
  categoryId: string;
  categoryName: string;
  activeTransactionCount: number;
  trashedTransactionCount: number;
  linkedMatterCount: number;
  pendingProposalCount: number;
  revision: string;
}

export interface PermanentDeletionResult {
  entityType: "transaction" | "category";
  entityId: string;
  permanentlyDeletedTransactionCount: number;
  detachedLedgerLinkCount: number;
  rejectedProposalCount: number;
  invalidatedOperationCount: number;
}

export interface DashboardData {
  today: { incomeMinor: number; expenseMinor: number; balanceMinor: number };
  month: { incomeMinor: number; expenseMinor: number; balanceMinor: number };
  recent: Transaction[];
  pendingProposalCount: number;
}

export interface AiAnalysis {
  id: string;
  title: string;
  overview: string;
  highlights: Array<{ title: string; detail: string; tone: "positive" | "warning" | "neutral" }>;
  suggestions: string[];
  answer: string | null;
  periodStart: string;
  periodEnd: string;
  transactionCount: number;
  model: string;
  includeNotes: boolean;
  createdAt: string;
  isStale: boolean;
}

export interface SystemStatus {
  service: "ok";
  database: "ok" | "error";
  deepseek: "configured" | "missing";
  backup: {
    lastSuccessAt: string | null;
    remoteConfigured: boolean;
    local: BackupCheckStatus;
    remote: BackupCheckStatus;
    restoreVerification: BackupCheckStatus;
  };
  version: string;
}

export interface BackupCheckStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  state: "success" | "failed" | "stale" | "not_configured" | "never";
}

export interface OpenClawControlSettings {
  mode: OpenClawMode;
  directCapabilities: string[];
  credentialsExposed: false;
  updatedAt: string;
}

export interface OpenClawOperation {
  id: string;
  requestId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  status: OpenClawOperationStatus;
  undoable: boolean;
  summary: string;
  createdAt: string;
  expiresAt: string;
  undoneAt: string | null;
  failedAt: string | null;
}

export interface OpenClawOperationItem {
  sequence: number;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface OpenClawOperationDetail extends OpenClawOperation {
  result: unknown | null;
  items: OpenClawOperationItem[];
}

export interface OpenClawDirectResult<T = unknown> {
  operation: OpenClawOperation;
  result: T;
  duplicate: boolean;
}

export interface LedgerLink {
  mode: LedgerLinkMode;
  transactionId: string | null;
  amountMinor: number | null;
  accountAmountMinor: number | null;
  currency: MatterCurrency;
}

export interface Borrower {
  id: string;
  name: string;
  note: string | null;
  isArchived: boolean;
  totalLentMinor: number;
  totalRepaidMinor: number;
  outstandingMinor: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LoanRepayment {
  id: string;
  loanId: string;
  amountMinor: number;
  localDate: string;
  note: string | null;
  ledgerLink: LedgerLink;
  accountId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Loan {
  id: string;
  borrowerId: string;
  borrowerName?: string;
  principalMinor: number;
  /** Backward-compatible UI alias for principalMinor. */
  amountMinor: number;
  repaidMinor: number;
  outstandingMinor: number;
  localDate: string;
  /** Backward-compatible UI alias for localDate. */
  lentDate: string;
  purpose: string | null;
  note: string | null;
  status: "active" | "settled";
  ledgerLink: LedgerLink;
  accountId: string | null;
  repayments: LoanRepayment[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LoanSummary {
  totalLentMinor: number;
  totalRepaidMinor: number;
  outstandingMinor: number;
  borrowerCount: number;
  openLoanCount: number;
}

export interface SubscriptionPayment {
  id: string;
  subscriptionId: string;
  amountMinor: number;
  currency: MatterCurrency;
  localDate: string;
  /** Backward-compatible UI alias for localDate. */
  paidDate: string;
  note: string | null;
  paymentType: "initial" | "renewal" | "manual";
  ledgerLink: LedgerLink;
  actualCnyAmountMinor?: number | null;
  nextBillingDateBefore?: string | null;
  refundedAt: string | null;
  nextBillingDateAfter?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Subscription {
  id: string;
  name: string;
  plan: string | null;
  startDate: string;
  recurringAmountMinor: number;
  currency: MatterCurrency;
  cycle: SubscriptionCycle;
  customDays: number | null;
  nextBillingDate: string;
  /** UI aliases retained while the matters page migrates to canonical names. */
  nextRenewalDate: string;
  reminderDays: number;
  status: MatterStatus;
  website: string | null;
  url: string | null;
  note: string | null;
  lastPaymentDate: string | null;
  lastPayment: SubscriptionPayment | null;
  priceMinor: number;
  initialPriceMinor: number | null;
  cycleDays: number | null;
  renewalState: "active" | "upcoming" | "due" | "overdue" | "paused" | "cancelled";
  payments: SubscriptionPayment[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SubscriptionSummary {
  activeCount: number;
  attentionCount: number;
  dueCount: number;
  upcomingCount: number;
  upcoming: Subscription[];
  currencies: Array<{ currency: MatterCurrency; amountMinor: number }>;
}
