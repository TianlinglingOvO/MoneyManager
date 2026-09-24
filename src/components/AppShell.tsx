import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BellRing,
  BookOpenText,
  ChartNoAxesCombined,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Landmark,
  Settings,
  Sparkles,
  WalletCards
} from "lucide-react";
import { api } from "../api";
import { useEntry } from "../entry-context";
import { ConnectionBanner } from "./ConnectionBanner";
import { BrandMark } from "./BrandMark";

const sidebarStorageKey = "money-manager.sidebar-collapsed";

const desktopPrimaryItems = [
  { to: "/", label: "洞察", icon: ChartNoAxesCombined, end: true },
  { to: "/bills", label: "账单", icon: BookOpenText },
  { to: "/matters?tab=loans", label: "事项", icon: WalletCards },
  { to: "/funds", label: "资金", icon: Landmark },
  { to: "/ai", label: "AI", icon: Sparkles }
];

function mattersNavLabel(subscriptionAttention: number, planAttention: number): string {
  const parts: string[] = [];
  if (subscriptionAttention > 0) parts.push(`${subscriptionAttention}项订阅`);
  if (planAttention > 0) parts.push(`${planAttention}项计划`);
  return parts.length ? `事项，${parts.join("、")}需要留意` : "事项";
}

function NavItem({ item, mobile = false, badge = 0, badgeLabel }: { item: typeof desktopPrimaryItems[number]; mobile?: boolean; badge?: number; badgeLabel?: string }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      viewTransition
      title={item.label}
      aria-label={badge > 0 && badgeLabel ? badgeLabel : item.label}
      className={({ isActive }) => `${mobile ? "mobile-nav__item" : "sidebar__item"} ${isActive ? "is-active" : ""}`}
    >
      <Icon size={mobile ? 21 : 19} strokeWidth={1.9} />
      <span>{item.label}</span>
      {badge > 0 && <em className={mobile ? "nav-badge nav-badge--mobile" : "nav-badge"}>{badge}</em>}
    </NavLink>
  );
}

export function AppShell() {
  const { openEntry } = useEntry();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(sidebarStorageKey) === "true");
  const proposals = useQuery({ queryKey: ["proposals", "pending", "badge"], queryFn: () => api.proposals("pending") });
  const subscriptions = useQuery({ queryKey: ["matters", "subscriptions", "badge"], queryFn: api.subscriptionSummary, staleTime: 60_000 });
  const plans = useQuery({ queryKey: ["matters", "plans", "badge"], queryFn: api.planSummary, staleTime: 60_000 });
  const pending = proposals.data?.length ?? 0;
  const subscriptionAttention = subscriptions.data?.attentionCount ?? 0;
  const planAttention = plans.data?.attentionCount ?? 0;
  const matterBadge = subscriptionAttention + planAttention;
  const matterDestination = subscriptionAttention > 0 ? "/matters?tab=subscriptions" : planAttention > 0 ? "/matters?tab=plans" : "/matters?tab=loans";
  const primaryItems = desktopPrimaryItems.map((item) => item.label === "事项"
    ? { ...item, to: matterDestination }
    : item);
  const mobilePrimaryItems = primaryItems.filter((item) => ["洞察", "账单", "事项"].includes(item.label));
  const mattersLabel = mattersNavLabel(subscriptionAttention, planAttention);

  useEffect(() => localStorage.setItem(sidebarStorageKey, String(collapsed)), [collapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
      if (isEditing || document.body.classList.contains("modal-open") || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        openEntry();
      }
      if (event.key === "/") {
        event.preventDefault();
        const search = document.querySelector<HTMLInputElement>("[data-global-search]");
        if (search) search.focus();
        else navigate("/bills?view=ledger&focus=search");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate, openEntry]);

  return (
    <div className={`app-shell ${collapsed ? "sidebar-is-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <BrandMark className="brand__mark" compact />
          <div className="brand__copy"><strong>SMB</strong><small>Sutady Moneybook</small></div>
        </div>
        <button className="sidebar__collapse" type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"}>
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        <nav className="sidebar__nav" aria-label="主导航">
          {primaryItems.map((item) => <NavItem key={item.to} item={item} badge={item.to.startsWith("/matters") ? matterBadge : 0} badgeLabel={item.to.startsWith("/matters") ? mattersLabel : undefined} />)}
        </nav>
        <button className="sidebar__new" onClick={() => openEntry()} title="记一笔（N）"><Plus size={19} /><span>记一笔</span></button>
        <div className="sidebar__secondary">
          <NavLink to="/proposals" title="OpenClaw 操作中心" className={({ isActive }) => `sidebar__item ${isActive ? "is-active" : ""}`}>
            <BellRing size={19} />
            <span>操作中心</span>
            {pending > 0 && <em className="nav-badge">{pending}</em>}
          </NavLink>
          <NavLink to="/settings" title="设置" className={({ isActive }) => `sidebar__item ${isActive ? "is-active" : ""}`}>
            <Settings size={19} /><span>设置</span>
          </NavLink>
        </div>
      </aside>

      <div className="main-column">
        <header className="mobile-header">
          <div className="brand brand--mobile">
            <BrandMark className="brand__mark" compact />
            <div className="brand__copy"><strong>SMB</strong><small>Sutady Moneybook</small></div>
          </div>
          <div className="mobile-header__actions">
            <NavLink to="/proposals" className="icon-button" aria-label={`OpenClaw 操作中心${pending ? `，${pending}项待处理` : ""}`}>
              <BellRing size={20} />{pending > 0 && <span className="icon-badge">{pending}</span>}
            </NavLink>
            <NavLink to="/settings" className="icon-button" aria-label="设置"><Settings size={20} /></NavLink>
            <NavLink to="/ai" className="icon-button" aria-label="AI 分析"><Sparkles size={20} /></NavLink>
          </div>
        </header>
        <main className="main-content"><ConnectionBanner /><Outlet /></main>
      </div>

      <nav className="mobile-nav" aria-label="移动端主导航">
        {mobilePrimaryItems.map((item) => <NavItem key={item.to} item={item} mobile badge={item.to.startsWith("/matters") ? matterBadge : 0} badgeLabel={item.to.startsWith("/matters") ? mattersLabel : undefined} />)}
        <button className="mobile-nav__add" onClick={() => openEntry()} aria-label="记一笔"><Plus size={23} /><span>记一笔</span></button>
      </nav>
    </div>
  );
}
