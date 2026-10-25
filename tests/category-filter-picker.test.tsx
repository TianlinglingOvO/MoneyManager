// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category } from "../shared/types";
import { CategoryFilterPicker } from "../src/components/CategoryFilterPicker";

afterEach(cleanup);

/** Option text without the decorative icon chip. */
const optionLabels = (options: HTMLElement[]) => options.map((option) => [...option.querySelectorAll(".category-filter-picker__name, small")].map((part) => part.textContent).join(" "));

function category(overrides: Partial<Category> & Pick<Category, "id" | "name">): Category {
  return {
    kind: "expense",
    icon: "🍜",
    color: "#D66A4C",
    sortOrder: 0,
    isArchived: false,
    transactionCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

const categories = [
  category({ id: "breakfast", name: "早餐" }),
  category({ id: "old-snacks", name: "零食", isArchived: true }),
  category({ id: "lunch", name: "午餐" }),
  category({ id: "salary", name: "工资", kind: "income", icon: "💰", color: "#3E8066" })
];

describe("CategoryFilterPicker", () => {
  it("用应用内列表选择分类，选择后关闭并把焦点还给触发器", async () => {
    const onChange = vi.fn();
    render(<CategoryFilterPicker categories={categories} value="" onChange={onChange} />);

    const trigger = screen.getByRole("combobox", { name: "筛选分类" });
    expect(trigger).toHaveTextContent("全部分类");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox", { name: "筛选分类" });
    expect(trigger).toHaveAttribute("aria-controls", listbox.id);
    expect(within(listbox).getByRole("option", { name: "全部分类" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(listbox).getByRole("option", { name: "午餐" }));

    expect(onChange).toHaveBeenCalledWith("lunch");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("全部收支时按支出、收入分组，停用分类排在各组末尾并标注", () => {
    render(<CategoryFilterPicker categories={categories} value="old-snacks" onChange={() => undefined} grouped />);

    const trigger = screen.getByRole("combobox", { name: "筛选分类" });
    expect(trigger).toHaveTextContent("零食已停用");
    expect(trigger).toHaveClass("is-filtered");
    fireEvent.click(trigger);

    const expense = screen.getByRole("group", { name: "支出" });
    const income = screen.getByRole("group", { name: "收入" });
    expect(optionLabels(within(expense).getAllByRole("option"))).toEqual(["早餐", "午餐", "零食 已停用"]);
    expect(optionLabels(within(income).getAllByRole("option"))).toEqual(["工资"]);
    expect(within(expense).getByRole("option", { name: /零食/ })).toHaveAttribute("aria-selected", "true");
  });

  it("支持方向键、首尾键，Escape 只关闭列表而不冒泡到外层抽屉", async () => {
    // Stands in for BottomSheet, which closes on any Escape that reaches the document.
    const outerEscape = vi.fn();
    const onDocumentKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") outerEscape(); };
    document.addEventListener("keydown", onDocumentKeyDown);
    render(<CategoryFilterPicker categories={categories} value="lunch" onChange={() => undefined} />);
    const trigger = screen.getByRole("combobox", { name: "筛选分类" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(optionLabels(options)).toEqual(["全部分类", "早餐", "午餐", "工资", "零食 已停用"]);
    expect(options.every((option) => option.tabIndex === -1)).toBe(true);
    // Otherwise Chrome turns the scrolling list itself into a Tab stop.
    expect(screen.getByRole("listbox")).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(document.activeElement).toBe(options[2]));
    fireEvent.keyDown(options[2]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[3]);
    fireEvent.keyDown(options[3]!, { key: "End" });
    expect(document.activeElement).toBe(options[4]);
    fireEvent.keyDown(options[4]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0]!, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(outerEscape).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    document.removeEventListener("keydown", onDocumentKeyDown);
  });

  it("Tab 保留浏览器默认的前进移动并在焦点离开后关闭，Shift+Tab 回到触发器并关闭", async () => {
    render(<><CategoryFilterPicker categories={categories} value="lunch" onChange={() => undefined} /><button type="button">下一个控件</button></>);
    const trigger = screen.getByRole("combobox", { name: "筛选分类" });
    const nextControl = screen.getByRole("button", { name: "下一个控件" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const lunch = screen.getByRole("option", { name: "午餐" });
    await waitFor(() => expect(document.activeElement).toBe(lunch));
    // jsdom has no default Tab navigation: assert the key is left to the browser, then move focus as it would.
    const tab = createEvent.keyDown(lunch, { key: "Tab" });
    fireEvent(lunch, tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    act(() => nextControl.focus());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(nextControl);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const reopened = screen.getByRole("option", { name: "午餐" });
    await waitFor(() => expect(document.activeElement).toBe(reopened));
    const shiftTab = createEvent.keyDown(reopened, { key: "Tab", shiftKey: true });
    fireEvent(reopened, shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("焦点从展开的触发器移到外部时关闭列表，在选择器内部移动则保持展开", async () => {
    render(<><CategoryFilterPicker categories={categories} value="" onChange={() => undefined} /><button type="button">收入</button></>);
    const trigger = screen.getByRole("combobox", { name: "筛选分类" });

    fireEvent.click(trigger);
    const first = screen.getByRole("option", { name: "全部分类" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    act(() => trigger.focus());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "收入" }).focus());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("分类数据尚未加载时，触发器显示已选分类而不是全部分类", () => {
    const { rerender } = render(<CategoryFilterPicker categories={[]} value="lunch" onChange={() => undefined} />);
    const trigger = screen.getByRole("combobox", { name: "筛选分类" });
    expect(trigger).toHaveTextContent("已选分类");
    expect(trigger).not.toHaveTextContent("全部分类");
    expect(trigger).toHaveClass("is-filtered");

    rerender(<CategoryFilterPicker categories={categories} value="lunch" onChange={() => undefined} />);
    expect(trigger).toHaveTextContent("午餐");
  });

  it("点击外部关闭列表，重复选择当前分类不会触发变更", () => {
    const onChange = vi.fn();
    render(<><CategoryFilterPicker categories={categories} value="breakfast" onChange={onChange} /><button type="button">外部</button></>);
    const trigger = screen.getByRole("combobox", { name: "筛选分类" });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "早餐" }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "外部" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("抽屉内使用页面内展开的列表，不浮在内容上", () => {
    const { container } = render(<CategoryFilterPicker categories={categories} value="" onChange={() => undefined} inline />);
    fireEvent.click(screen.getByRole("combobox", { name: "筛选分类" }));

    expect(container.firstElementChild).toHaveClass("category-filter-picker--inline");
    expect(screen.getByRole("listbox").getAttribute("style")).toBeNull();
  });
});
