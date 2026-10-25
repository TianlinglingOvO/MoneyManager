import { useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, LayoutGrid, Tag } from "lucide-react";
import type { Category, TransactionKind } from "@shared/types";

interface CategoryFilterPickerProps {
  categories: Category[];
  /** Category id, or "" for every category. */
  value: string;
  onChange: (categoryId: string) => void;
  /** Splits the options into 支出 and 收入 sections when both kinds are listed. */
  grouped?: boolean;
  /** Opens the list in the page flow instead of a floating popover, for use inside sheets. */
  inline?: boolean;
}

const allCategoriesLabel = "全部分类";
const selectedFallbackLabel = "已选分类";
const kindLabels: Record<TransactionKind, string> = { expense: "支出", income: "收入" };
const popoverMaxHeight = 360;
const popoverMinHeight = 180;
const popoverGap = 16;

function CategoryChip({ category, pending = false }: { category?: Category; pending?: boolean }) {
  if (!category) {
    return <span className="category-filter-picker__icon category-filter-picker__icon--all" aria-hidden="true">{pending ? <Tag size={14} /> : <LayoutGrid size={14} />}</span>;
  }
  return <span className="category-filter-picker__icon" style={{ "--category-color": category.color } as CSSProperties} aria-hidden="true">{category.icon}</span>;
}

export function CategoryFilterPicker({ categories, value, onChange, grouped = false, inline = false }: CategoryFilterPickerProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const [maxHeight, setMaxHeight] = useState(popoverMaxHeight);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const labelId = useId();
  const listboxId = useId();
  const selected = categories.find((category) => category.id === value);

  // Archived categories stay filterable but sit after the active ones, matching the entry picker's order.
  const ordered = [...categories.filter((category) => !category.isArchived), ...categories.filter((category) => category.isArchived)];
  const sections = grouped
    ? (["expense", "income"] as const)
      .map((kind) => ({ kind, items: ordered.filter((category) => category.kind === kind) }))
      .filter((section) => section.items.length > 0)
    : [{ kind: null, items: ordered }];
  const optionValues = ["", ...sections.flatMap((section) => section.items.map((category) => category.id))];

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const placePopover = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (inline || !rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const nextPlacement = spaceBelow < 280 && rect.top > spaceBelow ? "above" : "below";
    const space = (nextPlacement === "below" ? spaceBelow : rect.top) - popoverGap;
    setPlacement(nextPlacement);
    setMaxHeight(Math.max(popoverMinHeight, Math.min(popoverMaxHeight, space)));
  };

  const openAndFocus = (position: "selected" | "first" | "last" = "selected") => {
    placePopover();
    setOpen(true);
    window.requestAnimationFrame(() => {
      const index = position === "first" ? 0 : position === "last" ? optionValues.length - 1 : Math.max(0, optionValues.indexOf(value));
      optionRefs.current[index]?.focus();
    });
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      openAndFocus(event.key === "ArrowUp" || event.key === "End" ? "last" : event.key === "Home" ? "first" : "selected");
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab" && event.shiftKey) {
      // Step back to the trigger and close; moving focus first keeps it out of the options being unmounted.
      event.preventDefault();
      triggerRef.current?.focus();
      setOpen(false);
      return;
    }
    // A plain Tab keeps the browser's default move to the next control; the root's onBlur then closes the list.
    if (event.key === "Tab") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const count = optionValues.length;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? count - 1
        : event.key === "ArrowDown"
          ? (index + 1) % count
          : (index - 1 + count) % count;
    optionRefs.current[nextIndex]?.focus();
  };

  const choose = (categoryId: string) => {
    if (categoryId !== value) onChange(categoryId);
    close();
  };

  const renderOption = (category: Category | undefined, index: number) => {
    const optionValue = category?.id ?? "";
    const isSelected = optionValue === value;
    return <button
      ref={(node) => { optionRefs.current[index] = node; }}
      className="category-filter-picker__option"
      key={optionValue || "all"}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={isSelected}
      onClick={() => choose(optionValue)}
      onKeyDown={(event) => onOptionKeyDown(event, index)}
    >
      <CategoryChip category={category} />
      <span className="category-filter-picker__name">{category?.name ?? allCategoriesLabel}</span>
      {category?.isArchived && <small>已停用</small>}
      {isSelected && <Check className="category-filter-picker__check" size={15} aria-hidden="true" />}
    </button>;
  };

  // Close once focus lands outside the picker (Tab, Shift+Tab, or a script). A null relatedTarget is
  // ignored: Safari does not focus clicked buttons, and outside clicks are handled by the pointerdown listener.
  const onRootBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (open && next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
  };

  // A category id from the URL may arrive before the categories do; show that a filter is active without naming it.
  const triggerLabel = selected?.name ?? (value ? selectedFallbackLabel : allCategoriesLabel);

  let optionIndex = 1;
  return (
    <div ref={rootRef} className={`category-filter-picker ${inline ? "category-filter-picker--inline" : ""}`.trim()} onBlur={onRootBlur}>
      <span id={labelId} className="sr-only">筛选分类</span>
      <button
        ref={triggerRef}
        className={`category-filter-picker__trigger ${open ? "is-open" : ""} ${value ? "is-filtered" : ""}`.trim()}
        type="button"
        role="combobox"
        aria-labelledby={labelId}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => open ? close(false) : openAndFocus()}
        onKeyDown={onTriggerKeyDown}
      >
        <CategoryChip category={selected} pending={Boolean(value) && !selected} />
        <span className="category-filter-picker__name">{triggerLabel}</span>
        {selected?.isArchived && <small>已停用</small>}
        <ChevronDown className="category-filter-picker__chevron" size={16} aria-hidden="true" />
      </button>
      {open && <div
        id={listboxId}
        className={`category-filter-picker__options is-${placement}`}
        role="listbox"
        aria-labelledby={labelId}
        // Chrome makes a scroller with no tabbable children a Tab stop of its own; the options are -1, so opt out.
        tabIndex={-1}
        style={inline ? undefined : { "--picker-max-height": `${maxHeight}px` } as CSSProperties}
      >
        {renderOption(undefined, 0)}
        {sections.map((section) => section.kind
          ? <div className="category-filter-picker__group" role="group" aria-labelledby={`${listboxId}-${section.kind}`} key={section.kind}>
            <span id={`${listboxId}-${section.kind}`} className="category-filter-picker__group-label" role="presentation">{kindLabels[section.kind]}</span>
            {section.items.map((category) => renderOption(category, optionIndex++))}
          </div>
          : section.items.map((category) => renderOption(category, optionIndex++)))}
      </div>}
    </div>
  );
}
