import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { AccountCurrency } from "@shared/types";

export type { AccountCurrency } from "@shared/types";

export interface AccountPickerAccount {
  id: string;
  name: string;
  icon: string;
  balanceMinor: number;
  currency?: AccountCurrency;
}

interface AccountPickerProps {
  accounts: AccountPickerAccount[];
  value: string;
  onChange: (value: string) => void;
  label: ReactNode;
  emptyLabel?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
}

function formattedNumber(amountMinor: number): string {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amountMinor / 100);
}

export function formatAccountBalance(amountMinor: number, currency: AccountCurrency = "CNY"): string {
  const sign = amountMinor < 0 ? "−" : "";
  const amount = formattedNumber(Math.abs(amountMinor));
  if (currency === "USD") return `${sign}US$${amount}`;
  if (currency === "USDT") return `${sign}${amount} USDT`;
  return `${sign}¥${amount}`;
}

export function AccountPicker({
  accounts,
  value,
  onChange,
  label,
  emptyLabel = "选择资金账户",
  disabled = false,
  required = false,
  className = ""
}: AccountPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const labelId = useId();
  const listboxId = useId();
  const selected = accounts.find((account) => account.id === value);
  const unavailable = disabled || accounts.length === 0;

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openAndFocus = (position: "selected" | "first" | "last" = "selected") => {
    if (unavailable) return;
    setOpen(true);
    window.requestAnimationFrame(() => {
      const selectedIndex = Math.max(0, accounts.findIndex((account) => account.id === value));
      const index = position === "first" ? 0 : position === "last" ? accounts.length - 1 : selectedIndex;
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

  useEffect(() => {
    if (open && unavailable) setOpen(false);
  }, [open, unavailable]);

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
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? accounts.length - 1
        : event.key === "ArrowDown"
          ? (index + 1) % accounts.length
          : (index - 1 + accounts.length) % accounts.length;
    optionRefs.current[nextIndex]?.focus();
  };

  const choose = (accountId: string) => {
    onChange(accountId);
    close();
  };

  return (
    <div ref={rootRef} className={`account-picker ${className}`.trim()}>
      <span id={labelId} className="account-picker__label">{label}</span>
      <button
        ref={triggerRef}
        className={`account-picker__trigger ${open ? "is-open" : ""}`.trim()}
        type="button"
        role="combobox"
        aria-labelledby={labelId}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-required={required}
        disabled={unavailable}
        onClick={() => open ? close(false) : openAndFocus()}
        onKeyDown={onTriggerKeyDown}
      >
        {selected ? <>
          <span className="account-picker__icon" aria-hidden="true">{selected.icon}</span>
          <strong>{selected.name}</strong>
          <small>{formatAccountBalance(selected.balanceMinor, selected.currency)}</small>
        </> : <span className="account-picker__placeholder">{accounts.length === 0 ? "没有可用账户" : emptyLabel}</span>}
        <ChevronDown className="account-picker__chevron" size={17} aria-hidden="true" />
      </button>
      {open && <div id={listboxId} className="account-picker__options" role="listbox" aria-labelledby={labelId}>
        {accounts.map((account, index) => <button
          ref={(node) => { optionRefs.current[index] = node; }}
          className="account-picker__option"
          key={account.id}
          type="button"
          role="option"
          aria-selected={account.id === value}
          onClick={() => choose(account.id)}
          onKeyDown={(event) => onOptionKeyDown(event, index)}
        >
          <span className="account-picker__icon" aria-hidden="true">{account.icon}</span>
          <strong>{account.name}</strong>
          <small>{formatAccountBalance(account.balanceMinor, account.currency)}</small>
          {account.id === value && <span className="sr-only">当前选择</span>}
        </button>)}
      </div>}
    </div>
  );
}
