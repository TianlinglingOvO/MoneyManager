// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryMetric, TrendPoint } from "../shared/types";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: ReactNode }) => <svg>{children}</svg>,
  PieChart: ({ children }: { children: ReactNode }) => <svg>{children}</svg>,
  Area: ({ animationBegin, animationDuration, animationEasing, isAnimationActive, onAnimationStart, onAnimationEnd }: { animationBegin: number; animationDuration: number; animationEasing: string; isAnimationActive: boolean; onAnimationStart: () => void; onAnimationEnd: () => void }) => <foreignObject data-testid="area-motion" data-begin={animationBegin} data-duration={animationDuration} data-easing={animationEasing} data-active={isAnimationActive}><button onClick={onAnimationStart}>趋势开始</button><button onClick={onAnimationEnd}>趋势完成</button></foreignObject>,
  Pie: ({ animationBegin, animationDuration, animationEasing, isAnimationActive, paddingAngle, onAnimationStart, onAnimationEnd, children }: { animationBegin: number; animationDuration: number; animationEasing: string; isAnimationActive: boolean; paddingAngle: number; onAnimationStart: () => void; onAnimationEnd: () => void; children: ReactNode }) => <foreignObject data-testid="pie-motion" data-begin={animationBegin} data-duration={animationDuration} data-easing={animationEasing} data-active={isAnimationActive} data-padding={paddingAngle}><button onClick={onAnimationStart}>构成开始</button><button onClick={onAnimationEnd}>构成完成</button>{children}</foreignObject>,
  Cell: ({ className }: { className?: string }) => <span className={className} />,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null
}));

import FinanceCharts from "../src/components/FinanceCharts";
import { chartMotionEasing, motionDurations, resolveChartMotionToken, useChartMotion, useReducedMotion, useResolvedChartMotionToken } from "../src/motion";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const categories: CategoryMetric[] = [{
  categoryId: "category-1",
  name: "餐饮",
  icon: "饭",
  color: "#d66a4c",
  amountMinor: 12_340,
  percent: 100,
  previousAmountMinor: 0,
  deltaMinor: 12_340,
  changePercent: null,
  changeState: "new"
}];
const trend: TrendPoint[] = [{ key: "2026-08-20", label: "8月20日", amountMinor: 12_340 }];

function ReducedMotionProbe() {
  return <output>{useReducedMotion() ? "减少动画" : "正常动画"}</output>;
}

function ResolvedMotionProbe({ requested, placeholder, hasData }: { requested: number; placeholder: boolean; hasData: boolean }) {
  return <output data-testid="resolved-token">{useResolvedChartMotionToken(requested, placeholder, hasData)}</output>;
}

const motionEndCallbacks = new Map<number, () => void>();

function ChartMotionProbe({ token }: { token: number }) {
  const motion = useChartMotion(token, true);
  motionEndCallbacks.set(token, motion.onAnimationEnd);
  return <output data-testid="motion-active">{motion.isAnimationActive ? "播放" : "完成"}</output>;
}

describe("功能动效", () => {
  it("图表从首帧开始并使用独立时长与缓动", () => {
    render(<FinanceCharts trend={trend} categories={categories} kind="expense" averageMinor={1_234} averageLabel="日均" animationToken={1} variant="both" />);

    expect(screen.getByTestId("area-motion")).toHaveAttribute("data-begin", "0");
    expect(screen.getByTestId("area-motion")).toHaveAttribute("data-duration", String(motionDurations.trendChart));
    expect(screen.getByTestId("area-motion")).toHaveAttribute("data-easing", chartMotionEasing.trend);
    expect(screen.getByTestId("pie-motion")).toHaveAttribute("data-begin", "0");
    expect(screen.getByTestId("pie-motion")).toHaveAttribute("data-duration", String(motionDurations.pieChart));
    expect(screen.getByTestId("pie-motion")).toHaveAttribute("data-easing", "linear");
    expect(screen.getByTestId("pie-motion")).toHaveAttribute("data-padding", "0");
    expect(screen.getByLabelText("本期支出总额 ¥123.40")).toBeInTheDocument();
    expect(screen.queryByText("前三类占比")).not.toBeInTheDocument();
  });

  it("动画只由各自的 Recharts 完成回调结束", async () => {
    render(<FinanceCharts trend={trend} categories={categories} kind="expense" averageMinor={1_234} averageLabel="日均" animationToken={1} variant="both" />);

    expect(screen.getByTestId("area-motion")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("pie-motion")).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByRole("button", { name: "趋势开始" }));
    fireEvent.click(screen.getByRole("button", { name: "趋势完成" }));
    await waitFor(() => expect(screen.getByTestId("area-motion")).toHaveAttribute("data-active", "false"));
    expect(screen.getByTestId("pie-motion")).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByRole("button", { name: "构成开始" }));
    fireEvent.click(screen.getByRole("button", { name: "构成完成" }));
    await waitFor(() => expect(screen.getByTestId("pie-motion")).toHaveAttribute("data-active", "false"));
  });

  it("占位数据和慢加载不会提前推进动画令牌", async () => {
    expect(resolveChartMotionToken(2, 1, true, true)).toBe(1);
    expect(resolveChartMotionToken(2, 1, false, false)).toBe(1);
    expect(resolveChartMotionToken(2, 1, false, true)).toBe(2);

    const view = render(<ResolvedMotionProbe requested={2} placeholder hasData />);
    expect(screen.getByTestId("resolved-token")).toHaveTextContent("0");
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    expect(screen.getByTestId("resolved-token")).toHaveTextContent("0");
    view.rerender(<ResolvedMotionProbe requested={2} placeholder={false} hasData />);
    await waitFor(() => expect(screen.getByTestId("resolved-token")).toHaveTextContent("2"));
    view.rerender(<ResolvedMotionProbe requested={3} placeholder hasData />);
    expect(screen.getByTestId("resolved-token")).toHaveTextContent("2");
  });

  it("连续切换时忽略旧动画的完成回调", async () => {
    const view = render(<ChartMotionProbe token={1} />);
    expect(screen.getByTestId("motion-active")).toHaveTextContent("播放");
    const staleEnd = motionEndCallbacks.get(1)!;
    view.rerender(<ChartMotionProbe token={2} />);
    act(() => staleEnd());
    expect(screen.getByTestId("motion-active")).toHaveTextContent("播放");
    act(() => motionEndCallbacks.get(2)!());
    await waitFor(() => expect(screen.getByTestId("motion-active")).toHaveTextContent("完成"));
    view.rerender(<ChartMotionProbe token={2} />);
    expect(screen.getByTestId("motion-active")).toHaveTextContent("完成");
  });

  it("减少动画时无需等待完成回调", () => {
    render(<FinanceCharts trend={trend} categories={categories} kind="expense" averageMinor={1_234} averageLabel="日均" animationToken={1} motionEnabled={false} variant="both" />);
    expect(screen.getByTestId("area-motion")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("pie-motion")).toHaveAttribute("data-active", "false");
  });

  it("响应系统减少动画设置及其运行时变化", () => {
    let matches = true;
    let listener: (() => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return matches; },
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: (_type: string, next: () => void) => { listener = next; },
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true
    })));

    render(<ReducedMotionProbe />);
    expect(screen.getByText("减少动画")).toBeInTheDocument();
    matches = false;
    act(() => listener?.());
    expect(screen.getByText("正常动画")).toBeInTheDocument();
  });
});
