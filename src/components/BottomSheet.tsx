import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { motionDurations, useReducedMotion } from "../motion";

interface BottomSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  className?: string;
}

/**
 * A small, shared sheet shell for mobile filters and other short actions.
 * The sheet uses the browser history on mobile so Android's back gesture
 * closes it before navigating away from the page.
 */
export function BottomSheet({ open, title, onClose, children, labelledBy, className = "" }: BottomSheetProps) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const historyEntryActive = useRef(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const dragStart = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const titleId = labelledBy ?? "bottom-sheet-title";

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const finishClose = useCallback(() => {
    closingRef.current = false;
    setClosing(false);
    onCloseRef.current();
    window.requestAnimationFrame(() => restoreFocusRef.current?.focus());
  }, []);

  const close = useCallback((historyAlreadyPopped = false) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (historyEntryActive.current && !historyAlreadyPopped) {
      historyEntryActive.current = false;
      window.history.back();
    }
    setDragOffset(0);
    setClosing(true);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(finishClose, reducedMotion ? 0 : motionDurations.dialogExit);
  }, [finishClose, reducedMotion]);

  useEffect(() => {
    if (!open) return;
    closingRef.current = false;
    setClosing(false);
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    const isMobile = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;
    const onPopState = () => {
      if (!historyEntryActive.current) return;
      historyEntryActive.current = false;
      setDragOffset(0);
      close(true);
    };
    if (isMobile) {
      window.history.pushState({ ...window.history.state, moneyManagerSheet: true }, "");
      historyEntryActive.current = true;
      window.addEventListener("popstate", onPopState);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const firstFocusable = sheetRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]");
    window.requestAnimationFrame(() => firstFocusable?.focus());
    return () => {
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKeyDown);
      if (isMobile) window.removeEventListener("popstate", onPopState);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (historyEntryActive.current) {
        historyEntryActive.current = false;
        window.history.back();
      }
    };
  }, [close, open]);

  if (!open) return null;

  const onDragStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    dragStart.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragStart.current === null) return;
    setDragOffset(Math.min(180, Math.max(0, event.clientY - dragStart.current) * 0.82));
  };
  const onDragEnd = () => {
    const shouldClose = dragOffset >= 96;
    dragStart.current = null;
    setDragOffset(0);
    if (shouldClose) close();
  };

  return createPortal((
    <div
      className={`modal-backdrop bottom-sheet-backdrop ${closing ? "is-closing" : ""}`}
      role="presentation"
      onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}
    >
      <section
        ref={sheetRef}
        className={`small-dialog bottom-sheet ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ "--sheet-drag": `${dragOffset}px` } as CSSProperties}
      >
        <button className="bottom-sheet__handle" type="button" aria-label="向下拖动关闭" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}><span /></button>
        <header className="bottom-sheet__header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" onClick={() => close()} aria-label="关闭筛选"><X size={19} /></button>
        </header>
        {children}
      </section>
    </div>
  ), document.body);
}
