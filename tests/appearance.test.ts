import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { AppearanceService, contrastRatio, defaultAppearance, deriveAccentColors, normalizeAccent } from "../server/appearance";
import type { TestContext } from "./helpers";
import { createTestContext, expenseCategory, transactionInput } from "./helpers";

describe("外观偏好", () => {
  let context: TestContext;

  beforeEach(() => { context = createTestContext(); });
  afterEach(() => { context.cleanup(); });

  it("新账本返回温暖纸张默认值，并支持跨请求部分更新", async () => {
    const app = createApp(context.config, context.database).app;
    const initial = await request(app).get("/api/v1/appearance").expect(200);
    expect(initial.body.data).toMatchObject({
      preset: defaultAppearance.preset,
      accent: defaultAppearance.accent,
      density: defaultAppearance.density,
      backgroundPreset: defaultAppearance.backgroundPreset
    });

    await request(app).patch("/api/v1/appearance").send({ preset: "ink-night" }).expect(200);
    const updated = await request(app).patch("/api/v1/appearance").send({ density: "compact" }).expect(200);
    expect(updated.body.data).toMatchObject({ preset: "ink-night", density: "compact", accent: defaultAppearance.accent, backgroundPreset: defaultAppearance.backgroundPreset });

    const secondApp = createApp(context.config, context.database).app;
    const persisted = await request(secondApp).get("/api/v1/appearance").expect(200);
    expect(persisted.body.data).toMatchObject({ preset: "ink-night", density: "compact" });
  });

  it("拒绝无效颜色，并保留用户主色、提供满足对比度的派生文字色", async () => {
    const app = createApp(context.config, context.database).app;
    await request(app).patch("/api/v1/appearance").send({ accent: "yellow" }).expect(400);
    const response = await request(app).patch("/api/v1/appearance").send({ accent: "#FFFF00" }).expect(200);
    expect(response.body.data.accent).toBe("#FFFF00");
    expect(normalizeAccent("#B85C3B")).toBe("#B85C3B");
    const derivatives = deriveAccentColors(response.body.data.accent);
    expect(["#000000", "#FFFFFF"]).toContain(derivatives.onAccent);
    expect(contrastRatio(derivatives.accentTextOnLight, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(derivatives.accentTextOnDark, "#1B1C1A")).toBeGreaterThanOrEqual(4.5);
  });

  it("支持背景预设的部分更新并兼容旧设置", async () => {
    const app = createApp(context.config, context.database).app;
    const updated = await request(app).patch("/api/v1/appearance").send({ backgroundPreset: "linen" }).expect(200);
    expect(updated.body.data.backgroundPreset).toBe("linen");
    expect(updated.body.data.preset).toBe(defaultAppearance.preset);
    await request(app).patch("/api/v1/appearance").send({ backgroundPreset: "invalid" }).expect(400);
  });

  it("审计只保存变化字段，不保存设置值", () => {
    const service = new AppearanceService(context.database, context.repository);
    service.update({ accent: "#7844AA", density: "compact" });
    const row = context.database.prepare("SELECT metadata FROM audit_logs WHERE action = 'settings.appearance' ORDER BY created_at DESC LIMIT 1").get() as { metadata: string };
    expect(row.metadata).toContain("accent");
    expect(row.metadata).toContain("density");
    expect(row.metadata).not.toContain("#7844AA");
    expect(row.metadata).not.toContain("compact");
  });
});

describe("账目排序兼容", () => {
  let context: TestContext;

  beforeEach(() => { context = createTestContext(); });
  afterEach(() => { context.cleanup(); });

  it("默认按发生日期排序，最近录入视图按创建时间排序", async () => {
    const category = expenseCategory(context);
    const laterOccurrence = context.repository.createTransaction(transactionInput(category.id, { localDate: "2026-08-10", note: "较早录入" }));
    const laterRecorded = context.repository.createTransaction(transactionInput(category.id, { localDate: "2026-08-01", note: "较晚录入" }));
    context.database.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run("2026-08-12T00:00:00.000Z", laterOccurrence.id);
    context.database.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run("2026-08-13T00:00:00.000Z", laterRecorded.id);
    const app = createApp(context.config, context.database).app;

    const byDate = await request(app).get("/api/v1/transactions").expect(200);
    const byRecorded = await request(app).get("/api/v1/transactions?sort=recorded").expect(200);
    expect(byDate.body.data.items.map((item: { id: string }) => item.id)).toEqual([laterOccurrence.id, laterRecorded.id]);
    expect(byRecorded.body.data.items.map((item: { id: string }) => item.id)).toEqual([laterRecorded.id, laterOccurrence.id]);
  });
});
