// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BootSplash } from "../src/components/BootSplash";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("冷启动品牌开屏", () => {
  it("系统减少动画时直接进入应用", () => {
    window.sessionStorage.clear();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
    render(<BootSplash />);
    expect(screen.queryByText("寸金")).not.toBeInTheDocument();
  });

  it("每个浏览会话只播放一次并在 0.8 秒内退出", async () => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    const first = render(<BootSplash />);
    expect(screen.getByText("寸金")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(440); });
    expect(screen.getByText("寸金").closest(".boot-splash")).toHaveClass("is-closing");
    await act(async () => { await vi.advanceTimersByTimeAsync(280); });
    expect(screen.queryByText("寸金")).not.toBeInTheDocument();

    first.unmount();
    render(<BootSplash />);
    expect(screen.queryByText("寸金")).not.toBeInTheDocument();
  });
});
