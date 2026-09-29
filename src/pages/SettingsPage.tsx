import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  Bot,
  Check,
  CheckCircle2,
  Cloud,
  Database,
  Download,
  Globe,
  HardDrive,
  ImageOff,
  ImagePlus,
  LoaderCircle,
  Palette,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Target,
  Wallpaper
} from "lucide-react";
import type { AppearanceBackgroundPreset, AppearancePreferences, AppearancePreset, BackupCheckStatus } from "@shared/types";
import { APP_VERSION } from "@shared/app-metadata";
import { api } from "../api";
import { useAppearance } from "../appearance";
import { BudgetSheet } from "../components/BudgetSheet";
import { timezoneOffsetLabel, useLedgerClock } from "../ledger-clock";
import { refreshApplication } from "../pwa-update";
import { reminderHeadline } from "../reminder-status";

const appearancePresets: Array<{ value: AppearancePreset; name: string; description: string; colors: string[] }> = [
  { value: "warm-paper", name: "温暖纸张", description: "米白、炭黑与温暖留白", colors: ["#F3EFE7", "#FEFCF7", "#282622"] },
  { value: "ink-night", name: "墨夜", description: "低刺激的深色阅读体验", colors: ["#1B1C1A", "#242521", "#E9E4D9"] },
  { value: "auto", name: "跟随系统", description: "手机或电脑开深色模式时自动切换为墨夜", colors: ["#F3EFE7", "#FEFCF7", "#242521", "#1B1C1A"] }
];

const backgroundPresets: Array<{ value: AppearanceBackgroundPreset; name: string; description: string }> = [
  { value: "plain", name: "纯净", description: "不添加纹理" },
  { value: "paper", name: "纸张", description: "细微纸面颗粒" },
  { value: "linen", name: "织纹", description: "克制的纵横纹理" },
  { value: "mist", name: "薄雾", description: "柔和的环境光晕" }
];

function backupStateLabel(status: BackupCheckStatus): string {
  if (status.state === "success") return "正常";
  if (status.state === "failed") return "最近失败";
  if (status.state === "stale") return "已过期";
  if (status.state === "not_configured") return "未配置";
  return "尚未执行";
}

function backupTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function AppearanceSection() {
  const { appearance, updateAppearance, isSaving, deviceBackground } = useAppearance();
  const [accent, setAccent] = useState<string>(appearance.accent);
  const [backgroundError, setBackgroundError] = useState("");
  const [appearanceError, setAppearanceError] = useState("");
  const backgroundInput = useRef<HTMLInputElement>(null);
  useEffect(() => setAccent(appearance.accent), [appearance.accent]);

  const saveAppearance = async (input: Partial<Pick<AppearancePreferences, "preset" | "accent" | "backgroundPreset">>) => {
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
      </div>
    </section>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { today, timezone: ledgerTimezone } = useLedgerClock();
  const currentMonth = today.slice(0, 7);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 60_000 });
  const openClawSettings = useQuery({ queryKey: ["openclaw", "settings"], queryFn: api.openClawSettings });
  const categories = useQuery({ queryKey: ["categories", "settings", true], queryFn: () => api.categories(undefined, true) });
  const budget = useQuery({
    queryKey: ["budget", currentMonth],
    queryFn: () => api.budget(currentMonth)
  });
  const backup = useMutation({
    mutationFn: api.backup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] })
  });
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshApplication();
    } finally {
      setRefreshing(false);
    }
  };
  const reloadHint = status.data?.reload?.supervised
    ? (status.data.reload.stale
      ? "会先加载磁盘上已构建的最新本机服务，再更新网页。"
      : "本机服务已是最新构建。「检查并刷新」会同步网页程序。")
    : "会更新网页。若接口仍是旧版，请关掉 SMB Service 窗口后重新打开一次；之后这一按钮就能同步本机服务。";

  return (
    <div className="page">
      <header className="page-heading"><h1>设置</h1><p>管理外观、预算、备份和本机服务。</p></header>

      <AppearanceSection />

      <section className="content-card budget-settings-section">
        <div className="section-title section-title--row">
          <div><h2>月度预算</h2><p>预算只用于提醒，不会阻止记账，也不会自动结转。</p></div>
          <button className="secondary-button" type="button" onClick={() => setBudgetOpen(true)}>
            <Target size={17} />管理本月预算
          </button>
        </div>
        <div className="budget-settings-summary">
          <span>{currentMonth.replace("-", " 年 ")} 月</span>
          <strong>{budget.data?.totalMinor == null ? "未设置月总预算" : `¥${(budget.data.totalMinor / 100).toFixed(2)}`}</strong>
          <small>{budget.data?.categories.length ?? 0} 个分类预算</small>
        </div>
      </section>

      <section className="content-card status-section">
        <div className="section-title section-title--row"><div><h2>运行状态</h2><p>{reloadHint}</p></div><button className="secondary-button" type="button" disabled={refreshing} onClick={() => void refreshNow()}>{refreshing ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}{refreshing ? "正在同步…" : "检查并刷新"}</button></div>
        <div className="status-grid">
          <div><span className="status-icon"><Database size={20} /></span><p>数据库</p><strong>{status.data?.database === "ok" ? "运行正常" : "等待连接"}</strong><small>SQLite · 本机 SSD</small></div>
          <div><span className="status-icon"><HardDrive size={20} /></span><p>最近备份</p><strong>{status.data?.backup.lastSuccessAt ? new Date(status.data.backup.lastSuccessAt).toLocaleDateString("zh-CN") : "尚未备份"}</strong><small>{status.data?.backup.remoteConfigured ? "本地 + Google Drive" : "本地快照可用"}</small></div>
          <div><span className="status-icon"><ShieldCheck size={20} /></span><p>版本</p><strong>SMB {status.data?.version ?? APP_VERSION}</strong><small>{status.data?.reload?.stale ? `运行 ${status.data.version} · 磁盘 ${status.data.reload.builtVersion}` : "私人账本"}</small></div>
          <div><span className="status-icon"><Globe size={20} /></span><p>账本时区</p><strong>{timezoneOffsetLabel(ledgerTimezone)}</strong><small>{ledgerTimezone} · 决定账本的“今天”</small></div>
          <div><span className="status-icon"><BellRing size={20} /></span><p>OpenClaw 每日提醒</p><strong>{reminderHeadline(status.data?.openclawReminder, today)}</strong><small>{status.data?.openclawReminder?.configured ? `每天 ${status.data.openclawReminder.time} · 只在有待办时提醒` : "未配置"}</small></div>
        </div>
      </section>

      <section className="content-card backup-section">
        <div className="section-title"><h2>备份与导出</h2></div>
        <p>正式数据库保存在 SSD。快照会同时检查 SQLite 完整性与外键关系，状态中不会暴露本机路径或凭据。</p>
        {status.data?.backup && <div className="backup-status-grid">{[
          { label: "本地快照", value: status.data.backup.local },
          { label: "Google Drive 加密上传", value: status.data.backup.remote },
          { label: "恢复验证", value: status.data.backup.restoreVerification }
        ].map((item) => <article className={`is-${item.value.state}`} key={item.label}><span>{item.label}</span><strong>{backupStateLabel(item.value)}</strong><small>最近尝试：{backupTime(item.value.lastAttemptAt)}</small><small>最近成功：{backupTime(item.value.lastSuccessAt)}</small></article>)}</div>}
        {backup.data && <div className="backup-success"><CheckCircle2 size={17} />{backup.data.remoteMessage}</div>}
        {backup.isError && <p className="form-error">{backup.error instanceof Error ? backup.error.message : "备份失败"}</p>}
        <div className="button-stack"><button className="primary-button" disabled={backup.isPending} onClick={() => backup.mutate()}>{backup.isPending ? <LoaderCircle className="spin" size={17} /> : <HardDrive size={17} />}立即备份</button><a className="secondary-button" href="/api/v1/export.json"><Download size={17} />导出完整 JSON</a><a className="secondary-button" href="/api/v1/export.csv"><Download size={17} />导出 CSV</a></div>
      </section>

      <section className="content-card connection-section">
        <div className="section-title"><h2>设备与接入</h2></div>
        <div className="connection-grid">
          <article><span><Smartphone size={21} /></span><div><strong>安装为 App</strong><p>在 Android Chrome 或电脑浏览器打开菜单，选择“安装应用”或“添加到主屏幕”。</p></div></article>
          <article><span><Cloud size={21} /></span><div><strong>Cloudflare Tunnel</strong><p>正式部署后由 Cloudflare 域名转发到本机，不需要开放家庭路由器端口。</p></div></article>
          <article><span><Bot size={21} /></span><div><strong>OpenClaw MCP</strong><p>标准入口为 /mcp。当前为{openClawSettings.data?.mode === "direct" ? "直接接管模式：可管理账目、分类、借款、订阅、计划、备份和时区，操作记录保留 30 天。" : "确认模式：普通账目写入需要批准，借款、订阅和计划只允许查询。"}密钥、Access 和服务控制永不开放。</p></div></article>
        </div>
      </section>

      <BudgetSheet
        open={budgetOpen}
        month={currentMonth}
        budget={budget.data}
        categories={categories.data ?? []}
        onClose={() => setBudgetOpen(false)}
      />
    </div>
  );
}
