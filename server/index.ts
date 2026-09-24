import { createServer } from "node:http";
import { loadConfig, validateProductionConfig } from "./config";
import { closeDatabase, getDatabase } from "./database";
import { createApp } from "./app";
import { RELOAD_EXIT_CODE, setReloadExitHandler } from "./reload";

const config = loadConfig();
validateProductionConfig(config);
const database = getDatabase(config);
const storedTimezone = database.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value?: string } | undefined;
if (storedTimezone?.value) config.timezone = storedTimezone.value;
const { app, services } = createApp(config, database);
const server = createServer(app);
let backupTimer: NodeJS.Timeout | null = null;

server.listen(config.port, config.host, () => {
  if (config.nodeEnv === "production") backupTimer = services.backup.startDailyScheduler();
  const authLabel = config.authMode === "cloudflare" ? "Cloudflare Access" : "本地开发模式";
  console.log(`SMB 已启动：http://${config.host}:${config.port}（${authLabel}）`);
});

function shutdown(code = 0): void {
  if (backupTimer) clearInterval(backupTimer);
  server.close(() => {
    closeDatabase();
    process.exit(code);
  });
  setTimeout(() => process.exit(code || 1), 8_000).unref();
}

setReloadExitHandler(() => {
  setTimeout(() => shutdown(RELOAD_EXIT_CODE), 300).unref();
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
