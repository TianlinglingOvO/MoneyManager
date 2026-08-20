import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addMonths, addYears, format } from "date-fns";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Plus, Search } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import type { Transaction, TransactionKind } from "@shared/types";
import { api } from "../api";
import { BottomSheet } from "../components/BottomSheet";
import { DangerConfirmDialog } from "../components/DangerConfirmDialog";
import { FilterSummary } from "../components/FilterSummary";
import { RecentRecordedList } from "../components/RecentRecordedList";
import { TransactionList } from "../components/TransactionList";
import { useEntry } from "../entry-context";
import { useLedgerClock } from "../ledger-clock";
import { money, monthRange, yearRange } from "../utils";

type LedgerPeriod = "month" | "year";
type BillMode = "recent" | "ledger" | "trash";

const billsSessionKey = "money-manager.bills-session";

interface BillsSessionState {
  search?: string;
  scrollY?: number;
}

function readBillsSession(): BillsSessionState {
  if (typeof sessionStorage === "undefined") return {};
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(billsSessionKey) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const state = value as Record<string, unknown>;
    return {
      search: typeof state.search === "string" ? state.search : undefined,
      scrollY: typeof state.scrollY === "number" && Number.isFinite(state.scrollY) ? state.scrollY : undefined
    };
  } catch {
    return {};
  }
}

function isLocalDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && format(date, "yyyy-MM-dd") === value;
}

function getInitialBillState(searchParams: URLSearchParams, today: string) {
  const session = readBillsSession();
  const mode: BillMode = searchParams.get("view") === "trash" ? "trash" : searchParams.get("view") === "ledger" ? "ledger" : "recent";
  const period: LedgerPeriod = searchParams.get("period") === "year" ? "year" : "month";
  const rawKind = searchParams.get("kind");
  const kind: "all" | TransactionKind = rawKind === "expense" ? "expense" : rawKind === "income" ? "income" : "all";
  return {
    mode,
    period,
    anchor: isLocalDate(searchParams.get("anchor")) ? searchParams.get("anchor")! : today,
    kind,
    categoryId: searchParams.get("categoryId") ?? "",
    search: session.search ?? "",
    scrollY: session.scrollY ?? 0,
    focusSearch: searchParams.get("focus") === "search",
    returnTo: searchParams.get("returnTo")?.startsWith("/?") ? searchParams.get("returnTo") : null
  };
}

export function BillsPage() {
  const { today } = useLedgerClock();
  const { openEntry } = useEntry();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialState = useMemo(() => getInitialBillState(searchParams, today), [searchParams, today]);
  const [mode, setMode] = useState<BillMode>(initialState.mode);
  const [period, setPeriod] = useState<LedgerPeriod>(initialState.period);
  const [anchor, setAnchor] = useState(initialState.anchor);
  const [kind, setKind] = useState<"all" | TransactionKind>(initialState.kind);
  const [categoryId, setCategoryId] = useState(initialState.categoryId);
  const [search, setSearch] = useState(initialState.search);
  const [debouncedSearch, setDebouncedSearch] = useState(initialState.search);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [permanentlyDeleting, setPermanentlyDeleting] = useState<Transaction>();
  const returnTo = useRef(initialState.returnTo);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (mode === "ledger" || mode === "trash") {
      next.set("view", mode);
    }
    if (mode === "ledger") {
      next.set("period", period);
      next.set("anchor", anchor);
    }
    if (mode !== "recent" && kind !== "all") next.set("kind", kind);
    if (mode !== "recent" && categoryId) next.set("categoryId", categoryId);
    if (returnTo.current) next.set("returnTo", returnTo.current);
    setSearchParams(next, { replace: true });
  }, [mode, period, anchor, kind, categoryId, setSearchParams]);

  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem(billsSessionKey, JSON.stringify({ search, scrollY: window.scrollY } satisfies BillsSessionState));
    } catch {
      // Session storage can be unavailable in private browsing; the ledger still works.
    }
  }, [search]);

  useEffect(() => {
    const scrollContainer = document.querySelector<HTMLElement>(".main-column");
    const currentScrollTop = () => scrollContainer?.scrollTop ?? window.scrollY;
    const restore = window.requestAnimationFrame(() => {
      if (initialState.scrollY <= 0) return;
      if (scrollContainer) scrollContainer.scrollTo({ top: initialState.scrollY, behavior: "auto" });
      else window.scrollTo({ top: initialState.scrollY, behavior: "auto" });
    });
    const saveScroll = () => {
      try {
        const current = readBillsSession();
        sessionStorage.setItem(billsSessionKey, JSON.stringify({ ...current, search, scrollY: currentScrollTop() } satisfies BillsSessionState));
      } catch {
        // Ignore unavailable session storage.
      }
    };
    const scrollTarget: Window | HTMLElement = scrollContainer ?? window;
    scrollTarget.addEventListener("scroll", saveScroll, { passive: true });
    return () => {
      window.cancelAnimationFrame(restore);
      scrollTarget.removeEventListener("scroll", saveScroll);
    };
  }, [initialState.scrollY, search]);

  useEffect(() => {
    if (!initialState.focusSearch) return;
    const frame = window.requestAnimationFrame(() => searchInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialState.focusSearch]);

  const range = useMemo(() => period === "month" ? monthRange(anchor) : yearRange(anchor), [period, anchor]);
  const report = useQuery({
    queryKey: ["report", period, anchor, "expense", "bills"],
    queryFn: () => api.report(period, anchor, "expense"),
    enabled: mode === "ledger"
  });
  const categories = useQuery({ queryKey: ["categories", "all", true], queryFn: () => api.categories(undefined, true) });
  useEffect(() => {
    if (!categoryId || !categories.data) return;
    const category = categories.data.find((item) => item.id === categoryId);
    if (!category || (kind !== "all" && category.kind !== kind)) setCategoryId("");
  }, [categories.data, categoryId, kind]);
  const ledgerFilters = useMemo(() => ({
    start: range.start,
    end: range.end,
    kind: kind === "all" ? undefined : kind,
    categoryId: categoryId || undefined,
    search: debouncedSearch || undefined
  }), [range.start, range.end, kind, categoryId, debouncedSearch]);
  const transactionFilters = useMemo(() => mode === "trash" ? {
    kind: kind === "all" ? undefined : kind,
    categoryId: categoryId || undefined,
    search: debouncedSearch || undefined
  } : ledgerFilters, [mode, kind, categoryId, debouncedSearch, ledgerFilters]);
  const transactions = useInfiniteQuery({
    queryKey: ["transactions", "bills", mode, range, kind, categoryId, debouncedSearch],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.transactions({
      ...(mode === "recent" ? {} : transactionFilters),
      sort: mode === "recent" ? "recorded" : mode === "trash" ? "deleted" : "date",
      deleted: mode === "trash" ? "trash" : "active",
      page: pageParam,
      pageSize: mode === "recent" ? 30 : 100
    }),
    getNextPageParam: (lastPage) => lastPage.page * lastPage.pageSize < lastPage.total ? lastPage.page + 1 : undefined,
    placeholderData: keepPreviousData
  });
  const dailyTotals = useQuery({
    queryKey: ["daily-totals", ledgerFilters],
    queryFn: () => api.dailyTotals(ledgerFilters),
    enabled: mode === "ledger"
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreTransaction(id),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const permanentDelete = useMutation({
    mutationFn: (transaction: Transaction) => api.permanentlyDeleteTransaction(transaction.id, transaction.updatedAt),
    onSuccess: async () => {
      setPermanentlyDeleting(undefined);
      await queryClient.invalidateQueries();
    }
  });

  const movePeriod = (direction: -1 | 1) => {
    const value = new Date(`${anchor}T12:00:00`);
    const next = period === "month" ? addMonths(value, direction) : addYears(value, direction);
    setAnchor(format(next, "yyyy-MM-dd"));
  };
  const periodLabel = period === "month"
    ? format(new Date(`${anchor}T12:00:00`), "yyyy年 M月")
    : format(new Date(`${anchor}T12:00:00`), "yyyy年");
  const selectedCategories = categories.data?.filter((item) => kind === "all" || item.kind === kind) ?? [];
  const transactionItems = transactions.data?.pages.flatMap((page) => page.items) ?? [];
  const transactionTotal = transactions.data?.pages[0]?.total ?? 0;
  const summary = useMemo(() => {
    if (kind === "all" && !categoryId && !debouncedSearch) {
      return {
        incomeMinor: report.data?.incomeMinor ?? 0,
        expenseMinor: report.data?.expenseMinor ?? 0,
        balanceMinor: report.data?.balanceMinor ?? 0
      };
    }
    const totals = (dailyTotals.data ?? []).reduce((result, item) => ({
      incomeMinor: result.incomeMinor + item.incomeMinor,
      expenseMinor: result.expenseMinor + item.expenseMinor,
      balanceMinor: result.balanceMinor + item.incomeMinor - item.expenseMinor
    }), { incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 });
    return totals;
  }, [kind, categoryId, debouncedSearch, report.data, dailyTotals.data]);

  const activeFilterCount = (kind !== "all" ? 1 : 0) + (categoryId ? 1 : 0);
  const exportActions = (
    <div className="export-actions" aria-label="导出全部账本">
      <a className="secondary-button" href="/api/v1/export.csv"><Download size={16} />导出全部账本 CSV</a>
      <a className="secondary-button" href="/api/v1/export.json"><Download size={16} />导出全部账本 JSON</a>
    </div>
  );
  const filterControls = (
    <>
      <div className="kind-pills" role="group" aria-label="收支筛选">
        {(["all", "expense", "income"] as const).map((value) => (
          <button type="button" key={value} className={kind === value ? "is-active" : ""} aria-pressed={kind === value} onClick={() => { setKind(value); setCategoryId(""); }}>
            {value === "all" ? "全部" : value === "expense" ? "支出" : "收入"}
          </button>
        ))}
      </div>
      <label className="filter-category-field">
        <span className="sr-only">筛选分类</span>
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="筛选分类">
          <option value="">全部分类</option>
          {selectedCategories.map((category) => <option value={category.id} key={category.id}>{category.icon} {category.name}{category.isArchived ? "（已停用）" : ""}</option>)}
        </select>
      </label>
    </>
  );

  return (
    <div className="page bills-page">
      <header className="page-heading page-heading--row">
        <div>{returnTo.current && <Link className="bills-return-link" to={returnTo.current}><ArrowLeft size={15} />返回洞察</Link>}<h1>账单</h1><p>查看最近录入，或按月份和年份核对完整流水。</p></div>
        <button className="primary-button desktop-only" onClick={() => openEntry()}><Plus size={18} />记一笔</button>
      </header>

      <div className="view-tabs view-tabs--four" role="tablist" aria-label="账单视图" data-active={mode === "recent" ? "recent" : mode === "trash" ? "trash" : period}>
        <button id="bills-tab-recent" role="tab" aria-selected={mode === "recent"} aria-controls="bills-panel-recent" className={mode === "recent" ? "is-active" : ""} onClick={() => setMode("recent")}>最近录入</button>
        <button id="bills-tab-month" role="tab" aria-selected={mode === "ledger" && period === "month"} aria-controls="bills-panel-month" className={mode === "ledger" && period === "month" ? "is-active" : ""} onClick={() => { setPeriod("month"); setMode("ledger"); }}>月账单</button>
        <button id="bills-tab-year" role="tab" aria-selected={mode === "ledger" && period === "year"} aria-controls="bills-panel-year" className={mode === "ledger" && period === "year" ? "is-active" : ""} onClick={() => { setPeriod("year"); setMode("ledger"); }}>年账单</button>
        <button id="bills-tab-trash" role="tab" aria-selected={mode === "trash"} aria-controls="bills-panel-trash" className={mode === "trash" ? "is-active" : ""} onClick={() => setMode("trash")}>回收站</button>
      </div>

      {mode === "recent" ? (
        <section id="bills-panel-recent" className="content-card recent-ledger-card bill-view-panel" role="tabpanel" aria-labelledby="bills-tab-recent">
          <div className="section-title"><h2>最近录入</h2><p>录入日期和消费发生日期会分别显示，方便核对 OpenClaw 最近的操作。</p></div>
          <div className="list-summary"><span>已显示 {transactionItems.length} / {transactionTotal} 笔</span></div>
          {transactions.isLoading ? <div className="skeleton list-skeleton" /> : <RecentRecordedList items={transactionItems} onEdit={openEntry} />}
          {transactions.hasNextPage && <button className="secondary-button load-more-button" disabled={transactions.isFetchingNextPage} onClick={() => transactions.fetchNextPage()}>{transactions.isFetchingNextPage ? "正在加载…" : `加载更多（还剩 ${transactionTotal - transactionItems.length} 笔）`}</button>}
        </section>
      ) : (
        <div id={`bills-panel-${mode === "trash" ? "trash" : period}`} className={`bill-view-panel ${mode === "trash" ? "bill-view-panel--trash" : "bill-view-panel--ledger"}`} role="tabpanel" aria-labelledby={`bills-tab-${mode === "trash" ? "trash" : period}`} key={mode === "trash" ? "trash" : period}>
          {mode === "ledger" && <><section className="bill-toolbar bill-toolbar--period content-card">
            <div className="period-switcher">
              <button className="icon-button" onClick={() => movePeriod(-1)} aria-label="上一个期间"><ChevronLeft size={20} /></button>
              <strong>{periodLabel}</strong>
              <button className="icon-button" onClick={() => movePeriod(1)} aria-label="下一个期间"><ChevronRight size={20} /></button>
            </div>
            <div className="desktop-only">{exportActions}</div>
          </section>

          <div className="summary-strip">
            <div><span>收入</span><strong className="income-text">{money(summary.incomeMinor)}</strong></div>
            <div><span>支出</span><strong className="expense-text">{money(summary.expenseMinor)}</strong></div>
            <div className="summary-strip__balance"><span>结余</span><strong>{money(summary.balanceMinor)}</strong></div>
          </div></>}

          {mode === "trash" && <div className="trash-intro"><div><h2>回收站</h2><p>集中显示最近 30 天删除的账目，不受原账单月份限制。</p></div><strong>{transactionTotal} 笔</strong></div>}

          <section className="content-card bill-list-card">
            <div className="filter-row">
              <label className="search-field"><Search size={17} /><input ref={searchInput} data-global-search value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索备注" /></label>
              <div className="desktop-only desktop-filter-controls">{filterControls}</div>
              <span className="mobile-only"><FilterSummary count={activeFilterCount} onClick={() => setFiltersOpen(true)} /></span>
            </div>

            <div className="list-summary"><span>{mode === "trash" ? `已显示 ${transactionItems.length} / ${transactionTotal} 笔 · 删除满 30 天后自动清理` : `已显示 ${transactionItems.length} / ${transactionTotal} 笔`}</span>{transactions.isFetching && !transactions.isLoading && <em role="status">正在更新…</em>}{restore.isError && <em>恢复失败，请稍后重试</em>}</div>
            {transactions.isLoading ? <div className="skeleton list-skeleton" /> : (
              <>
                <TransactionList
                  items={transactionItems}
                  dailyTotals={mode === "trash" ? [] : dailyTotals.data}
                  onEdit={mode === "ledger" ? openEntry : undefined}
                  onRestore={mode === "trash" ? (transaction) => restore.mutate(transaction.id) : undefined}
                  onPermanentDelete={mode === "trash" ? setPermanentlyDeleting : undefined}
                  emptyText={mode === "trash" ? "回收站是空的" : "这个期间还没有账目"}
                />
                {transactions.hasNextPage && <button className="secondary-button load-more-button" disabled={transactions.isFetchingNextPage} onClick={() => transactions.fetchNextPage()}>{transactions.isFetchingNextPage ? "正在加载…" : `加载更多（还剩 ${transactionTotal - transactionItems.length} 笔）`}</button>}
              </>
            )}
          </section>
          <BottomSheet open={filtersOpen} title="账单筛选" onClose={() => setFiltersOpen(false)} className="bills-filter-sheet">
            <div className="bottom-sheet__content filter-sheet-content">
              {filterControls}
              {mode === "ledger" && <div className="filter-sheet__export">{exportActions}</div>}
              <button type="button" className="primary-button filter-sheet__done" onClick={() => setFiltersOpen(false)}>完成筛选</button>
            </div>
          </BottomSheet>
        </div>
      )}
      {permanentlyDeleting && <DangerConfirmDialog
        title="永久删除这笔账？"
        description="删除后无法从回收站恢复。若它关联了借款或订阅，事项会保留，但账本关联会解除。"
        details={<><strong>{permanentlyDeleting.category?.icon} {permanentlyDeleting.category?.name}</strong><span>{money(permanentlyDeleting.amountMinor)} · 发生于 {permanentlyDeleting.localDate}</span></>}
        confirmLabel="永久删除"
        isPending={permanentDelete.isPending}
        error={permanentDelete.isError ? (permanentDelete.error instanceof Error ? permanentDelete.error.message : "永久删除失败") : null}
        onConfirm={() => permanentDelete.mutate(permanentlyDeleting)}
        onClose={() => { if (!permanentDelete.isPending) setPermanentlyDeleting(undefined); }}
      />}
    </div>
  );
}
