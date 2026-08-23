import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { motionDurations, useReducedMotion } from "../motion";

export interface BottomSheetHandle {
  close: (options?: { skipBeforeClose?: boolean }) => void;
}

interface BottomSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
  closeLabel?: string;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  beforeClose?: () => boolean;
}

const focusableSelector = "button:not(:disabled):not([tabindex='-1']), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]";

/**
 * Shared responsive overlay: a centered dialog on desktop and a bottom sheet
 * on mobile. Android's back gesture closes the mobile sheet before routing.
 */
export const BottomSheet = forwardRef<BottomSheetHandle, BottomSheetProps>(function BottomSheet({
  open,
  title,
  onClose,
  children,
  footer,
  labelledBy,
  closeLabel,
  className = "",
  initialFocusRef,
  beforeClose
}, forwardedRef) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const beforeCloseRef = useRef(beforeClose);
  const historyEntryActive = useRef(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const dragStart = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const generatedTitleId = useId();
  const titleId = labelledBy ?? generatedTitleId;

  useEffect(() => {
    onCloseRef.current = onClose;
    beforeCloseRef.current = beforeClose;
  }, [beforeClose, onClose]);

  const finishClose = useCallback(() => {
    closingRef.current = false;
    setClosing(false);
    onCloseRef.current();
    window.requestAnimationFrame(() => restoreFocusRef.current?.focus());
  }, []);

  const requestClose = useCallback((historyAlreadyPopped = false, skipBeforeClose = false) => {
    if (closingRef.current) return;
    if (!skipBeforeClose && beforeCloseRef.current && !beforeCloseRef.current()) {
      setDragOffset(0);
      if (historyAlreadyPopped && !historyEntryActive.current) {
        window.history.pushState({ ...window.history.state, moneyManagerSheet: true }, "");
        historyEntryActive.current = true;
      }
      return;
    }
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

  useImperativeHandle(forwardedRef, () => ({
    close: (options) => requestClose(false, options?.skipBeforeClose ?? false)
  }), [requestClose]);

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
      requestClose(true);
    };
    if (isMobile) {
      window.history.pushState({ ...window.history.state, moneyManagerSheet: true }, "");
      historyEntryActive.current = true;
      window.addEventListener("popstate", onPopState);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(focusableSelector));
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
    window.requestAnimationFrame(() => {
      const target = initialFocusRef?.current ?? closeButtonRef.current ?? sheetRef.current?.querySelector<HTMLElement>(focusableSelector);
      target?.focus();
    });
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
  }, [initialFocusRef, open, requestClose]);

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
    if (shouldClose) requestClose();
  };

  return createPortal((
    <div
      className={`modal-backdrop bottom-sheet-backdrop ${closing ? "is-closing" : ""}`}
      role="presentation"
      onMouseDown={(event) => { if (event.currentTarget === event.target) requestClose(); }}
    >
      <section
        ref={sheetRef}
        className={`small-dialog bottom-sheet ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ "--sheet-drag": `${dragOffset}px` } as CSSProperties}
      >
        <button className="bottom-sheet__handle" type="button" tabIndex={-1} aria-label="向下拖动关闭" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}><span /></button>
        <header className="bottom-sheet__header">
          <h2 id={titleId}>{title}</h2>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={() => requestClose()} aria-label={closeLabel ?? `关闭${title}`}><X size={19} /></button>
        </header>
        <div className="bottom-sheet__body">{children}</div>
        {footer ? <footer className="bottom-sheet__footer">{footer}</footer> : null}
      </section>
    </div>
  ), document.body);
});
