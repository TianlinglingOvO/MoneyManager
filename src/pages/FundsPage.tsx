import { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Landmark,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCcw,
  Trash2,
  Undo2,
  WalletCards
} from "lucide-react";
import type { Account, AccountAdjustment, AccountCurrency, Transfer } from "@shared/types";
import { api } from "../api";
import { AccountPicker, formatAccountBalance } from "../components/AccountPicker";
import { BottomSheet } from "../components/BottomSheet";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { DangerConfirmDialog } from "../components/DangerConfirmDialog";
import { MoneyValue } from "../components/MoneyValue";
import { useLedgerClock } from "../ledger-clock";
import { money, parseAmountMinor } from "../utils";

type FundsSheet =
  | { type: "account"; account?: Account }
  | { type: "transfer"; transfer?: Transfer }
  | { type: "adjust"; account?: Account }
  | null;

const accountCurrencies: Array<{ value: AccountCurrency; label: string }> = [
  { value: "CNY", label: "CNY 人民币" }, { value: "USD", label: "USD 美元" }, { value: "USDT", label: "USDT 泰达币" }
];
const presets: Array<{ name: string; icon: string; currency: AccountCurrency }> = [
  { name: "微信", icon: "微", currency: "CNY" },
  { name: "支付宝", icon: "支", currency: "CNY" },
  { name: "建设银行", icon: "建", currency: "CNY" },
  { name: "招商银行", icon: "招", currency: "CNY" }
];

function cents(value: string): number | null {
  return parseAmountMinor(value);
}

function ActivationPanel() {
  const queryClient = useQueryClient();
  const [accounts, setAccounts] = useState(() => presets.map((item) => ({ ...item, balance: "" })));
  const [expenseName, setExpenseName] = useState("微信");
  const [incomeName, setIncomeName] = useState("微信");
  const [error, setError] = useState("");
  const activate = useMutation({
    mutationFn: () => {
      const input = accounts.map((item) => ({
        name: item.name.trim(),
        icon: item.icon.trim() || "账",
        currency: item.currency,
        openingBalanceMinor: cents(item.balance) ?? 0,
        aliases: []
      }));
      if (input.some((item) => !item.name)) throw new Error("账户名称不能为空");
      if (!input.some((item) => item.currency === "CNY")) throw new Error("至少需要一个人民币账户作为默认收支账户");
      if (!input.some((item) => item.currency === "CNY" && item.name === expenseName) || !input.some((item) => item.currency === "CNY" && item.name === incomeName)) {
        throw new Error("请选择有效的默认账户");
      }
      return api.activateFunds({
        accounts: input,
        defaultExpenseAccountName: expenseName,
        defaultIncomeAccountName: incomeName,
        defaultFeeCategoryId: null
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["funds"] });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "启用失败")
  });

  const update = (index: number, key: "name" | "icon" | "currency" | "balance", value: string) => {
    setAccounts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item));
  };
  const remove = (index: number) => {
    setAccounts((items) => {
      if (items.length === 1) return items;
      const removed = items[index]!;
      const next = items.filter((_, itemIndex) => itemIndex !== index);
      if (expenseName === removed.name) setExpenseName(next[0]!.name);
      if (incomeName === removed.name) setIncomeName(next[0]!.name);
      return next;
    });
  };

  return <section className="funds-activation content-card">
    <div className="funds-activation__intro">
      <span className="funds-hero-icon"><WalletCards size={24} /></span>
      <div><h2>开始资金追踪</h2><p>填写每个账户现在真实可用的原币余额。启用前的旧账不会被追溯，也不会改变这些余额。</p></div>
    </div>
    <div className="funds-activation__accounts">
      {accounts.map((account, index) => <div className="funds-activation-row" key={index}>
        <input className="account-icon-input" aria-label={`第 ${index + 1} 个账户图标`} value={account.icon} maxLength={8} onChange={(event) => update(index, "icon", event.target.value)} />
        <input aria-label={`第 ${index + 1} 个账户名称`} value={account.name} onChange={(event) => update(index, "name", event.target.value)} />
        <label className="funds-currency-field"><span>币种</span><select aria-label={`第 ${index + 1} 个账户币种`} value={account.currency} onChange={(event) => update(index, "currency", event.target.value)}>{accountCurrencies.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label><span>当前余额</span><input inputMode="decimal" value={account.balance} placeholder="0.00" onChange={(event) => update(index, "balance", event.target.value.replace(/[^\d.-]/g, ""))} /></label>
        <button className="icon-button danger-icon" type="button" aria-label={`删除 ${account.name || "账户"}`} onClick={() => remove(index)} disabled={accounts.length === 1}><Trash2 size={16} /></button>
      </div>)}
    </div>
    <button className="secondary-button" type="button" onClick={() => setAccounts((items) => [...items, { name: "", icon: "账", currency: "CNY", balance: "" }])}><Plus size={16} />增加账户</button>
    <div className="funds-defaults">
      <label><span>默认支出账户</span><select value={expenseName} onChange={(event) => setExpenseName(event.target.value)}>{accounts.filter((item) => item.currency === "CNY" && item.name.trim()).map((item, index) => <option key={index} value={item.name}>{item.name}</option>)}</select></label>
      <label><span>默认收入账户</span><select value={incomeName} onChange={(event) => setIncomeName(event.target.value)}>{accounts.filter((item) => item.currency === "CNY" && item.name.trim()).map((item, index) => <option key={index} value={item.name}>{item.name}</option>)}</select></label>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary-button funds-activate-button" type="button" disabled={activate.isPending} onClick={() => activate.mutate()}>
      {activate.isPending ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}确认启用
    </button>
  </section>;
}

function AccountForm({ account, today, isDefault, onClose }: { account?: Account; today: string; isDefault: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(account?.name ?? "");
  const [icon, setIcon] = useState(account?.icon ?? "账");
  const [currency, setCurrency] = useState<AccountCurrency>(account?.currency ?? "CNY");
  const initialBalanceMinor = account ? (account.isUnused ? account.openingBalanceMinor : account.balanceMinor) : 0;
  const [balance, setBalance] = useState(account ? (initialBalanceMinor / 100).toFixed(2) : "");
  const [balanceDate, setBalanceDate] = useState(today);
  const [balanceNote, setBalanceNote] = useState("");
  const [aliases, setAliases] = useState(account?.aliases.join("、") ?? "");
  const [error, setError] = useState("");
  const parsedBalanceMinor = cents(balance);
  const balanceChanged = account ? !account.isArchived && parsedBalanceMinor !== null && parsedBalanceMinor !== initialBalanceMinor : false;
  const canEditCurrency = !account || (!account.isArchived && account.isUnused && !isDefault);
  const currencyReason = account?.isArchived ? "请先恢复账户，再修改币种或余额。" : isDefault ? "默认收支账户不能更换币种。" : "已有资金流水或业务引用的账户不能更换币种。";
  const isDirty = name !== (account?.name ?? "")
    || icon !== (account?.icon ?? "账")
    || currency !== (account?.currency ?? "CNY")
    || aliases !== (account?.aliases.join("、") ?? "")
    || (account ? balanceChanged : balance !== "")
    || Boolean(account && !account.isUnused && balanceChanged && (balanceDate !== today || balanceNote.trim()));
  const save = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error("账户名称不能为空");
      if (parsedBalanceMinor === null) throw new Error(account?.isUnused ? "请输入初始余额" : "请输入当前余额");
      const normalizedAliases = aliases.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
      if (!account) return api.createAccount({ name, icon, currency, openingBalanceMinor: parsedBalanceMinor, aliases: normalizedAliases });
      return api.updateAccount(account.id, {
        name, icon, ...(canEditCurrency ? { currency } : {}), aliases: normalizedAliases, expectedUpdatedAt: account.updatedAt,
        ...(balanceChanged ? { balanceChange: { targetBalanceMinor: parsedBalanceMinor, localDate: account.isUnused ? today : balanceDate, note: account.isUnused ? null : balanceNote.trim() || null, requestId: crypto.randomUUID() } } : {})
      });
    },
    onSuccess: () => { void Promise.all([queryClient.invalidateQueries({ queryKey: ["funds"] }), queryClient.invalidateQueries({ queryKey: ["accounts"] }), queryClient.invalidateQueries({ queryKey: ["insights"] })]); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open title={account ? "编辑资金账户" : "新增资金账户"} closeLabel="关闭账户编辑" onClose={onClose} dirty={isDirty} discardDescription="当前账户修改尚未保存，关闭后会丢失。" busy={save.isPending} className="funds-sheet" footer={<button className="primary-button" type="submit" form="account-form" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}保存账户</button>}>
    <form id="account-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div className="matter-form-grid"><label className="matter-field"><span>图标</span><input value={icon} maxLength={8} onChange={(event) => setIcon(event.target.value)} /></label><label className="matter-field"><span>账户名称</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></label></div>
      <label className="matter-field"><span>币种 <small id="account-currency-help">{canEditCurrency ? "只更改资金单位，不会换算数值" : currencyReason}</small></span><select value={currency} disabled={!canEditCurrency} aria-describedby="account-currency-help" onChange={(event) => setCurrency(event.target.value as AccountCurrency)}>{accountCurrencies.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="matter-field"><span>{account?.isUnused || !account ? "初始余额" : "当前余额"} <small>{account?.isUnused ? "未使用账户会直接修改初始余额" : account ? "修改后将自动生成余额校准" : "可填写负数"}</small></span><input inputMode="decimal" value={balance} disabled={account?.isArchived} aria-describedby={account?.isArchived ? "account-currency-help" : undefined} onChange={(event) => setBalance(event.target.value.replace(/[^\d.-]/g, ""))} placeholder="0.00" /></label>
      {account && !account.isUnused && balanceChanged && <div className="funds-balance-change-fields"><p className="matter-form-intro">保存后会追加一条余额校准记录，不会计入收入、支出或最近资金流水。</p><div className="matter-form-grid"><label className="matter-field"><span>校准日期</span><input type="date" value={balanceDate} onChange={(event) => setBalanceDate(event.target.value)} /></label><label className="matter-field"><span>说明 <small>选填</small></span><input value={balanceNote} onChange={(event) => setBalanceNote(event.target.value)} placeholder="例如：对照银行余额" /></label></div></div>}
      <label className="matter-field"><span>别名 <small>用顿号分隔，供 OpenClaw 精确识别</small></span><input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="例如：微信钱包、零钱" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </BottomSheet>;
}

function TransferForm({ accounts, transfer, today, onClose }: { accounts: Account[]; transfer?: Transfer; today: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [fromId, setFromId] = useState(transfer?.fromAccountId ?? accounts[0]?.id ?? "");
  const [toId, setToId] = useState(transfer?.toAccountId ?? accounts[1]?.id ?? accounts[0]?.id ?? "");
  const [debited, setDebited] = useState(transfer ? (transfer.debitedMinor / 100).toFixed(2) : "");
  const [credited, setCredited] = useState(transfer ? (transfer.creditedMinor / 100).toFixed(2) : "");
  const [date, setDate] = useState(transfer?.localDate ?? today);
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState(transfer?.note ?? "");
  const [error, setError] = useState("");
  const expenseCategories = useQuery({ queryKey: ["categories", "expense", false], queryFn: () => api.categories("expense", false) });
  const fromAccount = accounts.find((account) => account.id === fromId);
  const toAccount = accounts.find((account) => account.id === toId);
  const isCnyTransfer = fromAccount?.currency === "CNY" && toAccount?.currency === "CNY";
  const transferCurrency = fromAccount?.currency ?? toAccount?.currency ?? "CNY";
  const feeMinor = isCnyTransfer ? Math.max(0, (cents(debited) ?? 0) - (cents(credited) ?? 0)) : 0;
  const save = useMutation({
    mutationFn: () => {
      const debitedMinor = cents(debited);
      const creditedMinor = cents(credited);
      if (!debitedMinor || !creditedMinor) throw new Error("请输入有效的扣款和到账金额");
      if (fromId === toId) throw new Error("转出和转入账户不能相同");
      if (!fromAccount || !toAccount || fromAccount.currency !== toAccount.currency) throw new Error("转账仅支持相同币种的账户");
      if (fromAccount.currency !== "CNY" && debitedMinor !== creditedMinor) throw new Error("外币转账不记录手续费，扣款和到账金额必须一致");
      if (debitedMinor < creditedMinor) throw new Error("到账金额不能大于实际扣款金额");
      if (debitedMinor > creditedMinor && !categoryId && !transfer?.feeTransactionId) throw new Error("请选择手续费支出分类");
      const input = { fromAccountId: fromId, toAccountId: toId, debitedMinor, creditedMinor, feeCategoryId: categoryId || undefined, localDate: date, note: note.trim() || null, requestId: crypto.randomUUID() };
      return transfer ? api.updateTransfer(transfer.id, { ...input, expectedUpdatedAt: transfer.updatedAt }) : api.createTransfer(input);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["funds"] }); void queryClient.invalidateQueries({ queryKey: ["transactions"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open title={transfer ? "编辑转账" : "记录转账"} closeLabel="关闭转账" onClose={onClose} className="funds-sheet" footer={<button className="primary-button" type="submit" form="transfer-form" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{transfer ? "保存转账" : "确认转账"}</button>}>
    <form id="transfer-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div className="matter-form-grid"><label className="matter-field"><span>转出账户</span><select value={fromId} onChange={(event) => setFromId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.icon} {account.name} · {formatAccountBalance(account.balanceMinor, account.currency)}</option>)}</select></label><label className="matter-field"><span>转入账户</span><select value={toId} onChange={(event) => setToId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.icon} {account.name} · {formatAccountBalance(account.balanceMinor, account.currency)}</option>)}</select></label></div>
      <div className="matter-form-grid"><label className="matter-field"><span>实际扣款（{transferCurrency}）</span><input autoFocus inputMode="decimal" value={debited} onChange={(event) => setDebited(event.target.value.replace(/[^\d.]/g, ""))} /></label><label className="matter-field"><span>实际到账（{toAccount?.currency ?? transferCurrency}）</span><input inputMode="decimal" value={credited} onChange={(event) => setCredited(event.target.value.replace(/[^\d.]/g, ""))} /></label></div>
      {fromAccount && toAccount && fromAccount.currency !== toAccount.currency ? <p className="form-error" role="alert">请选择两个相同币种的账户。</p> : fromAccount?.currency !== "CNY" ? <p className="matter-form-intro">外币转账按原币等额记录，不产生人民币手续费账目。</p> : null}
      {feeMinor > 0 && <label className="matter-field"><span>手续费分类 <small>{money(feeMinor)}</small></span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">请选择</option>{expenseCategories.data?.map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label>}
      <div className="matter-form-grid"><label className="matter-field"><span>发生日期</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="matter-field"><span>备注 <small>选填</small></span><input value={note} onChange={(event) => setNote(event.target.value)} /></label></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </BottomSheet>;
}

function AdjustmentForm({ accounts, account, today, onClose }: { accounts: Account[]; account?: Account; today: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState(account?.id ?? accounts[0]?.id ?? "");
  const [balance, setBalance] = useState(account ? (account.balanceMinor / 100).toFixed(2) : "");
  const selectedAccount = accounts.find((item) => item.id === accountId);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const targetBalanceMinor = cents(balance);
      if (targetBalanceMinor === null) throw new Error("请输入实际余额");
      return api.adjustAccount({ accountId, targetBalanceMinor, localDate: date, note: note.trim() || null, requestId: crypto.randomUUID() });
    },
    onSuccess: () => { void Promise.all([queryClient.invalidateQueries({ queryKey: ["funds"] }), queryClient.invalidateQueries({ queryKey: ["accounts"] }), queryClient.invalidateQueries({ queryKey: ["insights"] })]); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "校准失败")
  });
  return <BottomSheet open title="校准账户余额" closeLabel="关闭余额校准" onClose={onClose} className="funds-sheet" footer={<button className="primary-button" type="submit" form="adjustment-form" disabled={save.isPending}><RefreshCcw size={17} />保存校准</button>}>
    <form id="adjustment-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">只追加一笔差额流水，不会把差额算成收入或支出。</p>
      <AccountPicker accounts={accounts} value={accountId} onChange={(value) => { setAccountId(value); const next = accounts.find((item) => item.id === value); setBalance(next ? (next.balanceMinor / 100).toFixed(2) : ""); }} label="账户" required />
      <div className="matter-form-grid"><label className="matter-field"><span>现实余额（{selectedAccount?.currency ?? "CNY"}）</span><input inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value.replace(/[^\d.-]/g, ""))} /></label><label className="matter-field"><span>校准日期</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label></div>
      <label className="matter-field"><span>说明 <small>选填</small></span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：对照银行余额" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </BottomSheet>;
}

export function FundsPage() {
  const queryClient = useQueryClient();
  const { today } = useLedgerClock();
  const [sheet, setSheet] = useState<FundsSheet>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [accountActionError, setAccountActionError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [adjustmentActionError, setAdjustmentActionError] = useState("");
  const [transferToDelete, setTransferToDelete] = useState<Transfer | null>(null);
  const summaryQuery = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary });
  const accountsQuery = useQuery({ queryKey: ["accounts", showArchived], queryFn: () => api.accounts(showArchived), enabled: summaryQuery.data?.enabled === true });
  const movementsQuery = useInfiniteQuery({
    queryKey: ["funds", "movements"],
    queryFn: ({ pageParam }) => api.accountMovements({ page: pageParam, pageSize: 30, sort: "recent" }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.page * lastPage.pageSize < lastPage.total ? lastPage.page + 1 : undefined,
    enabled: summaryQuery.data?.enabled === true
  });
  const transfersQuery = useQuery({ queryKey: ["funds", "transfers", showArchived], queryFn: () => api.transfers(showArchived), enabled: summaryQuery.data?.enabled === true });
  const adjustmentsQuery = useInfiniteQuery({
    queryKey: ["funds", "adjustments"],
    queryFn: ({ pageParam }) => api.accountAdjustments({ page: pageParam, pageSize: 30 }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.page * lastPage.pageSize < lastPage.total ? lastPage.page + 1 : undefined,
    enabled: summaryQuery.data?.enabled === true && showAdjustments
  });
  const adjustmentItems = adjustmentsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const movementItems = (movementsQuery.data?.pages.flatMap((page) => page.items) ?? []).filter((movement) => movement.sourceType !== "adjustment");
  const accounts = accountsQuery.data ?? summaryQuery.data?.accounts ?? [];
  const activeAccounts = accounts.filter((item) => !item.isArchived);
  const accountMap = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
  const otherCurrencyBalances = (["USD", "USDT"] as const).filter((currency) => (summaryQuery.data?.currencyTotals[currency] ?? 0) !== 0)
    .map((currency) => formatAccountBalance(summaryQuery.data!.currencyTotals[currency], currency));
  const archive = useMutation({
    mutationFn: (account: Account) => account.isArchived ? api.restoreAccount(account.id, account.updatedAt) : api.archiveAccount(account.id, account.updatedAt),
    onSuccess: async () => { setAccountActionError(""); await queryClient.invalidateQueries({ queryKey: ["funds"] }); await queryClient.invalidateQueries({ queryKey: ["accounts"] }); },
    onError: (reason) => setAccountActionError(reason instanceof Error ? reason.message : "账户操作失败")
  });
  const removeAccount = useMutation({
    mutationFn: (account: Account) => api.deleteAccount(account.id, account.updatedAt),
    onSuccess: async () => { setDeleteTarget(null); setAccountActionError(""); await Promise.all([queryClient.invalidateQueries({ queryKey: ["funds"] }), queryClient.invalidateQueries({ queryKey: ["accounts"] }), queryClient.invalidateQueries({ queryKey: ["insights"] })]); },
    onError: (reason) => setAccountActionError(reason instanceof Error ? reason.message : "账户删除失败")
  });
  const undoAdjustment = useMutation({
    mutationFn: (adjustment: AccountAdjustment) => api.undoAccountAdjustment(adjustment.id, { expectedUpdatedAt: adjustment.updatedAt, requestId: crypto.randomUUID() }),
    onSuccess: async () => {
      setAdjustmentActionError("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["funds", "adjustments"] }),
        queryClient.invalidateQueries({ queryKey: ["funds", "movements"] }),
        queryClient.invalidateQueries({ queryKey: ["funds", "summary"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["insights"] })
      ]);
    },
    onError: (reason) => setAdjustmentActionError(reason instanceof Error ? reason.message : "校准撤销失败")
  });

  const removeTransfer = useMutation({
    mutationFn: (transfer: Transfer) => transfer.deletedAt ? api.restoreTransfer(transfer.id, transfer.updatedAt) : api.deleteTransfer(transfer.id, transfer.updatedAt),
    onSuccess: () => {
      setTransferToDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["funds"] });
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    }
  });

  if (summaryQuery.isLoading) return <div className="page"><div className="skeleton page-skeleton" /></div>;
  if (!summaryQuery.data?.enabled) return <div className="page funds-page"><header className="page-heading"><p className="eyebrow">资金</p><h1>可用资金</h1><p>记录各账户现在真正可用的余额；人民币总额与外币余额分开显示。</p></header><ActivationPanel /></div>;

  return <div className="page funds-page">
    <header className="page-heading page-heading--row"><div><p className="eyebrow">资金</p><h1>可用资金</h1><p>余额按账户币种记录，并随记账、转账、借款和还款自动更新。</p></div><div className="funds-heading-actions"><button className="secondary-button" type="button" onClick={() => setSheet({ type: "adjust" })}><RefreshCcw size={17} />校准</button><button className="primary-button" type="button" onClick={() => setSheet({ type: "transfer" })}><ArrowLeftRight size={17} />转账</button></div></header>

    <section className="funds-summary">
      <article className="funds-summary__total"><span>人民币可用资金</span><MoneyValue amountMinor={summaryQuery.data.totalMinor} />{otherCurrencyBalances.length > 0 && <small>其他币种：{otherCurrencyBalances.join(" · ")}</small>}</article>
      <article><span>可用账户</span><strong>{summaryQuery.data.accountCount} 个</strong><small>启用于 {summaryQuery.data.startedOn}</small></article>
      <button type="button" onClick={() => setSheet({ type: "account" })}><Plus size={18} /><span>新增账户</span></button>
    </section>

    <section className="ledger-section">
      <div className="section-title section-title--row"><div><h2>账户</h2><p>负数余额允许保留，但会在账本体检中提示。</p></div><button className="text-button" type="button" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "隐藏停用账户" : "查看停用账户"}</button></div>
      {accountActionError && <p className="form-error" role="alert">{accountActionError}</p>}
      <div className="funds-account-grid">{accounts.map((account) => <article className={`funds-account-card ${account.isArchived ? "is-archived" : ""}`} key={account.id}>
        <span className="funds-account-card__icon">{account.icon}</span>
        <div><strong>{account.name}</strong><small>{account.currency} 账户{account.isArchived ? " · 已停用" : account.aliases.length ? ` · 别名：${account.aliases.join("、")}` : ""}</small></div>
        <MoneyValue amountMinor={account.balanceMinor} currency={account.currency} />
        <div className="funds-account-card__actions"><button className="icon-button" type="button" aria-label={"编辑 " + account.name} onClick={() => setSheet({ type: "account", account })}><Pencil size={15} /></button><button className="icon-button" type="button" aria-label={(account.isArchived ? "恢复 " : "停用 ") + account.name} onClick={() => archive.mutate(account)}>{account.isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</button><button className="icon-button" type="button" aria-label={"校准 " + account.name} title={account.isArchived ? "请先恢复账户，再校准余额" : "校准账户余额"} disabled={account.isArchived} onClick={() => setSheet({ type: "adjust", account })}><RefreshCcw size={15} /></button><button className="icon-button danger-icon" type="button" title={!account.isUnused ? "已有资金记录的账户不能永久删除" : summaryQuery.data.defaultExpenseAccountId === account.id || summaryQuery.data.defaultIncomeAccountId === account.id ? "默认收支账户不能永久删除" : "永久删除未使用账户"} aria-label={"永久删除 " + account.name} disabled={!account.isUnused || summaryQuery.data.defaultExpenseAccountId === account.id || summaryQuery.data.defaultIncomeAccountId === account.id} onClick={() => { setAccountActionError(""); setDeleteTarget(account); }}><Trash2 size={15} /></button></div>
      </article>)}</div>
    </section>

    <div className="funds-columns">
      <section className="ledger-section"><div className="section-title"><h2>最近资金流水</h2><p>展示记账、转账、借款和还款，不含余额校准。最新发生的在上。</p></div><div className="funds-movement-list" onScroll={(event) => {
        const node = event.currentTarget;
        if (node.scrollTop + node.clientHeight < node.scrollHeight - 48) return;
        if (movementsQuery.hasNextPage && !movementsQuery.isFetchingNextPage) void movementsQuery.fetchNextPage();
      }}>{movementItems.map((movement) => {
        const movementAccount = accountMap.get(movement.accountId);
        return <div className="funds-movement-row" key={movement.id}><span className={movement.deltaMinor >= 0 ? "is-in" : "is-out"}>{movement.deltaMinor >= 0 ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span><div><strong>{movement.accountName ?? movementAccount?.name ?? "账户"}</strong><small>{movement.localDate} · {movement.sourceType === "transaction" ? "账目" : movement.sourceType === "loan" ? "借出" : movement.sourceType === "loan_repayment" ? "还款" : movement.sourceType === "transfer" ? "转账" : "余额校准"}</small></div><b className={movement.deltaMinor >= 0 ? "income-text" : "expense-text"}>{movement.deltaMinor >= 0 ? "+" : "−"}{formatAccountBalance(Math.abs(movement.deltaMinor), movement.currency)}</b></div>;
      })}{movementItems.length === 0 && <p className="muted-copy">还没有资金流水。</p>}{movementsQuery.hasNextPage && <button className="secondary-button funds-movements-load-more" type="button" disabled={movementsQuery.isFetchingNextPage} onClick={() => movementsQuery.fetchNextPage()}>{movementsQuery.isFetchingNextPage ? <><LoaderCircle className="spin" size={16} />加载中</> : "加载更多"}</button>}</div></section>
      <section className="ledger-section"><div className="section-title"><h2>转账记录</h2><p>人民币账户的扣到账差额可记录手续费；外币按原币等额转账。</p></div><div className="funds-transfer-list">{(transfersQuery.data ?? []).map((transfer) => {
        const fromAccount = accountMap.get(transfer.fromAccountId);
        const toAccount = accountMap.get(transfer.toAccountId);
        const currency = transfer.currency;
        return <div className={`funds-transfer-row ${transfer.deletedAt ? "is-deleted" : ""}`} key={transfer.id}><div><strong>{fromAccount?.name ?? "账户"} → {toAccount?.name ?? "账户"}</strong><small>{transfer.localDate}{transfer.feeMinor && currency === "CNY" ? ` · 手续费 ${money(transfer.feeMinor)}` : ""}</small></div><b>{formatAccountBalance(transfer.creditedMinor, currency)}</b><button className="icon-button" type="button" aria-label={transfer.deletedAt ? "恢复转账" : "编辑转账"} onClick={() => transfer.deletedAt ? removeTransfer.mutate(transfer) : setSheet({ type: "transfer", transfer })}>{transfer.deletedAt ? <ArchiveRestore size={15} /> : <Pencil size={15} />}</button>{!transfer.deletedAt && <button className="icon-button danger-icon" type="button" aria-label="删除转账" onClick={() => { removeTransfer.reset(); setTransferToDelete(transfer); }}><Trash2 size={15} /></button>}</div>;
      })}{transfersQuery.data?.length === 0 && <p className="muted-copy">还没有转账记录。</p>}</div></section>
    </div>


    <section className="ledger-section funds-adjustments-section">
      <button className="funds-adjustments-toggle" type="button" aria-expanded={showAdjustments} aria-controls="funds-adjustments-panel" onClick={() => setShowAdjustments((value) => !value)}>
        <div><strong className="funds-adjustments-toggle__title">余额校准记录</strong><p>独立保存余额修正，不计入普通资金流水和收支统计。</p></div>
        <ChevronDown className={showAdjustments ? "is-open" : ""} size={20} />
      </button>
      {showAdjustments && <div id="funds-adjustments-panel" className="funds-adjustments-panel">
        {adjustmentActionError && <p className="form-error" role="alert">{adjustmentActionError}</p>}
        {adjustmentsQuery.isLoading ? <div className="skeleton funds-adjustments-skeleton" /> : adjustmentsQuery.isError ? <p className="form-error" role="alert">校准记录加载失败，请稍后重试。</p> : <div className="funds-adjustment-list">
          {adjustmentItems.map((adjustment) => {
            const adjustmentAccount = accountMap.get(adjustment.accountId);
            const currency = adjustment.currency ?? adjustmentAccount?.currency ?? "CNY";
            return <article className="funds-adjustment-row" key={adjustment.id}>
              <div><strong>{adjustment.accountName ?? adjustmentAccount?.name ?? "账户"}</strong><small>{adjustment.localDate}{adjustment.note ? " · " + adjustment.note : ""}</small></div>
              <div className="funds-adjustment-row__balances"><span>{formatAccountBalance(adjustment.balanceBeforeMinor, currency)} → {formatAccountBalance(adjustment.targetBalanceMinor, currency)}</span><b className={adjustment.deltaMinor >= 0 ? "income-text" : "expense-text"}>{adjustment.deltaMinor >= 0 ? "+" : "−"}{formatAccountBalance(Math.abs(adjustment.deltaMinor), currency)}</b></div>
              <button className="secondary-button funds-adjustment-undo" type="button" aria-label={"撤销 " + (adjustment.accountName ?? adjustmentAccount?.name ?? "账户") + " " + adjustment.localDate + " 的余额校准"} disabled={!adjustment.canUndo || undoAdjustment.isPending} title={adjustment.canUndo ? "撤销这条最新校准" : "每个账户只能撤销最新一条校准"} onClick={() => undoAdjustment.mutate(adjustment)}><Undo2 size={15} />撤销</button>
            </article>;
          })}
          {adjustmentItems.length === 0 && <p className="muted-copy">还没有余额校准记录。</p>}
          {adjustmentsQuery.hasNextPage && <button className="secondary-button funds-adjustments-load-more" type="button" disabled={adjustmentsQuery.isFetchingNextPage} onClick={() => adjustmentsQuery.fetchNextPage()}>{adjustmentsQuery.isFetchingNextPage ? <><LoaderCircle className="spin" size={16} />加载中</> : "加载更多"}</button>}
        </div>}
      </div>}
    </section>

    {sheet?.type === "account" && <AccountForm account={sheet.account} today={today} isDefault={Boolean(sheet.account && (summaryQuery.data.defaultExpenseAccountId === sheet.account.id || summaryQuery.data.defaultIncomeAccountId === sheet.account.id))} onClose={() => setSheet(null)} />}
    {sheet?.type === "transfer" && <TransferForm accounts={activeAccounts} transfer={sheet.transfer} today={today} onClose={() => setSheet(null)} />}
    {sheet?.type === "adjust" && <AdjustmentForm accounts={activeAccounts} account={sheet.account} today={today} onClose={() => setSheet(null)} />}

    {deleteTarget && <DangerConfirmDialog
      title="永久删除资金账户"
      description={"“" + deleteTarget.name + "”没有任何资金记录。删除后无法恢复，账户的初始余额会被直接丢弃。"}
      details={<><span>将丢弃的账户余额</span><strong>{formatAccountBalance(deleteTarget.openingBalanceMinor, deleteTarget.currency)}</strong></>}
      confirmLabel="永久删除"
      isPending={removeAccount.isPending}
      error={accountActionError || null}
      onConfirm={() => removeAccount.mutate(deleteTarget)}
      onClose={() => { if (!removeAccount.isPending) { setDeleteTarget(null); setAccountActionError(""); } }}
    />}
    <ConfirmSheet
      open={Boolean(transferToDelete)}
      title="删除转账"
      closeLabel="关闭删除转账确认"
      description="删除转账会同时冲销本金和手续费的资金影响。之后可在“查看停用账户”中找到并恢复这笔转账。"
      confirmLabel="删除转账"
      danger
      isPending={removeTransfer.isPending}
      error={removeTransfer.isError ? (removeTransfer.error instanceof Error ? removeTransfer.error.message : "删除转账失败") : null}
      onConfirm={() => transferToDelete && removeTransfer.mutate(transferToDelete)}
      onClose={() => { if (!removeTransfer.isPending) setTransferToDelete(null); }}
    />
  </div>;
}

export default FundsPage;
