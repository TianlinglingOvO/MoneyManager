import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { HealthIssue, HealthReport } from "../finance-health";
import { useToast } from "../toast-context";
import { BottomSheet, type BottomSheetHandle } from "./BottomSheet";

interface HealthSheetProps {
  open: boolean;
  month: string;
  report: HealthReport | undefined;
  isLoading: boolean;
  isError: boolean;
  onClose: () => void;
  onOpenBudget: () => void;
}

function severityLabel(issue: HealthIssue): string {
  if (issue.severity === "critical") return "需要处理";
  if (issue.severity === "warning") return "建议核对";
  return "提示";
}

function actionLabel(issue: HealthIssue): string {
  if (issue.type === "budget_warning") return issue.href?.startsWith("/?") ? "管理预算" : "查看分类账单";
  if (issue.type === "subscription_due") return "查看订阅";
  if (issue.type === "foreign_key") return "查看设置";
  return "查看账目";
}

export function HealthSheet({ open, month, report, isLoading, isError, onClose, onOpenBudget }: HealthSheetProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notify = useToast();
  const sheetRef = useRef<BottomSheetHandle | null>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const acknowledge = useMutation({
    mutationFn: (fingerprint: string) => api.acknowledgeHealthIssue(fingerprint, month),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["health", month] });
      notify("已标记为已核对");
    }
  });
  const explain = useMutation({ mutationFn: () => api.explainHealth(month) });
  const issues = report?.issues ?? [];
  const activeIssues = issues.filter((issue) => !issue.acknowledged);
  const criticalIssues = activeIssues.filter((issue) => issue.severity === "critical").length;
  const warningIssues = activeIssues.filter((issue) => issue.severity === "warning").length;

  const finishClose = () => {
    const pendingAction = pendingActionRef.current;
    pendingActionRef.current = null;
    onClose();
    if (pendingAction) window.requestAnimationFrame(pendingAction);
  };
  const followIssue = (issue: HealthIssue) => {
    if (!issue.href) return;
    pendingActionRef.current = issue.type === "budget_warning" && issue.href.startsWith("/?")
      ? onOpenBudget
      : () => navigate(issue.href!);
    sheetRef.current?.close();
  };
  return <BottomSheet ref={sheetRef} open={open} title="账本体检" closeLabel="关闭账本体检" onClose={finishClose} className="health-sheet" labelledBy="health-sheet-title">
    <div className="health-sheet__content">
      <p className="sheet-intro">体检只帮助发现可能需要回看的记录；不会替你修改账本。</p>
      {isLoading ? <div className="sheet-loading" role="status">正在检查账本…</div> : isError ? <p className="form-error" role="alert">体检暂时无法读取，请稍后重试。</p> : <>
        <div className="health-score"><span>本月待核对</span><strong>{activeIssues.length}<small>项</small></strong><p>{activeIssues.length === 0 ? "目前没有需要处理的项目。" : `${criticalIssues > 0 ? `${criticalIssues} 项需要处理` : "没有严重问题"}${warningIssues > 0 ? `，${warningIssues} 项建议核对` : ""}。`}</p><small className="health-score__legacy">数据健康度 {report?.score ?? 100} 分</small></div>
        <div className="health-issue-list">
          {issues.map((issue) => <article key={issue.fingerprint} className={`health-issue is-${issue.severity} ${issue.acknowledged ? "is-acknowledged" : ""}`.trim()}>
            <CircleAlert size={19} aria-hidden="true" />
            <div><span>{severityLabel(issue)}</span><h3>{issue.title}</h3><p>{issue.detail}</p>{issue.relatedTransactionIds.length > 0 ? <small>涉及 {issue.relatedTransactionIds.length} 笔记录</small> : null}{issue.href ? <button className="text-link health-issue__link" type="button" onClick={() => followIssue(issue)}>{actionLabel(issue)}</button> : null}</div>
            {issue.acknowledged ? <em><Check size={15} />已核对</em> : <button className="secondary-button" type="button" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate(issue.fingerprint)}>{acknowledge.isPending && acknowledge.variables === issue.fingerprint ? "标记中…" : "标记已核对"}</button>}
          </article>)}
          {issues.length === 0 && <div className="health-empty"><Check size={25} /><strong>账本状态良好</strong><p>继续按自己的习惯记录即可。</p></div>}
        </div>
        {acknowledge.isError && <p className="form-error" role="alert">标记失败，请刷新后再试。</p>}
        <div className="health-explain">
          <div><strong>想知道该从哪里看起？</strong><p>AI 只解释统计和已发现的项目，不会直接改账。</p></div>
          <button className="secondary-button" type="button" disabled={activeIssues.length === 0 || explain.isPending} onClick={() => explain.mutate()}><Sparkles size={16} />{explain.isPending ? "正在整理…" : "让 AI 解释"}</button>
        </div>
        {explain.data && <div className="health-explanation" role="status"><p>{explain.data.overview}</p>{explain.data.suggestions.length > 0 && <ul>{explain.data.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>}</div>}
        {explain.isError && <p className="form-error" role="alert">AI 解释暂时不可用，请稍后重试。</p>}
      </>}
    </div>
  </BottomSheet>;
}
