import { existsSync } from "node:fs";
import { resolve } from "node:path";

process.env.NODE_ENV ??= "production";
const serverEntry = resolve(import.meta.dirname, "../dist-server/index.js");
if (!existsSync(serverEntry)) {
  console.error("尚未找到构建产物，请先执行 npm run build 完成打包后再启动。");
  process.exit(1);
}
await import("../dist-server/index.js");
