import "dotenv/config";
import path from "node:path";

function resolveProjectPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  databasePath: string;
  timezone: string;
  authMode: "disabled" | "cloudflare";
  cloudflareTeamDomain: string;
  cloudflareAudience: string;
  cloudflareMcpAudience: string;
  allowedEmail: string;
  mcpApiToken: string;
  deepseekApiKey: string;
  deepseekModel: string;
  deepseekThinking: "enabled" | "disabled";
  deepseekBaseUrl: string;
  backupLocalDir: string;
  backupRetentionCount: number;
  backupAgeRecipient: string;
  rcloneRemote: string;
  rcloneBackupPath: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const config: AppConfig = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    host: process.env.HOST ?? "127.0.0.1",
    port: numberFromEnv(process.env.PORT, 8788),
    databasePath: resolveProjectPath(process.env.DATABASE_PATH ?? "./data/money-manager.sqlite"),
    timezone: process.env.APP_TIMEZONE ?? "Asia/Shanghai",
    authMode: process.env.AUTH_MODE === "cloudflare" ? "cloudflare" : "disabled",
    cloudflareTeamDomain: process.env.CF_ACCESS_TEAM_DOMAIN ?? "",
    cloudflareAudience: process.env.CF_ACCESS_AUD ?? "",
    cloudflareMcpAudience: process.env.CF_ACCESS_MCP_AUD ?? process.env.CF_ACCESS_AUD ?? "",
    allowedEmail: (process.env.ALLOWED_EMAIL ?? "").trim().toLowerCase(),
    mcpApiToken: process.env.MCP_API_TOKEN ?? "",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
    deepseekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    deepseekThinking: process.env.DEEPSEEK_THINKING === "enabled" ? "enabled" : "disabled",
    deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, ""),
    backupLocalDir: resolveProjectPath(process.env.BACKUP_LOCAL_DIR ?? "./backups/local"),
    backupRetentionCount: numberFromEnv(process.env.BACKUP_RETENTION_COUNT, 14),
    backupAgeRecipient: process.env.BACKUP_AGE_RECIPIENT ?? "",
    rcloneRemote: process.env.RCLONE_REMOTE ?? "",
    rcloneBackupPath: process.env.RCLONE_BACKUP_PATH ?? "MoneyManagerBackups"
  };
  return { ...config, ...overrides };
}

export function validateProductionConfig(config: AppConfig): void {
  if (config.nodeEnv !== "production") return;
  if (config.authMode === "disabled") {
    if (config.host !== "127.0.0.1" && config.host !== "localhost") {
      throw new Error("关闭身份验证时只允许监听本机 127.0.0.1");
    }
    return;
  }
  if (config.authMode !== "cloudflare") {
    throw new Error("正式环境必须启用 Cloudflare Access 身份验证");
  }
  if (!config.cloudflareTeamDomain || !config.cloudflareAudience || !config.cloudflareMcpAudience || !config.allowedEmail) {
    throw new Error("正式环境缺少 Cloudflare Access 配置");
  }
  if (config.mcpApiToken.length < 32) {
    throw new Error("正式环境 MCP_API_TOKEN 至少需要 32 个字符");
  }
}
