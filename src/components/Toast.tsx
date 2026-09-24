import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ToastOptions } from "../toast-context";

export interface ToastMessage extends ToastOptions {
  id: number;
  text: string;
}

export const toastDurations = { plain: 2_600, withAction: 6_000 } as const;

export function Toast({ message, onDismiss }: { message: ToastMessage | null; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => setPaused(false), [message]);

  useEffect(() => {
    if (!message || paused) return;
    const timer = window.setTimeout(onDismiss, message.action ? toastDurations.withAction : toastDurations.plain);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, paused]);

  if (!message) return null;
  const Icon = message.tone === "error" ? AlertCircle : CheckCircle2;

  return (
    <div
      className={`app-toast ${message.tone === "error" ? "is-error" : ""}`.trim()}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false); }}
    >
      <Icon size={18} aria-hidden="true" />
      <span>{message.text}</span>
      {message.action && (
        <button type="button" className="app-toast__action" onClick={() => { const { run } = message.action!; onDismiss(); run(); }}>
          {message.action.label}
        </button>
      )}
      <button type="button" className="app-toast__close" onClick={onDismiss} aria-label="关闭提示"><X size={16} /></button>
    </div>
  );
}
