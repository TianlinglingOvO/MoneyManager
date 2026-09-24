import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawReminderService, reminderMessage } from "../server/openclaw-reminder";
import type { MattersRepository } from "../server/matters";
import { createTestContext, type TestContext } from "./helpers";

const hookConfig = {
  timezone: "Asia/Shanghai",
  openclawHookUrl: "http://127.0.0.1:18789/hooks/agent",
  openclawHookToken: "hook-token-for-tests-only",
  openclawHookAgentId: "main",
  openclawReminderChannel: "telegram",
  openclawReminderTo: "10001",
  openclawReminderTime: "09:00"
};

function mattersWith(counts: { subscriptions: number; plans: number }, seen: string[] = []): MattersRepository {
  return {
    subscriptionSummary: (today: string) => { seen.push(today); return { attentionCount: counts.subscriptions }; },
    planSummary: (today: string) => { seen.push(today); return { attentionCount: counts.plans }; }
  } as unknown as MattersRepository;
}

describe("SMB → OpenClaw 每日提醒", () => {
  let context: TestContext;
  beforeEach(() => { context = createTestContext(hookConfig); });
  afterEach(() => { context.cleanup(); });

  it("未配置时不请求，状态显示未配置", async () => {
    const local = createTestContext({ openclawHookUrl: "", openclawHookToken: "" });
    try {
      const fetcher = vi.fn();
      const service = new OpenClawReminderService(local.database, local.config, mattersWith({ subscriptions: 2, plans: 0 }), fetcher);
      expect(await service.tick(new Date("2026-09-24T02:00:00Z"))).toBe("skipped");
      expect(fetcher).not.toHaveBeenCalled();
      expect(service.status()).toMatchObject({ configured: false, state: "not_configured" });
    } finally {
      local.cleanup();
    }
  });

  it("按账本时区判断提醒时间和日期，而不是主机时间", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const seen: string[] = [];
    const service = new OpenClawReminderService(context.database, context.config, mattersWith({ subscriptions: 1, plans: 0 }, seen), fetcher);
    // UTC 16:30 已过 09:00，但上海是次日 00:30，还没到提醒时间。
    expect(await service.tick(new Date("2026-09-24T16:30:00Z"))).toBe("skipped");
    // 上海 08:59 仍然太早。
    expect(await service.tick(new Date("2026-09-24T00:59:00Z"))).toBe("skipped");
    expect(fetcher).not.toHaveBeenCalled();
    // 上海 09:00（UTC 01:00）开始检查，日期用账本日期。
    expect(await service.tick(new Date("2026-09-24T01:00:00Z"))).toBe("sent");
    expect(seen).toContain("2026-09-24");
  });

  it("没有待办时不打扰 OpenClaw", async () => {
    const fetcher = vi.fn();
    const service = new OpenClawReminderService(context.database, context.config, mattersWith({ subscriptions: 0, plans: 0 }), fetcher);
    expect(await service.tick(new Date("2026-09-24T02:00:00Z"))).toBe("nothing");
    expect(await service.tick(new Date("2026-09-24T05:00:00Z"))).toBe("skipped");
    expect(fetcher).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({ state: "nothing", lastCheckedDate: "2026-09-24", lastSentDate: null });
  });

  it("有待办时每天只调用一次 hook，只发送数量并带幂等键", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{\"ok\":true}", { status: 200 }));
    const service = new OpenClawReminderService(context.database, context.config, mattersWith({ subscriptions: 2, plans: 1 }), fetcher);
    expect(await service.tick(new Date("2026-09-24T02:00:00Z"))).toBe("sent");
    expect(await service.tick(new Date("2026-09-24T03:00:00Z"))).toBe("skipped");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(hookConfig.openclawHookUrl);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${hookConfig.openclawHookToken}`,
      "Idempotency-Key": "smb-reminder-2026-09-24"
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ agentId: "main", channel: "telegram", to: "10001", name: "SMB 每日待办提醒" });
    expect(body.message).toBe(reminderMessage("2026-09-24", 2, 1));
    expect(body.message).toContain("get_subscription_summary");
    expect(body.message).toContain("不要调用任何 direct_");

    const status = service.status();
    expect(status).toMatchObject({ configured: true, state: "sent", lastSentDate: "2026-09-24", time: "09:00" });
    expect(JSON.stringify(status)).not.toContain(hookConfig.openclawHookToken);
    expect(JSON.stringify(status)).not.toContain("18789");
  });

  it("失败后在后续检查中重试，每天最多 6 次；次日使用新的幂等键", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    const service = new OpenClawReminderService(context.database, context.config, mattersWith({ subscriptions: 0, plans: 1 }), fetcher);
    for (let index = 0; index < 8; index += 1) {
      await service.tick(new Date(Date.UTC(2026, 8, 24, 2, index * 5)));
    }
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(service.status().state).toBe("failed");

    fetcher.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await service.tick(new Date("2026-09-25T02:00:00Z"))).toBe("sent");
    const lastInit = fetcher.mock.calls.at(-1)![1] as RequestInit;
    expect(lastInit.headers).toMatchObject({ "Idempotency-Key": "smb-reminder-2026-09-25" });
  });

  it("请求异常只记录失败状态，不抛出", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const service = new OpenClawReminderService(context.database, context.config, mattersWith({ subscriptions: 1, plans: 0 }), fetcher);
    await expect(service.tick(new Date("2026-09-24T02:00:00Z"))).resolves.toBe("failed");
  });
});
