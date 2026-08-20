import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Archive,
  ArchiveRestore,
  ArrowDownLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  WalletCards,
  X
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import type { Borrower, Category, LedgerLinkMode, Loan, LoanRepayment, MatterCurrency, Subscription, SubscriptionPayment, Transaction } from "@shared/types";
import { api } from "../api";
import { BottomSheet } from "../components/BottomSheet";
import { SegmentedControl } from "../components/SegmentedControl";
import { useLedgerClock } from "../ledger-clock";
import { money, parseAmountMinor } from "../utils";

type MatterTab = "loans" | "subscriptions";

function listOf<T>(value: T[] | { items?: T[] } | undefined): T[] {
  return Array.isArray(value) ? value : value?.items ?? [];
}

function amountText(amountMinor: number, currency: MatterCurrency): string {
  return new Intl.NumberFormat(currency === "CNY" ? "zh-CN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amountMinor / 100);
}

function dateLabel(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : format(date, "yyyy年M月d日");
}

function daysUntil(value: string, today: string): number {
  const start = new Date(`${today}T12:00:00`).getTime();
  const end = new Date(`${value}T12:00:00`).getTime();
  return Math.round((end - start) / 86_400_000);
}

function subscriptionDateHint(subscription: Subscription, today: string): string {
  const renewalDate = subscription.nextBillingDate ?? today;
  const days = daysUntil(renewalDate, today);
  if (subscription.status === "cancelled") return "已取消";
  if (subscription.status === "paused") return "已暂停";
  if (days < 0 || subscription.renewalState === "overdue") return `已到期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天续费";
  if (days <= subscription.reminderDays) return `${days} 天后续费`;
  return `${dateLabel(renewalDate)} 续费`;
}

function defaultDate(today: string): string { return today; }

interface LedgerLinkFieldsProps {
  mode: LedgerLinkMode;
  setMode: (mode: LedgerLinkMode) => void;
  kind: "expense" | "income";
  setKind: (kind: "expense" | "income") => void;
  amount: string;
  setAmount: (value: string) => void;
  categoryId: string;
  setCategoryId: (value: string) => void;
  date: string;
  setDate: (value: string) => void;
  transactions: Transaction[];
  categories: Category[];
  currency?: MatterCurrency;
}

function LedgerLinkFields({ mode, setMode, kind, setKind, amount, setAmount, categoryId, setCategoryId, date, setDate, transactions, categories, currency = "CNY" }: LedgerLinkFieldsProps) {
  return (
    <div className="matter-ledger-link">
      <div className="matter-form-label"><span>关联普通账目</span><small>默认不计入账单</small></div>
      <SegmentedControl
        value={mode}
        label="账目关联方式"
        options={[{ value: "none", label: "不关联" }, { value: "existing", label: "已有账目" }, { value: "create", label: "同时创建" }]}
        onChange={setMode}
      />
      {mode === "existing" && (
        <label className="matter-field"><span>选择账目</span><select value={amount} onChange={(event) => setAmount(event.target.value)}>
          <option value="">请选择一笔{kind === "expense" ? "支出" : "收入"}</option>
          {transactions.filter((item) => item.kind === kind).map((item) => <option key={item.id} value={item.id}>{dateLabel(item.localDate)} · {item.category?.name ?? "未分类"} · {item.kind === "expense" ? "−" : "+"}{money(item.amountMinor)}</option>)}
        </select></label>
      )}
      {mode === "create" && (
        <div className="matter-link-create-fields">
          {currency === "USD" && <label className="matter-field"><span>实际扣款人民币 <small>必填</small></span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label>}
          {currency !== "USD" && <label className="matter-field"><span>账目金额</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label>}
          <div className="matter-link-kind"><button type="button" className={kind === "expense" ? "is-active" : ""} onClick={() => setKind("expense")}>支出</button><button type="button" className={kind === "income" ? "is-active" : ""} onClick={() => setKind("income")}>收入</button></div>
          <label className="matter-field"><span>分类</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">选择分类</option>{categories.filter((item) => item.kind === kind && !item.isArchived).map((item) => <option key={item.id} value={item.id}>{item.icon} {item.name}</option>)}</select></label>
          <label className="matter-field"><span>发生日期</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        </div>
      )}
    </div>
  );
}

function LoanForm({ open, onClose, borrowers, editing, today }: { open: boolean; onClose: () => void; borrowers: Borrower[]; editing?: Loan; today: string }) {
  const queryClient = useQueryClient();
  const [borrowerId, setBorrowerId] = useState(editing?.borrowerId ?? borrowers[0]?.id ?? "");
  const [newBorrower, setNewBorrower] = useState("");
  const [amount, setAmount] = useState(editing ? (editing.amountMinor / 100).toFixed(2) : "");
  const [lentDate, setLentDate] = useState(editing?.localDate ?? defaultDate(today));
  const [purpose, setPurpose] = useState(editing?.purpose ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [linkMode, setLinkMode] = useState<LedgerLinkMode>("none");
  const [linkKind, setLinkKind] = useState<"expense" | "income">("expense");
  const [linkAmount, setLinkAmount] = useState("");
  const [linkCategory, setLinkCategory] = useState("");
  const [linkDate, setLinkDate] = useState(lentDate);
  const [error, setError] = useState("");
  const categories = useQuery({ queryKey: ["categories", "all", false], queryFn: () => api.categories(undefined, false) });
  const transactions = useQuery({ queryKey: ["transactions", "matter-link"], queryFn: () => api.transactions({ page: 1, pageSize: 50, deleted: "active", sort: "date" }) });
  const save = useMutation({
    mutationFn: async () => {
      setError("");
      const amountMinor = parseAmountMinor(amount);
      if (!borrowerId && !newBorrower.trim()) throw new Error("请选择或填写借款人");
      if (!amountMinor) throw new Error("请输入有效借款金额");
      let targetBorrowerId = borrowerId;
      if (!targetBorrowerId) targetBorrowerId = (await api.createBorrower({ name: newBorrower.trim() })).id;
      const ledgerLink = linkMode === "none" ? undefined : linkMode === "existing" ? { mode: "existing", transactionId: linkAmount } : { mode: "create", ledgerAmountMinor: parseAmountMinor(linkAmount) ?? amountMinor, categoryId: linkCategory };
      const input = { borrowerId: targetBorrowerId, principalMinor: amountMinor, localDate: lentDate, purpose: purpose.trim() || null, note: note.trim() || null, ledgerLink };
      if (editing) return api.updateLoan(editing.id, {
        principalMinor: amountMinor,
        localDate: lentDate,
        purpose: purpose.trim() || null,
        note: note.trim() || null,
        expectedUpdatedAt: editing.updatedAt
      });
      return api.createLoan(input);
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); await queryClient.invalidateQueries({ queryKey: ["loan"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open={open} title={editing ? "编辑借款" : "记录一笔借款"} onClose={onClose} className="matter-sheet">
    <form className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">记录别人从你这里借走的钱，之后可以在对应借款下分次登记还款。</p>
      <label className="matter-field"><span>借款人</span><select value={borrowerId} disabled={Boolean(editing)} onChange={(event) => { setBorrowerId(event.target.value); setNewBorrower(""); }}><option value="">选择已有借款人</option>{borrowers.filter((item) => !item.isArchived).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {!editing && <div className="matter-inline-new"><span>或</span><input value={newBorrower} onChange={(event) => { setNewBorrower(event.target.value); setBorrowerId(""); }} placeholder="填写新的借款人" /></div>}
      <div className="matter-form-grid"><label className="matter-field"><span>借出金额（人民币）</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="300.00" /></label><label className="matter-field"><span>借出日期</span><input required type="date" value={lentDate} onChange={(event) => { setLentDate(event.target.value); setLinkDate(event.target.value); }} /></label></div>
      <label className="matter-field"><span>用途</span><input maxLength={120} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="例如：生活费、给女朋友买花" /></label>
      <label className="matter-field"><span>备注 <small>选填</small></span><textarea maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} placeholder="可以补充约定或说明" /></label>
      {!editing && <LedgerLinkFields mode={linkMode} setMode={setLinkMode} kind={linkKind} setKind={setLinkKind} amount={linkAmount} setAmount={setLinkAmount} categoryId={linkCategory} setCategoryId={setLinkCategory} date={linkDate} setDate={setLinkDate} transactions={transactions.data?.items ?? []} categories={categories.data ?? []} />}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button matter-submit" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{editing ? "保存修改" : "保存借款"}</button>
    </form>
  </BottomSheet>;
}

function RepaymentForm({ open, onClose, loan, today }: { open: boolean; onClose: () => void; loan?: Loan; today: string }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [repaidDate, setRepaidDate] = useState(today);
  const [note, setNote] = useState("");
  const [linkMode, setLinkMode] = useState<LedgerLinkMode>("none");
  const [linkAmount, setLinkAmount] = useState("");
  const [linkCategory, setLinkCategory] = useState("");
  const [error, setError] = useState("");
  const categories = useQuery({ queryKey: ["categories", "income", false], queryFn: () => api.categories("income", false) });
  const save = useMutation({
    mutationFn: async () => {
      if (!loan) throw new Error("没有选择借款");
      const amountMinor = parseAmountMinor(amount);
      if (!amountMinor || amountMinor > loan.outstandingMinor) throw new Error("还款金额不能超过未还余额");
      const ledgerLink = linkMode === "none" ? undefined : linkMode === "existing" ? { mode: "existing", transactionId: linkAmount } : { mode: "create", ledgerAmountMinor: amountMinor, categoryId: linkCategory };
      return api.createLoanRepayment(loan.id, { amountMinor, localDate: repaidDate, note: note.trim() || null, ledgerLink });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); await queryClient.invalidateQueries({ queryKey: ["loan", loan?.id] }); setAmount(""); setNote(""); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  const transactions = useQuery({ queryKey: ["transactions", "matter-link-income"], queryFn: () => api.transactions({ page: 1, pageSize: 50, deleted: "active", sort: "date", kind: "income" }) });
  return <BottomSheet open={open} title="记录还款" onClose={onClose} className="matter-sheet">
    <form className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">{loan?.borrowerName ?? "这笔借款"} · 未还 {money(loan?.outstandingMinor ?? 0)}</p>
      <div className="matter-form-grid"><label className="matter-field"><span>还款金额（人民币）</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label><label className="matter-field"><span>还款日期</span><input required type="date" value={repaidDate} onChange={(event) => setRepaidDate(event.target.value)} /></label></div>
      <label className="matter-field"><span>备注 <small>选填</small></span><input maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：微信转账" /></label>
      <LedgerLinkFields mode={linkMode} setMode={setLinkMode} kind="income" setKind={() => undefined} amount={linkAmount} setAmount={setLinkAmount} categoryId={linkCategory} setCategoryId={setLinkCategory} date={repaidDate} setDate={setRepaidDate} transactions={transactions.data?.items ?? []} categories={categories.data ?? []} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button matter-submit" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}保存还款</button>
    </form>
  </BottomSheet>;
}

function LoanRepaymentHistory({ loan }: { loan: Loan }) {
  const queryClient = useQueryClient();
  const [showTrash, setShowTrash] = useState(false);
  const active = loan.repayments;
  const trashQuery = useQuery({
    queryKey: ["matters", "loan-repayments", loan.id, "trash"],
    queryFn: () => api.loanRepayments(loan.id, "trash"),
    enabled: showTrash
  });
  const remove = useMutation({
    mutationFn: (repayment: LoanRepayment) => api.deleteLoanRepayment(loan.id, repayment.id, repayment.updatedAt),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); }
  });
  const restore = useMutation({
    mutationFn: (repayment: LoanRepayment) => api.restoreLoanRepayment(loan.id, repayment.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["matters"] });
      void queryClient.invalidateQueries({ queryKey: ["matters", "loan-repayments", loan.id, "trash"] });
    }
  });
  const repayments = showTrash ? (trashQuery.data ?? []) : active;
  return <details className="matter-history">
    <summary>还款记录（{active.length}）</summary>
    <div className="matter-history__toolbar"><button type="button" className="text-button" onClick={(event) => { event.preventDefault(); setShowTrash((value) => !value); }}>{showTrash ? "返回记录" : "还款回收站"}</button></div>
    <div className="matter-history__list">{repayments.length === 0 ? <small>{showTrash ? "没有已删除的还款" : "还没有还款记录"}</small> : repayments.map((repayment) => <div key={repayment.id}><span><strong>{money(repayment.amountMinor)}</strong><small>{dateLabel(repayment.localDate)}{repayment.note ? ` · ${repayment.note}` : ""}</small></span>{showTrash ? <button type="button" className="icon-button" aria-label="恢复还款" onClick={() => restore.mutate(repayment)}><ArchiveRestore size={15} /></button> : <button type="button" className="icon-button danger-icon" aria-label="删除还款" onClick={() => { if (window.confirm("将这笔还款移入回收站？")) remove.mutate(repayment); }}><Trash2 size={15} /></button>}</div>)}</div>
  </details>;
}

function LoanCard({ borrower, loans, trash, onEdit, onRepay, onRefresh }: { borrower: Borrower; loans: Loan[]; trash?: boolean; onEdit: (loan: Loan) => void; onRepay: (loan: Loan) => void; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const archive = useMutation({ mutationFn: (loan: Loan) => api.deleteLoan(loan.id, loan.updatedAt), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); onRefresh(); } });
  const restore = useMutation({ mutationFn: (id: string) => api.restoreLoan(id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); onRefresh(); } });
  const toggleBorrower = useMutation({ mutationFn: () => api.updateBorrower(borrower.id, { isArchived: !borrower.isArchived, expectedUpdatedAt: borrower.updatedAt }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); onRefresh(); } });
  return <article className="matter-person-card">
    <button type="button" className="matter-person-card__header" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span className="matter-person-card__avatar">{borrower.name.slice(0, 1)}</span><span className="matter-person-card__identity"><strong>{borrower.name}{borrower.isArchived ? " · 已停用" : ""}</strong><small>{loans.length} 笔借款 · 已还 {money(borrower.totalRepaidMinor)}</small></span><span className="matter-person-card__balance"><small>还欠</small><b>{money(borrower.outstandingMinor)}</b></span><ChevronDown className={expanded ? "is-rotated" : ""} size={19} />
    </button>
    {expanded && <div className="matter-loan-list">{loans.map((loan) => <div className="matter-loan-row" key={loan.id}>
      <span className="matter-loan-row__icon"><WalletCards size={18} /></span><span className="matter-loan-row__body"><strong>{loan.purpose || "未注明用途"}</strong><small>{dateLabel(loan.localDate)} · 已还 {money(loan.repaidMinor)}</small>{loan.note && <small>{loan.note}</small>}{!trash && <LoanRepaymentHistory loan={loan} />}</span><span className={`matter-status matter-status--${loan.status}`}>{loan.status === "settled" ? "已结清" : `未还 ${money(loan.outstandingMinor)}`}</span><span className="matter-row-actions">{trash ? <button type="button" className="secondary-button" onClick={() => restore.mutate(loan.id)}><ArchiveRestore size={16} />恢复</button> : <><button type="button" className="icon-button" aria-label="编辑借款" onClick={() => onEdit(loan)}><Pencil size={16} /></button>{loan.status !== "settled" && <button type="button" className="secondary-button matter-repay-button" onClick={() => onRepay(loan)}><ArrowDownLeft size={15} />还款</button>}<button type="button" className="icon-button danger-icon" aria-label="移入回收站" onClick={() => { if (window.confirm("将这笔借款移入回收站？")) archive.mutate(loan); }}><Trash2 size={16} /></button></>}</span>
    </div>)}{loans.length === 0 && <p className="muted-copy">暂无借款。</p>}{!trash && <button type="button" className="text-button matter-borrower-toggle" onClick={() => toggleBorrower.mutate()}>{borrower.isArchived ? "恢复借款人" : "停用借款人"}</button>}</div>}
  </article>;
}

function LoansTab({ today }: { today: string }) {
  const queryClient = useQueryClient();
  const [loanForm, setLoanForm] = useState<{ open: boolean; editing?: Loan }>({ open: false });
  const [repayLoan, setRepayLoan] = useState<Loan>();
  const [showTrash, setShowTrash] = useState(false);
  const borrowersQuery = useQuery({ queryKey: ["matters", "borrowers"], queryFn: () => api.borrowers(false) });
  const loansQuery = useQuery({ queryKey: ["matters", "loans", showTrash], queryFn: () => api.loans({ status: showTrash ? "trash" : "active", pageSize: 100 }) });
  const borrowers = listOf(borrowersQuery.data);
  const loans = listOf(loansQuery.data);
  const borrowerCards = borrowers.map((borrower) => ({ borrower, loans: loans.filter((loan) => loan.borrowerId === borrower.id) })).filter((item) => !showTrash || item.loans.length > 0);
  const totalLent = borrowers.reduce((sum, item) => sum + item.totalLentMinor, 0);
  const totalRepaid = borrowers.reduce((sum, item) => sum + item.totalRepaidMinor, 0);
  return <>
    {!showTrash && <div className="matter-summary-grid"><article><span>借出总额</span><strong>{money(totalLent)}</strong></article><article><span>已收回</span><strong className="income-text">{money(totalRepaid)}</strong></article><article className="matter-summary-grid__main"><span>待收回</span><strong className="expense-text">{money(Math.max(0, totalLent - totalRepaid))}</strong></article></div>}
    <div className="matter-section-heading"><div><h2>{showTrash ? "借款回收站" : "按借款人"}</h2><p>{showTrash ? "删除满 30 天后会自动清理。" : "每笔借款都能独立记录用途和还款流水。"}</p></div><div className="matter-heading-actions"><button className="secondary-button" onClick={() => setShowTrash((value) => !value)}>{showTrash ? <RotateCcw size={17} /> : <Archive size={17} />}{showTrash ? "返回借款" : "回收站"}</button>{!showTrash && <button className="primary-button" onClick={() => setLoanForm({ open: true })}><Plus size={17} />记录借款</button>}</div></div>
    {borrowersQuery.isLoading || loansQuery.isLoading ? <div className="skeleton matter-skeleton" /> : borrowerCards.length === 0 ? <div className="content-card matter-empty"><CircleDollarSign size={34} /><strong>{showTrash ? "回收站为空" : "还没有借款记录"}</strong><p>{showTrash ? "删除的借款会在这里保留 30 天。" : "把别人借走的钱记在这里，之后就不会忘记。"}</p>{!showTrash && <button className="secondary-button" onClick={() => setLoanForm({ open: true })}><Plus size={16} />记录第一笔</button>}</div> : <div className="matter-person-list">{borrowerCards.map((item) => <LoanCard key={item.borrower.id} borrower={item.borrower} loans={item.loans} trash={showTrash} onEdit={(loan) => setLoanForm({ open: true, editing: loan })} onRepay={setRepayLoan} onRefresh={() => void queryClient.invalidateQueries({ queryKey: ["matters"] })} />)}</div>}
    {loanForm.open && <LoanForm key={loanForm.editing?.id ?? "new-loan"} open onClose={() => setLoanForm({ open: false })} borrowers={borrowers} editing={loanForm.editing} today={today} />}
    {repayLoan && <RepaymentForm key={repayLoan.id} open onClose={() => setRepayLoan(undefined)} loan={repayLoan} today={today} />}
  </>;
}

function nextDate(subscription: Subscription, today: string): string {
  const base = subscription.nextBillingDate ?? today;
  const [year, month, day] = base.split("-").map(Number);
  if (subscription.cycle === "custom") {
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + (subscription.customDays ?? 30));
    return date.toISOString().slice(0, 10);
  }
  const monthOffset = subscription.cycle === "year" ? 12 : 1;
  const targetMonth = month - 1 + monthOffset;
  const targetYear = year + Math.floor(targetMonth / 12);
  const targetMonthIndex = ((targetMonth % 12) + 12) % 12;
  const anchorDay = Number(subscription.startDate.slice(8, 10));
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const targetDay = Math.min(anchorDay, lastDay);
  return `${targetYear.toString().padStart(4, "0")}-${(targetMonthIndex + 1).toString().padStart(2, "0")}-${targetDay.toString().padStart(2, "0")}`;
}

function SubscriptionForm({ open, onClose, editing, today }: { open: boolean; onClose: () => void; editing?: Subscription; today: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(editing?.name ?? "");
  const [plan, setPlan] = useState(editing?.plan ?? "");
  const [price, setPrice] = useState(editing ? (editing.recurringAmountMinor / 100).toFixed(2) : "");
  const [initialPrice, setInitialPrice] = useState("");
  const [currency, setCurrency] = useState<MatterCurrency>(editing?.currency ?? "USD");
  const [cycle, setCycle] = useState<"month" | "year" | "custom">(editing?.cycle ?? "month");
  const [cycleDays, setCycleDays] = useState(editing?.customDays?.toString() ?? "30");
  const [startDate, setStartDate] = useState(editing?.startDate ?? today);
  const [nextRenewalDate, setNextRenewalDate] = useState(editing?.nextBillingDate ?? today);
  const [reminderDays, setReminderDays] = useState(editing?.reminderDays?.toString() ?? "3");
  const [url, setUrl] = useState(editing?.website ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const priceMinor = parseAmountMinor(price);
      if (!name.trim()) throw new Error("请填写订阅名称");
      if (!priceMinor) throw new Error("请填写有效的常规续费价格");
      const parsedReminderDays = reminderDays.trim() === "" ? 3 : Number(reminderDays);
      const base = { name: name.trim(), plan: plan.trim() || null, recurringAmountMinor: priceMinor, currency, cycle, customDays: cycle === "custom" ? Number(cycleDays) : null, startDate, nextBillingDate: nextRenewalDate, reminderDays: parsedReminderDays, website: url.trim() || null, note: note.trim() || null };
      if (editing) return api.updateSubscription(editing.id, { ...base, expectedUpdatedAt: editing.updatedAt });
      const firstPayment = parseAmountMinor(initialPrice);
      return api.createSubscription({ ...base, initialPayment: firstPayment ? { amountMinor: firstPayment, currency, localDate: startDate, paymentType: "initial" } : undefined });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open={open} title={editing ? "编辑订阅" : "添加订阅"} onClose={onClose} className="matter-sheet">
    <form className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">记下价格、续费日期和首月优惠，之后只需确认每次是否真的续费。</p>
      <div className="matter-form-grid"><label className="matter-field"><span>订阅名称</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="OpenAI、opencode…" /></label><label className="matter-field"><span>套餐 <small>选填</small></span><input value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="Pro" /></label></div>
      <div className="matter-form-grid"><label className="matter-field"><span>常规续费价格</span><input required inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value.replace(/[^\d.]/g, ""))} placeholder="10.00" /></label><label className="matter-field"><span>币种</span><select value={currency} onChange={(event) => setCurrency(event.target.value as MatterCurrency)}><option value="USD">USD 美元</option><option value="CNY">CNY 人民币</option></select></label></div>
      <div className="matter-form-grid"><label className="matter-field"><span>首期价格 <small>选填</small></span><input inputMode="decimal" value={initialPrice} onChange={(event) => setInitialPrice(event.target.value.replace(/[^\d.]/g, ""))} placeholder={currency === "USD" ? "5.00" : ""} /></label><label className="matter-field"><span>提醒提前天数</span><input type="number" min="0" max="60" value={reminderDays} onChange={(event) => setReminderDays(event.target.value)} /></label></div>
      <div className="matter-field"><span>续费周期</span><div className="matter-cycle-buttons"><button type="button" className={cycle === "month" ? "is-active" : ""} onClick={() => setCycle("month")}>每月</button><button type="button" className={cycle === "year" ? "is-active" : ""} onClick={() => setCycle("year")}>每年</button><button type="button" className={cycle === "custom" ? "is-active" : ""} onClick={() => setCycle("custom")}>自定义</button></div></div>
      {cycle === "custom" && <label className="matter-field"><span>每隔多少天</span><input type="number" min="1" value={cycleDays} onChange={(event) => setCycleDays(event.target.value)} /></label>}
      <div className="matter-form-grid"><label className="matter-field"><span>开始日期</span><input required type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label className="matter-field"><span>下次续费日期</span><input required type="date" value={nextRenewalDate} onChange={(event) => setNextRenewalDate(event.target.value)} /></label></div>
      <label className="matter-field"><span>网址 <small>选填</small></span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label>
      <label className="matter-field"><span>备注 <small>选填</small></span><textarea maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} placeholder="首月优惠、付款方式等" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button matter-submit" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{editing ? "保存修改" : "保存订阅"}</button>
    </form>
  </BottomSheet>;
}

function PaymentForm({ open, onClose, subscription, today }: { open: boolean; onClose: () => void; subscription?: Subscription; today: string }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(subscription?.priceMinor ? (subscription.priceMinor / 100).toFixed(2) : "");
  const [currency, setCurrency] = useState<MatterCurrency>(subscription?.currency ?? "USD");
  const [paidDate, setPaidDate] = useState(today);
  const [nextRenewalDate] = useState(subscription ? nextDate(subscription, today) : today);
  const [actualCny, setActualCny] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const categories = useQuery({ queryKey: ["categories", "expense", false], queryFn: () => api.categories("expense", false) });
  const save = useMutation({
    mutationFn: () => {
      if (!subscription) throw new Error("没有选择订阅");
      const amountMinor = parseAmountMinor(amount);
      if (!amountMinor) throw new Error("请输入有效付款金额");
      const ledgerLink = linkMode === "none" ? undefined : linkMode === "existing" ? { mode: "existing", transactionId: linkAmount } : { mode: "create", categoryId: linkCategory, ledgerAmountMinor: currency === "USD" ? parseAmountMinor(actualCny) ?? undefined : amountMinor };
      if (linkMode === "create" && !linkCategory) throw new Error("请选择订阅支出的分类");
      if (linkMode === "create" && currency === "USD" && !parseAmountMinor(actualCny)) throw new Error("请填写实际扣款人民币金额");
      return api.createSubscriptionPayment(subscription.id, { amountMinor, currency, localDate: paidDate, paymentType: "renewal", note: note.trim() || null, ledgerLink });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); setNote(""); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  const [linkMode, setLinkMode] = useState<LedgerLinkMode>("none");
  const [linkAmount, setLinkAmount] = useState("");
  const [linkCategory, setLinkCategory] = useState("");
  const transactions = useQuery({ queryKey: ["transactions", "matter-link-subscription"], queryFn: () => api.transactions({ page: 1, pageSize: 50, deleted: "active", sort: "date", kind: "expense" }) });
  return <BottomSheet open={open} title="记录一次续费" onClose={onClose} className="matter-sheet">
    <form className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">{subscription?.name} · 确认付款后才会更新下一次续费日期。</p>
      <div className="matter-form-grid"><label className="matter-field"><span>本次付款金额</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} /></label><label className="matter-field"><span>币种</span><select value={currency} onChange={(event) => setCurrency(event.target.value as MatterCurrency)}><option value="USD">USD 美元</option><option value="CNY">CNY 人民币</option></select></label></div>
      {currency === "USD" && <label className="matter-field"><span>实际扣款人民币 <small>用于账单</small></span><input inputMode="decimal" value={actualCny} onChange={(event) => setActualCny(event.target.value.replace(/[^\d.]/g, ""))} placeholder="例如 72.00" /></label>}
      <div className="matter-form-grid"><label className="matter-field"><span>付款日期</span><input required type="date" value={paidDate} onChange={(event) => setPaidDate(event.target.value)} /></label><label className="matter-field"><span>预计下次续费</span><input type="date" value={nextRenewalDate} readOnly /></label></div>
      <label className="matter-field"><span>备注 <small>选填</small></span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="首月优惠已结束" /></label>
      <LedgerLinkFields mode={linkMode} setMode={setLinkMode} kind="expense" setKind={() => undefined} amount={linkAmount || actualCny} setAmount={setLinkAmount} categoryId={linkCategory} setCategoryId={setLinkCategory} date={paidDate} setDate={setPaidDate} transactions={transactions.data?.items ?? []} categories={categories.data ?? []} currency={currency} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button matter-submit" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}确认已付款</button>
    </form>
  </BottomSheet>;
}

function SubscriptionCard({ subscription, today, trash, onEdit, onPay }: { subscription: Subscription; today: string; trash?: boolean; onEdit: (subscription: Subscription) => void; onPay: (subscription: Subscription) => void }) {
  const queryClient = useQueryClient();
  const [showPayments, setShowPayments] = useState(false);
  const [showPaymentTrash, setShowPaymentTrash] = useState(false);
  const paymentsQuery = useQuery({ queryKey: ["matters", "subscription-payments", subscription.id, showPaymentTrash], queryFn: () => api.subscriptionPayments(subscription.id, showPaymentTrash ? "trash" : "active"), enabled: showPayments });
  const update = useMutation({ mutationFn: (status: "active" | "paused" | "cancelled") => api.updateSubscription(subscription.id, { status, expectedUpdatedAt: subscription.updatedAt }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); } });
  const remove = useMutation({ mutationFn: () => api.deleteSubscription(subscription.id, subscription.updatedAt), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); } });
  const restore = useMutation({ mutationFn: () => api.restoreSubscription(subscription.id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); } });
  const removePayment = useMutation({ mutationFn: (payment: SubscriptionPayment) => api.deleteSubscriptionPayment(subscription.id, payment.id, payment.updatedAt), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); void queryClient.invalidateQueries({ queryKey: ["matters", "subscription-payments", subscription.id] }); } });
  const restorePayment = useMutation({ mutationFn: (payment: SubscriptionPayment) => api.restoreSubscriptionPayment(subscription.id, payment.id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); void queryClient.invalidateQueries({ queryKey: ["matters", "subscription-payments", subscription.id] }); } });
  const hint = subscriptionDateHint(subscription, today);
  const due = subscription.renewalState === "due" || subscription.renewalState === "overdue" || (subscription.nextBillingDate ? daysUntil(subscription.nextBillingDate, today) <= subscription.reminderDays : false);
  return <article className={`subscription-card ${due ? "is-due" : ""}`}>
    <div className="subscription-card__top"><span className="subscription-card__logo">{subscription.name.slice(0, 1)}</span><div className="subscription-card__identity"><strong>{subscription.name}</strong><small>{subscription.plan || "订阅服务"} · {subscription.cycle === "month" ? "每月" : subscription.cycle === "year" ? "每年" : `每 ${subscription.customDays} 天`}</small></div><span className={`matter-status matter-status--${due ? "due" : subscription.status}`}>{subscription.renewalState === "active" || subscription.renewalState === "upcoming" ? hint : subscription.renewalState === "due" || subscription.renewalState === "overdue" ? "待确认" : subscription.renewalState === "paused" ? "已暂停" : "已取消"}</span></div>
    <div className="subscription-card__summary"><div><span>常规价格</span><strong>{amountText(subscription.recurringAmountMinor, subscription.currency)}</strong></div><div><span>下次续费</span><strong>{subscription.nextBillingDate ? dateLabel(subscription.nextBillingDate) : "未设置"}</strong><small>{hint}</small></div><div><span>上次付款</span><strong>{subscription.lastPaymentDate ? dateLabel(subscription.lastPaymentDate) : "尚未记录"}</strong><small>{subscription.payments[0] ? amountText(subscription.payments[0].amountMinor, subscription.payments[0].currency) : ""}</small></div></div>
    {subscription.note && <p className="subscription-card__note">{subscription.note}</p>}
    <div className="matter-card-actions">{trash ? <button type="button" className="secondary-button" onClick={() => restore.mutate()}><ArchiveRestore size={16} />恢复订阅</button> : <><button type="button" className="primary-button" onClick={() => onPay(subscription)} disabled={subscription.status === "cancelled"}><Check size={16} />记录续费</button><button type="button" className="secondary-button" onClick={() => setShowPayments((value) => !value)}>{showPayments ? "收起付款记录" : "付款记录"}<ChevronDown size={15} /></button>{subscription.website && <a className="icon-button" href={subscription.website} target="_blank" rel="noreferrer" aria-label="打开订阅网址"><ExternalLink size={16} /></a>}<button className="icon-button" type="button" aria-label="编辑订阅" onClick={() => onEdit(subscription)}><Pencil size={16} /></button><button className="icon-button danger-icon" type="button" aria-label="删除订阅" onClick={() => { if (window.confirm("将订阅移入回收站？")) remove.mutate(); }}><Trash2 size={16} /></button><button className="secondary-button" type="button" onClick={() => update.mutate(subscription.status === "paused" ? "active" : "paused")}>{subscription.status === "paused" ? "恢复" : "暂停"}</button>{subscription.status !== "cancelled" && <button className="text-button" type="button" onClick={() => update.mutate("cancelled")}>取消订阅</button>}</>}</div>
    {showPayments && <div className="subscription-payments"><div className="subscription-payments__toolbar"><button type="button" className="text-button" onClick={() => setShowPaymentTrash((value) => !value)}>{showPaymentTrash ? "返回付款记录" : "付款回收站"}</button></div>{paymentsQuery.isLoading ? <span>正在读取付款记录…</span> : (paymentsQuery.data ?? []).length === 0 ? <span>{showPaymentTrash ? "没有已删除的付款" : "还没有付款记录"}</span> : (paymentsQuery.data ?? []).map((payment: SubscriptionPayment) => <div key={payment.id}><span>{dateLabel(payment.localDate)}</span><strong>{amountText(payment.amountMinor, payment.currency)}</strong><small>{payment.paymentType === "initial" ? "首笔付款" : payment.paymentType === "renewal" ? "续费" : "手动记录"}</small>{showPaymentTrash ? <button type="button" className="icon-button" aria-label="恢复付款" onClick={() => restorePayment.mutate(payment)}><ArchiveRestore size={15} /></button> : <button type="button" className="icon-button danger-icon" aria-label="删除付款" onClick={() => { if (window.confirm("将这笔付款移入回收站？")) removePayment.mutate(payment); }}><Trash2 size={15} /></button>}</div>)}</div>}
  </article>;
}

function SubscriptionsTab({ today }: { today: string }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ open: boolean; editing?: Subscription }>({ open: false });
  const [paymentSubscription, setPaymentSubscription] = useState<Subscription>();
  const [showTrash, setShowTrash] = useState(false);
  const subscriptionsQuery = useQuery({ queryKey: ["matters", "subscriptions", showTrash], queryFn: () => api.subscriptions({ status: showTrash ? "trash" : "active", pageSize: 100 }) });
  const subscriptions = listOf(subscriptionsQuery.data);
  const active = subscriptions.filter((item) => item.status !== "cancelled");
  const due = active.filter((item) => item.renewalState === "due" || item.renewalState === "overdue" || (item.nextBillingDate ? daysUntil(item.nextBillingDate, today) <= item.reminderDays : false));
  const upcoming = active.filter((item) => !due.includes(item)).sort((a, b) => (a.nextBillingDate ?? "9999-12-31").localeCompare(b.nextBillingDate ?? "9999-12-31"));
  return <>
    {!showTrash && <div className="matter-summary-grid"><article className="matter-summary-grid__main"><span>启用中的订阅</span><strong>{active.filter((item) => item.status === "active").length} 项</strong></article><article><span>近期续费</span><strong className={due.length ? "expense-text" : ""}>{due.length} 项</strong></article><article><span>本月记录</span><strong>{subscriptions.filter((item) => item.lastPaymentDate?.slice(0, 7) === today.slice(0, 7)).length} 项</strong></article></div>}
    <div className="matter-section-heading"><div><h2>{showTrash ? "订阅回收站" : "订阅列表"}</h2><p>{showTrash ? "删除满 30 天后会自动清理。" : "到期后不会自动视为已续费，确认付款后再更新下一次日期。"}</p></div><div className="matter-heading-actions"><button className="secondary-button" onClick={() => setShowTrash((value) => !value)}>{showTrash ? <RotateCcw size={17} /> : <Archive size={17} />}{showTrash ? "返回订阅" : "回收站"}</button>{!showTrash && <button className="primary-button" onClick={() => setForm({ open: true })}><Plus size={17} />添加订阅</button>}</div></div>
    {subscriptionsQuery.isLoading ? <div className="skeleton matter-skeleton" /> : subscriptions.length === 0 ? <div className="content-card matter-empty"><Clock3 size={34} /><strong>{showTrash ? "回收站为空" : "还没有订阅"}</strong><p>{showTrash ? "删除的订阅会在这里保留 30 天。" : "把每月或每年的固定服务放在这里，续费日期就不会被忘记。"}</p>{!showTrash && <button className="secondary-button" onClick={() => setForm({ open: true })}><Plus size={16} />添加第一项</button>}</div> : showTrash ? <div className="subscription-list">{subscriptions.map((item) => <SubscriptionCard key={item.id} subscription={item} today={today} trash onEdit={() => undefined} onPay={() => undefined} />)}</div> : <div className="subscription-groups">{due.length > 0 && <section><div className="matter-section-heading matter-section-heading--small"><div><h3>需要留意</h3><p>近期续费或已经到期的项目。</p></div><span className="matter-count-badge">{due.length}</span></div><div className="subscription-list">{due.map((item) => <SubscriptionCard key={item.id} subscription={item} today={today} onEdit={(value) => setForm({ open: true, editing: value })} onPay={setPaymentSubscription} />)}</div></section>}<section><div className="matter-section-heading matter-section-heading--small"><div><h3>其他订阅</h3><p>{upcoming.length} 项启用中或已暂停。</p></div></div><div className="subscription-list">{upcoming.map((item) => <SubscriptionCard key={item.id} subscription={item} today={today} onEdit={(value) => setForm({ open: true, editing: value })} onPay={setPaymentSubscription} />)}</div></section></div>}
    {form.open && <SubscriptionForm key={form.editing?.id ?? "new-subscription"} open onClose={() => { setForm({ open: false }); void queryClient.invalidateQueries({ queryKey: ["matters"] }); }} editing={form.editing} today={today} />}
    {paymentSubscription && <PaymentForm key={paymentSubscription.id} open onClose={() => { setPaymentSubscription(undefined); void queryClient.invalidateQueries({ queryKey: ["matters"] }); }} subscription={paymentSubscription} today={today} />}
  </>;
}

export function MattersPage() {
  const { today } = useLedgerClock();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: MatterTab = searchParams.get("tab") === "subscriptions" ? "subscriptions" : "loans";
  const setTab = (value: MatterTab) => setSearchParams({ tab: value }, { replace: true });
  return <div className="page matters-page">
    <header className="page-heading page-heading--row"><div><p className="eyebrow">财务事项</p><h1>借款与订阅</h1><p>把不适合放进日常账单的财务承诺，放在一个容易回看的地方。</p></div><div className="matters-heading-icon"><WalletCards size={25} /></div></header>
    <div className="view-tabs matters-tabs" role="tablist" aria-label="财务事项分类"><button role="tab" aria-selected={tab === "loans"} className={tab === "loans" ? "is-active" : ""} onClick={() => setTab("loans")}>借款</button><button role="tab" aria-selected={tab === "subscriptions"} className={tab === "subscriptions" ? "is-active" : ""} onClick={() => setTab("subscriptions")}>订阅</button></div>
    {tab === "loans" ? <LoansTab today={today} /> : <SubscriptionsTab today={today} />}
  </div>;
}

export default MattersPage;
