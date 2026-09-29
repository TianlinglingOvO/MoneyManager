import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ArrowRightLeft, ChevronDown, ChevronUp, LoaderCircle, MoreHorizontal, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import type { Category, TransactionKind } from "@shared/types";
import { api } from "../api";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { DangerConfirmDialog } from "../components/DangerConfirmDialog";

const colors = ["#D66A4C", "#B66A8C", "#D49B45", "#2E7D61", "#4E87A6", "#5963A6", "#9A6FB0", "#7A7A73"];

function CategoryDialog({ category, kind, onClose }: { category?: Category; kind: TransactionKind; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(category?.name ?? "");
  const [icon, setIcon] = useState(category?.icon ?? "✨");
  const [color, setColor] = useState(category?.color ?? colors[0]);
  const save = useMutation({
    mutationFn: () => category
      ? api.updateCategory(category.id, { name, icon, color })
      : api.createCategory({ kind, name, icon, color }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["categories"] }); onClose(); }
  });
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="small-dialog" role="dialog" aria-modal="true">
        <header><div><p className="eyebrow">{category ? "修改分类" : "新增分类"}</p><h2>{kind === "expense" ? "支出" : "收入"}分类</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></header>
        <label className="dialog-field"><span>分类名称</span><input maxLength={16} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：宠物" autoFocus /></label>
        <label className="dialog-field"><span>图标</span><input maxLength={8} value={icon} onChange={(event) => setIcon(event.target.value)} placeholder="🐾" /></label>
        <div className="dialog-field"><span>颜色</span><div className="color-picker">{colors.map((value) => <button key={value} aria-label={`选择颜色 ${value}`} className={color === value ? "is-active" : ""} style={{ background: value }} onClick={() => setColor(value)} />)}<input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="自定义颜色" /></div></div>
        <div className="category-preview"><span style={{ background: `${color}20` }}>{icon || "✨"}</span><strong>{name || "分类预览"}</strong></div>
        {save.isError && <p className="form-error">{save.error instanceof Error ? save.error.message : "保存失败"}</p>}
        <button className="primary-button dialog-save" disabled={!name.trim() || !icon.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" size={18} /> : <Save size={18} />}保存分类</button>
      </section>
    </div>
  );
}

function CategoryDispositionDialog({ category, targets, onClose }: { category: Category; targets: Category[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [targetCategoryId, setTargetCategoryId] = useState(targets[0]?.id ?? "");
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [migrateConfirmOpen, setMigrateConfirmOpen] = useState(false);
  const impact = useQuery({
    queryKey: ["category-deletion-impact", category.id],
    queryFn: () => api.categoryDeletionImpact(category.id),
    enabled: purgeOpen,
    staleTime: 0
  });
  const disposition = useMutation({
    mutationFn: (input: { action: "archive" | "restore" | "delete" } | { action: "migrate"; targetCategoryId: string } | { action: "purge"; expectedRevision: string; confirmName: string }) => api.manageCategory(category.id, input),
    onSuccess: () => { void queryClient.invalidateQueries(); onClose(); }
  });
  const migrateTarget = targets.find((item) => item.id === targetCategoryId);
  if (migrateConfirmOpen) {
    return (
      <ConfirmSheet
        open
        title="迁移并删除原分类"
        closeLabel="关闭迁移确认"
        description={`将“${category.name}”的 ${category.transactionCount} 笔账目全部迁移到“${migrateTarget?.name ?? "目标分类"}”，然后删除原分类？`}
        confirmLabel="迁移并删除"
        isPending={disposition.isPending}
        error={disposition.isError ? (disposition.error instanceof Error ? disposition.error.message : "迁移失败") : null}
        onConfirm={() => { if (targetCategoryId) disposition.mutate({ action: "migrate", targetCategoryId }); }}
        onClose={() => { if (!disposition.isPending) setMigrateConfirmOpen(false); }}
      />
    );
  }
  if (purgeOpen) {
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
        isPending={disposition.isPending || impact.isLoading}
        error={disposition.isError ? (disposition.error instanceof Error ? disposition.error.message : "永久删除失败") : null}
        onClose={() => { if (!disposition.isPending) setPurgeOpen(false); }}
        onConfirm={() => {
          if (!item) return;
          disposition.mutate({ action: "purge", expectedRevision: item.revision, confirmName: category.name });
        }}
      />
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="small-dialog category-disposition-dialog" role="dialog" aria-modal="true" aria-labelledby="category-disposition-title">
        <header><div><p className="eyebrow">分类处理</p><h2 id="category-disposition-title">{category.icon} {category.name}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></header>
        <p className="category-usage-copy">这个分类关联 <strong>{category.transactionCount} 笔</strong>账目。请选择你希望如何处理。</p>

        <div className="category-action-list">
          <button disabled={disposition.isPending} onClick={() => disposition.mutate({ action: category.isArchived ? "restore" : "archive" })}>
            <span className="category-action-list__icon">{category.isArchived ? <ArchiveRestore size={20} /> : <Archive size={20} />}</span>
            <span><strong>{category.isArchived ? "恢复使用" : "停用分类"}</strong><small>{category.isArchived ? "重新出现在记账分类中" : "保留历史账目，不再用于新记账"}</small></span>
          </button>

          <div className="category-migrate-action">
            <span className="category-action-list__icon"><ArrowRightLeft size={20} /></span>
            <span><strong>迁移并删除原分类</strong><small>历史账目和回收站记录都会改到目标分类</small></span>
            <select value={targetCategoryId} onChange={(event) => setTargetCategoryId(event.target.value)} disabled={targets.length === 0 || disposition.isPending} aria-label="迁移目标分类">
              {targets.length === 0 ? <option value="">请先创建另一个同类型分类</option> : targets.map((item) => <option value={item.id} key={item.id}>{item.icon} {item.name}</option>)}
            </select>
            <button className="secondary-button" disabled={!targetCategoryId || disposition.isPending} onClick={() => { disposition.reset(); setMigrateConfirmOpen(true); }}>开始迁移</button>
          </div>

          <button className="category-delete-action" disabled={disposition.isPending} onClick={() => setPurgeOpen(true)}>
            <span className="category-action-list__icon"><Trash2 size={20} /></span>
            <span><strong>永久删除分类及账目</strong><small>永久清除这个分类下的全部正常账目和回收站账目</small></span>
          </button>
        </div>
        {disposition.isError && <p className="form-error">{disposition.error instanceof Error ? disposition.error.message : "处理失败"}</p>}
      </section>
    </div>
  );
}

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TransactionKind>("expense");
  const [editing, setEditing] = useState<Category | undefined>();
  const [managing, setManaging] = useState<Category | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const categories = useQuery({ queryKey: ["categories", "settings", true], queryFn: () => api.categories(undefined, true) });
  const visibleCategories = categories.data?.filter((item) => item.kind === kind) ?? [];
  const reorder = useMutation({
    mutationFn: async ({ category, direction }: { category: Category; direction: -1 | 1 }) => {
      const currentIndex = visibleCategories.findIndex((item) => item.id === category.id);
      const target = visibleCategories[currentIndex + direction];
      if (!target) return category;
      await api.updateCategory(category.id, { sortOrder: target.sortOrder });
      return api.updateCategory(target.id, { sortOrder: category.sortOrder });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["categories"] })
  });

  return (
    <div className="page categories-page">
      <header className="page-heading"><h1>分类</h1><p>整理记账时可选的支出和收入分类。</p></header>

      <section className="content-card categories-section">
        <div className="section-title section-title--row"><div><h2>分类管理</h2></div><button className="secondary-button" onClick={() => { setEditing(undefined); setDialogOpen(true); }}><Plus size={17} />新增分类</button></div>
        <div className="kind-pills category-kind-tabs"><button className={kind === "expense" ? "is-active" : ""} onClick={() => setKind("expense")}>支出分类</button><button className={kind === "income" ? "is-active" : ""} onClick={() => setKind("income")}>收入分类</button></div>
        <div className="category-settings-list">
          {visibleCategories.length === 0 && (
            <div className="category-settings-empty">
              <span>＋</span><strong>还没有{kind === "expense" ? "支出" : "收入"}分类</strong><small>点击右上角“新增分类”，只添加你真正需要的。</small>
            </div>
          )}
          {visibleCategories.map((category, index) => (
            <div className={category.isArchived ? "is-archived" : ""} key={category.id}>
              <span className="category-settings-list__icon" style={{ background: `${category.color}18` }}>{category.icon}</span>
              <span><strong>{category.name}</strong><small>{category.isArchived ? `已停用 · ${category.transactionCount} 笔账目` : `${category.transactionCount} 笔账目`}</small></span>
              <span className="category-order-controls">
                <button className="icon-button" disabled={index === 0 || reorder.isPending} aria-label={`上移${category.name}`} onClick={() => reorder.mutate({ category, direction: -1 })}><ChevronUp size={14} /></button>
                <button className="icon-button" disabled={index === visibleCategories.length - 1 || reorder.isPending} aria-label={`下移${category.name}`} onClick={() => reorder.mutate({ category, direction: 1 })}><ChevronDown size={14} /></button>
              </span>
              <button className="icon-button" aria-label={`编辑${category.name}`} onClick={() => { setEditing(category); setDialogOpen(true); }}><Pencil size={17} /></button>
              <button className="icon-button" aria-label={`管理${category.name}`} onClick={() => setManaging(category)}><MoreHorizontal size={18} /></button>
            </div>
          ))}
        </div>
      </section>

      {dialogOpen && <CategoryDialog category={editing} kind={kind} onClose={() => { setDialogOpen(false); setEditing(undefined); }} />}
      {managing && <CategoryDispositionDialog category={managing} targets={visibleCategories.filter((item) => item.id !== managing.id && !item.isArchived)} onClose={() => setManaging(undefined)} />}
    </div>
  );
}
