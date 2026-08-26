import { useEffect, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HealthIssue, Transaction } from "@shared/types";
import { api } from "../api";
import { money, signedMoney } from "../utils";
import { useToast } from "../toast-context";
import { AccountPicker } from "./AccountPicker";

interface FundsMissingAccountDetailsProps {
  issue: HealthIssue;
  month: string;
}

function noteSummary(note: string | null): string {
  if (!note) return "无备注";
  return note.length > 42 ? `${note.slice(0, 42)}…` : note;
}

export function FundsMissingAccountDetails({ issue, month }: FundsMissingAccountDetailsProps) {
  const queryClient = useQueryClient();
  const notify = useToast();
  const [accountId, setAccountId] = useState("");
  const funds = useQuery({ queryKey: ["funds", "summary"], queryFn: api.fundsSummary });
  const detailQueries = useQueries({
    queries: issue.relatedTransactionIds.map((id) => ({
      queryKey: ["transaction", id],
      queryFn: () => api.transaction(id),
      retry: false
    }))
  });
  const transactions = detailQueries.map((query) => query.data).filter((item): item is Transaction => Boolean(item));
  const cnyAccounts = (funds.data?.accounts ?? []).filter((account) => !account.isArchived && account.currency === "CNY");
  const isLoading = detailQueries.some((query) => query.isLoading);
  const isError = detailQueries.some((query) => query.isError);
  const netMinor = transactions.reduce((total, transaction) => total + (transaction.kind === "income" ? transaction.amountMinor : -transaction.amountMinor), 0);
  const selectedAccount = cnyAccounts.find((account) => account.id === accountId);

  useEffect(() => {
    if (cnyAccounts.some((account) => account.id === accountId)) return;
    setAccountId(cnyAccounts[0]?.id ?? "");
  }, [accountId, cnyAccounts]);

  const assign = useMutation({
    mutationFn: () => api.assignTransactionsAccount({
      accountId,
      transactions: transactions.map((transaction) => ({ id: transaction.id, expectedUpdatedAt: transaction.updatedAt }))
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["health", month] }),
        queryClient.invalidateQueries({ queryKey: ["funds"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] })
      ]);
      notify(`已为 ${transactions.length} 笔账目指定账户`);
    }
  });

  return <div className="health-funds-details">
    {isLoading && <p className="health-funds-details__state" role="status">正在读取账目明细…</p>}
    {isError && <p className="form-error" role="alert">部分账目暂时无法读取，请刷新后重试。</p>}
    {transactions.length > 0 && <div className="health-funds-transaction-list">
      {transactions.map((transaction) => <article key={transaction.id}>
        <span className={`health-funds-transaction-list__kind is-${transaction.kind}`}>{transaction.kind === "expense" ? "支" : "收"}</span>
        <span><strong>{transaction.localDate} · {transaction.category?.name ?? "未分类"}</strong><small>{noteSummary(transaction.note)} · 当前未指定账户</small></span>
        <b className={transaction.kind === "income" ? "income-text" : "expense-text"}>{signedMoney(transaction.amountMinor, transaction.kind)}</b>
      </article>)}
    </div>}
    {transactions.length === issue.relatedTransactionIds.length && transactions.length > 0 && <div className="health-funds-batch">
      <AccountPicker accounts={cnyAccounts} value={accountId} onChange={setAccountId} label="批量指定人民币账户" required />
      {selectedAccount && <p>预计 {selectedAccount.name} 资金净变化：<strong className={netMinor >= 0 ? "income-text" : "expense-text"}>{netMinor >= 0 ? "+" : "−"}{money(Math.abs(netMinor))}</strong></p>}
      <button className="primary-button" type="button" disabled={!accountId || assign.isPending} onClick={() => assign.mutate()}>{assign.isPending ? "正在指定…" : `将 ${transactions.length} 笔全部指定为${selectedAccount?.name ?? "所选账户"}`}</button>
      {assign.isError && <p className="form-error" role="alert">批量指定失败，账目可能已发生变化，请刷新后重试。</p>}
    </div>}
  </div>;
}
