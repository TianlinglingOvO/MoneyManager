import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiService } from "../server/ai";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory, transactionInput } from "./helpers";

const validAnalysis = {
  title: "本月消费概览",
  overview: "餐饮是主要支出。",
  highlights: [{ title: "餐饮", detail: "支出较集中。", tone: "neutral" }],
  suggestions: ["记录一周后再比较。"],
  answer: null
};

function deepseekResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("DeepSeek 分析", () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestContext({ deepseekApiKey: "test-key", deepseekModel: "deepseek-test" });
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id));
  });
  afterEach(() => { context.cleanup(); });

  it("发送完整明细，但以程序计算的汇总为准，并缓存结果", async () => {
    const fetchMock = vi.fn().mockResolvedValue(deepseekResponse(JSON.stringify(validAnalysis)));
    vi.stubGlobal("fetch", fetchMock);
    const service = new AiService(context.database, context.repository, context.config);
    const first = await service.analyze({ mode: "overview", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const second = await service.analyze({ mode: "overview", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    expect(first.title).toBe(validAnalysis.title);
    expect(second.id).toBe(first.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.thinking).toEqual({ type: "disabled" });
    const userMessage = requestBody.messages[1].content as string;
    expect(userMessage).toContain('"expenseMinor":1234');
    expect(userMessage).toContain('"note":"早餐"');
  });

  it.each([
    ["限流", vi.fn().mockResolvedValue(deepseekResponse("rate limited", 429))],
    ["异常 JSON", vi.fn().mockResolvedValue(deepseekResponse("not-json"))],
    ["超时", vi.fn().mockRejectedValue(new DOMException("timeout", "AbortError"))]
  ])("在%s时安全失败且不会写入报告", async (_label, fetchMock) => {
    vi.stubGlobal("fetch", fetchMock);
    const service = new AiService(context.database, context.repository, context.config);
    await expect(service.analyze({ mode: "saving", periodStart: "2026-08-01", periodEnd: "2026-08-31" }))
      .rejects.toMatchObject({ code: "DEEPSEEK_ERROR", status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const count = context.database.prepare("SELECT COUNT(*) AS count FROM ai_reports").get() as { count: number };
    expect(Number(count.count)).toBe(0);
  });

  it("账目变化后把旧分析标记为需要重新分析", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(deepseekResponse(JSON.stringify(validAnalysis))));
    const service = new AiService(context.database, context.repository, context.config);
    await service.analyze({ mode: "overview", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const category = expenseCategory(context);
    context.repository.createTransaction(transactionInput(category.id, {
      amountMinor: 300,
      localDate: "2026-08-05"
    }));
    expect(service.listRecent()[0]?.isStale).toBe(true);
  });
});
