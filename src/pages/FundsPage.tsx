import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Archive,
  ArchiveRestore,
  Check,
  Landmark,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCcw,
  Trash2,
  WalletCards
} from "lucide-react";
import type { Account, Transfer } from "@shared/types";
import { api } from "../api";
import { BottomSheet } from "../components/BottomSheet";
import { MoneyValue } from "../components/MoneyValue";
import { useLedgerClock } from "../ledger-clock";
import { money, parseAmountMinor, signedMoney } from "../utils";

type FundsSheet =
  | { type: "account"; account?: Account }
  | { type: "transfer"; transfer?: Transfer }
  | { type: "adjust"; account?: Account }
  | null;

const presets = [
  { name: "微信", icon: "微" },
  { name: "支付宝", icon: "支" },
  { name: "建设银行", icon: "建" },
  { name: "招商银行", icon: "招" }
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
        openingBalanceMinor: cents(item.balance) ?? 0,
        aliases: []
      }));
      if (input.some((item) => !item.name)) throw new Error("账户名称不能为空");
      if (!input.some((item) => item.name === expenseName) || !input.some((item) => item.name === incomeName)) {
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

  const update = (index: number, key: "name" | "icon" | "balance", value: string) => {
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
      <div><h2>开始资金追踪</h2><p>填写现在真实可用的人民币余额。启用前的旧账不会被追溯，也不会改变这些余额。</p></div>
    </div>
    <div className="funds-activation__accounts">
      {accounts.map((account, index) => <div className="funds-activation-row" key={index}>
        <input className="account-icon-input" aria-label={`第 ${index + 1} 个账户图标`} value={account.icon} maxLength={8} onChange={(event) => update(index, "icon", event.target.value)} />
        <input aria-label={`第 ${index + 1} 个账户名称`} value={account.name} onChange={(event) => update(index, "name", event.target.value)} />
        <label><span>当前余额</span><input inputMode="decimal" value={account.balance} placeholder="0.00" onChange={(event) => update(index, "balance", event.target.value.replace(/[^\d.-]/g, ""))} /></label>
        <button className="icon-button danger-icon" type="button" aria-label={`删除 ${account.name || "账户"}`} onClick={() => remove(index)} disabled={accounts.length === 1}><Trash2 size={16} /></button>
      </div>)}
    </div>
    <button className="secondary-button" type="button" onClick={() => setAccounts((items) => [...items, { name: "", icon: "账", balance: "" }])}><Plus size={16} />增加账户</button>
    <div className="funds-defaults">
      <label><span>默认支出账户</span><select value={expenseName} onChange={(event) => setExpenseName(event.target.value)}>{accounts.filter((item) => item.name.trim()).map((item, index) => <option key={index} value={item.name}>{item.name}</option>)}</select></label>
      <label><span>默认收入账户</span><select value={incomeName} onChange={(event) => setIncomeName(event.target.value)}>{accounts.filter((item) => item.name.trim()).map((item, index) => <option key={index} value={item.name}>{item.name}</option>)}</select></label>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary-button funds-activate-button" type="button" disabled={activate.isPending} onClick={() => activate.mutate()}>
      {activate.isPending ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}确认启用
    </button>
  </section>;
}

function AccountForm({ account, onClose }: { account?: Account; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(account?.name ?? "");
  const [icon, setIcon] = useState(account?.icon ?? "账");
  const [balance, setBalance] = useState("");
  const [aliases, setAliases] = useState(account?.aliases.join("、") ?? "");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => account
      ? api.updateAccount(account.id, { name, icon, aliases: aliases.split(/[、,，]/).map((item) => item.trim()).filter(Boolean), expectedUpdatedAt: account.updatedAt })
      : api.createAccount({ name, icon, openingBalanceMinor: cents(balance) ?? 0, aliases: aliases.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["funds"] }); await queryClient.invalidateQueries({ queryKey: ["accounts"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open title={account ? "编辑资金账户" : "新增资金账户"} closeLabel="关闭账户编辑" onClose={onClose} className="funds-sheet" footer={<button className="primary-button" type="submit" form="account-form" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}保存账户</button>}>
    <form id="account-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div className="matter-form-grid"><label className="matter-field"><span>图标</span><input value={icon} maxLength={8} onChange={(event) => setIcon(event.target.value)} /></label><label className="matter-field"><span>账户名称</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></label></div>
      {!account && <label className="matter-field"><span>初始余额</span><input inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value.replace(/[^\d.-]/g, ""))} placeholder="0.00" /></label>}
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
  const feeMinor = Math.max(0, (cents(debited) ?? 0) - (cents(credited) ?? 0));
  const save = useMutation({
    mutationFn: () => {
      const debitedMinor = cents(debited);
      const creditedMinor = cents(credited);
      if (!debitedMinor || !creditedMinor) throw new Error("请输入有效的扣款和到账金额");
      if (fromId === toId) throw new Error("转出和转入账户不能相同");
      if (debitedMinor < creditedMinor) throw new Error("到账金额不能大于实际扣款金额");
      if (debitedMinor > creditedMinor && !categoryId && !transfer?.feeTransactionId) throw new Error("请选择手续费支出分类");
      const input = { fromAccountId: fromId, toAccountId: toId, debitedMinor, creditedMinor, feeCategoryId: categoryId || undefined, localDate: date, note: note.trim() || null, requestId: crypto.randomUUID() };
      return transfer ? api.updateTransfer(transfer.id, { ...input, expectedUpdatedAt: transfer.updatedAt }) : api.createTransfer(input);
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["funds"] }); await queryClient.invalidateQueries({ queryKey: ["transactions"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "保存失败")
  });
  return <BottomSheet open title={transfer ? "编辑转账" : "记录转账"} closeLabel="关闭转账" onClose={onClose} className="funds-sheet" footer={<button className="primary-button" type="submit" form="transfer-form" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{transfer ? "保存转账" : "确认转账"}</button>}>
    <form id="transfer-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div className="matter-form-grid"><label className="matter-field"><span>转出账户</span><select value={fromId} onChange={(event) => setFromId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.icon} {account.name}</option>)}</select></label><label className="matter-field"><span>转入账户</span><select value={toId} onChange={(event) => setToId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.icon} {account.name}</option>)}</select></label></div>
      <div className="matter-form-grid"><label className="matter-field"><span>实际扣款</span><input autoFocus inputMode="decimal" value={debited} onChange={(event) => setDebited(event.target.value.replace(/[^\d.]/g, ""))} /></label><label className="matter-field"><span>实际到账</span><input inputMode="decimal" value={credited} onChange={(event) => setCredited(event.target.value.replace(/[^\d.]/g, ""))} /></label></div>
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
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const targetBalanceMinor = cents(balance);
      if (targetBalanceMinor === null) throw new Error("请输入实际余额");
      return api.adjustAccount({ accountId, targetBalanceMinor, localDate: date, note: note.trim() || null, requestId: crypto.randomUUID() });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["funds"] }); onClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "校准失败")
  });
  return <BottomSheet open title="校准账户余额" closeLabel="关闭余额校准" onClose={onClose} className="funds-sheet" footer={<button className="primary-button" type="submit" form="adjustment-form" disabled={save.isPending}><RefreshCcw size={17} />保存校准</button>}>
    <form id="adjustment-form" className="matter-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="matter-form-intro">只追加一笔差额流水，不会把差额算成收入或支出。</p>
      <label className="matter-field"><span>账户</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.icon} {item.name} · {money(item.balanceMinor)}</option>)}</select></label>
      <div className="matter-form-grid"><label className="matter-field"><span>现实余额</span><input autoFocus inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value.replace(/[^\d.-]/g, ""))} /></label><label className="matter-field"><span>校准日期</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label></div>
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
  const summaryQuery = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary });
  const accountsQuery = useQuery({ queryKey: ["accounts", showArchived], queryFn: () => api.accounts(showArchived), enabled: summaryQuery.data?.enabled === true });
  const movementsQuery = useQuery({ queryKey: ["funds", "movements"], queryFn: () => api.accountMovements({ pageSize: 30 }), enabled: summaryQuery.data?.enabled === true });
  const transfersQuery = useQuery({ queryKey: ["funds", "transfers", showArchived], queryFn: () => api.transfers(showArchived), enabled: summaryQuery.data?.enabled === true });
  const accounts = accountsQuery.data ?? summaryQuery.data?.accounts ?? [];
  const activeAccounts = accounts.filter((item) => !item.isArchived);
  const accountMap = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
  const archive = useMutation({
    mutationFn: (account: Account) => account.isArchived ? api.restoreAccount(account.id, account.updatedAt) : api.archiveAccount(account.id, account.updatedAt),
    onSuccess: async () => { setAccountActionError(""); await queryClient.invalidateQueries({ queryKey: ["funds"] }); await queryClient.invalidateQueries({ queryKey: ["accounts"] }); },
    onError: (reason) => setAccountActionError(reason instanceof Error ? reason.message : "账户操作失败")
  });
  const removeAccount = useMutation({
    mutationFn: (account: Account) => api.deleteAccount(account.id, account.updatedAt),
    onSuccess: async () => { setAccountActionError(""); await queryClient.invalidateQueries({ queryKey: ["funds"] }); await queryClient.invalidateQueries({ queryKey: ["accounts"] }); },
    onError: (reason) => setAccountActionError(reason instanceof Error ? reason.message : "账户删除失败")
  });
  const removeTransfer = useMutation({
    mutationFn: (transfer: Transfer) => transfer.deletedAt ? api.restoreTransfer(transfer.id, transfer.updatedAt) : api.deleteTransfer(transfer.id, transfer.updatedAt),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["funds"] }); await queryClient.invalidateQueries({ queryKey: ["transactions"] }); }
  });

  if (summaryQuery.isLoading) return <div className="page"><div className="skeleton page-skeleton" /></div>;
  if (!summaryQuery.data?.enabled) return <div className="page funds-page"><header className="page-heading"><p className="eyebrow">资金</p><h1>可用资金</h1><p>只看你现在真正可用的人民币，不把待收借款和未来收入算进去。</p></header><ActivationPanel /></div>;

  return <div className="page funds-page">
    <header className="page-heading page-heading--row"><div><p className="eyebrow">资金</p><h1>可用资金</h1><p>余额来自初始余额与所有资金流水，不单独维护容易失真的余额字段。</p></div><div className="funds-heading-actions"><button className="secondary-button" type="button" onClick={() => setSheet({ type: "adjust" })}><RefreshCcw size={17} />校准</button><button className="primary-button" type="button" onClick={() => setSheet({ type: "transfer" })}><ArrowLeftRight size={17} />转账</button></div></header>

    <section className="funds-summary">
      <article className="funds-summary__total"><span>总资金</span><MoneyValue amountMinor={summaryQuery.data.totalMinor} /></article>
      <article><span>可用账户</span><strong>{summaryQuery.data.accountCount} 个</strong><small>启用于 {summaryQuery.data.startedOn}</small></article>
      <button type="button" onClick={() => setSheet({ type: "account" })}><Plus size={18} /><span>新增账户</span></button>
    </section>

    <section className="ledger-section">
      <div className="section-title section-title--row"><div><h2>账户</h2><p>负数余额允许保留，但会在账本体检中提示。</p></div><button className="text-button" type="button" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "隐藏停用账户" : "查看停用账户"}</button></div>
      {accountActionError && <p className="form-error" role="alert">{accountActionError}</p>}
      <div className="funds-account-grid">{accounts.map((account) => <article className={`funds-account-card ${account.isArchived ? "is-archived" : ""}`} key={account.id}>
        <span className="funds-account-card__icon">{account.icon}</span>
        <div><strong>{account.name}</strong><small>{account.aliases.length ? `别名：${account.aliases.join("、")}` : account.isArchived ? "已停用" : "人民币账户"}</small></div>
        <MoneyValue amountMinor={account.balanceMinor} />
        <div className="funds-account-card__actions"><button className="icon-button" type="button" aria-label={`编辑 ${account.name}`} onClick={() => setSheet({ type: "account", account })}><Pencil size={15} /></button><button className="icon-button" type="button" aria-label={account.isArchived ? `恢复 ${account.name}` : `停用 ${account.name}`} onClick={() => archive.mutate(account)}>{account.isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</button><button className="icon-button" type="button" aria-label={`校准 ${account.name}`} onClick={() => setSheet({ type: "adjust", account })}><RefreshCcw size={15} /></button><button className="icon-button danger-icon" type="button" title="仅未使用账户可以永久删除" aria-label={`永久删除 ${account.name}`} onClick={() => { if (window.confirm(`永久删除未使用账户“${account.name}”？此操作不可撤销。`)) removeAccount.mutate(account); }}><Trash2 size={15} /></button></div>
      </article>)}</div>
    </section>

    <div className="funds-columns">
      <section className="ledger-section"><div className="section-title"><h2>最近资金流水</h2><p>只追加差额，不会回写旧流水。</p></div><div className="funds-movement-list">{(movementsQuery.data?.items ?? []).map((movement) => <div className="funds-movement-row" key={movement.id}><span className={movement.deltaMinor >= 0 ? "is-in" : "is-out"}>{movement.deltaMinor >= 0 ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span><div><strong>{movement.accountName ?? accountMap.get(movement.accountId)?.name ?? "账户"}</strong><small>{movement.localDate} · {movement.sourceType === "transaction" ? "账目" : movement.sourceType === "loan" ? "借出" : movement.sourceType === "loan_repayment" ? "还款" : movement.sourceType === "transfer" ? "转账" : "余额校准"}</small></div><b className={movement.deltaMinor >= 0 ? "income-text" : "expense-text"}>{signedMoney(Math.abs(movement.deltaMinor), movement.deltaMinor >= 0 ? "income" : "expense")}</b></div>)}{movementsQuery.data?.items.length === 0 && <p className="muted-copy">还没有资金流水。</p>}</div></section>
      <section className="ledger-section"><div className="section-title"><h2>转账记录</h2><p>本金不进入收入或支出，差额才是手续费。</p></div><div className="funds-transfer-list">{(transfersQuery.data ?? []).map((transfer) => <div className={`funds-transfer-row ${transfer.deletedAt ? "is-deleted" : ""}`} key={transfer.id}><div><strong>{accountMap.get(transfer.fromAccountId)?.name ?? "账户"} → {accountMap.get(transfer.toAccountId)?.name ?? "账户"}</strong><small>{transfer.localDate}{transfer.feeMinor ? ` · 手续费 ${money(transfer.feeMinor)}` : ""}</small></div><b>{money(transfer.creditedMinor)}</b><button className="icon-button" type="button" aria-label={transfer.deletedAt ? "恢复转账" : "编辑转账"} onClick={() => transfer.deletedAt ? removeTransfer.mutate(transfer) : setSheet({ type: "transfer", transfer })}>{transfer.deletedAt ? <ArchiveRestore size={15} /> : <Pencil size={15} />}</button>{!transfer.deletedAt && <button className="icon-button danger-icon" type="button" aria-label="删除转账" onClick={() => { if (window.confirm("删除转账会同时冲销本金和手续费资金影响，是否继续？")) removeTransfer.mutate(transfer); }}><Trash2 size={15} /></button>}</div>)}{transfersQuery.data?.length === 0 && <p className="muted-copy">还没有转账记录。</p>}</div></section>
    </div>

    {sheet?.type === "account" && <AccountForm account={sheet.account} onClose={() => setSheet(null)} />}
    {sheet?.type === "transfer" && <TransferForm accounts={activeAccounts} transfer={sheet.transfer} today={today} onClose={() => setSheet(null)} />}
    {sheet?.type === "adjust" && <AdjustmentForm accounts={activeAccounts} account={sheet.account} today={today} onClose={() => setSheet(null)} />}
  </div>;
}

export default FundsPage;
