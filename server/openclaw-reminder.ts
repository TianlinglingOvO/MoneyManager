import type { DatabaseSync } from "node:sqlite";
import type { OpenClawReminderStatus } from "../shared/types";
import type { AppConfig } from "./config";
import type { MattersRepository } from "./matters";

const maxAttemptsPerDay = 6;
const requestTimeoutMs = 25_000;

type ReminderState = OpenClawReminderStatus["state"];

function ledgerClock(timezone: string, now: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}

function normalizedTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "09:00";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

export function reminderMessage(date: string, subscriptionCount: number, planCount: number): string {
  const pending = [
    subscriptionCount > 0 ? `${subscriptionCount} 项订阅续费待确认` : "",
    planCount > 0 ? `${planCount} 项计划临近或已逾期` : ""
  ].filter(Boolean).join("、");
  return [
    `SMB 每日待办提醒（账本日期 ${date}）：${pending}。`,
    "请只调用 money-manager 的只读工具 get_subscription_summary 和 get_plan_summary 查看详情，然后用简短中文提醒我：",
    "订阅写名称、金额与币种、续费日期（已逾期要标出）；计划写标题、日期和金额（如有）。",
    "不要调用任何 direct_、propose_ 或 undo 开头的工具，不要修改账本；工具暂时不可用时只说明今天没能读取 SMB。",
    "最后提醒我到 SMB 的「事项」页确认处理。"
  ].join("\n");
}

/**
 * Once per ledger day, after the configured time, asks OpenClaw (through its
 * Gateway `/hooks/agent` endpoint) to remind the owner about subscriptions and
 * plans that need attention. SMB sends counts only; OpenClaw reads details via
 * the read-only MCP tools. Nothing is sent when nothing is pending.
 */
export class OpenClawReminderService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly config: AppConfig,
    private readonly matters: MattersRepository,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  get configured(): boolean {
    return Boolean(this.config.openclawHookUrl && this.config.openclawHookToken && this.config.openclawReminderChannel && this.config.openclawReminderTo);
  }

  private read(): Map<string, string> {
    const rows = this.database.prepare("SELECT key, value FROM settings WHERE key LIKE 'openclaw.reminder.%'")
      .all() as unknown as Array<{ key: string; value: string }>;
    return new Map(rows.map((row) => [row.key.slice("openclaw.reminder.".length), row.value]));
  }

  private write(values: Record<string, string>): void {
    const now = new Date().toISOString();
    const statement = this.database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    for (const [key, value] of Object.entries(values)) statement.run(`openclaw.reminder.${key}`, value, now);
  }

  status(): OpenClawReminderStatus {
    const state = this.read();
    return {
      configured: this.configured,
      time: normalizedTime(this.config.openclawReminderTime),
      lastCheckedDate: state.get("lastCheckedDate") ?? null,
      lastSentDate: state.get("lastSentDate") ?? null,
      lastAttemptAt: state.get("lastAttemptAt") ?? null,
      state: this.configured ? (state.get("state") as ReminderState | undefined) ?? "idle" : "not_configured"
    };
  }

  /** Runs one scheduler tick. Returns what happened, for tests and diagnostics. */
  async tick(now = new Date()): Promise<ReminderState | "skipped"> {
    if (!this.configured) return "skipped";
    const clock = ledgerClock(this.config.timezone, now);
    if (clock.time < normalizedTime(this.config.openclawReminderTime)) return "skipped";
    const state = this.read();
    if (state.get("lastCheckedDate") === clock.date && state.get("state") !== "failed") return "skipped";
    const attempts = state.get("attemptsDate") === clock.date ? Number(state.get("attempts") ?? 0) : 0;
    if (attempts >= maxAttemptsPerDay) return "skipped";

    const subscriptionCount = this.matters.subscriptionSummary(clock.date).attentionCount;
    const planCount = this.matters.planSummary(clock.date).attentionCount;
    if (subscriptionCount + planCount === 0) {
      this.write({ lastCheckedDate: clock.date, state: "nothing" });
      return "nothing";
    }

    this.write({ attemptsDate: clock.date, attempts: String(attempts + 1), lastAttemptAt: now.toISOString() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await this.fetcher(this.config.openclawHookUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.openclawHookToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `smb-reminder-${clock.date}`
        },
        body: JSON.stringify({
          message: reminderMessage(clock.date, subscriptionCount, planCount),
          name: "SMB 每日待办提醒",
          agentId: this.config.openclawHookAgentId,
          channel: this.config.openclawReminderChannel,
          to: this.config.openclawReminderTo,
          timeoutSeconds: 180
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.write({ lastCheckedDate: clock.date, lastSentDate: clock.date, state: "sent" });
      return "sent";
    } catch {
      // 只记录失败状态；不记录地址、令牌或提醒内容。
      this.write({ lastCheckedDate: clock.date, state: "failed" });
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }

  startDailyScheduler(): NodeJS.Timeout {
    void this.tick();
    return setInterval(() => void this.tick(), 5 * 60 * 1000);
  }
}
