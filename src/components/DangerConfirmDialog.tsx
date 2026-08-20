import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, LoaderCircle, X } from "lucide-react";

interface DangerConfirmDialogProps {
  title: string;
  description: string;
  details?: ReactNode;
  confirmText?: string;
  confirmLabel: string;
  isPending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function DangerConfirmDialog({
  title,
  description,
  details,
  confirmText,
  confirmLabel,
  isPending = false,
  error,
  onConfirm,
  onClose
}: DangerConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const pendingRef = useRef(isPending);
  const confirmed = confirmText === undefined || typed === confirmText;
  closeRef.current = onClose;
  pendingRef.current = isPending;

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) closeRef.current();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]"));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKeyDown);
      const target = previousFocus.current;
      if (target?.isConnected) window.requestAnimationFrame(() => target.focus());
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !isPending) onClose(); }}>
      <section ref={dialog} className="small-dialog danger-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="danger-confirm-title" aria-describedby="danger-confirm-description">
        <header>
          <div className="danger-confirm-dialog__heading"><span><AlertTriangle size={20} /></span><h2 id="danger-confirm-title">{title}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={isPending} aria-label="关闭"><X size={20} /></button>
        </header>
        <p id="danger-confirm-description" className="danger-confirm-dialog__copy">{description}</p>
        {details && <div className="danger-confirm-dialog__details">{details}</div>}
        {confirmText !== undefined && (
          <label className="dialog-field">
            <span>请输入 <strong>{confirmText}</strong> 以确认</span>
            <input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="danger-confirm-dialog__actions">
          <button ref={cancelButton} className="secondary-button" type="button" onClick={onClose} disabled={isPending}>取消</button>
          <button className="danger-button" type="button" onClick={onConfirm} disabled={!confirmed || isPending}>
            {isPending && <LoaderCircle className="spin" size={17} />}{confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
