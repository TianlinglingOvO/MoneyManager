import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, ListFilter, LoaderCircle, LockKeyhole, RefreshCcw, Send } from "lucide-react";
import type { AiAnalysis } from "@shared/types";
import { api } from "../api";
import { useLedgerClock } from "../ledger-clock";
import { analysisPeriodRange, type AnalysisPeriodPreset } from "../utils";

const modes = [
  { value: "overview", label: "消费概览" },
  { value: "growth", label: "异常增长" },
  { value: "saving", label: "节省建议" },
  { value: "structure", label: "分类结构" },
  { value: "custom", label: "自定义问题" }
] as const;

const periodPresets: Array<{ value: AnalysisPeriodPreset | "custom"; label: string }> = [
  { value: "last-week", label: "上周" },
  { value: "last-month", label: "上月" },
  { value: "last-quarter", label: "上季度" },
  { value: "last-year", label: "去年" },
  { value: "custom", label: "自定义" }
];

export function AiPage() {
  const { today } = useLedgerClock();
  const initialPeriod = analysisPeriodRange("last-month", today);
  const [periodPreset, setPeriodPreset] = useState<AnalysisPeriodPreset | "custom">("last-month");
  const [periodStart, setPeriodStart] = useState(initialPeriod.start);
  const [periodEnd, setPeriodEnd] = useState(initialPeriod.end);
  const [mode, setMode] = useState<(typeof modes)[number]["value"]>("overview");
  const [question, setQuestion] = useState("");
  const [active, setActive] = useState<AiAnalysis | null>(null);
  const [resultSignature, setResultSignature] = useState<string | null>(null);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const resultRef = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ["ai-preview", periodStart, periodEnd],
    queryFn: () => api.aiPreview(periodStart, periodEnd),
    enabled: Boolean(periodStart && periodEnd && periodStart <= periodEnd)
  });

  useEffect(() => {
    if (periodPreset === "custom") return;
    const range = analysisPeriodRange(periodPreset, today);
    setPeriodStart(range.start);
    setPeriodEnd(range.end);
  }, [periodPreset, today]);
  const history = useQuery({ queryKey: ["ai-analyses"], queryFn: api.aiAnalyses });
  const analyze = useMutation({
    mutationFn: () => api.analyze({ mode, periodStart, periodEnd, question: mode === "custom" ? question : null }),
    onSuccess: async (result) => {
      setActive(result);
      setResultSignature(JSON.stringify({ periodStart, periodEnd, mode, question: mode === "custom" ? question.trim() : "" }));
      if (window.matchMedia("(max-width: 900px)").matches) {
        setControlsCollapsed(true);
        window.requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
      }
      await queryClient.invalidateQueries({ queryKey: ["ai-analyses"] });
    }
  });
  const result = active ?? history.data?.[0] ?? null;
  const currentSignature = JSON.stringify({ periodStart, periodEnd, mode, question: mode === "custom" ? question.trim() : "" });
  const isPreviousResult = Boolean(result && resultSignature && resultSignature !== currentSignature);
  const canAnalyze = (preview.data?.transactionCount ?? 0) > 0 && (mode !== "custom" || question.trim().length > 0);
  const fields = useMemo(() => preview.data?.fields.join("、") ?? "日期、类型、分类、金额和备注", [preview.data]);
  const selectPeriod = (preset: AnalysisPeriodPreset | "custom") => {
    setPeriodPreset(preset);
    if (preset === "custom") return;
    const range = analysisPeriodRange(preset, today);
    setPeriodStart(range.start);
    setPeriodEnd(range.end);
  };

  useEffect(() => {
    if (active || !result || resultSignature) return;
    if (result.periodStart === periodStart && result.periodEnd === periodEnd) setResultSignature(currentSignature);
  }, [active, currentSignature, periodEnd, periodStart, result, resultSignature]);

  return (
    <div className="page ai-page">
      <header className="page-heading"><h1>账本解读</h1><p>统计结果由账本计算，DeepSeek 只负责解释变化和给出参考。</p></header>

      <div className="ai-layout">
        <section className={`content-card ai-controls ${controlsCollapsed ? "is-collapsed" : ""}`}>
          <div className="ai-mark"><ListFilter size={25} /><span><strong>分析条件</strong><small>只有点击“生成分析”后才会发送所示明细</small></span></div>
          {controlsCollapsed ? (
            <div className="ai-controls__compact">
              <span><strong>{periodStart} 至 {periodEnd}</strong><small>{modes.find((item) => item.value === mode)?.label} · {preview.data?.transactionCount ?? 0} 笔</small></span>
              <button className="secondary-button" type="button" onClick={() => setControlsCollapsed(false)}>修改条件</button>
            </div>
          ) : (
            <div className="ai-controls__body">
              <div className="period-presets" aria-label="分析周期">{periodPresets.map((item) => <button className={periodPreset === item.value ? "is-active" : ""} key={item.value} onClick={() => selectPeriod(item.value)}>{item.label}</button>)}</div>
              <div className="selected-period"><span>分析期间</span><strong>{periodStart} 至 {periodEnd}</strong></div>
              {periodPreset === "custom" && <div className="ai-period-fields"><label><span>开始日期</span><input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label><label><span>结束日期</span><input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label></div>}
              <div className="analysis-modes">{modes.map((item) => <button className={mode === item.value ? "is-active" : ""} key={item.value} onClick={() => setMode(item.value)}>{item.label}</button>)}</div>
              {mode === "custom" && <label className="custom-question"><span>你想问什么？</span><textarea maxLength={500} rows={4} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：哪些消费是最近才明显增加的？" /></label>}
              <div className="privacy-preview"><LockKeyhole size={19} /><div><strong>即将发送 {preview.data?.transactionCount ?? 0} 笔账目</strong><p>包含：{fields}。不包含内部 ID、密钥或登录信息。</p></div></div>
              {analyze.isError && <div className="inline-error"><AlertTriangle size={18} />{analyze.error instanceof Error ? analyze.error.message : "分析失败"}</div>}
              <button className="primary-button ai-submit" disabled={!canAnalyze || analyze.isPending} onClick={() => analyze.mutate()}>{analyze.isPending ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}{analyze.isPending ? "正在整理账本…" : "生成分析"}</button>
            </div>
          )}
        </section>

        <section ref={resultRef} className={`content-card ai-result ${isPreviousResult ? "is-previous" : ""}`}>
          {!result ? (
            <div className="ai-empty"><span><FileText size={29} /></span><h2>还没有分析记录</h2><p>选择期间和分析方式后，生成一份基于当前账目的说明。</p></div>
          ) : (
            <>
              <div className="ai-result__header"><div><span className="ai-result__status">{isPreviousResult ? "上一份结果" : result.isStale ? "账目已变化" : "账本分析"}</span><h2>{result.title}</h2><small>{result.periodStart} 至 {result.periodEnd} · {result.transactionCount} 笔 · 由 {result.model} 生成</small></div>{isPreviousResult ? <span className="previous-badge">条件已改变</span> : result.isStale && <span className="stale-badge"><RefreshCcw size={14} />需重新分析</span>}</div>
              <p className="ai-overview">{result.overview}</p>
              {result.answer && <div className="ai-answer"><strong>直接回答</strong><p>{result.answer}</p></div>}
              <div className="highlight-grid">{result.highlights.map((item, index) => <article className={`highlight-card is-${item.tone}`} key={`${item.title}-${index}`}><span>{item.tone === "positive" ? <CheckCircle2 /> : item.tone === "warning" ? <AlertTriangle /> : <FileText />}</span><div><strong>{item.title}</strong><p>{item.detail}</p></div></article>)}</div>
              <div className="suggestion-list"><h3>建议</h3>{result.suggestions.map((item, index) => <div key={item}><span>{index + 1}</span><p>{item}</p></div>)}</div>
            </>
          )}
        </section>
      </div>

      {(history.data?.length ?? 0) > 0 && <section className="content-card ai-history"><div className="section-title"><h2>历史分析</h2></div><div>{history.data?.map((item) => <button key={item.id} onClick={() => { setActive(item); setResultSignature(JSON.stringify({ periodStart: item.periodStart, periodEnd: item.periodEnd, mode: "history", question: "" })); }}><span><strong>{item.title}</strong><small>{item.periodStart} 至 {item.periodEnd}</small></span>{item.isStale && <em>已过期</em>}</button>)}</div></section>}
    </div>
  );
}
