// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { api } from "../src/api";
import { LedgerClockProvider, localDateForTimestamp, useLedgerClock } from "../src/ledger-clock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe() {
  const clock = useLedgerClock();
  return <output data-testid="clock">{clock.timezone}|{clock.today}|{clock.isLoading ? "loading" : "ready"}|{clock.isError ? "error" : "ok"}</output>;
}

function renderClock(node: ReactNode = <Probe />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><LedgerClockProvider>{node}</LedgerClockProvider></QueryClientProvider>);
}

describe("统一账本时钟", () => {
  it("使用服务端时区和账本今天日期", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ currency: "CNY", timezone: "Asia/Singapore", today: "2026-08-19", rows: [] });
    renderClock();

    await waitFor(() => expect(screen.getByTestId("clock")).toHaveTextContent("Asia/Singapore|2026-08-19|ready|ok"));
  });

  it("设置接口失败时保留浏览器回退并暴露错误状态", async () => {
    vi.spyOn(api, "settings").mockRejectedValue(new Error("暂时不可用"));
    renderClock();

    await waitFor(() => expect(screen.getByTestId("clock")).toHaveTextContent(/\|\d{4}-\d{2}-\d{2}\|ready\|error/));
  });

  it("按账本时区转换录入时间日期", () => {
    expect(localDateForTimestamp("2026-08-18T16:30:00.000Z", "Asia/Shanghai")).toBe("2026-08-19");
    expect(localDateForTimestamp("not-a-date", "Asia/Shanghai")).toBeNull();
  });
});
