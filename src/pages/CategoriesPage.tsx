import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ArrowRightLeft, ChevronDown, ChevronUp, LoaderCircle, MoreHorizontal, Pencil, Plus, Save, Trash2 } from "lucide-react";
import type { Category, TransactionKind } from "@shared/types";
import { api } from "../api";
import { BottomSheet, type BottomSheetHandle } from "../components/BottomSheet";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { DangerConfirmDialog } from "../components/DangerConfirmDialog";
import { useDirtyCheck } from "../form-state";

const colors = ["#D66A4C", "#B66A8C", "#D49B45", "#2E7D61", "#4E87A6", "#5963A6", "#9A6FB0", "#7A7A73"];
const iconSuggestions: Record<TransactionKind, string[]> = {
  expense: ["🍜", "🚇", "🛍️", "🏠", "🎮", "💊", "📱", "☕", "🐾", "🎁", "📚", "✈️"],
  income: ["💼", "📈", "🧧", "💰", "🎁", "🏦"]
};

function CategoryDialog({ category, kind, onClose }: { category?: Category; kind: TransactionKind; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(category?.name ?? "");
  const [icon, setIcon] = useState(category?.icon ?? "✨");
  const [color, setColor] = useState(category?.color ?? colors[0]);
  const [isFixed, setIsFixed] = useState(Boolean(category?.isFixed));
  const dirty = useDirtyCheck({ name, icon, color, isFixed });
  const kindLabel = kind === "expense" ? "支出" : "收入";
  const save = useMutation({
    mutationFn: () => {
      const fixed = kind === "expense" ? { isFixed } : {};
      return category
        ? api.updateCategory(category.id, { name, icon, color, ...fixed })
        : api.createCategory({ kind, name, icon, color, ...fixed });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["categories"] }); void queryClient.invalidateQueries({ queryKey: ["budget"] }); onClose(); }
  });
  return (
    <BottomSheet
      open
      title={category ? `修改${kindLabel}分类` : `新增${kindLabel}分类`}
      closeLabel={category ? "关闭修改分类" : "关闭新增分类"}
      onClose={onClose}
      dirty={dirty}
      discardDescription="分类修改还没有保存，关闭后会丢失。"
      busy={save.isPending}
      className="category-sheet"
      footer={<button className="primary-button" type="submit" form="category-form" disabled={!name.trim() || !icon.trim() || save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={18} /> : <Save size={18} />}保存分类</button>}
    >
      <form id="category-form" className="category-form" onSubmit={(event) => { event.preventDefault(); if (name.trim() && icon.trim()) save.mutate(); }}>
        <label className="dialog-field"><span>分类名称</span><input maxLength={16} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：宠物" autoFocus /></label>
        <div className="dialog-field">
          <label htmlFor="category-icon-input">图标</label>
          <div className="category-icon-field">
            <input id="category-icon-input" maxLength={8} value={icon} onChange={(event) => setIcon(event.target.value)} placeholder="🐾" />
            <div className="category-icon-suggestions" role="group" aria-label="常用图标">
              {iconSuggestions[kind].map((item) => <button type="button" key={item} className={icon === item ? "is-active" : ""} aria-pressed={icon === item} aria-label={`使用图标 ${item}`} onClick={() => setIcon(item)}>{item}</button>)}
            </div>
          </div>
        </div>
        <div className="dialog-field"><span>颜色</span><div className="color-picker">{colors.map((value) => <button type="button" key={value} aria-label={`选择颜色 ${value}`} aria-pressed={color === value} className={color === value ? "is-active" : ""} style={{ background: value }} onClick={() => setColor(value)} />)}<input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="自定义颜色" /></div></div>
        {kind === "expense" && <label className="category-fixed-toggle">
          <input type="checkbox" checked={isFixed} onChange={(event) => setIsFixed(event.target.checked)} />
          <span><strong>固定支出</strong><small>房租、保险这类每月一次的支出。预计月底支出时按实际计入、不按天外推；账本体检只在金额明显高于往常时提醒。</small></span>
        </label>}
        <div className="category-preview"><span style={{ background: `${color}20` }}>{icon || "✨"}</span><strong>{name || "分类预览"}</strong>{kind === "expense" && isFixed && <em className="category-fixed-badge">固定</em>}</div>
        {save.isError && <p className="form-error" role="alert">{save.error instanceof Error ? save.error.message : "保存失败"}</p>}
      </form>
    </BottomSheet>
  );
}

type PendingDisposition = { type: "migrate"; targetCategoryId: string } | { type: "purge" } | null;

function CategoryDispositionSheet({ category, targets, onClose, onRequestMigrate, onRequestPurge }: {
  category: Category;
  targets: Category[];
  onClose: () => void;
  onRequestMigrate: (targetCategoryId: string) => void;
  onRequestPurge: () => void;
}) {
  const queryClient = useQueryClient();
  const sheetRef = useRef<BottomSheetHandle | null>(null);
  const pendingRef = useRef<PendingDisposition>(null);
  const [targetCategoryId, setTargetCategoryId] = useState(targets[0]?.id ?? "");
  const toggleArchive = useMutation({
    mutationFn: () => api.manageCategory(category.id, { action: category.isArchived ? "restore" : "archive" }),
    onSuccess: () => { void queryClient.invalidateQueries(); sheetRef.current?.close({ skipBeforeClose: true }); }
  });
  // The follow-up confirmation opens only after this sheet has finished closing, so the two never stack.
  const finishClose = () => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    onClose();
    if (pending?.type === "migrate") window.requestAnimationFrame(() => onRequestMigrate(pending.targetCategoryId));
    if (pending?.type === "purge") window.requestAnimationFrame(onRequestPurge);
  };
  const follow = (pending: NonNullable<PendingDisposition>) => {
    pendingRef.current = pending;
    sheetRef.current?.close({ skipBeforeClose: true });
  };
  return (
    <BottomSheet ref={sheetRef} open title={`${category.icon} ${category.name}`} closeLabel="关闭分类处理" onClose={finishClose} busy={toggleArchive.isPending} className="category-disposition-sheet">
      <p className="category-usage-copy">这个分类关联 <strong>{category.transactionCount} 笔</strong>账目。请选择你希望如何处理。</p>
      <div className="category-action-list">
        <button type="button" disabled={toggleArchive.isPending} onClick={() => toggleArchive.mutate()}>
          <span className="category-action-list__icon">{category.isArchived ? <ArchiveRestore size={20} /> : <Archive size={20} />}</span>
          <span><strong>{category.isArchived ? "恢复使用" : "停用分类"}</strong><small>{category.isArchived ? "重新出现在记账分类中" : "保留历史账目，不再用于新记账"}</small></span>
        </button>

        <div className="category-migrate-action">
          <span className="category-action-list__icon"><ArrowRightLeft size={20} /></span>
          <span><strong>迁移并删除原分类</strong><small>历史账目和回收站记录都会改到目标分类</small></span>
          <select value={targetCategoryId} onChange={(event) => setTargetCategoryId(event.target.value)} disabled={targets.length === 0} aria-label="迁移目标分类">
            {targets.length === 0 ? <option value="">请先创建另一个同类型分类</option> : targets.map((item) => <option value={item.id} key={item.id}>{item.icon} {item.name}</option>)}
          </select>
          <button type="button" className="secondary-button" disabled={!targetCategoryId || toggleArchive.isPending} onClick={() => follow({ type: "migrate", targetCategoryId })}>开始迁移</button>
        </div>

        <button type="button" className="category-delete-action" disabled={toggleArchive.isPending} onClick={() => follow({ type: "purge" })}>
          <span className="category-action-list__icon"><Trash2 size={20} /></span>
          <span><strong>永久删除分类及账目</strong><small>永久清除这个分类下的全部正常账目和回收站账目</small></span>
        </button>
      </div>
      {toggleArchive.isError && <p className="form-error" role="alert">{toggleArchive.error instanceof Error ? toggleArchive.error.message : "处理失败"}</p>}
    </BottomSheet>
  );
}

function CategoryMigrateConfirm({ category, target, onClose }: { category: Category; target?: Category; onClose: () => void }) {
  const queryClient = useQueryClient();
  const migrate = useMutation({
    mutationFn: () => api.manageCategory(category.id, { action: "migrate", targetCategoryId: target!.id }),
    onSuccess: () => { void queryClient.invalidateQueries(); onClose(); }
  });
  return (
    <ConfirmSheet
      open
      title="迁移并删除原分类"
      closeLabel="关闭迁移确认"
      description={`将“${category.name}”的 ${category.transactionCount} 笔账目全部迁移到“${target?.name ?? "目标分类"}”，然后删除原分类？`}
      confirmLabel="迁移并删除"
      isPending={migrate.isPending}
      error={migrate.isError ? (migrate.error instanceof Error ? migrate.error.message : "迁移失败") : null}
      onConfirm={() => { if (target) migrate.mutate(); }}
      onClose={() => { if (!migrate.isPending) onClose(); }}
    />
  );
}

function CategoryPurgeConfirm({ category, onClose }: { category: Category; onClose: () => void }) {
  const queryClient = useQueryClient();
  const impact = useQuery({
    queryKey: ["category-deletion-impact", category.id],
    queryFn: () => api.categoryDeletionImpact(category.id),
    staleTime: 0
  });
  const purge = useMutation({
    mutationFn: (expectedRevision: string) => api.manageCategory(category.id, { action: "purge", expectedRevision, confirmName: category.name }),
    onSuccess: () => { void queryClient.invalidateQueries(); onClose(); }
  });
  const item = impact.data;
  return (
    <DangerConfirmDialog
      title={`永久删除“${category.name}”`}
      description="分类以及分类下的全部正常账目和回收站账目都会被永久删除，此操作无法撤销。"
      details={item ? (
        <>
          <span>正常账目 <strong>{item.activeTransactionCount} 笔</strong></span>
          <span>回收站账目 <strong>{item.trashedTransactionCount} 笔</strong></span>
          <span>事项关联 <strong>{item.linkedMatterCount} 项</strong>（事项会保留并解除账本关联）</span>
          <span>待确认提案 <strong>{item.pendingProposalCount} 项</strong>（将自动拒绝）</span>
        </>
      ) : impact.isError ? <span className="form-error">{impact.error instanceof Error ? impact.error.message : "无法读取删除影响"}</span> : <span>正在核对受影响内容……</span>}
      confirmText={category.name}
      confirmLabel="永久删除分类及账目"
      isPending={purge.isPending || impact.isLoading}
      error={purge.isError ? (purge.error instanceof Error ? purge.error.message : "永久删除失败") : null}
      onClose={() => { if (!purge.isPending) onClose(); }}
      onConfirm={() => { if (item) purge.mutate(item.revision); }}
    />
  );
}

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TransactionKind>("expense");
  const [editing, setEditing] = useState<Category | undefined>();
  const [managing, setManaging] = useState<Category | undefined>();
  const [migrating, setMigrating] = useState<{ category: Category; targetCategoryId: string } | null>(null);
  const [purging, setPurging] = useState<Category | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const categories = useQuery({ queryKey: ["categories", "settings", true], queryFn: () => api.categories(undefined, true) });
  const visibleCategories = categories.data?.filter((item) => item.kind === kind) ?? [];
  const reorder = useMutation({
    // The whole order is written in one request, so a failure can never leave two categories sharing a position.
    mutationFn: ({ category, direction }: { category: Category; direction: -1 | 1 }) => {
      const ids = visibleCategories.map((item) => item.id);
      const index = ids.indexOf(category.id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ids.length) return Promise.resolve(categories.data ?? []);
      [ids[index], ids[target]] = [ids[target]!, ids[index]!];
      return api.reorderCategories(kind, ids);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["categories"] })
  });
  const migrateTarget = migrating ? categories.data?.find((item) => item.id === migrating.targetCategoryId) : undefined;

  return (
    <div className="page categories-page">
      <header className="page-heading"><h1>分类</h1><p>整理记账时可选的支出和收入分类。</p></header>

      <section className="content-card categories-section">
        <div className="section-title section-title--row"><div><h2>分类管理</h2></div><button className="secondary-button" onClick={() => { setEditing(undefined); setDialogOpen(true); }}><Plus size={17} />新增分类</button></div>
        <div className="kind-pills category-kind-tabs"><button className={kind === "expense" ? "is-active" : ""} onClick={() => setKind("expense")}>支出分类</button><button className={kind === "income" ? "is-active" : ""} onClick={() => setKind("income")}>收入分类</button></div>
        {kind === "expense" && <p className="category-fixed-hint">标为“固定”的分类（如房租）在预计月底支出时按实际计入，不按天外推。</p>}
        {reorder.isError && <p className="form-error" role="alert">{reorder.error instanceof Error ? reorder.error.message : "调整顺序失败，请刷新后重试"}</p>}
        <div className="category-settings-list">
          {visibleCategories.length === 0 && (
            <div className="category-settings-empty">
              <span>＋</span><strong>还没有{kind === "expense" ? "支出" : "收入"}分类</strong><small>点击右上角“新增分类”，只添加你真正需要的。</small>
            </div>
          )}
          {visibleCategories.map((category, index) => (
            <div className={category.isArchived ? "is-archived" : ""} key={category.id}>
              <span className="category-settings-list__icon" style={{ background: `${category.color}18` }}>{category.icon}</span>
              <span className="category-settings-list__body"><strong>{category.name}{category.isFixed && <em className="category-fixed-badge">固定</em>}</strong><small>{category.isArchived ? `已停用 · ${category.transactionCount} 笔账目` : `${category.transactionCount} 笔账目`}</small></span>
              <span className="category-settings-list__actions">
                <button className="icon-button" disabled={index === 0 || reorder.isPending} aria-label={`上移${category.name}`} onClick={() => reorder.mutate({ category, direction: -1 })}><ChevronUp size={16} /></button>
                <button className="icon-button" disabled={index === visibleCategories.length - 1 || reorder.isPending} aria-label={`下移${category.name}`} onClick={() => reorder.mutate({ category, direction: 1 })}><ChevronDown size={16} /></button>
                <button className="icon-button" aria-label={`编辑${category.name}`} onClick={() => { setEditing(category); setDialogOpen(true); }}><Pencil size={16} /></button>
                <button className="icon-button" aria-label={`管理${category.name}`} onClick={() => setManaging(category)}><MoreHorizontal size={17} /></button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {dialogOpen && <CategoryDialog key={editing?.id ?? `new-${kind}`} category={editing} kind={editing?.kind ?? kind} onClose={() => { setDialogOpen(false); setEditing(undefined); }} />}
      {managing && <CategoryDispositionSheet
        key={managing.id}
        category={managing}
        targets={(categories.data ?? []).filter((item) => item.kind === managing.kind && item.id !== managing.id && !item.isArchived)}
        onClose={() => setManaging(undefined)}
        onRequestMigrate={(targetCategoryId) => setMigrating({ category: managing, targetCategoryId })}
        onRequestPurge={() => setPurging(managing)}
      />}
      {migrating && <CategoryMigrateConfirm category={migrating.category} target={migrateTarget} onClose={() => setMigrating(null)} />}
      {purging && <CategoryPurgeConfirm category={purging} onClose={() => setPurging(null)} />}
    </div>
  );
}
