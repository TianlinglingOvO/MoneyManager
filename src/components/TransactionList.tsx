import { ChevronRight, RotateCcw, Trash2 } from "lucide-react";
import type { DailyTransactionTotal, Transaction } from "@shared/types";
import { localDateForTimestamp, useLedgerClock } from "../ledger-clock";
import { friendlyDate, money, signedMoney } from "../utils";

interface TransactionListProps {
  items: Transaction[];
  onEdit?: (transaction: Transaction) => void;
  onRestore?: (transaction: Transaction) => void;
  onPermanentDelete?: (transaction: Transaction) => void;
  compact?: boolean;
  emptyText?: string;
  dailyTotals?: DailyTransactionTotal[];
}

export function TransactionList({ items, onEdit, onRestore, onPermanentDelete, compact = false, emptyText = "还没有账目", dailyTotals = [] }: TransactionListProps) {
  const { timezone } = useLedgerClock();
  if (items.length === 0) {
    return <div className="empty-state"><span>记</span><strong>{emptyText}</strong><p>每一笔小记录，都会让生活更清楚。</p></div>;
  }

  const trashMode = items.some((item) => Boolean(item.deletedAt));
  const groups = items.reduce<Record<string, Transaction[]>>((result, item) => {
    const groupDate = trashMode && item.deletedAt ? (localDateForTimestamp(item.deletedAt, timezone) ?? item.localDate) : item.localDate;
    (result[groupDate] ??= []).push(item);
    return result;
  }, {});
  const totalsByDate = new Map(dailyTotals.map((item) => [item.localDate, item]));

  return (
    <div className={`transaction-groups ${compact ? "is-compact" : ""}`}>
      {Object.entries(groups).map(([date, transactions]) => {
        const dailyTotal = totalsByDate.get(date);
        return <section className="transaction-group" key={date}>
          {compact ? (
            <div className="compact-date-divider"><span>{friendlyDate(date)}</span></div>
          ) : (
            <h3 className="transaction-group__heading">
              <span className="transaction-group__date">{trashMode ? `删除于 ${friendlyDate(date)}` : friendlyDate(date)}</span>
              <span className="transaction-group__count">{dailyTotal?.transactionCount ?? transactions.length} 笔</span>
              {dailyTotal && (
                <span className="transaction-group__totals">
                  {dailyTotal.incomeMinor > 0 && <b className="income-text">收入 {money(dailyTotal.incomeMinor)}</b>}
                  {dailyTotal.expenseMinor > 0 && <b className="expense-text">支出 {money(dailyTotal.expenseMinor)}</b>}
                </span>
              )}
            </h3>
          )}
          <div className="transaction-list">
            {transactions.map((transaction) => {
              const canEdit = !transaction.deletedAt && Boolean(onEdit);
              return (
              <div
                className="transaction-row"
                key={transaction.id}
                role={canEdit ? "button" : undefined}
                tabIndex={canEdit ? 0 : undefined}
                aria-label={canEdit ? `编辑${transaction.category?.name ?? "未知分类"}账目，${signedMoney(transaction.amountMinor, transaction.kind)}` : undefined}
                title={canEdit ? "点击编辑这笔账" : undefined}
                onClick={() => canEdit && onEdit?.(transaction)}
                onKeyDown={(event) => {
                  if (canEdit && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onEdit?.(transaction);
                  }
                }}
              >
                <span className="transaction-row__icon" style={{ background: `${transaction.category?.color ?? "#7A7A73"}18`, color: transaction.category?.color }}>
                  {transaction.category?.icon ?? "✦"}
                </span>
                <span className="transaction-row__body">
                  <strong>{transaction.category?.name ?? "未知分类"}</strong>
                  <small>{transaction.note ?? "无备注"}</small>
                  {transaction.deletedAt && <small>发生于 {transaction.localDate}</small>}
                </span>
                <span className="transaction-row__trailing">
                  <span className={`transaction-row__amount is-${transaction.kind}`}>{signedMoney(transaction.amountMinor, transaction.kind)}</span>
                  {canEdit && <ChevronRight className="transaction-row__edit" size={18} aria-hidden="true" />}
                </span>
                {transaction.deletedAt && (onRestore || onPermanentDelete) && (
                  <span className="transaction-row__trash-actions">
                    {onRestore && <button type="button" className="restore-button" onClick={(event) => { event.stopPropagation(); onRestore(transaction); }}><RotateCcw size={15} />恢复</button>}
                    {onPermanentDelete && <button type="button" className="permanent-delete-button" onClick={(event) => { event.stopPropagation(); onPermanentDelete(transaction); }}><Trash2 size={15} />永久删除</button>}
                  </span>
                )}
              </div>
              );
            })}
          </div>
        </section>;
      })}
    </div>
  );
}
