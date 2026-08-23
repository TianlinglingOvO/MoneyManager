import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, ChevronDown, Clock3, History, Pencil, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { Category, OpenClawOperation, OpenClawOperationDetail, Proposal, TransactionKind } from "@shared/types";
import { api, ApiError } from "../api";
import { QuickEntry } from "../components/QuickEntry";
import { money } from "../utils";

function actionLabel(proposal: Proposal): string {
  if (proposal.action === "create") return "新增一笔账";
  if (proposal.action === "update") return "修改一笔账";
  return "删除一笔账";
}

interface ProposalCardProps {
  proposal: Proposal;
  categoryMap: Map<string, Category>;
  busy: boolean;
  onEdit: (proposal: Proposal) => void;
  onResolve: (proposal: Proposal, decision: "approve" | "reject") => void;
}

function ProposalCard({ proposal, categoryMap, busy, onEdit, onResolve }: ProposalCardProps) {
  const needsTarget = proposal.action !== "create" && Boolean(proposal.targetTransactionId);
  const target = useQuery({
    queryKey: ["transaction", proposal.targetTransactionId],
    queryFn: () => api.transaction(proposal.targetTransactionId!),
    enabled: needsTarget,
    retry: false
  });
  const payload = proposal.payload as {
    kind?: TransactionKind;
    amountMinor?: number;
    categoryId?: string;
    localDate?: string;
    note?: string | null;
  };
  const effective = proposal.action === "create"
    ? payload
    : target.data
      ? { ...target.data, ...payload }
      : payload;
  const category = effective.categoryId ? categoryMap.get(effective.categoryId) : undefined;
  const targetUnavailable = target.isError || Boolean(target.data?.deletedAt);

  return (
    <article className="content-card proposal-card">
      <div className="proposal-card__head">
        <span className="proposal-card__bot"><Bot size={21} /></span>
        <div>
          <p>{actionLabel(proposal)}</p>
          <small><Clock3 size={13} />提交于 {new Date(proposal.createdAt).toLocaleString("zh-CN")}</small>
          {proposal.revision > 1 && <small className="proposal-card__modified">已修改 · {new Date(proposal.updatedAt).toLocaleString("zh-CN")} · 版本 {proposal.revision}</small>}
        </div>
        <em>等待确认</em>
      </div>
      <div className="proposal-card__details">
        {effective.amountMinor !== undefined && <div><span>金额</span><strong className={effective.kind === "income" ? "income-text" : "expense-text"}>{effective.kind === "income" ? "+" : "−"}{money(effective.amountMinor)}</strong></div>}
        {category && <div><span>分类</span><strong>{category.icon} {category.name}</strong></div>}
        {effective.localDate && <div><span>日期</span><strong>{effective.localDate}</strong></div>}
        {proposal.targetTransactionId && <div><span>目标记录</span><strong>{proposal.targetTransactionId.slice(0, 8)}…</strong></div>}
        {effective.note !== undefined && <div className="wide"><span>备注</span><strong>{effective.note || "（无备注）"}</strong></div>}
        {targetUnavailable && <div className="wide proposal-card__target-error"><span>目标账目</span><strong>已删除或不可读取，无法执行或修订</strong></div>}
        {proposal.reason && <div className="wide"><span>OpenClaw 说明</span><strong>{proposal.reason}</strong></div>}
      </div>
      <div className="proposal-card__actions">
        {proposal.action !== "delete" && <button className="secondary-button" disabled={busy} onClick={() => onEdit(proposal)}><Pencil size={16} />编辑</button>}
        <button className="secondary-button" disabled={busy} onClick={() => onResolve(proposal, "reject")}><X size={17} />拒绝</button>
        <button className="primary-button" disabled={busy || (needsTarget && target.isLoading) || targetUnavailable} onClick={() => onResolve(proposal, "approve")}><Check size={17} />批准并执行</button>
      </div>
    </article>
  );
}

function changedFields(detail: OpenClawOperationDetail): string[] {
  return [...new Set(detail.items.flatMap((item) => {
    const before = item.before ?? {};
    const after = item.after ?? {};
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  }))].sort();
}

function snapshotText(value: Record<string, unknown> | null): string {
  return value === null ? "（无）" : JSON.stringify(value, null, 2);
}

function OperationDetail({ operationId }: { operationId: string }) {
  const [showValues, setShowValues] = useState(false);
  const detail = useQuery({
    queryKey: ["openclaw", "operation", operationId],
    queryFn: () => api.openClawOperation(operationId)
  });
  if (detail.isLoading) return <div className="operation-detail is-loading">正在读取操作详情…</div>;
  if (detail.isError || !detail.data) return <div className="operation-detail is-error">操作详情暂时无法读取。</div>;
  const fields = changedFields(detail.data);
  const failureReason = detail.data.result && typeof detail.data.result === "object" && "failureReason" in detail.data.result
    ? String((detail.data.result as { failureReason?: unknown }).failureReason ?? "")
    : "";
  return <div className="operation-detail">
    <dl>
      <div><dt>请求 ID</dt><dd><code>{detail.data.requestId}</code></dd></div>
      <div><dt>影响项目</dt><dd>{detail.data.items.length} 项</dd></div>
      <div><dt>字段变化</dt><dd>{fields.length > 0 ? fields.join("、") : "无快照字段变化"}</dd></div>
      {detail.data.failedAt && <div><dt>失败时间</dt><dd>{new Date(detail.data.failedAt).toLocaleString("zh-CN")}</dd></div>}
      {failureReason && <div><dt>失败原因</dt><dd>{failureReason}</dd></div>}
    </dl>
    {detail.data.items.length > 0 && <>
      <button type="button" className="text-button operation-detail__reveal" onClick={() => setShowValues((value) => !value)} aria-expanded={showValues}>
        <ChevronDown className={showValues ? "is-open" : ""} size={15} />{showValues ? "隐藏字段值" : "显示字段值（可能包含金额和备注）"}
      </button>
      {showValues && <div className="operation-snapshot-list">{detail.data.items.map((item) => <section key={`${item.sequence}-${item.entityId}`}>
        <strong>{item.entityType} · {item.entityId.slice(0, 8)}…</strong>
        <div><span>执行前</span><pre>{snapshotText(item.before)}</pre></div>
        <div><span>执行后</span><pre>{snapshotText(item.after)}</pre></div>
      </section>)}</div>}
    </>}
  </div>;
}

export function ProposalsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const proposals = useQuery({ queryKey: ["proposals", "pending"], queryFn: () => api.proposals("pending") });
  const control = useQuery({ queryKey: ["openclaw", "settings"], queryFn: api.openClawSettings });
  const operations = useQuery({ queryKey: ["openclaw", "operations"], queryFn: () => api.openClawOperations(50) });
  const categories = useQuery({ queryKey: ["categories", "proposal", true], queryFn: () => api.categories(undefined, true) });
  const resolve = useMutation({
    mutationFn: ({ proposal, decision }: { proposal: Proposal; decision: "approve" | "reject" }) =>
      api.resolveProposal(proposal.id, decision, proposal.revision),
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries();
    },
    onError: (reason) => {
      const message = reason instanceof Error ? reason.message : "处理失败";
      setError(message);
      if (reason instanceof ApiError && reason.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["proposals"] });
      }
    }
  });
  const updateMode = useMutation({
    mutationFn: api.updateOpenClawSettings,
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["openclaw"] }); }
  });
  const undo = useMutation({
    mutationFn: api.undoOpenClawOperation,
    onSuccess: async () => { setError(""); await queryClient.invalidateQueries(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "撤销失败")
  });
  const categoryMap = new Map(categories.data?.map((item) => [item.id, item]) ?? []);

  return (
    <div className="page">
      <header className="page-heading"><h1>OpenClaw 操作中心</h1><p>管理直接接管模式、撤销最近操作，并处理以前留下的待确认提案。</p></header>
      <section className={`safety-note openclaw-mode-card is-${control.data?.mode ?? "confirm"}`}>
        <ShieldCheck size={22} />
        <div><strong>{control.data?.mode === "direct" ? "直接接管已开启" : "网页确认已开启"}</strong><p>{control.data?.mode === "direct" ? "账目、分类、借款、订阅、AI、备份和时区操作会立即执行；可逆修改保留 30 天撤销记录。" : "普通账目只会创建待确认提案；借款和订阅只允许查询。"}</p></div>
        <button className={control.data?.mode === "direct" ? "secondary-button" : "primary-button"} disabled={!control.data || updateMode.isPending} onClick={() => updateMode.mutate(control.data?.mode === "direct" ? "confirm" : "direct")}>{control.data?.mode === "direct" ? "改为需要确认" : "开启直接接管"}</button>
      </section>

      <section className="content-card openclaw-history">
        <div className="section-title section-title--row"><div><h2>最近直接操作</h2><p>可逆操作在 30 天内可以撤销。</p></div><History size={21} /></div>
        {(operations.data?.length ?? 0) === 0 ? <div className="openclaw-history__empty">还没有直接操作记录</div> : <div className="openclaw-operation-list">
          {operations.data?.map((operation: OpenClawOperation) => {
            const canUndo = operation.undoable && operation.status === "applied" && operation.expiresAt > new Date().toISOString();
            const isOpen = detailId === operation.id;
            return <article className="openclaw-operation-card" key={operation.id}>
              <div className="openclaw-operation-row">
                <span className={`operation-status is-${operation.status}`}>{operation.status === "undone" ? "已撤销" : operation.status === "running" ? "处理中" : operation.status === "failed" ? "失败" : "已执行"}</span>
                <div><strong>{operation.summary}</strong><small>{new Date(operation.createdAt).toLocaleString("zh-CN")} · {operation.action}</small></div>
                <div className="openclaw-operation-actions">
                  <button className="secondary-button" type="button" aria-expanded={isOpen} onClick={() => setDetailId(isOpen ? null : operation.id)}>查看详情</button>
                  {canUndo && <button className="secondary-button" disabled={undo.isPending} onClick={() => undo.mutate(operation.id)}><RotateCcw size={16} />撤销</button>}
                  {!operation.undoable && <em>不可撤销</em>}
                </div>
              </div>
              {isOpen && <OperationDetail operationId={operation.id} />}
            </article>;
          })}
        </div>}
      </section>

      <div className="section-title proposal-legacy-title"><h2>仍需人工处理的提案</h2></div>

      {proposals.isLoading ? <div className="skeleton list-skeleton" /> : (proposals.data?.length ?? 0) === 0 ? (
        <div className="content-card empty-state proposal-empty"><span><Bot size={28} /></span><strong>没有遗留的待确认操作</strong><p>直接模式下的新操作会显示在上方历史记录中。</p></div>
      ) : (
        <div className="proposal-list">
          {proposals.data?.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              categoryMap={categoryMap}
              busy={resolve.isPending}
              onEdit={(item) => { setError(""); setEditing(item); }}
              onResolve={(item, decision) => resolve.mutate({ proposal: item, decision })}
            />
          ))}
        </div>
      )}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <QuickEntry
        open={Boolean(editing)}
        proposal={editing ?? undefined}
        onClose={() => setEditing(null)}
        onConflict={(message) => setError(message)}
      />
    </div>
  );
}
