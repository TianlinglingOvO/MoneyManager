import { lazy, Suspense, useEffect, useMemo, useReducer, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { addMonths, addWeeks, addYears, format } from "date-fns";
import { ArrowDownRight, ArrowUpRight, CalendarDays, ChartLine, ChevronLeft, ChevronRight, Clock3, Minus, ReceiptText, ShieldCheck, Target, WalletCards } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ReportGrain, TransactionKind } from "@shared/types";
import { api } from "../api";
import { buildCategoryComposition, categoryCompositionPercent } from "../category-composition";
import { formatAccountBalance } from "../components/AccountPicker";
import { RecentRecordedList } from "../components/RecentRecordedList";
import { MoneyValue } from "../components/MoneyValue";
import { SegmentedControl } from "../components/SegmentedControl";
import { BudgetSheet } from "../components/BudgetSheet";
import { HealthSheet } from "../components/HealthSheet";
import { useEntry } from "../entry-context";
import { budgetProgress, budgetTone, hasConfiguredBudget } from "../finance-health";
import { useLedgerClock } from "../ledger-clock";
import { useReducedMotion, useResolvedChartMotionToken } from "../motion";
import { categoryDetailAriaLabel, comparisonHeadline, formatSameProgressWindow, previousAmountLabel } from "../insights-comparison";
import { money, percentLabel } from "../utils";

const FinanceCharts = lazy(() => import("../components/FinanceCharts"));

const grains: Array<{ value: Exclude<ReportGrain, "day">; label: string }> = [
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "year", label: "年" }
];

type InsightGrain = Exclude<ReportGrain, "day">;
const insightMotionSessionKey = "money-manager.insights-motion-seen";

function shouldPlayInitialMotion(): boolean {
  try {
    return sessionStorage.getItem(insightMotionSessionKey) !== "true";
  } catch {
    return true;
  }
}

function isLocalDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && format(date, "yyyy-MM-dd") === value;
}

function parseInsightState(searchParams: URLSearchParams, fallbackAnchor: string) {
  const rawGrain = searchParams.get("grain");
  const grain: InsightGrain = rawGrain === "week" || rawGrain === "year" ? rawGrain : "month";
  const rawKind = searchParams.get("kind");
  const kind: TransactionKind = rawKind === "income" ? "income" : "expense";
  return {
    grain,
    kind,
    anchor: isLocalDate(searchParams.get("anchor")) ? searchParams.get("anchor")! : fallbackAnchor
  };
}

export function InsightsPage() {
  const { today } = useLedgerClock();
  const { openEntry } = useEntry();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fallbackAnchor = today;
  const state = useMemo(() => parseInsightState(searchParams, fallbackAnchor), [searchParams, fallbackAnchor]);
  const { grain, kind, anchor } = state;
  const [breakdownView, setBreakdownView] = useState<"detail" | "composition">("detail");
  const [showAllCategories, setShowAllCategories] = useState(false);
  const reducedMotion = useReducedMotion();
  const [chartMotionRequest, requestChartMotion] = useReducer((value: number) => value + 1, shouldPlayInitialMotion() ? 1 : 0);
  const [breakdownMotionRequest, requestBreakdownMotion] = useReducer((value: number) => value + 1, 0);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    if (searchParams.get("grain") !== grain) { next.set("grain", grain); changed = true; }
    if (searchParams.get("anchor") !== anchor) { next.set("anchor", anchor); changed = true; }
    if (searchParams.get("kind") !== kind) { next.set("kind", kind); changed = true; }
    if (changed) setSearchParams(next, { replace: true });
  }, [anchor, grain, kind, searchParams, setSearchParams]);

  const updateState = (changes: Partial<typeof state>) => {
    const nextGrain = changes.grain ?? grain;
    const nextAnchor = changes.anchor ?? anchor;
    const nextKind = changes.kind ?? kind;
    if (nextGrain === grain && nextAnchor === anchor && nextKind === kind) return;
    const next = new URLSearchParams(searchParams);
    next.set("grain", nextGrain);
    next.set("anchor", nextAnchor);
    next.set("kind", nextKind);
    setSearchParams(next, { replace: true });
    requestChartMotion();
  };

  const reportQuery = useQuery({
    queryKey: ["report", grain, anchor, kind],
    queryFn: () => api.report(grain, anchor, kind),
    placeholderData: keepPreviousData
  });
  const recentQuery = useQuery({
    queryKey: ["transactions", "insights-recent"],
    queryFn: () => api.transactions({ sort: "recorded", deleted: "active", page: 1, pageSize: 6 })
  });
  const loanSummaryQuery = useQuery({ queryKey: ["matters", "loans", "summary"], queryFn: api.loanSummary, staleTime: 60_000 });
  const subscriptionSummaryQuery = useQuery({ queryKey: ["matters", "subscriptions", "summary"], queryFn: api.subscriptionSummary, staleTime: 60_000 });
  const planSummaryQuery = useQuery({ queryKey: ["matters", "plans", "summary"], queryFn: api.planSummary, staleTime: 60_000 });
  const fundsSummaryQuery = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary, staleTime: 30_000 });
  const report = reportQuery.data;
  const budgetMonth = report?.range.start.slice(0, 7) ?? anchor.slice(0, 7);
  const showPlanning = grain === "month" && kind === "expense";
  const budgetQuery = useQuery({
    queryKey: ["budget", budgetMonth],
    queryFn: () => api.budget(budgetMonth),
    enabled: showPlanning
  });
  const healthQuery = useQuery({
    queryKey: ["health", budgetMonth],
    queryFn: () => api.healthReport(budgetMonth),
    enabled: showPlanning
  });
  const expenseCategoriesQuery = useQuery({
    queryKey: ["categories", "expense", true],
    queryFn: () => api.categories("expense", true),
    enabled: budgetOpen
  });
  const averageLabel = report?.averageUnit === "month" ? "月均" : "日均";
  const visibleCategories = report && showAllCategories ? report.categories : report?.categories.slice(0, 5) ?? [];
  const compositionCategories = useMemo(() => buildCategoryComposition(report?.categories ?? []), [report?.categories]);
  const motionKey = `${grain}:${anchor}:${kind}`;
  const chartMotionToken = useResolvedChartMotionToken(chartMotionRequest, reportQuery.isPlaceholderData, Boolean(report));
  const pieMotionToken = chartMotionToken + breakdownMotionRequest;

  useEffect(() => {
    if (chartMotionToken <= 0) return;
    try { sessionStorage.setItem(insightMotionSessionKey, "true"); } catch { /* device storage may be unavailable */ }
  }, [chartMotionToken]);

  const move = (direction: -1 | 1) => {
    const date = new Date(`${anchor}T12:00:00`);
    const next = grain === "week" ? addWeeks(date, direction) : grain === "month" ? addMonths(date, direction) : addYears(date, direction);
    updateState({ anchor: format(next, "yyyy-MM-dd") });
  };
  const changeBreakdownView = (value: "detail" | "composition") => {
    if (value === breakdownView) return;
    setBreakdownView(value);
    setActiveCategoryId(null);
    if (value === "composition") requestBreakdownMotion();
  };
  const comparisonTone = report?.selectedComparison.state === "same" ? "neutral"
    : kind === "expense"
      ? report?.selectedComparison.state === "up" || report?.selectedComparison.state === "new" ? "warning" : "positive"
      : report?.selectedComparison.state === "up" || report?.selectedComparison.state === "new" ? "positive" : "warning";
  const ComparisonIcon = report?.selectedComparison.state === "up" || report?.selectedComparison.state === "new"
    ? ArrowUpRight : report?.selectedComparison.state === "down" ? ArrowDownRight : Minus;
  const ledgerPath = (categoryId?: string) => {
    const params = new URLSearchParams({
      view: "ledger",
      period: grain === "year" ? "year" : "month",
      anchor,
      kind,
      returnTo: `/?grain=${grain}&anchor=${anchor}&kind=${kind}`
    });
    if (categoryId) params.set("categoryId", categoryId);
    return `/bills?${params.toString()}`;
  };
  const planningBudget = budgetQuery.data;
  const planningProgress = budgetProgress(planningBudget?.totalMinor ?? null, planningBudget?.spentMinor ?? 0);
  const planningTone = budgetTone(planningBudget?.totalMinor ?? null, planningBudget?.spentMinor ?? 0);
  const activeHealthIssues = healthQuery.data?.issues.filter((issue) => !issue.acknowledged) ?? [];
  const criticalHealthIssues = activeHealthIssues.filter((issue) => issue.severity === "critical").length;
  const warningHealthIssues = activeHealthIssues.filter((issue) => issue.severity === "warning").length;
  const otherFunds = fundsSummaryQuery.data ? (["USD", "USDT"] as const)
    .filter((currency) => fundsSummaryQuery.data.currencyTotals[currency] !== 0)
    .map((currency) => formatAccountBalance(fundsSummaryQuery.data!.currencyTotals[currency], currency)) : [];
  const fundsCardDetail = otherFunds.length > 0 ? `另有 ${otherFunds.join(" · ")}`
    : `${fundsSummaryQuery.data?.accountCount ?? 0} 个可用账户 · 查看资金`;

  return (
    <div className={`page insights-page ${reportQuery.isFetching && report ? "is-refreshing" : ""}`}>
      <header className="page-heading page-heading--row insights-heading">
        <div><h1>{report?.range.label ?? "当前期间"}</h1></div>
        <div className="kind-pills kind-pills--large insight-kind-switch">
          <button className={kind === "expense" ? "is-active" : ""} onClick={() => updateState({ kind: "expense" })}>支出</button>
          <button className={kind === "income" ? "is-active" : ""} onClick={() => updateState({ kind: "income" })}>收入</button>
        </div>
      </header>

      <section className="analytics-toolbar content-card insights-toolbar">
        <div className="segment-control grain-control">
          {grains.map((item) => <button key={item.value} className={grain === item.value ? "is-active" : ""} onClick={() => updateState({ grain: item.value })}>{item.label}</button>)}
        </div>
        <div className="period-switcher">
          <button className="icon-button" onClick={() => move(-1)} aria-label="上一个期间"><ChevronLeft size={20} /></button>
          <label className="anchor-date"><input type="date" value={anchor} onChange={(event) => updateState({ anchor: event.target.value })} /><strong>{report?.range.label ?? "选择期间"}</strong></label>
          <button className="icon-button" onClick={() => move(1)} aria-label="下一个期间"><ChevronRight size={20} /></button>
        </div>
        {reportQuery.isFetching && report && <span className="insights-refresh-status" role="status">正在更新…</span>}
      </section>

      {reportQuery.isPending && !report ? <div className="skeleton chart-skeleton" /> : !report ? <div className="error-card">洞察暂时无法加载。</div> : (
        <>
          <section className="insight-summary" aria-label="期间摘要">
            <article className="insight-summary__primary"><span>{kind === "expense" ? "本期支出" : "本期收入"}</span><strong><MoneyValue amountMinor={report.selectedTotalMinor} animateKey={motionKey} /></strong><small>{report.range.label}</small></article>
            <div className="insight-summary__metrics">
              <article><span>{averageLabel}</span><strong><MoneyValue amountMinor={report.selectedAverageMinor} animateKey={motionKey} /></strong><small>按 {report.averageDivisor} 个{report.averageUnit === "month" ? "月" : "自然日"}计算</small></article>
              <article className={`is-${comparisonTone}`}><span>{comparisonHeadline(report.grain, report.isCurrentPeriod, report.previousRange.label)}</span><strong><ComparisonIcon size={19} />{percentLabel(report.selectedComparison.percent, report.selectedComparison.state)}</strong><small>{formatSameProgressWindow(report.previousRange.start, report.previousRange.end, report.grain === "year")} · {report.selectedComparison.delta >= 0 ? "+" : "−"}{money(Math.abs(report.selectedComparison.delta))}</small></article>
              <article><span>记录笔数</span><strong>{report.transactionCount}</strong><small>本期有效账目</small></article>
            </div>
          </section>

          {showPlanning && <section className="insight-planning-strip" aria-label="预算与账本体检">
            <button className={`insight-planning-card is-${planningTone}`} type="button" onClick={() => setBudgetOpen(true)}>
              <span className="insight-planning-card__icon"><Target size={19} /></span>
              <span className="insight-planning-card__body">
                <small>本月预算</small>
                {hasConfiguredBudget(planningBudget) ? <>
                  <strong>{planningBudget?.totalMinor == null
                    ? `${planningBudget?.categories.length ?? 0} 个分类预算`
                    : <>{money(planningBudget.spentMinor)} <em>/ {money(planningBudget.totalMinor)}</em></>}</strong>
                  {planningBudget?.totalMinor != null && <i aria-hidden="true"><b style={{ width: `${planningProgress ?? 0}%` }} /></i>}
                  <span>{planningBudget?.totalMinor == null
                    ? "按分类分别提醒"
                    : planningBudget.remainingMinor != null && planningBudget.remainingMinor < 0
                      ? `已超支 ${money(Math.abs(planningBudget.remainingMinor))}`
                      : `还可使用 ${money(planningBudget.remainingMinor ?? 0)}`}</span>
                </> : <><strong>设置本月预算</strong><span>只提醒，不限制记账</span></>}
              </span>
              <ChevronRight size={17} />
            </button>
            <button className={`insight-planning-card health-card ${(healthQuery.data?.issueCount ?? 0) > 0 ? "has-issues" : ""}`} type="button" onClick={() => setHealthOpen(true)}>
              <span className="insight-planning-card__icon"><ShieldCheck size={19} /></span>
              <span className="insight-planning-card__body">
                <small>账本体检</small>
                <strong>{healthQuery.isPending ? "正在检查…" : `${activeHealthIssues.length} 项待核对`}</strong>
                <span>{activeHealthIssues.length > 0 ? `${criticalHealthIssues > 0 ? `${criticalHealthIssues} 项需要处理` : "无严重问题"}${warningHealthIssues > 0 ? ` · ${warningHealthIssues} 项建议核对` : ""}` : `目前没有需要处理的项目 · 数据健康度 ${healthQuery.data?.score ?? 100} 分`}</span>
              </span>
              <ChevronRight size={17} />
            </button>
          </section>}

          {(fundsSummaryQuery.data || loanSummaryQuery.data || subscriptionSummaryQuery.data || planSummaryQuery.data) && <section className="insight-finance-grid" aria-label="财务事项摘要">
            {fundsSummaryQuery.data && <Link to="/funds" className="insight-matter-card insight-matter-card--funds">
              <span className="insight-matter-card__icon"><WalletCards size={18} /></span>
              <span><small>{fundsSummaryQuery.data.enabled ? "总资金" : "资金追踪"}</small><strong>{fundsSummaryQuery.data.enabled ? money(fundsSummaryQuery.data.totalMinor) : "尚未启用"}</strong><em>{fundsSummaryQuery.data.enabled ? fundsCardDetail : "填写现实余额后开始追踪"}</em></span>
              <ChevronRight size={17} />
            </Link>}
            {loanSummaryQuery.data && <Link to="/matters?tab=loans" className="insight-matter-card insight-matter-card--loan">
              <span className="insight-matter-card__icon"><WalletCards size={18} /></span>
              <span><small>待收款</small><strong>{money(loanSummaryQuery.data.outstandingMinor)}</strong><em>{loanSummaryQuery.data.borrowerCount} 位借款人 · 查看借款</em></span>
              <ChevronRight size={17} />
            </Link>}
            {subscriptionSummaryQuery.data && <Link to="/matters?tab=subscriptions" className="insight-matter-card insight-matter-card--subscription">
              <span className="insight-matter-card__icon"><Clock3 size={18} /></span>
              <span><small>近期续费</small><strong>{subscriptionSummaryQuery.data.attentionCount} 项</strong><em>{subscriptionSummaryQuery.data.upcoming.length} 项近期需要确认 · 查看订阅</em></span>
              <ChevronRight size={17} />
            </Link>}
            {planSummaryQuery.data && <Link to="/matters?tab=plans" className="insight-matter-card insight-matter-card--plan">
              <span className="insight-matter-card__icon"><CalendarDays size={18} /></span>
              <span><small>待办计划</small><strong>{planSummaryQuery.data.attentionCount > 0 ? `${planSummaryQuery.data.attentionCount} 项` : `${planSummaryQuery.data.openCount} 项`}</strong><em>{planSummaryQuery.data.openCount} 项未完成 · 查看计划</em></span>
              <ChevronRight size={17} />
            </Link>}
          </section>}

          <section className="content-card chart-card insights-trend-card">
            <div className="section-title section-title--row"><div><h2>{kind === "expense" ? "支出" : "收入"}趋势</h2></div><span className="chart-legend"><i className={`is-${kind}`} />{averageLabel} {money(report.selectedAverageMinor)}</span></div>
            {report.selectedTotalMinor === 0 ? <div className="empty-chart"><ChartLine size={36} /><strong>这个期间还没有{kind === "expense" ? "支出" : "收入"}</strong></div> : (
              <Suspense fallback={<div className="trend-chart chart-loading" role="status">图表加载中…</div>}>
                <FinanceCharts trend={report.trend} categories={report.categories} kind={kind} averageMinor={report.selectedAverageMinor} averageLabel={averageLabel} animationToken={chartMotionToken} motionEnabled={!reducedMotion} variant="trend" />
              </Suspense>
            )}
          </section>

          <section className="ledger-section category-breakdown-card">
            <div className="section-title section-title--row"><h2>{breakdownView === "detail" ? "分类明细" : "分类构成"}</h2><SegmentedControl value={breakdownView} label="分类展示方式" className="breakdown-switch" options={[{ value: "detail", label: "明细" }, { value: "composition", label: "构成" }]} onChange={changeBreakdownView} /></div>
            <div className="breakdown-panel" key={breakdownView} aria-label={breakdownView === "detail" ? "分类明细" : "分类构成"}>
              {breakdownView === "detail" ? (
                <>
                  <div className="ranking-list">
                    {report.categories.length === 0 && <p className="muted-copy">暂无分类数据</p>}
                    {visibleCategories.map((category, index) => (
                      <Link className="ranking-row" key={category.categoryId} to={ledgerPath(category.categoryId)} aria-label={categoryDetailAriaLabel(category.name, category.amountMinor, category.previousAmountMinor, category.changePercent, category.changeState)}>
                        <span className="ranking-row__number">{String(index + 1).padStart(2, "0")}</span>
                        <span className="ranking-row__icon" style={{ background: `${category.color}18` }}>{category.icon}</span>
                        <div className="ranking-row__body"><strong>{category.name}</strong><small>{previousAmountLabel(category.previousAmountMinor, category.changeState)}</small></div>
                        <div className="ranking-row__value"><strong>{money(category.amountMinor)}</strong><small className={`is-${category.changeState}`}>{percentLabel(category.changePercent, category.changeState)}</small></div>
                      </Link>
                    ))}
                  </div>
                  {report.categories.length > 5 && <button className="text-button ranking-expand" onClick={() => setShowAllCategories((value) => !value)}>{showAllCategories ? "收起分类" : `展开全部（${report.categories.length}）`}</button>}
                </>
              ) : compositionCategories.length === 0 ? <div className="empty-chart"><strong>暂无构成数据</strong></div> : (
                <div className="category-composition">
                  <Suspense fallback={<div className="pie-chart chart-loading" role="status">图表加载中…</div>}>
                    <FinanceCharts trend={report.trend} categories={report.categories} kind={kind} averageMinor={report.selectedAverageMinor} averageLabel={averageLabel} animationToken={pieMotionToken} motionEnabled={!reducedMotion} activeCategoryId={activeCategoryId} onCategoryHighlight={setActiveCategoryId} variant="pie" onCategorySelect={(categoryId) => navigate(ledgerPath(categoryId))} />
                  </Suspense>
                  <div className="pie-legend">{compositionCategories.map((item) => {
                    const content = <><span><i style={{ background: item.color }} />{item.name}</span><strong>{money(item.amountMinor)}</strong><b>{categoryCompositionPercent(item.percent)}</b></>;
                    return <Link className={`pie-legend__item ${activeCategoryId === item.categoryId ? "is-active" : ""} ${activeCategoryId && activeCategoryId !== item.categoryId ? "is-dimmed" : ""}`.trim()} key={item.categoryId} to={ledgerPath(item.categoryId)} aria-label={`查看${item.name}分类账单`} onMouseEnter={() => setActiveCategoryId(item.categoryId)} onMouseLeave={() => setActiveCategoryId(null)} onFocus={() => setActiveCategoryId(item.categoryId)} onBlur={() => setActiveCategoryId(null)} onPointerDown={() => setActiveCategoryId(item.categoryId)} onPointerCancel={() => setActiveCategoryId(null)}>{content}</Link>;
                  })}</div>
                </div>
              )}
            </div>
          </section>

          <section className="ledger-section insights-recent-card">
            <div className="section-title section-title--row"><div><h2>最近录入</h2></div><ReceiptText size={22} /></div>
            <RecentRecordedList items={recentQuery.data?.items ?? []} onEdit={openEntry} />
          </section>
          <BudgetSheet
            open={budgetOpen}
            month={budgetMonth}
            budget={planningBudget}
            categories={expenseCategoriesQuery.data ?? []}
            onClose={() => setBudgetOpen(false)}
          />
          <HealthSheet
            open={healthOpen}
            month={budgetMonth}
            report={healthQuery.data}
            isLoading={healthQuery.isPending}
            isError={healthQuery.isError}
            onClose={() => setHealthOpen(false)}
            onOpenBudget={() => setBudgetOpen(true)}
          />
        </>
      )}
    </div>
  );
}
