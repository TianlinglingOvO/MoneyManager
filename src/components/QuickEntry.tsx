import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import { CalendarDays, Check, CheckCircle2, LoaderCircle, Trash2, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { Proposal, Transaction, TransactionKind } from "@shared/types";
import { api, ApiError } from "../api";
import { useLedgerClock } from "../ledger-clock";
import { motionDurations, useReducedMotion } from "../motion";
import { parseAmountMinor } from "../utils";

interface QuickEntryProps {
  open: boolean;
  transaction?: Transaction;
  proposal?: Proposal;
  onClose: () => void;
  onConflict?: (message: string) => void;
  onSaved?: (message: string) => void;
}

interface TransactionDraft {
  kind: TransactionKind;
  amountMinor: number;
  categoryId: string;
  localDate: string;
  note: string | null;
}

function asDraft(value: Record<string, unknown>): TransactionDraft {
  return {
    kind: value.kind as TransactionKind,
    amountMinor: Number(value.amountMinor),
    categoryId: String(value.categoryId),
    localDate: String(value.localDate),
    note: typeof value.note === "string" ? value.note : null
  };
}

export function QuickEntry({ open, transaction, proposal, onClose, onConflict, onSaved }: QuickEntryProps) {
  const { today } = useLedgerClock();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TransactionKind>("expense");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [closing, setClosing] = useState(false);
  const reducedMotion = useReducedMotion();
  const historyEntryActive = useRef(false);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const saveCloseTimer = useRef<number | null>(null);
  const exitCloseTimer = useRef<number | null>(null);
  const initialDraft = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const sheetRef = useRef<HTMLElement | null>(null);
  const dragStart = useRef<number | null>(null);
  const targetId = proposal?.action === "update" ? proposal.targetTransactionId : null;
  const proposalTarget = useQuery({
    queryKey: ["transaction", targetId],
    queryFn: () => api.transaction(targetId!),
    enabled: open && Boolean(targetId),
    retry: false
  });
  const categories = useQuery({ queryKey: ["categories", kind], queryFn: () => api.categories(kind) });

  const draftSignature = JSON.stringify({ kind, amount, categoryId, date, note });
  const isDirty = !saved && Boolean(initialDraft.current) && draftSignature !== initialDraft.current;
  dirtyRef.current = isDirty;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const finishClose = useCallback(() => {
    closingRef.current = false;
    setClosing(false);
    onCloseRef.current();
  }, []);

  const beginClose = useCallback((historyAlreadyPopped = false) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (historyEntryActive.current && !historyAlreadyPopped) {
      historyEntryActive.current = false;
      window.history.back();
    }
    setDiscardOpen(false);
    setDragOffset(0);
    setClosing(true);
    if (exitCloseTimer.current !== null) window.clearTimeout(exitCloseTimer.current);
    exitCloseTimer.current = window.setTimeout(finishClose, reducedMotion ? 0 : motionDurations.dialogExit);
  }, [finishClose, reducedMotion]);

  const requestClose = useCallback(() => {
    if (savingRef.current) return;
    if (isDirty) {
      setDiscardOpen(true);
      return;
    }
    beginClose();
  }, [beginClose, isDirty]);

  useEffect(() => {
    if (!open) return;
    closingRef.current = false;
    setClosing(false);
    document.body.classList.add("modal-open");
    initialDraft.current = "";
    setSaved(false);
    setDiscardOpen(false);
    setDragOffset(0);
    const mobile = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;
    const onPopState = () => {
      if (!historyEntryActive.current) return;
      historyEntryActive.current = false;
      if (dirtyRef.current) {
        window.history.pushState({ ...window.history.state, moneyManagerEntry: true }, "");
        historyEntryActive.current = true;
        setDiscardOpen(true);
      } else {
        beginClose(true);
      }
    };
    if (mobile) {
      window.history.pushState({ ...window.history.state, moneyManagerEntry: true }, "");
      historyEntryActive.current = true;
      window.addEventListener("popstate", onPopState);
    }
    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("popstate", onPopState);
      if (saveCloseTimer.current !== null) window.clearTimeout(saveCloseTimer.current);
      if (exitCloseTimer.current !== null) window.clearTimeout(exitCloseTimer.current);
      if (historyEntryActive.current) {
        historyEntryActive.current = false;
        window.history.back();
      }
    };
  }, [beginClose, open]);

  useEffect(() => {
    if (!open) return;
    let draft: TransactionDraft | undefined;
    if (proposal?.action === "create") {
      draft = asDraft(proposal.payload);
    } else if (proposal?.action === "update") {
      if (!proposalTarget.data) return;
      draft = asDraft({
        kind: proposalTarget.data.kind,
        amountMinor: proposalTarget.data.amountMinor,
        categoryId: proposalTarget.data.categoryId,
        localDate: proposalTarget.data.localDate,
        note: proposalTarget.data.note,
        ...proposal.payload
      });
    } else if (transaction) {
      draft = {
        kind: transaction.kind,
        amountMinor: transaction.amountMinor,
        categoryId: transaction.categoryId,
        localDate: transaction.localDate,
        note: transaction.note
      };
    }

    setKind(draft?.kind ?? "expense");
    setAmount(draft ? (draft.amountMinor / 100).toFixed(2) : "");
    setCategoryId(draft?.categoryId ?? "");
    setDate(draft?.localDate ?? today);
    setNote(draft?.note ?? "");
    setError("");
    setSaved(false);
    initialDraft.current = JSON.stringify({
      kind: draft?.kind ?? "expense",
      amount: draft ? (draft.amountMinor / 100).toFixed(2) : "",
      categoryId: draft?.categoryId ?? "",
      date: draft?.localDate ?? today,
      note: draft?.note ?? ""
    });
  }, [open, proposal, proposalTarget.data, today, transaction]);

  useEffect(() => {
    if (!open || !categories.isSuccess) return;
    const available = categories.data ?? [];
    if (!available.some((item) => item.id === categoryId)) {
      const nextCategoryId = available[0]?.id ?? "";
      setCategoryId(nextCategoryId);
      if (initialDraft.current) {
        const initial = JSON.parse(initialDraft.current) as Record<string, unknown>;
        if (!initial.categoryId) initialDraft.current = JSON.stringify({ ...initial, categoryId: nextCategoryId });
      }
    }
  }, [categories.data, categories.isSuccess, categoryId, open]);

  const parsedMinor = useMemo(() => parseAmountMinor(amount), [amount]);
  const dateShortcuts = useMemo(() => {
    const todayDate = new Date(`${today}T12:00:00`);
    return [
      { label: "今天", value: format(todayDate, "yyyy-MM-dd") },
      { label: "昨天", value: format(subDays(todayDate, 1), "yyyy-MM-dd") },
      { label: "前天", value: format(subDays(todayDate, 2), "yyyy-MM-dd") }
    ];
  }, [open, today]);

  const save = useMutation({
    mutationFn: async () => {
      savingRef.current = true;
      if (parsedMinor === null) throw new ApiError("请输入大于 0 且最多两位小数的金额", "VALIDATION_ERROR", 400);
      if (!categoryId) throw new ApiError("请选择分类", "VALIDATION_ERROR", 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError("请选择有效日期", "VALIDATION_ERROR", 400);
      const input = { kind, amountMinor: parsedMinor, categoryId, localDate: date, note: note.trim() || null };
      if (proposal) return api.reviseProposal(proposal.id, proposal.revision, input);
      if (transaction) return api.updateTransaction(transaction.id, input, transaction.updatedAt);
      return api.createTransaction(input, crypto.randomUUID());
    },
    onSuccess: async () => {
      savingRef.current = false;
      await queryClient.invalidateQueries();
      setSaved(true);
      initialDraft.current = "";
      onSaved?.(proposal ? "修订已保存，仍等待确认" : transaction ? "账目已更新" : "已记入账本");
      saveCloseTimer.current = window.setTimeout(beginClose, 520);
    },
    onError: (reason) => {
      savingRef.current = false;
      if (reason instanceof ApiError && reason.code === "PROPOSAL_REVISION_CONFLICT") {
        void queryClient.invalidateQueries({ queryKey: ["proposals"] }).then(() => {
          onConflict?.(reason.message);
          beginClose();
        });
        return;
      }
      setError(reason instanceof Error ? reason.message : "保存失败");
    }
  });

  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const focusable = () => Array.from(sheet.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]"));
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    sheet.addEventListener("keydown", trapFocus);
    return () => sheet.removeEventListener("keydown", trapFocus);
  }, [open]);

  const onDragStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    dragStart.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragStart.current === null) return;
    const distance = Math.max(0, event.clientY - dragStart.current);
    setDragOffset(Math.min(170, distance * 0.82));
  };

  const onDragEnd = () => {
    const shouldClose = dragOffset >= 92;
    dragStart.current = null;
    setDragOffset(0);
    if (shouldClose) requestClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !save.isPending) requestClose();
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !save.isPending && !saved) {
        event.preventDefault();
        save.mutate();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, requestClose, save, saved]);

  const remove = useMutation({
    mutationFn: () => api.deleteTransaction(transaction!.id, transaction!.updatedAt),
    onSuccess: async () => { await queryClient.invalidateQueries(); requestClose(); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "删除失败")
  });

  if (!open) return null;
  const isProposal = Boolean(proposal);
  const targetLoading = proposal?.action === "update" && proposalTarget.isLoading;
  const targetUnavailable = proposal?.action === "update" && (proposalTarget.isError || Boolean(proposalTarget.data?.deletedAt));
  const title = isProposal ? "修订待确认内容" : transaction ? "编辑账目" : "记一笔";
  const subtitle = isProposal ? "保存后仍需单独批准" : transaction ? "修改正式账本" : "哪一天发生的？";

  return (
    <div className={`modal-backdrop ${closing ? "is-closing" : ""}`} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) requestClose(); }}>
      <section ref={sheetRef} className="entry-sheet" role="dialog" aria-modal="true" aria-labelledby="entry-title" style={{ "--sheet-drag": `${dragOffset}px` } as CSSProperties}>
        <button className="entry-sheet__handle" type="button" aria-label="向下拖动关闭" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}><span /></button>
        <header className="entry-sheet__header">
          <div><small>{subtitle}</small><h2 id="entry-title">{title}</h2></div>
          <button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={21} /></button>
        </header>

        {targetLoading ? (
          <div className="entry-sheet__state"><LoaderCircle className="spin" size={25} /><strong>正在读取目标账目</strong></div>
        ) : targetUnavailable ? (
          <div className="entry-sheet__state is-error"><strong>目标账目已删除或不可读取</strong><p>这项待确认操作已经不能修订，请返回后拒绝它。</p></div>
        ) : (
          <>
            {isProposal && <p className="entry-sheet__hint">这里只修改待确认内容，不会立即写入正式账本。</p>}
            <div className="kind-switch" role="tablist" aria-label="收支类型">
              <button className={kind === "expense" ? "is-active" : ""} onClick={() => setKind("expense")}>支出</button>
              <button className={kind === "income" ? "is-active" : ""} onClick={() => setKind("income")}>收入</button>
            </div>

            <label className="amount-field">
              <span>¥</span>
              <input
                autoFocus
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0.00"
                aria-label="金额"
              />
            </label>

            <div className="field-block">
              <div className="field-label"><span>分类</span><small>{categories.data?.length ?? 0} 个可用</small></div>
              <div className="category-picker">
                {categories.data?.map((category) => (
                  <button
                    type="button"
                    key={category.id}
                    className={categoryId === category.id ? "is-active" : ""}
                    style={{ "--category-color": category.color } as CSSProperties}
                    aria-pressed={categoryId === category.id}
                    onClick={() => setCategoryId(category.id)}
                  >
                    <span className="category-picker__icon">{category.icon}</span>
                    <span className="category-picker__label">{category.name}</span>
                    {categoryId === category.id && <Check className="category-picker__check" size={14} strokeWidth={3} aria-hidden="true" />}
                  </button>
                ))}
                {categories.data?.length === 0 && (
                  <div className="category-picker__empty">
                    <strong>还没有{kind === "expense" ? "支出" : "收入"}分类</strong>
                    <span>先创建一个符合你习惯的分类。</span>
                    <Link to="/settings" onClick={requestClose}>去添加分类</Link>
                  </div>
                )}
              </div>
            </div>

            <div className="entry-fields">
              <div className="entry-date-control">
                <span className="entry-field-label"><CalendarDays size={17} />发生日期</span>
                <div className="date-shortcuts" aria-label="常用日期">
                  {dateShortcuts.map((item) => <button type="button" className={date === item.value ? "is-active" : ""} key={item.value} onClick={() => setDate(item.value)}>{item.label}</button>)}
                </div>
                <input required aria-label="自定义发生日期" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </div>
              <label><span>备注 <small>选填</small></span><input maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：和朋友吃晚饭" /></label>
            </div>

            {error && <p className="form-error" role="alert">{error}</p>}
            {saved && <p className="entry-success" role="status"><CheckCircle2 size={18} />已保存</p>}
            <div className="entry-sheet__actions">
              {transaction && !proposal && <button className="danger-ghost" disabled={remove.isPending} onClick={() => { if (window.confirm("移入回收站？30 天内可以恢复。")) remove.mutate(); }}><Trash2 size={17} />移入回收站</button>}
              <button type="button" className="primary-button save-button" disabled={save.isPending || saved} onClick={() => save.mutate()} title="Ctrl + Enter 保存">
                {save.isPending && <LoaderCircle className="spin" size={18} />}
                {saved ? <><Check size={18} />已保存</> : proposal ? "保存修订（仍待确认）" : transaction ? "保存修改" : `保存${kind === "expense" ? "支出" : "收入"}`}
              </button>
            </div>
          </>
        )}
      </section>
      {discardOpen && (
        <div className="discard-confirm" role="alertdialog" aria-modal="true" aria-labelledby="discard-title">
          <h3 id="discard-title">放弃这次修改？</h3>
          <p>金额和备注不会保存在浏览器中，关闭后本次输入会丢失。</p>
          <div>
            <button className="secondary-button" type="button" onClick={() => setDiscardOpen(false)}>继续编辑</button>
            <button className="primary-button" type="button" onClick={() => beginClose()}>放弃并关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}
