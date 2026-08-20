import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Database,
  Download,
  HardDrive,
  ImageOff,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wallpaper,
  X
} from "lucide-react";
import type { AppearanceBackgroundPreset, AppearancePreferences, AppearancePreset, Category, TransactionKind } from "@shared/types";
import { api } from "../api";
import { useAppearance } from "../appearance";
import { DangerConfirmDialog } from "../components/DangerConfirmDialog";
import { refreshApplication } from "../pwa-update";

const colors = ["#D66A4C", "#B66A8C", "#D49B45", "#2E7D61", "#4E87A6", "#5963A6", "#9A6FB0", "#7A7A73"];

const appearancePresets: Array<{ value: AppearancePreset; name: string; description: string; colors: string[] }> = [
  { value: "warm-paper", name: "温暖纸张", description: "米白、炭黑与温暖留白", colors: ["#F3EFE7", "#FEFCF7", "#282622"] },
  { value: "porcelain", name: "瓷白", description: "清爽明亮，减少纸张色", colors: ["#F7F7F5", "#FFFFFF", "#202321"] },
  { value: "sage-ledger", name: "鼠尾草账本", description: "保留熟悉的绿色气质", colors: ["#EEF2EC", "#FBFCF9", "#284A3D"] },
  { value: "ink-night", name: "墨夜", description: "低刺激的深色阅读体验", colors: ["#1B1C1A", "#242521", "#E9E4D9"] }
];

const backgroundPresets: Array<{ value: AppearanceBackgroundPreset; name: string; description: string }> = [
  { value: "plain", name: "纯净", description: "不添加纹理" },
  { value: "paper", name: "纸张", description: "细微纸面颗粒" },
  { value: "linen", name: "织纹", description: "克制的纵横纹理" },
  { value: "mist", name: "薄雾", description: "柔和的环境光晕" }
];

function AppearanceSection() {
  const { appearance, updateAppearance, isSaving, deviceBackground } = useAppearance();
  const [accent, setAccent] = useState<string>(appearance.accent);
  const [backgroundError, setBackgroundError] = useState("");
  const [appearanceError, setAppearanceError] = useState("");
  const backgroundInput = useRef<HTMLInputElement>(null);
  useEffect(() => setAccent(appearance.accent), [appearance.accent]);

  const saveAppearance = async (input: Partial<Pick<AppearancePreferences, "preset" | "accent" | "density" | "backgroundPreset">>) => {
    setAppearanceError("");
    try {
      await updateAppearance(input);
      return true;
    } catch (error) {
      setAppearanceError(error instanceof Error ? error.message : "外观设置无法保存，请稍后重试");
      return false;
    }
  };

  const selectBackgroundPreset = async (preset: AppearanceBackgroundPreset) => {
    setBackgroundError("");
    if (!await saveAppearance({ backgroundPreset: preset })) return;
    if (deviceBackground.background?.active) {
      try {
        await deviceBackground.deactivate();
      } catch (error) {
        setBackgroundError(error instanceof Error ? error.message : "无法切换到内置背景");
      }
    }
  };

  const activateBackground = async () => {
    setBackgroundError("");
    try {
      await deviceBackground.activate();
    } catch (error) {
      setBackgroundError(error instanceof Error ? error.message : "个人背景无法启用");
    }
  };

  const importBackground = async (file: File | undefined) => {
    if (!file) return;
    setBackgroundError("");
    try {
      await deviceBackground.save(file);
    } catch (error) {
      setBackgroundError(error instanceof Error ? error.message : "背景图片无法保存");
    } finally {
      if (backgroundInput.current) backgroundInput.current.value = "";
    }
  };

  const removeBackground = async () => {
    setBackgroundError("");
    try {
      await deviceBackground.remove();
    } catch (error) {
      setBackgroundError(error instanceof Error ? error.message : "背景图片无法移除");
    }
  };

  return (
    <section className="content-card appearance-section">
      <div className="section-title"><h2>外观</h2><p>主题和内置背景会跨设备同步；个人图片只保存在当前设备。</p></div>
      <div className="theme-preset-grid" role="radiogroup" aria-label="主题预设">
        {appearancePresets.map((preset) => (
          <button type="button" role="radio" aria-checked={appearance.preset === preset.value} className={appearance.preset === preset.value ? "is-active" : ""} key={preset.value} disabled={isSaving} onClick={() => void saveAppearance({ preset: preset.value })}>
            <span className="theme-preset__swatches">{preset.colors.map((color) => <i style={{ background: color }} key={color} />)}</span>
            <span><strong>{preset.name}</strong><small>{preset.description}</small></span>
            {appearance.preset === preset.value && <Check size={17} />}
          </button>
        ))}
      </div>
      <div className="background-preset-section">
        <span className="appearance-control-label"><Wallpaper size={17} />页面背景</span>
        <div className="background-preset-grid" role="radiogroup" aria-label="内置背景">
          {backgroundPresets.map((preset) => (
            <button
              type="button"
              role="radio"
              aria-checked={!deviceBackground.background?.active && appearance.backgroundPreset === preset.value}
              className={`background-preset is-${preset.value} ${!deviceBackground.background?.active && appearance.backgroundPreset === preset.value ? "is-active" : ""}`}
              key={preset.value}
              disabled={isSaving}
              onClick={() => void selectBackgroundPreset(preset.value)}
            >
              <span aria-hidden="true" />
              <strong>{preset.name}</strong>
              <small>{preset.description}</small>
              {!deviceBackground.background?.active && appearance.backgroundPreset === preset.value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className={`device-background-control ${deviceBackground.background?.active ? "is-active" : ""}`}>
          <div className="device-background-preview" style={deviceBackground.background?.url ? { backgroundImage: `url(${deviceBackground.background.url})` } : undefined}>
            {!deviceBackground.background?.url && <Wallpaper size={25} aria-hidden="true" />}
          </div>
          <div>
            <strong>{deviceBackground.background?.active ? "正在使用个人图片" : deviceBackground.background ? "个人图片已保留" : "个人背景图片"}</strong>
            <small>{deviceBackground.background ? `${deviceBackground.background.width} × ${deviceBackground.background.height}，${deviceBackground.background.active ? "仅当前设备可见" : "点击“使用图片”即可恢复"}` : "支持 JPEG、PNG、WebP 等图片，原文件最大 15 MB"}</small>
          </div>
          <input ref={backgroundInput} className="visually-hidden" type="file" accept="image/avif,image/bmp,image/gif,image/jpeg,image/png,image/webp" onChange={(event) => void importBackground(event.target.files?.[0])} />
          <div className="device-background-actions">
            {deviceBackground.background && !deviceBackground.background.active && <button className="primary-button" disabled={deviceBackground.isLoading} onClick={() => void activateBackground()}><Wallpaper size={17} />使用图片</button>}
            <button className="secondary-button" disabled={deviceBackground.isLoading} onClick={() => backgroundInput.current?.click()}><ImagePlus size={17} />{deviceBackground.background ? "更换" : "选择图片"}</button>
            {deviceBackground.background && <button className="icon-button" disabled={deviceBackground.isLoading} onClick={() => void removeBackground()} aria-label="移除个人背景"><ImageOff size={18} /></button>}
          </div>
        </div>
        {(backgroundError || deviceBackground.error) && <p className="form-error" role="alert">{backgroundError || deviceBackground.error?.message}</p>}
        {appearanceError && <p className="form-error" role="alert">{appearanceError}</p>}
        <small className="device-background-note">图片会在浏览器内压缩并去除元数据，不会上传到服务器，也不会进入账本备份。切换内置背景不会删除图片。</small>
      </div>
      <div className="appearance-controls">
        <div>
          <span className="appearance-control-label"><Palette size={17} />主色</span>
          <div className="accent-control"><input type="color" value={accent} onChange={(event) => setAccent(event.target.value.toUpperCase())} aria-label="自定义主色" /><input value={accent} onChange={(event) => setAccent(event.target.value.toUpperCase())} maxLength={7} aria-label="主色十六进制值" /><button className="secondary-button" disabled={isSaving || accent === appearance.accent || !/^#[0-9A-F]{6}$/.test(accent)} onClick={() => void saveAppearance({ accent: accent as `#${string}` })}>应用</button></div>
          <small>系统会自动选择深色或浅色文字，并生成适合当前主题的强调色。</small>
        </div>
        <div>
          <span className="appearance-control-label">桌面密度</span>
          <div className="density-switch"><button className={appearance.density === "comfortable" ? "is-active" : ""} onClick={() => void saveAppearance({ density: "comfortable" })}>舒适</button><button className={appearance.density === "compact" ? "is-active" : ""} onClick={() => void saveAppearance({ density: "compact" })}>紧凑</button></div>
          <small>紧凑模式只压缩桌面列表，手机触控区域不会变小。</small>
        </div>
      </div>
    </section>
  );
}

function CategoryDialog({ category, kind, onClose }: { category?: Category; kind: TransactionKind; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(category?.name ?? "");
  const [icon, setIcon] = useState(category?.icon ?? "✨");
  const [color, setColor] = useState(category?.color ?? colors[0]);
  const save = useMutation({
    mutationFn: () => category
      ? api.updateCategory(category.id, { name, icon, color })
      : api.createCategory({ kind, name, icon, color }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["categories"] }); onClose(); }
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
  const impact = useQuery({
    queryKey: ["category-deletion-impact", category.id],
    queryFn: () => api.categoryDeletionImpact(category.id),
    enabled: purgeOpen,
    staleTime: 0
  });
  const disposition = useMutation({
    mutationFn: (input: { action: "archive" | "restore" | "delete" } | { action: "migrate"; targetCategoryId: string } | { action: "purge"; expectedRevision: string; confirmName: string }) => api.manageCategory(category.id, input),
    onSuccess: async () => { await queryClient.invalidateQueries(); onClose(); }
  });
  const migrate = () => {
    if (!targetCategoryId) return;
    const target = targets.find((item) => item.id === targetCategoryId);
    if (window.confirm(`将“${category.name}”的 ${category.transactionCount} 笔账目全部迁移到“${target?.name ?? "目标分类"}”，然后删除原分类？`)) {
      disposition.mutate({ action: "migrate", targetCategoryId });
    }
  };
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
            <button className="secondary-button" disabled={!targetCategoryId || disposition.isPending} onClick={migrate}>开始迁移</button>
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

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TransactionKind>("expense");
  const [editing, setEditing] = useState<Category | undefined>();
  const [managing, setManaging] = useState<Category | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const openClawSettings = useQuery({ queryKey: ["openclaw", "settings"], queryFn: api.openClawSettings });
  const categories = useQuery({ queryKey: ["categories", "settings", true], queryFn: () => api.categories(undefined, true) });
  const currentTimezone = useMemo(() => settings.data?.rows.find((row) => row.key === "timezone")?.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone, [settings.data]);
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai");
  useEffect(() => setTimezone(currentTimezone), [currentTimezone]);
  const timezoneMutation = useMutation({
    mutationFn: () => api.updateTimezone(timezone),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] })
  });
  const backup = useMutation({
    mutationFn: api.backup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] })
  });
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
    <div className="page">
      <header className="page-heading"><h1>设置</h1><p>管理外观、分类、备份和本机服务。</p></header>

      <AppearanceSection />

      <section className="content-card status-section">
        <div className="section-title section-title--row"><div><h2>运行状态</h2><p>页面会自动同步账目并检查新版本，无需清除 Cookie。</p></div><button className="secondary-button" onClick={() => void refreshApplication()}><RefreshCw size={17} />检查并刷新</button></div>
        <div className="status-grid">
          <div><span className="status-icon"><Database size={20} /></span><p>数据库</p><strong>{status.data?.database === "ok" ? "运行正常" : "等待连接"}</strong><small>SQLite · 本机 SSD</small></div>
          <div><span className="status-icon"><Bot size={20} /></span><p>DeepSeek</p><strong>{status.data?.deepseek === "configured" ? "已配置" : "尚未配置"}</strong><small>密钥仅保存在本机</small></div>
          <div><span className="status-icon"><HardDrive size={20} /></span><p>最近备份</p><strong>{status.data?.backup.lastSuccessAt ? new Date(status.data.backup.lastSuccessAt).toLocaleDateString("zh-CN") : "尚未备份"}</strong><small>{status.data?.backup.remoteConfigured ? "本地 + Google Drive" : "本地快照可用"}</small></div>
          <div><span className="status-icon"><ShieldCheck size={20} /></span><p>版本</p><strong>寸金 {status.data?.version ?? "1.0.0"}</strong><small>单人私人账本</small></div>
        </div>
      </section>

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

      <div className="settings-two-column">
        <section className="content-card backup-section">
          <div className="section-title"><h2>备份与导出</h2></div>
          <p>正式数据库保存在 SSD。手动备份会先做完整性检查，再生成一致快照。</p>
          {status.data?.backup.lastLocalPath && <code className="path-code">{status.data.backup.lastLocalPath}</code>}
          {backup.data && <div className="backup-success"><CheckCircle2 size={17} />{backup.data.remoteMessage}</div>}
          {backup.isError && <p className="form-error">{backup.error instanceof Error ? backup.error.message : "备份失败"}</p>}
          <div className="button-stack"><button className="primary-button" disabled={backup.isPending} onClick={() => backup.mutate()}>{backup.isPending ? <LoaderCircle className="spin" size={17} /> : <HardDrive size={17} />}立即备份</button><a className="secondary-button" href="/api/v1/export.json"><Download size={17} />导出完整 JSON</a><a className="secondary-button" href="/api/v1/export.csv"><Download size={17} />导出 CSV</a></div>
        </section>

        <section className="content-card preferences-section">
          <div className="section-title"><h2>账本时区</h2></div>
          <p>旧账保存自己的本地日期，修改时区不会把它们移动到其他日期。</p>
          <label className="dialog-field"><span>IANA 时区</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Shanghai" /></label>
          {timezoneMutation.isError && <p className="form-error">时区无效，请使用例如 Asia/Shanghai</p>}
          <button className="secondary-button" disabled={timezone === currentTimezone || timezoneMutation.isPending} onClick={() => timezoneMutation.mutate()}><Save size={17} />保存时区</button>
        </section>
      </div>

      <section className="content-card connection-section">
        <div className="section-title"><h2>设备与接入</h2></div>
        <div className="connection-grid">
          <article><span><Smartphone size={21} /></span><div><strong>安装为 App</strong><p>在 Android Chrome 或电脑浏览器打开菜单，选择“安装应用”或“添加到主屏幕”。</p></div></article>
          <article><span><Cloud size={21} /></span><div><strong>Cloudflare Tunnel</strong><p>正式部署后由 money.sutady.top 转发到本机，不需要开放家庭路由器端口。</p></div></article>
          <article><span><KeyRound size={21} /></span><div><strong>DeepSeek 密钥</strong><p>在服务电脑上双击“配置DeepSeek密钥.cmd”，隐藏输入密钥后重启服务；思考模式可在 .env 中设为 enabled 或 disabled。</p></div></article>
          <article><span><Bot size={21} /></span><div><strong>OpenClaw MCP</strong><p>标准入口为 /mcp。当前为{openClawSettings.data?.mode === "direct" ? "直接接管模式：可管理账目、分类、借款、订阅、AI、备份和时区，操作记录保留 30 天。" : "确认模式：普通账目写入需要批准，借款和订阅只允许查询。"}密钥、Access 和服务控制永不开放。</p></div></article>
        </div>
      </section>

      {dialogOpen && <CategoryDialog category={editing} kind={kind} onClose={() => { setDialogOpen(false); setEditing(undefined); }} />}
      {managing && <CategoryDispositionDialog category={managing} targets={visibleCategories.filter((item) => item.id !== managing.id && !item.isArchived)} onClose={() => setManaging(undefined)} />}
    </div>
  );
}
