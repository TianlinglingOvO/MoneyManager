import { useMemo, useRef, useState } from "react";
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
  Search,
  Trash2,
  WalletCards,
  X
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import type { Account, AccountCurrency, Borrower, Category, LedgerLinkMode, Loan, LoanRepayment, MatterCurrency, Plan, Subscription, SubscriptionPayment, Transaction } from "@shared/types";
import { api } from "../api";
import { AccountPicker } from "../components/AccountPicker";
import { BottomSheet } from "../components/BottomSheet";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { SegmentedControl } from "../components/SegmentedControl";
import { useLedgerClock } from "../ledger-clock";
import { money, parseAmountMinor } from "../utils";

type MatterTab = "loans" | "subscriptions" | "plans";
type PlanView = "open" | "closed";
type PlanScope = "dated" | "undated";

function parseMatterTab(value: string | null): MatterTab {
  return value === "subscriptions" || value === "plans" ? value : "loans";
}

function parsePlanView(value: string | null): PlanView {
  return value === "closed" ? "closed" : "open";
}

function parsePlanScope(value: string | null): PlanScope | null {
  return value === "dated" || value === "undated" ? value : null;
}

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
function FundsAccountField({ accounts, value, onChange, label, currencies }: { accounts: Account[]; value: string; onChange: (value: string) => void; label: string; currencies?: AccountCurrency[] }) {
  const availableAccounts = accounts.filter((account) => !account.isArchived && (!currencies || currencies.includes(account.currency)));
  return <AccountPicker accounts={availableAccounts} value={value} onChange={onChange} label={label} required />;
}


function LoanForm({ open, onClose, borrowers, editing, today }: { open: boolean; onClose: () => void; borrowers: Borrower[]; editing?: Loan; today: string }) {
  const queryClient = useQueryClient();
  const [borrowerId, setBorrowerId] = useState(editing?.borrowerId ?? "");
  const [borrowerSearch, setBorrowerSearch] = useState("");
  const [borrowerPickerOpen, setBorrowerPickerOpen] = useState(false);
  const borrowerSearchRef = useRef<HTMLInputElement | null>(null);
  const [amount, setAmount] = useState(editing ? (editing.amountMinor / 100).toFixed(2) : "");
  const [lentDate, setLentDate] = useState(editing?.localDate ?? defaultDate(today));
  const [purpose, setPurpose] = useState(editing?.purpose ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [linkMode, setLinkMode] = useState<LedgerLinkMode>("none");
  const [linkKind, setLinkKind] = useState<"expense" | "income">("expense");
  const [linkAmount, setLinkAmount] = useState("");
  const [linkCategory, setLinkCategory] = useState("");
  const [linkDate, setLinkDate] = useState(lentDate);
  const [accountId, setAccountId] = useState(editing?.accountId ?? "");
  const [error, setError] = useState("");
  const categories = useQuery({ queryKey: ["categories", "all", false], queryFn: () => api.categories(undefined, false) });
  const transactions = useQuery({ queryKey: ["transactions", "matter-link"], queryFn: () => api.transactions({ page: 1, pageSize: 50, deleted: "active", sort: "date" }) });
  const funds = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary });
  const fundsRequired = Boolean(funds.data?.enabled && funds.data.startedOn && lentDate >= funds.data.startedOn);
  const selectedAccountId = accountId || funds.data?.defaultExpenseAccountId || "";
  const selectedBorrower = borrowers.find((item) => item.id === borrowerId);
  const normalizedBorrowerSearch = borrowerSearch.trim().replace(/\s+/g, " ");
  const matchingBorrowers = borrowers.filter((item) => item.name.toLocaleLowerCase().includes(normalizedBorrowerSearch.toLocaleLowerCase()));
  const exactBorrower = borrowers.find((item) => item.name.toLocaleLowerCase() === normalizedBorrowerSearch.toLocaleLowerCase());
  const restoreBorrower = useMutation({
    mutationFn: (borrower: Borrower) => api.updateBorrower(borrower.id, { isArchived: false, expectedUpdatedAt: borrower.updatedAt }),
    onSuccess: async (borrower) => {
      await queryClient.invalidateQueries({ queryKey: ["matters", "borrowers"] });
      setBorrowerId(borrower.id);
      setBorrowerSearch("");
      setBorrowerPickerOpen(false);
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "恢复借款人失败")
  });
  const save = useMutation({
    mutationFn: async () => {
      setError("");
      const amountMinor = parseAmountMinor(amount);
      if (!borrowerId && !normalizedBorrowerSearch) throw new Error("请选择或新建借款人");
      if (!amountMinor) throw new Error("请输入有效借款金额");
      if (fundsRequired && !selectedAccountId) throw new Error("请选择借出资金账户");
      const ledgerLink = fundsRequired ? undefined : linkMode === "none" ? undefined : linkMode === "existing" ? { mode: "existing", transactionId: linkAmount } : { mode: "create", ledgerAmountMinor: parseAmountMinor(linkAmount) ?? amountMinor, categoryId: linkCategory };
      const input = { ...(borrowerId ? { borrowerId } : { newBorrowerName: normalizedBorrowerSearch }), principalMinor: amountMinor, localDate: lentDate, purpose: purpose.trim() || null, note: note.trim() || null, ledgerLink, accountId: fundsRequired ? selectedAccountId : null };
      if (editing) return api.updateLoan(editing.id, {
        principalMinor: amountMinor,
        localDate: lentDate,
        purpose: purpose.trim() || null,
        note: note.trim() || null,
        accountId: fundsRequired ? selectedAccountId : null,
        expectedUpdatedAt: editing.updatedAt
      });
      return api.createLoan(input);
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); await queryClient.invalidateQueries({ queryKey: ["loan"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open={open} title={editing ? "编辑借款" : "记录一笔借款"} closeLabel={editing ? "关闭编辑借款" : "关闭记录借款"} onClose={onClose} className="matter-sheet" footer={<button className="primary-button matter-submit" form="loan-form" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{editing ? "保存修改" : "保存借款"}</button>}>
    <form id="loan-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">记录别人从你这里借走的钱，之后可以在对应借款下分次登记还款。</p>
      {editing ? (
        <label className="matter-field">
          <span>借款人</span>
          <div className="borrower-picker__selected is-locked">
            <strong>{selectedBorrower?.name ?? editing.borrowerName}</strong>
            <small>已有借款不能更换借款人</small>
          </div>
        </label>
      ) : (
        <div className="matter-field borrower-picker">
          <span>借款人</span>
          {selectedBorrower ? (
            <div className="borrower-picker__selected">
              <span><strong>{selectedBorrower.name}</strong><small>已选择借款人</small></span>
              <button type="button" className="text-button" onClick={() => {
                setBorrowerId("");
                setBorrowerPickerOpen(true);
                window.requestAnimationFrame(() => borrowerSearchRef.current?.focus());
              }}>更换</button>
            </div>
          ) : (
            <>
              <div className="borrower-picker__control">
                <Search size={17} aria-hidden="true" />
                <input
                  ref={borrowerSearchRef}
                  role="combobox"
                  aria-label="搜索或新建借款人"
                  aria-expanded={borrowerPickerOpen}
                  aria-controls="borrower-options"
                  aria-autocomplete="list"
                  value={borrowerSearch}
                  onFocus={() => setBorrowerPickerOpen(true)}
                  onChange={(event) => {
                    setBorrowerSearch(event.target.value);
                    setBorrowerPickerOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && borrowerPickerOpen) {
                      event.preventDefault();
                      event.stopPropagation();
                      setBorrowerPickerOpen(false);
                    }
                  }}
                  placeholder="搜索已有借款人，或输入新名称"
                />
              </div>
              {borrowerPickerOpen && (
                <div id="borrower-options" className="borrower-picker__options" role="listbox" aria-label="借款人选项">
                  {matchingBorrowers.map((borrower) => (
                    <div className="borrower-picker__option" key={borrower.id}>
                      {borrower.isArchived ? (
                        <>
                          <span><strong>{borrower.name}</strong><small>已停用</small></span>
                          <button type="button" className="secondary-button" onClick={() => restoreBorrower.mutate(borrower)} disabled={restoreBorrower.isPending}>恢复后选择</button>
                        </>
                      ) : (
                        <button type="button" role="option" aria-selected="false" onClick={() => {
                          setBorrowerId(borrower.id);
                          setBorrowerSearch("");
                          setBorrowerPickerOpen(false);
                        }}>
                          <span className="matter-person-card__avatar">{borrower.name.slice(0, 1)}</span>
                          <span><strong>{borrower.name}</strong><small>待收回 {money(borrower.outstandingMinor)}</small></span>
                        </button>
                      )}
                    </div>
                  ))}
                  {normalizedBorrowerSearch && !exactBorrower && (
                    <button type="button" className="borrower-picker__create" role="option" aria-selected="false" onClick={() => setBorrowerPickerOpen(false)}>
                      <Plus size={17} />
                      <span><strong>新建“{normalizedBorrowerSearch}”</strong><small>保存借款时一并创建</small></span>
                    </button>
                  )}
                  {matchingBorrowers.length === 0 && !normalizedBorrowerSearch && <p>输入姓名以搜索或新建借款人。</p>}
                </div>
              )}
            </>
          )}
          {exactBorrower && !borrowerId && (
            <small className={exactBorrower.isArchived ? "form-warning" : "form-hint"}>
              {exactBorrower.isArchived ? "同名借款人已停用，请先恢复。" : "已有同名借款人，选择后会沿用现有记录。"}
            </small>
          )}
        </div>
      )}
      <div className="matter-form-grid"><label className="matter-field"><span>借出金额（人民币）</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="300.00" /></label><label className="matter-field"><span>借出日期</span><input required type="date" value={lentDate} onChange={(event) => { setLentDate(event.target.value); setLinkDate(event.target.value); }} /></label></div>
      <label className="matter-field"><span>用途</span><input maxLength={120} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="例如：生活费、给女朋友买花" /></label>
      <label className="matter-field"><span>备注 <small>选填</small></span><textarea maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} placeholder="可以补充约定或说明" /></label>
      {fundsRequired && <FundsAccountField accounts={funds.data?.accounts ?? []} value={selectedAccountId} onChange={setAccountId} label="借出资金账户" currencies={["CNY"]} />}
      {!editing && !fundsRequired && <LedgerLinkFields mode={linkMode} setMode={setLinkMode} kind={linkKind} setKind={setLinkKind} amount={linkAmount} setAmount={setLinkAmount} categoryId={linkCategory} setCategoryId={setLinkCategory} date={linkDate} setDate={setLinkDate} transactions={transactions.data?.items ?? []} categories={categories.data ?? []} />}
      {error && <p className="form-error" role="alert">{error}</p>}

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
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState("");
  const categories = useQuery({ queryKey: ["categories", "income", false], queryFn: () => api.categories("income", false) });
  const funds = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary });
  const fundsRequired = Boolean(funds.data?.enabled && funds.data.startedOn && repaidDate >= funds.data.startedOn);
  const selectedAccountId = accountId || funds.data?.defaultIncomeAccountId || "";
  const save = useMutation({
    mutationFn: async () => {
      if (!loan) throw new Error("没有选择借款");
      const amountMinor = parseAmountMinor(amount);
      if (!amountMinor || amountMinor > loan.outstandingMinor) throw new Error("还款金额不能超过未还余额");
      if (fundsRequired && !selectedAccountId) throw new Error("请选择还款到账账户");
      const ledgerLink = fundsRequired ? undefined : linkMode === "none" ? undefined : linkMode === "existing" ? { mode: "existing", transactionId: linkAmount } : { mode: "create", ledgerAmountMinor: amountMinor, categoryId: linkCategory };
      return api.createLoanRepayment(loan.id, { amountMinor, localDate: repaidDate, note: note.trim() || null, ledgerLink, accountId: fundsRequired ? selectedAccountId : null });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); await queryClient.invalidateQueries({ queryKey: ["loan", loan?.id] }); setAmount(""); setNote(""); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  const transactions = useQuery({ queryKey: ["transactions", "matter-link-income"], queryFn: () => api.transactions({ page: 1, pageSize: 50, deleted: "active", sort: "date", kind: "income" }) });
  return <BottomSheet open={open} title="记录还款" closeLabel="关闭记录还款" onClose={onClose} className="matter-sheet" footer={<button className="primary-button matter-submit" form="repayment-form" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}保存还款</button>}>
    <form id="repayment-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">{loan?.borrowerName ?? "这笔借款"} · 未还 {money(loan?.outstandingMinor ?? 0)}</p>
      <div className="matter-form-grid"><label className="matter-field"><span>还款金额（人民币）</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label><label className="matter-field"><span>还款日期</span><input required type="date" value={repaidDate} onChange={(event) => setRepaidDate(event.target.value)} /></label></div>
      <label className="matter-field"><span>备注 <small>选填</small></span><input maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：微信转账" /></label>
      {fundsRequired && <FundsAccountField accounts={funds.data?.accounts ?? []} value={selectedAccountId} onChange={setAccountId} label="还款到账账户" currencies={["CNY"]} />}
      {!fundsRequired && <LedgerLinkFields mode={linkMode} setMode={setLinkMode} kind="income" setKind={() => undefined} amount={linkAmount} setAmount={setLinkAmount} categoryId={linkCategory} setCategoryId={setLinkCategory} date={repaidDate} setDate={setRepaidDate} transactions={transactions.data?.items ?? []} categories={categories.data ?? []} />}
      {error && <p className="form-error" role="alert">{error}</p>}

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
  const [initialActualCny, setInitialActualCny] = useState("");
  const [initialAccountAmount, setInitialAccountAmount] = useState("");
  const [initialCategory, setInitialCategory] = useState("");
  const [initialAccountId, setInitialAccountId] = useState("");
  const [currency, setCurrency] = useState<MatterCurrency>(editing?.currency ?? "USD");
  const [cycle, setCycle] = useState<"month" | "year" | "custom">(editing?.cycle ?? "month");
  const [cycleDays, setCycleDays] = useState(editing?.customDays?.toString() ?? "30");
  const [startDate, setStartDate] = useState(editing?.startDate ?? today);
  const [nextRenewalDate, setNextRenewalDate] = useState(editing?.nextBillingDate ?? today);
  const [reminderDays, setReminderDays] = useState(editing?.reminderDays?.toString() ?? "3");
  const [url, setUrl] = useState(editing?.website ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [error, setError] = useState("");
  const funds = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary });
  const expenseCategories = useQuery({ queryKey: ["categories", "expense", false], queryFn: () => api.categories("expense", false) });
  const initialPaymentMinor = parseAmountMinor(initialPrice);
  const initialFundsRequired = Boolean(initialPaymentMinor && funds.data?.enabled && funds.data.startedOn && startDate >= funds.data.startedOn);
  const selectedInitialAccountId = initialAccountId || funds.data?.defaultExpenseAccountId || "";
  const selectedInitialAccount = funds.data?.accounts.find((account) => account.id === selectedInitialAccountId);
  const save = useMutation({
    mutationFn: () => {
      const priceMinor = parseAmountMinor(price);
      if (!name.trim()) throw new Error("请填写订阅名称");
      if (!priceMinor) throw new Error("请填写有效的常规续费价格");
      const parsedReminderDays = reminderDays.trim() === "" ? 3 : Number(reminderDays);
      const base = { name: name.trim(), plan: plan.trim() || null, recurringAmountMinor: priceMinor, currency, cycle, customDays: cycle === "custom" ? Number(cycleDays) : null, startDate, nextBillingDate: nextRenewalDate, reminderDays: parsedReminderDays, website: url.trim() || null, note: note.trim() || null };
      if (editing) return api.updateSubscription(editing.id, { ...base, expectedUpdatedAt: editing.updatedAt });
      const firstPayment = parseAmountMinor(initialPrice);
      if (initialFundsRequired && !initialCategory) throw new Error("请选择首期订阅支出分类");
      if (initialFundsRequired && !selectedInitialAccount) throw new Error("请选择首期扣款账户");
      const initialLedgerAmount = currency === "USD" ? parseAmountMinor(initialActualCny) : firstPayment;
      if (initialFundsRequired && !initialLedgerAmount) throw new Error("请填写首期实际人民币扣款金额");
      const initialAccountAmountMinor = selectedInitialAccount?.currency === "CNY"
        ? undefined
        : selectedInitialAccount?.currency === "USD" && currency === "USD" ? firstPayment : parseAmountMinor(initialAccountAmount);
      if (initialFundsRequired && selectedInitialAccount?.currency !== "CNY" && !initialAccountAmountMinor) throw new Error(`请填写首期实际扣款 ${selectedInitialAccount?.currency ?? "外币"}`);
      const ledgerLink = initialFundsRequired
        ? { mode: "create", categoryId: initialCategory, ledgerAmountMinor: initialLedgerAmount!, accountId: selectedInitialAccountId, accountAmountMinor: initialAccountAmountMinor }
        : undefined;
      return api.createSubscription({ ...base, initialPayment: firstPayment ? { amountMinor: firstPayment, currency, localDate: startDate, paymentType: "initial", ledgerLink } : undefined });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open={open} title={editing ? "编辑订阅" : "添加订阅"} closeLabel={editing ? "关闭编辑订阅" : "关闭添加订阅"} onClose={onClose} className="matter-sheet" footer={<button className="primary-button matter-submit" form="subscription-form" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{editing ? "保存修改" : "保存订阅"}</button>}>
    <form id="subscription-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">记下价格、续费日期和首月优惠，之后只需确认每次是否真的续费。</p>
      <div className="matter-form-grid"><label className="matter-field"><span>订阅名称</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="OpenAI、opencode…" /></label><label className="matter-field"><span>套餐 <small>选填</small></span><input value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="Pro" /></label></div>
      <div className="matter-form-grid"><label className="matter-field"><span>常规续费价格</span><input required inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value.replace(/[^\d.]/g, ""))} placeholder="10.00" /></label><label className="matter-field"><span>币种</span><select value={currency} onChange={(event) => { setCurrency(event.target.value as MatterCurrency); setInitialActualCny(""); setInitialAccountAmount(""); }}><option value="USD">USD 美元</option><option value="CNY">CNY 人民币</option></select></label></div>
      <div className="matter-form-grid"><label className="matter-field"><span>首期价格 <small>选填</small></span><input inputMode="decimal" value={initialPrice} onChange={(event) => setInitialPrice(event.target.value.replace(/[^\d.]/g, ""))} placeholder={currency === "USD" ? "5.00" : ""} /></label><label className="matter-field"><span>提醒提前天数</span><input type="number" min="0" max="60" value={reminderDays} onChange={(event) => setReminderDays(event.target.value)} /></label></div>
      {initialFundsRequired && <>
        <div className="matter-form-grid">
          {currency === "USD" && <label className="matter-field"><span>首期实际扣款人民币</span><input required inputMode="decimal" value={initialActualCny} onChange={(event) => setInitialActualCny(event.target.value.replace(/[^\d.]/g, ""))} placeholder="例如 36.00" /></label>}
          <label className="matter-field"><span>首期支出分类</span><select required value={initialCategory} onChange={(event) => setInitialCategory(event.target.value)}><option value="">选择分类</option>{(expenseCategories.data ?? []).map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label>
        </div>
        <FundsAccountField accounts={funds.data?.accounts ?? []} value={selectedInitialAccountId} onChange={(value) => { setInitialAccountId(value); setInitialAccountAmount(""); }} label="首期扣款账户" />
        {selectedInitialAccount && selectedInitialAccount.currency !== "CNY" && (selectedInitialAccount.currency === "USD" && currency === "USD" ? <label className="matter-field"><span>首期实际扣款 USD <small>与首期价格一致</small></span><input readOnly value={initialPrice} /></label> : <label className="matter-field"><span>首期实际扣款 {selectedInitialAccount.currency} <small>必填</small></span><input required inputMode="decimal" value={initialAccountAmount} onChange={(event) => setInitialAccountAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label>)}
      </>}
      <div className="matter-field"><span>续费周期</span><div className="matter-cycle-buttons"><button type="button" className={cycle === "month" ? "is-active" : ""} onClick={() => setCycle("month")}>每月</button><button type="button" className={cycle === "year" ? "is-active" : ""} onClick={() => setCycle("year")}>每年</button><button type="button" className={cycle === "custom" ? "is-active" : ""} onClick={() => setCycle("custom")}>自定义</button></div></div>
      {cycle === "custom" && <label className="matter-field"><span>每隔多少天</span><input type="number" min="1" value={cycleDays} onChange={(event) => setCycleDays(event.target.value)} /></label>}
      <div className="matter-form-grid"><label className="matter-field"><span>开始日期</span><input required type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label className="matter-field"><span>下次续费日期</span><input required type="date" value={nextRenewalDate} onChange={(event) => setNextRenewalDate(event.target.value)} /></label></div>
      <label className="matter-field"><span>网址 <small>选填</small></span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label>
      <label className="matter-field"><span>备注 <small>选填</small></span><textarea maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} placeholder="首月优惠、付款方式等" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}

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
  const [accountAmount, setAccountAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const categories = useQuery({ queryKey: ["categories", "expense", false], queryFn: () => api.categories("expense", false) });
  const [linkMode, setLinkMode] = useState<LedgerLinkMode>("none");
  const [linkAmount, setLinkAmount] = useState("");
  const [linkCategory, setLinkCategory] = useState("");
  const [accountId, setAccountId] = useState("");
  const funds = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary });
  const fundsRequired = Boolean(funds.data?.enabled && funds.data.startedOn && paidDate >= funds.data.startedOn);
  const selectedAccountId = accountId || funds.data?.defaultExpenseAccountId || "";
  const selectedAccount = funds.data?.accounts.find((account) => account.id === selectedAccountId);
  const save = useMutation({
    mutationFn: () => {
      if (!subscription) throw new Error("没有选择订阅");
      const amountMinor = parseAmountMinor(amount);
      if (!amountMinor) throw new Error("请输入有效付款金额");
      const actualLedgerAmount = currency === "USD" ? parseAmountMinor(actualCny) : amountMinor;
      const accountAmountMinor = selectedAccount?.currency === "CNY"
        ? undefined
        : selectedAccount?.currency === "USD" && currency === "USD" ? amountMinor : parseAmountMinor(accountAmount);
      if ((fundsRequired || linkMode === "create") && !linkCategory) throw new Error("请选择订阅支出的分类");
      if ((fundsRequired || linkMode === "create") && !actualLedgerAmount) throw new Error("请填写实际扣款人民币金额");
      if (fundsRequired && !selectedAccount) throw new Error("请选择订阅扣款账户");
      if (fundsRequired && selectedAccount?.currency !== "CNY" && !accountAmountMinor) throw new Error(`请填写实际扣款 ${selectedAccount?.currency ?? "外币"}`);
      const ledgerLink = fundsRequired
        ? { mode: "create", categoryId: linkCategory, ledgerAmountMinor: actualLedgerAmount!, accountId: selectedAccountId, accountAmountMinor }
        : linkMode === "none" ? undefined : linkMode === "existing" ? { mode: "existing", transactionId: linkAmount } : { mode: "create", categoryId: linkCategory, ledgerAmountMinor: actualLedgerAmount! };
      return api.createSubscriptionPayment(subscription.id, { amountMinor, currency, localDate: paidDate, paymentType: "renewal", note: note.trim() || null, ledgerLink });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); setNote(""); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  const transactions = useQuery({ queryKey: ["transactions", "matter-link-subscription"], queryFn: () => api.transactions({ page: 1, pageSize: 50, deleted: "active", sort: "date", kind: "expense" }) });
  return <BottomSheet open={open} title="记录一次续费" closeLabel="关闭记录续费" onClose={onClose} className="matter-sheet" footer={<button className="primary-button matter-submit" form="subscription-payment-form" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}确认已付款</button>}>
    <form id="subscription-payment-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">{subscription?.name} · 确认付款后才会更新下一次续费日期。</p>
      <div className="matter-form-grid"><label className="matter-field"><span>本次付款金额</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} /></label><label className="matter-field"><span>币种</span><select value={currency} onChange={(event) => { setCurrency(event.target.value as MatterCurrency); setActualCny(""); setAccountAmount(""); }}><option value="USD">USD 美元</option><option value="CNY">CNY 人民币</option></select></label></div>
      {currency === "USD" && <label className="matter-field"><span>实际扣款人民币 <small>用于账单</small></span><input inputMode="decimal" value={actualCny} onChange={(event) => setActualCny(event.target.value.replace(/[^\d.]/g, ""))} placeholder="例如 72.00" /></label>}
      <div className="matter-form-grid"><label className="matter-field"><span>付款日期</span><input required type="date" value={paidDate} onChange={(event) => setPaidDate(event.target.value)} /></label><label className="matter-field"><span>预计下次续费</span><input type="date" value={nextRenewalDate} readOnly /></label></div>
      <label className="matter-field"><span>备注 <small>选填</small></span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="首月优惠已结束" /></label>
      {fundsRequired ? <>
        <label className="matter-field"><span>订阅支出分类</span><select required value={linkCategory} onChange={(event) => setLinkCategory(event.target.value)}><option value="">选择分类</option>{(categories.data ?? []).map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label>
        <FundsAccountField accounts={funds.data?.accounts ?? []} value={selectedAccountId} onChange={(value) => { setAccountId(value); setAccountAmount(""); }} label="订阅扣款账户" />
        {selectedAccount && selectedAccount.currency !== "CNY" && (selectedAccount.currency === "USD" && currency === "USD" ? <label className="matter-field"><span>实际扣款 USD <small>与付款金额一致</small></span><input readOnly value={amount} /></label> : <label className="matter-field"><span>实际扣款 {selectedAccount.currency} <small>必填</small></span><input required inputMode="decimal" value={accountAmount} onChange={(event) => setAccountAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label>)}
      </> : <LedgerLinkFields mode={linkMode} setMode={setLinkMode} kind="expense" setKind={() => undefined} amount={linkAmount || actualCny} setAmount={setLinkAmount} categoryId={linkCategory} setCategoryId={setLinkCategory} date={paidDate} setDate={setPaidDate} transactions={transactions.data?.items ?? []} categories={categories.data ?? []} currency={currency} />}
      {error && <p className="form-error" role="alert">{error}</p>}

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

function planDateHint(plan: Plan, today: string): string {
  if (plan.status === "completed") return plan.completedAt ? `${dateLabel(plan.completedAt)} 已完成` : "已完成";
  if (plan.status === "cancelled") return "已取消";
  if (!plan.dueDate) return "未设置日期";
  const days = daysUntil(plan.dueDate, today);
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  if (days <= plan.reminderDays) return `${days} 天后到期`;
  return dateLabel(plan.dueDate);
}

function PlanForm({ open, onClose, editing, today }: { open: boolean; onClose: () => void; editing?: Plan; today: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(editing?.title ?? "");
  const [amount, setAmount] = useState(editing?.amountMinor ? (editing.amountMinor / 100).toFixed(2) : "");
  const [dueDate, setDueDate] = useState(editing?.dueDate ?? "");
  const [reminderDays, setReminderDays] = useState(String(editing?.reminderDays ?? 3));
  const [note, setNote] = useState(editing?.note ?? "");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const parsedReminderDays = Number(reminderDays);
      if (!Number.isInteger(parsedReminderDays) || parsedReminderDays < 0 || parsedReminderDays > 60) throw new Error("提醒天数需要在 0 到 60 之间");
      const amountMinor = amount.trim() ? parseAmountMinor(amount) : null;
      if (amount.trim() && !amountMinor) throw new Error("请输入有效金额");
      const payload = {
        title: title.trim(),
        amountMinor,
        dueDate: dueDate || null,
        reminderDays: parsedReminderDays,
        note: note.trim() || null
      };
      return editing ? api.updatePlan(editing.id, { ...payload, expectedUpdatedAt: editing.updatedAt }) : api.createPlan(payload);
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open={open} title={editing ? "编辑计划" : "添加计划"} closeLabel={editing ? "关闭编辑计划" : "关闭添加计划"} onClose={onClose} className="matter-sheet" footer={<button className="primary-button matter-submit" form="plan-form" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{editing ? "保存修改" : "保存计划"}</button>}>
    <form id="plan-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">先记下以后要做的事。付款时再选账户并记账，现在不用绑定账户。</p>
      <label className="matter-field"><span>标题</span><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="预购尾款、想买的东西…" maxLength={100} /></label>
      <div className="matter-form-grid"><label className="matter-field"><span>待付金额 <small>选填</small></span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label><label className="matter-field"><span>到期日 <small>选填</small></span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label></div>
      <label className="matter-field"><span>提前提醒天数</span><input inputMode="numeric" value={reminderDays} onChange={(event) => setReminderDays(event.target.value.replace(/[^\d]/g, ""))} /><small>设置日期后才会提醒。今天是 {dateLabel(today)}。</small></label>
      <label className="matter-field"><span>备注 <small>选填</small></span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={240} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </BottomSheet>;
}

function PlanCompleteForm({ open, onClose, plan, today }: { open: boolean; onClose: () => void; plan: Plan; today: string }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(plan.amountMinor ? (plan.amountMinor / 100).toFixed(2) : "");
  const [paidDate, setPaidDate] = useState(today);
  const [note, setNote] = useState(plan.note ?? "");
  const [error, setError] = useState("");
  const categories = useQuery({ queryKey: ["categories", "expense", false], queryFn: () => api.categories("expense", false) });
  const [linkMode, setLinkMode] = useState<LedgerLinkMode>("create");
  const [linkTransactionId, setLinkTransactionId] = useState("");
  const [linkCategory, setLinkCategory] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accountAmount, setAccountAmount] = useState("");
  const funds = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary });
  const fundsRequired = Boolean(funds.data?.enabled && funds.data.startedOn && paidDate >= funds.data.startedOn);
  const selectedAccountId = accountId || funds.data?.defaultExpenseAccountId || "";
  const selectedAccount = funds.data?.accounts.find((item) => item.id === selectedAccountId);
  const transactions = useQuery({ queryKey: ["transactions", "matter-link-plan"], queryFn: () => api.transactions({ page: 1, pageSize: 50, deleted: "active", sort: "date", kind: "expense" }), enabled: !fundsRequired && linkMode === "existing" });
  const save = useMutation({
    mutationFn: () => {
      const amountMinor = parseAmountMinor(amount);
      if (!amountMinor) throw new Error("请输入有效付款金额");
      const accountAmountMinor = selectedAccount && selectedAccount.currency !== "CNY" ? parseAmountMinor(accountAmount) : undefined;
      if ((fundsRequired || linkMode === "create") && !linkCategory) throw new Error("请选择支出分类");
      if (fundsRequired && !selectedAccount) throw new Error("请选择支付账户");
      if (fundsRequired && selectedAccount?.currency !== "CNY" && !accountAmountMinor) throw new Error(`请填写实际扣款 ${selectedAccount?.currency ?? "外币"}`);
      if (!fundsRequired && linkMode === "existing" && !linkTransactionId) throw new Error("请选择要关联的账目");
      const ledgerLink = fundsRequired
        ? { mode: "create" as const, categoryId: linkCategory, accountId: selectedAccountId, accountAmountMinor }
        : linkMode === "existing"
          ? { mode: "existing" as const, transactionId: linkTransactionId }
          : { mode: "create" as const, categoryId: linkCategory };
      return api.completePlan(plan.id, { expectedUpdatedAt: plan.updatedAt, amountMinor, localDate: paidDate, note: note.trim() || null, ledgerLink });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["matters"] }); await queryClient.invalidateQueries({ queryKey: ["transactions"] }); await queryClient.invalidateQueries({ queryKey: ["funds"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open={open} title="完成并记账" closeLabel="关闭完成计划" onClose={onClose} className="matter-sheet" footer={<button className="primary-button matter-submit" form="plan-complete-form" disabled={save.isPending} type="submit">{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}确认已付款并记账</button>}>
    <form id="plan-complete-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">{plan.title} · 会按实际付款金额记一笔支出，之后计划与账单不再同步。</p>
      <div className="matter-form-grid"><label className="matter-field"><span>实际付款金额</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} /></label><label className="matter-field"><span>付款日期</span><input required type="date" value={paidDate} onChange={(event) => setPaidDate(event.target.value)} /></label></div>
      <label className="matter-field"><span>备注 <small>选填</small></span><input value={note} onChange={(event) => setNote(event.target.value)} /></label>
      {fundsRequired ? <>
        <label className="matter-field"><span>支出分类</span><select required value={linkCategory} onChange={(event) => setLinkCategory(event.target.value)}><option value="">选择分类</option>{(categories.data ?? []).map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label>
        <FundsAccountField accounts={funds.data?.accounts ?? []} value={selectedAccountId} onChange={(value) => { setAccountId(value); setAccountAmount(""); }} label="支付账户" />
        {selectedAccount && selectedAccount.currency !== "CNY" && <label className="matter-field"><span>实际扣款 {selectedAccount.currency} <small>必填</small></span><input required inputMode="decimal" value={accountAmount} onChange={(event) => setAccountAmount(event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label>}
      </> : <>
        <SegmentedControl value={linkMode === "existing" ? "existing" : "create"} label="入账方式" options={[{ value: "create", label: "创建支出" }, { value: "existing", label: "已有账目" }]} onChange={(value) => setLinkMode(value)} />
        {linkMode === "create" && <label className="matter-field"><span>支出分类</span><select required value={linkCategory} onChange={(event) => setLinkCategory(event.target.value)}><option value="">选择分类</option>{(categories.data ?? []).map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label>}
        {linkMode === "existing" && <label className="matter-field"><span>选择账目</span><select value={linkTransactionId} onChange={(event) => setLinkTransactionId(event.target.value)}><option value="">请选择一笔支出</option>{(transactions.data?.items ?? []).map((item) => <option key={item.id} value={item.id}>{dateLabel(item.localDate)} · {item.category?.name ?? "未分类"} · −{money(item.amountMinor)}</option>)}</select></label>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </BottomSheet>;
}

function PlanCard({ plan, today, trash, onEdit, onComplete }: { plan: Plan; today: string; trash?: boolean; onEdit: (plan: Plan) => void; onComplete: (plan: Plan) => void }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"complete" | "delete" | null>(null);
  const due = plan.attentionState === "due" || plan.attentionState === "overdue";
  const remove = useMutation({
    mutationFn: () => api.deletePlan(plan.id, plan.updatedAt),
    onSuccess: () => { setConfirm(null); void queryClient.invalidateQueries({ queryKey: ["matters"] }); }
  });
  const restore = useMutation({ mutationFn: () => api.restorePlan(plan.id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["matters"] }); } });
  const completeOpen = useMutation({
    mutationFn: () => api.completePlan(plan.id, { expectedUpdatedAt: plan.updatedAt }),
    onSuccess: () => { setConfirm(null); void queryClient.invalidateQueries({ queryKey: ["matters"] }); }
  });
  const hint = planDateHint(plan, today);
  return <>
    <article className={`subscription-card ${due ? "is-due" : ""}`}>
    <div className="subscription-card__top"><span className="subscription-card__logo">{plan.title.slice(0, 1)}</span><div className="subscription-card__identity"><strong>{plan.title}</strong><small>{plan.amountMinor == null ? "未填写金额" : amountText(plan.amountMinor, "CNY")}</small></div><span className={`matter-status matter-status--${due ? "due" : plan.status === "completed" ? "active" : plan.status}`}>{plan.status === "open" ? hint : plan.status === "completed" ? "已完成" : "已取消"}</span></div>
    <div className="subscription-card__summary"><div><span>待付金额</span><strong>{plan.amountMinor == null ? "—" : amountText(plan.amountMinor, "CNY")}</strong></div><div><span>到期日</span><strong>{plan.dueDate ? dateLabel(plan.dueDate) : "未设置"}</strong><small>{hint}</small></div><div><span>入账</span><strong>{plan.ledgerLink.mode === "none" ? "尚未记账" : "已关联账单"}</strong><small>{plan.completedAt ? dateLabel(plan.completedAt) : ""}</small></div></div>
    {plan.note && <p className="subscription-card__note">{plan.note}</p>}
    <div className="matter-card-actions">{trash ? <button type="button" className="secondary-button" onClick={() => restore.mutate()}><ArchiveRestore size={16} />恢复计划</button> : <><button type="button" className="primary-button" onClick={() => plan.amountMinor ? onComplete(plan) : setConfirm("complete")} disabled={plan.status !== "open"}><Check size={16} />{plan.amountMinor ? "完成并记账" : "完成"}</button>{plan.status === "open" && <button className="icon-button" type="button" aria-label="编辑计划" onClick={() => onEdit(plan)}><Pencil size={16} /></button>}<button className="icon-button danger-icon" type="button" aria-label="删除计划" onClick={() => setConfirm("delete")}><Trash2 size={16} /></button></>}</div>
    </article>
    {confirm === "complete" && <ConfirmSheet open title="完成计划" closeLabel="关闭完成确认" description="没有金额，完成不会记入账单。" confirmLabel="确认完成" isPending={completeOpen.isPending} onConfirm={() => completeOpen.mutate()} onClose={() => { if (!completeOpen.isPending) setConfirm(null); }} />}
    {confirm === "delete" && <ConfirmSheet open title="移入回收站" closeLabel="关闭删除确认" description="将计划移入回收站？已入账的支出会留在账单里。" confirmLabel="移入回收站" danger isPending={remove.isPending} onConfirm={() => remove.mutate()} onClose={() => { if (!remove.isPending) setConfirm(null); }} />}
  </>;
}

function PlansTab({ today }: { today: string }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [form, setForm] = useState<{ open: boolean; editing?: Plan }>({ open: false });
  const [completing, setCompleting] = useState<Plan>();
  const [showTrash, setShowTrash] = useState(false);
  const planView = parsePlanView(searchParams.get("planView"));
  const planScopeFromUrl = parsePlanScope(searchParams.get("planScope"));
  const plansQuery = useQuery({ queryKey: ["matters", "plans", showTrash], queryFn: () => api.plans({ status: showTrash ? "trash" : "active", pageSize: 100 }) });
  const plans = listOf(plansQuery.data);
  const openPlans = plans.filter((item) => item.status === "open");
  const attention = openPlans.filter((item) => item.attentionState === "due" || item.attentionState === "overdue");
  const undated = openPlans.filter((item) => !item.dueDate && !attention.includes(item));
  const scheduled = openPlans.filter((item) => item.dueDate && item.attentionState === "scheduled");
  const closed = plans.filter((item) => item.status !== "open");
  const completed = closed.filter((item) => item.status === "completed");
  const cancelled = closed.filter((item) => item.status === "cancelled");
  const defaultScope: PlanScope = attention.length > 0 || scheduled.length > 0 ? "dated" : "undated";
  const planScope = planScopeFromUrl ?? defaultScope;
  const openAmount = openPlans.reduce((sum, item) => sum + (item.amountMinor ?? 0), 0);
  const editPlan = (value: Plan) => setForm({ open: true, editing: value });
  const renderCards = (items: Plan[]) => items.map((item) => <PlanCard key={item.id} plan={item} today={today} onEdit={editPlan} onComplete={setCompleting} />);
  const updatePlanParams = (patch: { planView?: PlanView; planScope?: PlanScope }) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "plans");
    const nextView = patch.planView ?? planView;
    if (nextView === "open") next.delete("planView");
    else next.set("planView", "closed");
    if (patch.planScope) next.set("planScope", patch.planScope);
    setSearchParams(next, { replace: true });
  };
  return <>
    {!showTrash && <div className="matter-summary-grid"><article className="matter-summary-grid__main"><span>未完成</span><strong>{openPlans.length} 项</strong></article><article><span>需要留意</span><strong className={attention.length ? "expense-text" : ""}>{attention.length} 项</strong></article><article><span>未完成金额</span><strong>{openAmount ? money(openAmount) : "未填写"}</strong></article></div>}
    <div className="matter-section-heading"><div><h2>{showTrash ? "计划回收站" : "计划列表"}</h2><p>{showTrash ? "删除满 30 天后会自动清理。" : "有金额的计划在完成时才会选账户并记入账单。"}</p></div><div className="matter-heading-actions"><button className="secondary-button" onClick={() => setShowTrash((value) => !value)}>{showTrash ? <RotateCcw size={17} /> : <Archive size={17} />}{showTrash ? "返回计划" : "回收站"}</button>{!showTrash && <button className="primary-button" onClick={() => setForm({ open: true })}><Plus size={17} />添加计划</button>}</div></div>
    {!showTrash && !plansQuery.isLoading && plans.length > 0 && <div className="view-tabs plan-view-tabs" role="tablist" aria-label="计划进度"><button role="tab" aria-selected={planView === "open"} className={planView === "open" ? "is-active" : ""} onClick={() => updatePlanParams({ planView: "open" })}>未完成</button><button role="tab" aria-selected={planView === "closed"} className={planView === "closed" ? "is-active" : ""} onClick={() => updatePlanParams({ planView: "closed" })}>已结束</button></div>}
    {plansQuery.isLoading ? <div className="skeleton matter-skeleton" /> : showTrash ? (plans.length === 0 ? <div className="content-card matter-empty"><CalendarDays size={34} /><strong>回收站为空</strong><p>删除的计划会在这里保留 30 天。</p></div> : <div className="subscription-list">{plans.map((item) => <PlanCard key={item.id} plan={item} today={today} trash onEdit={() => undefined} onComplete={() => undefined} />)}</div>) : plans.length === 0 ? <div className="content-card matter-empty"><CalendarDays size={34} /><strong>还没有计划</strong><p>预购尾款、某天要付的一笔，或还没定日期的打算，都可以放在这里。</p><button className="secondary-button" onClick={() => setForm({ open: true })}><Plus size={16} />添加第一项</button></div> : planView === "open" ? (openPlans.length === 0 ? <div className="content-card matter-empty"><CalendarDays size={34} /><strong>没有未完成的计划</strong><p>已完成或已取消的计划在「已结束」里。</p></div> : <>
      <SegmentedControl className="plan-scope-switch" label="未完成计划范围" value={planScope} options={[{ value: "dated", label: "有日期" }, { value: "undated", label: "无日期" }]} onChange={(value) => updatePlanParams({ planScope: value })} />
      <div className="plan-open-columns" data-scope={planScope}>
        <div className="plan-column plan-column--dated">
          {attention.length > 0 && <section><div className="matter-section-heading matter-section-heading--small"><div><h3>需要留意</h3><p>已经到期或进入提醒窗口的计划。</p></div><span className="matter-count-badge">{attention.length}</span></div><div className="subscription-list">{renderCards(attention)}</div></section>}
          {scheduled.length > 0 && <section><div className="matter-section-heading matter-section-heading--small"><div><h3>尚未到期</h3><p>{scheduled.length} 项还没进入提醒窗口。</p></div></div><div className="subscription-list">{renderCards(scheduled)}</div></section>}
          {attention.length === 0 && scheduled.length === 0 && <div className="content-card matter-empty"><Clock3 size={28} /><strong>没有带日期的计划</strong><p>到期日会让计划出现在这一侧。</p></div>}
        </div>
        <div className="plan-column plan-column--undated">
          {undated.length > 0 ? <section><div className="matter-section-heading matter-section-heading--small"><div><h3>未定期限</h3><p>想做但还没有日期的计划。</p></div></div><div className="subscription-list">{renderCards(undated)}</div></section> : <div className="content-card matter-empty"><Clock3 size={28} /><strong>没有未定期限的计划</strong><p>还没定日期的打算会出现在这一侧。</p></div>}
        </div>
      </div>
    </>) : closed.length === 0 ? <div className="content-card matter-empty"><CalendarDays size={34} /><strong>没有已结束的计划</strong><p>完成或取消后会出现在这里。</p></div> : <div className="subscription-groups">
      {completed.length > 0 && <section><div className="matter-section-heading matter-section-heading--small"><div><h3>已完成</h3></div></div><div className="subscription-list">{renderCards(completed)}</div></section>}
      {cancelled.length > 0 && <section><div className="matter-section-heading matter-section-heading--small"><div><h3>已取消</h3></div></div><div className="subscription-list">{renderCards(cancelled)}</div></section>}
    </div>}
    {form.open && <PlanForm key={form.editing?.id ?? "new-plan"} open onClose={() => { setForm({ open: false }); void queryClient.invalidateQueries({ queryKey: ["matters"] }); }} editing={form.editing} today={today} />}
    {completing && <PlanCompleteForm key={completing.id} open onClose={() => { setCompleting(undefined); void queryClient.invalidateQueries({ queryKey: ["matters"] }); }} plan={completing} today={today} />}
  </>;
}

export function MattersPage() {
  const { today } = useLedgerClock();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseMatterTab(searchParams.get("tab"));
  const setTab = (value: MatterTab) => {
    if (value === "plans") {
      const next = new URLSearchParams(searchParams);
      next.set("tab", "plans");
      setSearchParams(next, { replace: true });
      return;
    }
    setSearchParams({ tab: value }, { replace: true });
  };
  const subscriptionSummaryQuery = useQuery({ queryKey: ["matters", "subscriptions", "badge"], queryFn: api.subscriptionSummary, staleTime: 60_000 });
  const planSummaryQuery = useQuery({ queryKey: ["matters", "plans", "badge"], queryFn: api.planSummary, staleTime: 60_000 });
  const attentionCount = subscriptionSummaryQuery.data?.attentionCount ?? 0;
  const planAttentionCount = planSummaryQuery.data?.attentionCount ?? 0;
  return <div className="page matters-page">
    <header className="page-heading page-heading--row"><div><p className="eyebrow">财务事项</p><h1>借款、订阅与计划</h1><p>把不适合放进日常账单的财务承诺，放在一个容易回看的地方。</p></div><div className="matters-heading-icon"><WalletCards size={25} /></div></header>
    <div className="view-tabs matters-tabs" role="tablist" aria-label="财务事项分类"><button role="tab" aria-selected={tab === "loans"} className={tab === "loans" ? "is-active" : ""} onClick={() => setTab("loans")}>借款</button><button role="tab" aria-selected={tab === "subscriptions"} aria-label={attentionCount > 0 ? `订阅，${attentionCount}项需要留意` : "订阅"} className={tab === "subscriptions" ? "is-active" : ""} onClick={() => setTab("subscriptions")}><span>订阅</span>{attentionCount > 0 && <em className="matter-tab-badge">{attentionCount}</em>}</button><button role="tab" aria-selected={tab === "plans"} aria-label={planAttentionCount > 0 ? `计划，${planAttentionCount}项需要留意` : "计划"} className={tab === "plans" ? "is-active" : ""} onClick={() => setTab("plans")}><span>计划</span>{planAttentionCount > 0 && <em className="matter-tab-badge">{planAttentionCount}</em>}</button></div>
    {tab === "loans" ? <LoansTab today={today} /> : tab === "subscriptions" ? <SubscriptionsTab today={today} /> : <PlansTab today={today} />}
  </div>;
}

export default MattersPage;
