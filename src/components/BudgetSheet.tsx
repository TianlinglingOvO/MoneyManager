import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type { Category, MonthlyBudget, MonthlyBudgetInput } from "@shared/types";
import { api } from "../api";
import { useToast } from "../toast-context";
import { parseAmountMinor } from "../utils";
import { BottomSheet, type BottomSheetHandle } from "./BottomSheet";

interface BudgetSheetProps {
  open: boolean;
  month: string;
  budget: MonthlyBudget | undefined;
  categories: Category[];
  onClose: () => void;
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-");
  return `${year}年${Number(monthNumber)}月`;
}

function formatAmountInput(minor: number | null | undefined): string {
  return typeof minor === "number" ? (minor / 100).toFixed(2) : "";
}

function draftSignature(totalValue: string, categoryValues: Record<string, string>): string {
  return JSON.stringify([totalValue.trim(), Object.entries(categoryValues).sort(([left], [right]) => left.localeCompare(right))]);
}

export function BudgetSheet({ open, month, budget, categories, onClose }: BudgetSheetProps) {
  const queryClient = useQueryClient();
  const notify = useToast();
  const sheetRef = useRef<BottomSheetHandle | null>(null);
  const totalInputRef = useRef<HTMLInputElement | null>(null);
  const initialSignature = useRef("");
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [totalValue, setTotalValue] = useState("");
  const [categoryValues, setCategoryValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const deletePromptShown = useRef(false);
  const expenseCategories = useMemo(() => categories.filter((category) => category.kind === "expense"), [categories]);

  useEffect(() => {
    if (!open) return;
    const nextTotal = formatAmountInput(budget?.totalMinor);
    const nextCategories = Object.fromEntries((budget?.categories ?? []).map((category) => [category.categoryId, formatAmountInput(category.budgetMinor)]));
    setTotalValue(nextTotal);
    setCategoryValues(nextCategories);
    initialSignature.current = draftSignature(nextTotal, nextCategories);
    setError(null);
    setPickerOpen(false);
    deletePromptShown.current = false;
    setConfirmingDelete(false);
  }, [budget, open]);

  const save = useMutation({
    mutationFn: (input: MonthlyBudgetInput) => api.updateBudget(month, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["budget", month] });
      notify("预算已保存");
      sheetRef.current?.close({ skipBeforeClose: true });
    }
  });
  const remove = useMutation({
    mutationFn: () => {
      if (!budget?.updatedAt) throw new Error("预算版本已经变化，请刷新后重试。");
      return api.deleteBudget(month, budget.updatedAt);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["budget", month] });
      notify("预算已删除");
      sheetRef.current?.close({ skipBeforeClose: true });
    }
  });

  const configuredIds = Object.keys(categoryValues);
  const availableCategories = expenseCategories.filter((category) => !category.isArchived && !configuredIds.includes(category.id));
  const configuredCategories = configuredIds.map((id) => {
    const category = expenseCategories.find((item) => item.id === id);
    if (category) return { id: category.id, name: category.name, icon: category.icon, color: category.color };
    const fallback = budget?.categories.find((item) => item.categoryId === id);
    return fallback ? { id: fallback.categoryId, name: fallback.name, icon: fallback.icon, color: fallback.color } : null;
  }).filter((item): item is { id: string; name: string; icon: string; color: string } => Boolean(item));
  const hasSavedBudget = budget?.totalMinor !== null || (budget?.categories.length ?? 0) > 0;
  useEffect(() => {
    if (!pickerOpen) return;
    pickerOptionRefs.current = pickerOptionRefs.current.slice(0, availableCategories.length);
    const frame = window.requestAnimationFrame(() => pickerOptionRefs.current[0]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [availableCategories.length, pickerOpen]);

  const closePicker = () => {
    setPickerOpen(false);
    window.requestAnimationFrame(() => pickerTriggerRef.current?.focus());
  };
  const addCategoryBudget = (categoryId: string) => {
    setCategoryValues((values) => ({ ...values, [categoryId]: "" }));
    closePicker();
  };
  const onPickerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const options = pickerOptionRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || options.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, options.indexOf(event.currentTarget));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % options.length
          : (currentIndex - 1 + options.length) % options.length;
    options[nextIndex]?.focus();
  };
  const isDirty = open && draftSignature(totalValue, categoryValues) !== initialSignature.current;

  useEffect(() => {
    if (confirmingDelete) {
      deletePromptShown.current = true;
      window.requestAnimationFrame(() => cancelDeleteRef.current?.focus());
    } else if (deletePromptShown.current) {
      deletePromptShown.current = false;
      window.requestAnimationFrame(() => deleteTriggerRef.current?.focus());
    }
  }, [confirmingDelete]);

  const submit = () => {
    const trimmedTotal = totalValue.trim();
    const totalMinor = trimmedTotal ? parseAmountMinor(trimmedTotal) : null;
    if (trimmedTotal && totalMinor === null) {
      setError("总预算请输入大于 0 的金额，最多保留两位小数。");
      return;
    }
    const categoryBudgets: MonthlyBudgetInput["categories"] = [];
    for (const categoryId of configuredIds) {
      const value = categoryValues[categoryId]?.trim() ?? "";
      const amountMinor = parseAmountMinor(value);
      if (amountMinor === null) {
        setError("每个分类预算都需要填写大于 0 的金额。");
        return;
      }
      categoryBudgets.push({ categoryId, amountMinor });
    }
    if (totalMinor === null && categoryBudgets.length === 0) {
      setError("请设置总预算，或至少保留一个分类预算。");
      return;
    }
    setError(null);
    save.mutate({ totalMinor, categories: categoryBudgets, expectedUpdatedAt: budget?.updatedAt });
  };

  const footer = confirmingDelete
    ? <div className="sheet-actions budget-sheet__actions budget-sheet__actions--confirm" role="group" aria-label="确认删除预算">
      <p>删除{monthLabel(month)}的预算？账目不会受到影响。</p>
      <button ref={cancelDeleteRef} className="secondary-button" type="button" disabled={remove.isPending} onClick={() => setConfirmingDelete(false)}>取消</button>
      <button className="danger-button" type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? "删除中…" : "确认删除"}</button>
    </div>
    : <div className="sheet-actions budget-sheet__actions">
      {hasSavedBudget && <button ref={deleteTriggerRef} className="text-button danger-button" type="button" disabled={remove.isPending || save.isPending} onClick={() => { remove.reset(); setConfirmingDelete(true); }}>删除预算</button>}
      <button className="primary-button" type="button" disabled={save.isPending || remove.isPending} onClick={submit}>{save.isPending ? "保存中…" : "保存预算"}</button>
    </div>;

  return <BottomSheet
    ref={sheetRef}
    open={open}
    title={`管理 ${monthLabel(month)}预算`}
    closeLabel="关闭预算"
    onClose={onClose}
    dirty={isDirty}
    discardDescription="未保存的预算修改会丢失。"
    busy={save.isPending || remove.isPending}
    initialFocusRef={totalInputRef}
    footer={footer}
    className="budget-sheet"
    labelledBy="budget-sheet-title"
  >
    <div className="budget-sheet__content">
      <p className="sheet-intro">预算只用于提醒和阅读，不会限制记账，也不会改变已有统计。</p>
      <label className="dialog-field">
        <span>本月总支出预算 <em>可选</em></span>
        <input ref={totalInputRef} inputMode="decimal" value={totalValue} onChange={(event) => setTotalValue(event.target.value)} placeholder="例如：3000.00" aria-describedby="budget-total-help" />
        <small id="budget-total-help">留空时，仅按分类预算提醒。</small>
      </label>

      <div className="budget-sheet__categories">
        <div className="section-title section-title--row"><div><h3>分类预算</h3><p>只显示支出分类；停用分类仍可保留已有预算。</p></div></div>
        {configuredCategories.map((category) => <div className="budget-category-input" key={category.id}>
          <span className="budget-category-input__icon" style={{ background: `${category.color}20` }}>{category.icon}</span>
          <label><span className="sr-only">{category.name}预算</span><input inputMode="decimal" value={categoryValues[category.id] ?? ""} onChange={(event) => setCategoryValues((values) => ({ ...values, [category.id]: event.target.value }))} placeholder="金额" /></label>
          <button className="icon-button" type="button" aria-label={`移除${category.name}预算`} onClick={() => setCategoryValues((values) => { const next = { ...values }; delete next[category.id]; return next; })}><Trash2 size={17} /></button>
        </div>)}
        {availableCategories.length > 0 && <div className="budget-category-picker">
          <button ref={pickerTriggerRef} className={`budget-category-add ${pickerOpen ? "is-open" : ""}`.trim()} type="button" aria-expanded={pickerOpen} aria-controls="budget-category-options" onClick={() => setPickerOpen((value) => !value)}>
            <Plus size={17} /><span>添加分类预算</span><ChevronDown size={17} />
          </button>
          {pickerOpen && <div id="budget-category-options" className="budget-category-options" role="listbox" aria-label="可添加的支出分类">
            {availableCategories.map((category, index) => <button
              ref={(node) => { pickerOptionRefs.current[index] = node; }}
              className="budget-category-option"
              key={category.id}
              type="button"
              role="option"
              aria-selected="false"
              aria-label={category.name}
              onClick={() => addCategoryBudget(category.id)}
              onKeyDown={onPickerKeyDown}
            ><span style={{ background: `${category.color}20` }}>{category.icon}</span><strong>{category.name}</strong></button>)}
          </div>}
        </div>}
      </div>
      {(error || save.isError || remove.isError) && <p className="form-error" role="alert">{error ?? (save.error instanceof Error ? save.error.message : remove.error instanceof Error ? remove.error.message : "保存预算失败，请稍后重试。")}</p>}
    </div>
  </BottomSheet>;
}
