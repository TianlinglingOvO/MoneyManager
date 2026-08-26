import { useEffect, useRef, useState } from "react";
import type { AccountCurrency } from "@shared/types";
import { formatAccountBalance } from "./AccountPicker";

export function MoneyValue({
  amountMinor,
  className = "",
  animateKey,
  currency = "CNY"
}: {
  amountMinor: number;
  className?: string;
  animateKey?: string;
  currency?: AccountCurrency;
}) {
  const previousKey = useRef(animateKey);
  const previousAmount = useRef(amountMinor);
  const [direction, setDirection] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (previousKey.current === animateKey) {
      previousAmount.current = amountMinor;
      return;
    }
    previousKey.current = animateKey;
    setDirection(amountMinor >= previousAmount.current ? "up" : "down");
    previousAmount.current = amountMinor;
    const timer = window.setTimeout(() => setDirection(null), 300);
    return () => window.clearTimeout(timer);
  }, [amountMinor, animateKey]);

  return <span className={`money-value ${direction ? `is-${direction}` : ""} ${className}`.trim()}>{formatAccountBalance(amountMinor, currency)}</span>;
}
