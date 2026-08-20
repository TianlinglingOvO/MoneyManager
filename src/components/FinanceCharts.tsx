import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
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

export default function FinanceCharts({
  trend,
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
  const chartData = trend.map((point) => ({ ...point, amount: point.amountMinor / 100 }));
  const pieData = buildCategoryComposition(categories);
  const selectedTotalMinor = pieData.reduce((total, item) => total + item.amountMinor, 0);
  const color = kind === "expense" ? "var(--expense)" : "var(--income)";
  const trendMotion = useChartMotion(animationToken, motionEnabled && (variant === "trend" || variant === "both"));
  const pieMotion = useChartMotion(animationToken, motionEnabled && (variant === "pie" || variant === "both"));

  const trendChart = (
    <div className="trend-chart" aria-label="收支趋势图" data-animate={trendMotion.isAnimationActive ? "true" : "false"} data-animation-running={trendMotion.isAnimationRunning ? "true" : "false"}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 12, right: 8, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id={`amountFill-${kind}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 6" vertical={false} />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} minTickGap={18} />
          <YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} tickFormatter={(value) => `¥${value}`} />
          <Tooltip
            formatter={(value) => [`¥${plainMoney(Number(value) * 100)}`, kind === "expense" ? "支出" : "收入"]}
            contentStyle={{ borderRadius: 12, border: "1px solid var(--line)", background: "var(--paper)", boxShadow: "var(--shadow)" }}
          />
          {averageMinor > 0 && (
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
        </AreaChart>
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
