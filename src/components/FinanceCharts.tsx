import { memo, useMemo } from "react";
import {
  Area,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { CategoryMetric, TrendPoint, TransactionKind } from "@shared/types";
import { buildCategoryComposition, categoryCompositionPadding } from "../category-composition";
import { chartMotionEasing, motionDurations, useChartMotion } from "../motion";
import { money, plainMoney } from "../utils";

export interface FinanceChartsProps {
  trend: TrendPoint[];
  /** Previous period over the same-progress window, aligned by position; drawn only in cumulative mode. */
  previousTrend?: TrendPoint[];
  /** daily shows each day's amount; cumulative shows the running total against the previous period's. */
  trendMode?: "daily" | "cumulative";
  categories: CategoryMetric[];
  kind: TransactionKind;
  averageMinor: number;
  averageLabel: string;
  animationToken?: number;
  motionEnabled?: boolean;
  activeCategoryId?: string | null;
  onCategoryHighlight?: (categoryId: string | null) => void;
  onCategorySelect?: (categoryId: string) => void;
  variant?: "trend" | "pie" | "both";
}

/** Axis labels keep thousands separators; ten thousand and up switch to 万 so labels stay narrow. */
function axisMoney(value: number): string {
  const amount = Number(value);
  if (Math.abs(amount) >= 10_000) return `¥${(amount / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}万`;
  return `¥${amount.toLocaleString("zh-CN")}`;
}

// A stable default keeps the memoized chart data from changing identity on every render.
const emptyTrend: TrendPoint[] = [];

function FinanceCharts({
  trend,
  previousTrend = emptyTrend,
  trendMode = "daily",
  categories,
  kind,
  averageMinor,
  averageLabel,
  animationToken = 0,
  motionEnabled = true,
  activeCategoryId = null,
  onCategoryHighlight,
  onCategorySelect,
  variant = "both"
}: FinanceChartsProps) {
  // Stable data identity keeps Recharts from re-deriving sectors when the page re-renders mid-animation.
  const chartData = useMemo(() => {
    if (trendMode === "daily") return trend.map((point) => ({ ...point, amount: point.amountMinor / 100, previous: null as number | null }));
    let running = 0;
    let previousRunning = 0;
    return trend.map((point, index) => {
      running += point.amountMinor;
      const previousPoint = previousTrend[index];
      if (previousPoint) previousRunning += previousPoint.amountMinor;
      return { ...point, amount: running / 100, previous: previousPoint ? previousRunning / 100 : null };
    });
  }, [previousTrend, trend, trendMode]);
  const cumulative = trendMode === "cumulative";
  const pieData = useMemo(() => buildCategoryComposition(categories), [categories]);
  const selectedTotalMinor = pieData.reduce((total, item) => total + item.amountMinor, 0);
  const color = kind === "expense" ? "var(--expense)" : "var(--income)";
  const trendMotion = useChartMotion(animationToken, motionEnabled && (variant === "trend" || variant === "both"));
  const pieMotion = useChartMotion(animationToken, motionEnabled && (variant === "pie" || variant === "both"));

  const trendChart = (
    <div className="trend-chart" aria-label={cumulative ? "本期累计与上期同期累计对比图" : "收支趋势图"} data-animate={trendMotion.isAnimationActive ? "true" : "false"} data-animation-running={trendMotion.isAnimationRunning ? "true" : "false"}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 12, right: 8, left: -6, bottom: 0 }}>
          <defs>
            <linearGradient id={`amountFill-${kind}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 6" vertical={false} />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} minTickGap={18} />
          <YAxis axisLine={false} tickLine={false} width={58} tick={{ fill: "var(--muted)", fontSize: 12 }} tickFormatter={axisMoney} />
          <Tooltip
            formatter={(value, name) => [`¥${plainMoney(Number(value) * 100)}`, name === "previous" ? "上期同期累计" : cumulative ? "本期累计" : kind === "expense" ? "支出" : "收入"]}
            contentStyle={{ borderRadius: 12, border: "1px solid var(--line)", background: "var(--paper)", boxShadow: "var(--shadow)" }}
          />
          {!cumulative && averageMinor > 0 && (
            <ReferenceLine
              y={averageMinor / 100}
              stroke="var(--muted)"
              strokeDasharray="5 5"
              label={{ value: averageLabel, position: "insideTopRight", fill: "var(--muted)", fontSize: 12 }}
            />
          )}
          <Area
            key={`trend-${animationToken}`}
            type="monotone"
            dataKey="amount"
            stroke={color}
            strokeWidth={2.5}
            fill={`url(#amountFill-${kind})`}
            activeDot={{ r: 5 }}
            isAnimationActive={trendMotion.isAnimationActive}
            animationBegin={0}
            animationDuration={motionDurations.trendChart}
            animationEasing={chartMotionEasing.trend}
            onAnimationStart={trendMotion.onAnimationStart}
            onAnimationEnd={trendMotion.onAnimationEnd}
          />
          {cumulative && <Line
            key={`previous-${animationToken}`}
            type="monotone"
            dataKey="previous"
            stroke="var(--muted)"
            strokeWidth={1.8}
            strokeDasharray="5 5"
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={trendMotion.isAnimationActive}
            animationBegin={0}
            animationDuration={motionDurations.trendChart}
            animationEasing={chartMotionEasing.trend}
          />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );

  const pieChart = (
    <div className="pie-chart" aria-label="分类构成图" data-animate={pieMotion.isAnimationActive ? "true" : "false"} data-animation-running={pieMotion.isAnimationRunning ? "true" : "false"} data-active-category={activeCategoryId ?? ""}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            key={`pie-${animationToken}`}
            data={pieData}
            dataKey="amountMinor"
            nameKey="name"
            innerRadius="58%"
            outerRadius="84%"
            paddingAngle={categoryCompositionPadding(pieData.length)}
            stroke="none"
            isAnimationActive={pieMotion.isAnimationActive}
            animationBegin={0}
            animationDuration={motionDurations.pieChart}
            animationEasing={chartMotionEasing.pie}
            onAnimationStart={pieMotion.onAnimationStart}
            onAnimationEnd={pieMotion.onAnimationEnd}
            onMouseEnter={(_, index) => onCategoryHighlight?.(pieData[index]?.categoryId ?? null)}
            onMouseLeave={() => onCategoryHighlight?.(null)}
            onClick={(_, index) => {
              const category = pieData[index as number];
              if (category?.categoryId) onCategorySelect?.(category.categoryId);
            }}
            style={{ cursor: onCategorySelect ? "pointer" : undefined }}
          >
            {pieData.map((item) => {
              const highlighted = activeCategoryId === item.categoryId;
              const dimmed = Boolean(activeCategoryId) && !highlighted;
              return <Cell
                className={`pie-sector ${highlighted ? "is-active" : ""} ${dimmed ? "is-dimmed" : ""}`.trim()}
                key={item.categoryId}
                fill={item.color}
                fillOpacity={dimmed ? 0.34 : 1}
                stroke={highlighted ? "var(--surface-card)" : "none"}
                strokeWidth={highlighted ? 3 : 0}
              />;
            })}
          </Pie>
          <Tooltip
            formatter={(value) => money(Number(value))}
            contentStyle={{ borderRadius: 12, border: "1px solid var(--line)", color: "var(--ink)", background: "var(--paper)", boxShadow: "var(--shadow)" }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pie-chart__center" aria-label={`${kind === "expense" ? "本期支出" : "本期收入"}总额 ${money(selectedTotalMinor)}`}><strong>{money(selectedTotalMinor)}</strong><span>{kind === "expense" ? "本期支出" : "本期收入"}</span></div>
    </div>
  );

  return (
    <>
      {(variant === "trend" || variant === "both") && trendChart}
      {(variant === "pie" || variant === "both") && pieChart}
    </>
  );
}

export default memo(FinanceCharts);
