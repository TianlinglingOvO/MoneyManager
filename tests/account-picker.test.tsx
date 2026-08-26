// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPicker, formatAccountBalance } from "../src/components/AccountPicker";

const accounts = [
  { id: "cny", name: "微信", icon: "微", balanceMinor: 12_345, currency: "CNY" as const },
  { id: "usd", name: "美元卡", icon: "卡", balanceMinor: 2_000, currency: "USD" as const },
  { id: "usdt", name: "Bybit", icon: "B", balanceMinor: 3_050, currency: "USDT" as const }
];

afterEach(cleanup);

describe("AccountPicker", () => {
  it("展示账户币种余额并在选择后恢复触发器焦点", async () => {
    const onChange = vi.fn();
    render(<AccountPicker accounts={accounts} value="cny" onChange={onChange} label="付款账户" />);

    const trigger = screen.getByRole("combobox", { name: "付款账户" });
    expect(trigger).toHaveTextContent("¥123.45");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /美元卡.*US\$20\.00/ }));

    expect(onChange).toHaveBeenCalledWith("usd");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("支持方向键、首尾键和 Escape 关闭", async () => {
    render(<AccountPicker accounts={accounts} value="usd" onChange={() => undefined} label="资金账户" />);
    const trigger = screen.getByRole("combobox", { name: "资金账户" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    await waitFor(() => expect(document.activeElement).toBe(options[1]));
    fireEvent.keyDown(options[1]!, { key: "End" });
    expect(document.activeElement).toBe(options[2]);
    fireEvent.keyDown(options[2]!, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("把负余额的符号放在币种符号之前", () => {
    expect(formatAccountBalance(-2_500, "USD")).toBe("−US$25.00");
    expect(formatAccountBalance(-2_500, "USDT")).toBe("−25.00 USDT");
  });
});
