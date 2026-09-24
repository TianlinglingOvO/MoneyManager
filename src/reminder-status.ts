import type { OpenClawReminderStatus } from "@shared/types";

/** Settings headline for the daily SMB → OpenClaw reminder, relative to the ledger's today. */
export function reminderHeadline(status: OpenClawReminderStatus | undefined, today: string): string {
  if (!status?.configured) return "未启用";
  if (status.state === "failed") return "今日提醒失败，稍后重试";
  if (status.lastSentDate === today) return "今日已提醒";
  if (status.lastCheckedDate === today) return "今日无待办";
  return "今天尚未检查";
}
