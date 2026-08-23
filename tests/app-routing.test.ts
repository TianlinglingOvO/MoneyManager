import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("应用路由结构", () => {
  it("资金页路由位于 Routes 容器内且只注册一次", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const routesStart = source.indexOf("<Routes>");
    const routesEnd = source.indexOf("</Routes>");
    const route = '<Route path="funds" element={<FundsPage />} />';
    const fundsRoute = source.indexOf(route);

    expect(routesStart).toBeGreaterThanOrEqual(0);
    expect(routesEnd).toBeGreaterThan(routesStart);
    expect(fundsRoute).toBeGreaterThan(routesStart);
    expect(fundsRoute).toBeLessThan(routesEnd);
    expect(source.indexOf(route, fundsRoute + route.length)).toBe(-1);
  });
});
