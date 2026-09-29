import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");

describe("页面背景层", () => {
  it("背景画在固定的 body::before 层上，并位于 body 底色之上", () => {
    // Without its own stacking context, body's opaque background colour covers the z-index:-1 layer.
    expect(css).toMatch(/body \{[^}]*isolation: isolate/);
    expect(css).toMatch(/body::before \{[^}]*position: fixed[^}]*z-index: -1[^}]*background-image: var\(--app-background-image/);
    expect(css).not.toMatch(/background-attachment: fixed/);
  });
});
