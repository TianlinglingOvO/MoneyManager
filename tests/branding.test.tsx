// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import {
  APP_BRAND_NAME,
  APP_DESCRIPTION,
  APP_FULL_NAME,
  APP_VERSION,
  BRAND_COLORS,
  PWA_ICONS
} from "../shared/app-metadata";
import { BrandMark } from "../src/components/BrandMark";

afterEach(cleanup);

function pngDimensions(filePath: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(filePath);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25]! };
}

describe("SMB 2.0 品牌", () => {
  it("以 package.json 作为唯一版本来源并保留内部包名", () => {
    expect(packageMetadata).toMatchObject({ name: "sutady-money-manager", version: "2.0.0" });
    expect(APP_VERSION).toBe(packageMetadata.version);
  });

  it("固定品牌文案、颜色和安装图标清单", () => {
    expect(APP_BRAND_NAME).toBe("SMB");
    expect(APP_FULL_NAME).toBe("SMB — Sutady Moneybook");
    expect(APP_DESCRIPTION).toBe("Sutady 的私人账本");
    expect(BRAND_COLORS).toEqual({ ink: "#291D3A", coral: "#F06B55", cream: "#FFF3E4" });
    expect(PWA_ICONS).toEqual([
      expect.objectContaining({ src: "/smb-pwa-192-v2.png", sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ src: "/smb-pwa-512-v2.png", sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ src: "/smb-maskable-512-v2.png", sizes: "512x512", purpose: "maskable" })
    ]);
  });

  it("品牌组件提供标准和小尺寸可编辑 SVG", () => {
    const view = render(<BrandMark decorative={false} />);
    expect(screen.getByRole("img", { name: "SMB" })).toHaveAttribute("src", "/smb-mark-v2.svg");
    view.rerender(<BrandMark compact decorative={false} />);
    expect(screen.getByRole("img", { name: "SMB" })).toHaveAttribute("src", "/smb-favicon-v2.svg");
  });

  it("PWA PNG 尺寸正确、支持透明通道且总量低于 200KB", () => {
    const publicPath = path.resolve(process.cwd(), "public");
    const files = ["smb-pwa-192-v2.png", "smb-pwa-512-v2.png", "smb-maskable-512-v2.png"];
    const expected = [192, 512, 512];
    files.forEach((file, index) => {
      const dimensions = pngDimensions(path.join(publicPath, file));
      expect(dimensions).toMatchObject({ width: expected[index], height: expected[index], colorType: 6 });
    });
    expect(files.reduce((total, file) => total + statSync(path.join(publicPath, file)).size, 0)).toBeLessThan(200_000);
  });
});
