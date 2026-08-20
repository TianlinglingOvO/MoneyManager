import { Bot, PenLine } from "lucide-react";
import { differenceInCalendarDays, format } from "date-fns";
import type { Transaction } from "@shared/types";
import { localDateForTimestamp, useLedgerClock } from "../ledger-clock";
import { money } from "../utils";

function recordedLabel(createdAt: string, today: string, timezone: string): string {
  const createdDateKey = localDateForTimestamp(createdAt, timezone);
  if (!createdDateKey) return "录入日期未知";
  const days = differenceInCalendarDays(new Date(`${today}T12:00:00`), new Date(`${createdDateKey}T12:00:00`));
  if (days === 0) return "今天录入";
  if (days === 1) return "昨天录入";
  if (days === 2) return "前天录入";
  return `${format(new Date(`${createdDateKey}T12:00:00`), "M月d日")}录入`;
}

export function RecentRecordedList({
  items,
  onEdit,
  emptyText = "还没有最近录入"
}: {
  items: Transaction[];
  onEdit?: (transaction: Transaction) => void;
  emptyText?: string;
}) {
  const { today, timezone } = useLedgerClock();
  if (items.length === 0) {
    return <div className="empty-state recent-recorded-empty"><span>录</span><strong>{emptyText}</strong><p>OpenClaw 或你自己新记的账会出现在这里。</p></div>;
  }

  return (
    <div className="recent-recorded-list">
      {items.map((transaction) => (
        <button
          type="button"
          key={transaction.id}
          onClick={() => onEdit?.(transaction)}
          disabled={!onEdit}
          title={onEdit ? "点击编辑这笔账" : undefined}
          aria-label={onEdit ? `编辑${transaction.category?.name ?? "未知分类"}，${transaction.kind === "expense" ? "支出" : "收入"}${money(transaction.amountMinor)}，发生于${format(new Date(`${transaction.localDate}T12:00:00`), "M月d日")}` : undefined}
        >
          <span className="recent-recorded-list__icon" style={{ background: `${transaction.category?.color ?? "#7A7A73"}18`, color: transaction.category?.color }}>
            {transaction.category?.icon ?? "✦"}
          </span>
          <span className="recent-recorded-list__body">
            <strong>{transaction.category?.name ?? "未知分类"}</strong>
            <small>{transaction.note ?? "无备注"}</small>
            <em>
              {transaction.source === "openclaw" ? <Bot size={13} /> : <PenLine size={13} />}
              {transaction.source === "openclaw" ? "OpenClaw" : "手动"}
              <i />发生于 {format(new Date(`${transaction.localDate}T12:00:00`), "M月d日")}
              <i />{recordedLabel(transaction.createdAt, today, timezone)}
            </em>
          </span>
          <span className={`recent-recorded-list__amount is-${transaction.kind}`}>
            {transaction.kind === "expense" ? "−" : "+"}{money(transaction.amountMinor)}{onEdit && <span aria-hidden="true">　›</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
