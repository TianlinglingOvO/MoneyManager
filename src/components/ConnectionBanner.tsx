import { useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LogIn, RefreshCw, ShieldX, WifiOff } from "lucide-react";
import {
  getConnectionIssue,
  subscribeConnectionIssue,
  type ConnectionIssueCode
} from "../connection-status";

const content: Record<ConnectionIssueCode, { title: string; description: string }> = {
  AUTH_EXPIRED: {
    title: "登录状态已过期",
    description: "账本和本机服务没有丢失。请重新完成 Cloudflare 验证后继续使用。"
  },
  FORBIDDEN: {
    title: "当前账号没有访问权限",
    description: "请退出当前登录状态，并使用允许访问寸金记账的邮箱重新登录。"
  },
  OFFLINE: {
    title: "设备暂时没有网络",
    description: "连接网络后点击重试，页面中已经显示的账目不会被清除。"
  },
  SERVICE_UNAVAILABLE: {
    title: "暂时无法连接账本服务",
    description: "请检查本机寸金服务和 Cloudflare Tunnel 是否正在运行，然后重试。"
  },
  INVALID_RESPONSE: {
    title: "账本服务返回了异常内容",
    description: "这可能是登录状态或 Cloudflare 转发暂时异常，可以先重试或重新登录。"
  }
};

export function ConnectionBanner() {
  const issue = useSyncExternalStore(subscribeConnectionIssue, getConnectionIssue, getConnectionIssue);
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);

  if (!issue) return null;

  const copy = content[issue.code];
  const canLogin = issue.code === "AUTH_EXPIRED" || issue.code === "FORBIDDEN" || issue.code === "INVALID_RESPONSE";
  const Icon = issue.code === "OFFLINE" ? WifiOff : issue.code === "FORBIDDEN" ? ShieldX : AlertTriangle;

  const retry = async () => {
    setRetrying(true);
    try {
      await queryClient.refetchQueries({ type: "active" });
    } finally {
      if (getConnectionIssue()) setRetrying(false);
    }
  };

  return (
    <section className={`connection-banner connection-banner--${issue.code.toLowerCase()}`} role="alert" aria-live="assertive">
      <span className="connection-banner__icon"><Icon size={21} /></span>
      <div className="connection-banner__copy">
        <strong>{copy.title}</strong>
        <p>{copy.description}</p>
      </div>
      <div className="connection-banner__actions">
        {canLogin && <a className="primary-button" href="/auth/refresh"><LogIn size={17} />重新登录</a>}
        <button className="secondary-button" type="button" disabled={retrying} onClick={retry}>
          <RefreshCw className={retrying ? "spin" : undefined} size={17} />{retrying ? "正在重试" : "重试"}
        </button>
        {canLogin && <a className="connection-banner__reset" href="/cdn-cgi/access/logout">仍无法登录？重置登录状态</a>}
      </div>
    </section>
  );
}
