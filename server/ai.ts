import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AiAnalysis } from "../shared/types";
import type { AppConfig } from "./config";
import { AppError } from "./errors";
import { LedgerRepository } from "./repository";

const deepseekResultSchema = z.object({
  title: z.string().min(1).max(80),
  overview: z.string().min(1).max(1200),
  highlights: z.array(z.object({
    title: z.string().min(1).max(80),
    detail: z.string().min(1).max(500),
    tone: z.enum(["positive", "warning", "neutral"])
  })).max(8),
  suggestions: z.array(z.string().min(1).max(400)).max(8),
  answer: z.string().max(1600).nullable().optional()
});

interface AiReportRow {
  id: string;
  mode: string;
  period_start: string;
  period_end: string;
  question: string | null;
  data_hash: string;
  transaction_count: number;
  model: string;
  content: string;
  created_at: string;
}

export class AiService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly repository: LedgerRepository,
    private readonly config: AppConfig
  ) {}

  preview(periodStart: string, periodEnd: string): { transactionCount: number; fields: string[] } {
    const { transactions } = this.repository.dataHash(periodStart, periodEnd);
    return {
      transactionCount: transactions.length,
      fields: ["日期", "收入或支出", "分类", "金额", "备注"]
    };
  }

  private mapRow(row: AiReportRow, currentHash?: string): AiAnalysis {
    const parsed = deepseekResultSchema.parse(JSON.parse(row.content));
    return {
      id: row.id,
      ...parsed,
      answer: parsed.answer ?? null,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      transactionCount: Number(row.transaction_count),
      model: row.model,
      createdAt: row.created_at,
      isStale: currentHash ? currentHash !== row.data_hash : false
    };
  }

  listRecent(limit = 12): AiAnalysis[] {
    const rows = this.database.prepare("SELECT * FROM ai_reports ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as AiReportRow[];
    return rows.map((row) => {
      const current = this.repository.dataHash(row.period_start, row.period_end);
      return this.mapRow(row, current.hash);
    });
  }

  async analyze(input: {
    mode: "overview" | "growth" | "saving" | "structure" | "custom";
    periodStart: string;
    periodEnd: string;
    question?: string | null;
  }, actor: "user" | "openclaw" = "user"): Promise<AiAnalysis> {
    if (!this.config.deepseekApiKey) {
      throw new AppError("尚未配置 DeepSeek API Key", 503, "DEEPSEEK_NOT_CONFIGURED");
    }

    const { hash, transactions } = this.repository.dataHash(input.periodStart, input.periodEnd);
    if (transactions.length === 0) throw new AppError("这个期间还没有账目可供分析");
    const cached = this.database.prepare(`SELECT * FROM ai_reports
      WHERE mode = ? AND period_start = ? AND period_end = ? AND COALESCE(question, '') = ? AND data_hash = ?
      ORDER BY created_at DESC LIMIT 1`)
      .get(input.mode, input.periodStart, input.periodEnd, input.question ?? "", hash) as unknown as AiReportRow | undefined;
    if (cached) return this.mapRow(cached, hash);

    const totals = transactions.reduce((result, item) => {
      result[item.kind] += item.amountMinor;
      const key = `${item.kind}:${item.category?.name ?? item.categoryId}`;
      result.byCategory[key] = (result.byCategory[key] ?? 0) + item.amountMinor;
      return result;
    }, { income: 0, expense: 0, byCategory: {} as Record<string, number> });

    const payload = {
      request: {
        mode: input.mode,
        question: input.question ?? null,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        currency: "CNY"
      },
      deterministicSummary: {
        incomeMinor: totals.income,
        expenseMinor: totals.expense,
        balanceMinor: totals.income - totals.expense,
        byCategoryMinor: totals.byCategory,
        transactionCount: transactions.length
      },
      transactions: transactions.map((item) => ({
        date: item.localDate,
        kind: item.kind,
        category: item.category?.name ?? "未知分类",
        amountMinor: item.amountMinor,
        note: item.note
      }))
    };

    const systemPrompt = `你是一名谨慎的个人收支分析助手。所有确定性金额都由程序计算，你不得自行改写或猜测总额。
请使用简体中文，只依据提供的数据给出观察，不提供投资、借贷或医疗建议。
金额单位字段为人民币分，展示时换算成人民币元。
必须输出 JSON，结构为：
{"title":"标题","overview":"概览","highlights":[{"title":"要点","detail":"说明","tone":"positive|warning|neutral"}],"suggestions":["可执行建议"],"answer":null}
自定义问题时把直接回答放进 answer；其他模式 answer 为 null。不要在 JSON 外输出任何文字。`;

    let parsed: z.infer<typeof deepseekResultSchema> | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.deepseekApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: this.config.deepseekModel,
            thinking: { type: this.config.deepseekThinking },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `请分析以下 JSON 数据：\n${JSON.stringify(payload)}` }
            ],
            response_format: { type: "json_object" },
            max_tokens: 2200,
            stream: false
          }),
          signal: AbortSignal.timeout(60_000)
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 180)}`);
        }
        const json = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
        const content = json.choices?.[0]?.message?.content;
        if (!content) throw new Error("DeepSeek 返回了空内容");
        parsed = deepseekResultSchema.parse(JSON.parse(content));
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!parsed) {
      throw new AppError(`DeepSeek 暂时无法完成分析：${lastError instanceof Error ? lastError.message : "未知错误"}`, 502, "DEEPSEEK_ERROR");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const questionHash = createHash("sha256").update(input.question ?? "").digest("hex").slice(0, 12);
    this.database.prepare(`INSERT INTO ai_reports(
      id, mode, period_start, period_end, question, data_hash, transaction_count, model, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.mode, input.periodStart, input.periodEnd, input.question ?? null, hash, transactions.length, this.config.deepseekModel, JSON.stringify(parsed), now);
    this.repository.audit(actor, "ai.analyze", "ai_report", id, { mode: input.mode, transactionCount: transactions.length, questionHash });
    const row = this.database.prepare("SELECT * FROM ai_reports WHERE id = ?").get(id) as unknown as AiReportRow;
    return this.mapRow(row, hash);
  }
}
