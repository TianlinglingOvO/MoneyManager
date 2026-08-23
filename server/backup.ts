import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as SnapshotDatabase } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AppConfig } from "./config";
import { AppError } from "./errors";
import type { LedgerRepository } from "./repository";
import type { BackupCheckStatus } from "../shared/types";

export interface BackupResult {
  success: true;
  createdAt: string;
  localPath: string;
  remoteUploaded: boolean;
  remoteMessage: string;
}

function safeSqlitePath(value: string): string {
  return value.replaceAll("'", "''");
}

function remoteTarget(config: AppConfig, filename: string): string {
  const remote = config.rcloneRemote.endsWith(":") ? config.rcloneRemote : `${config.rcloneRemote}:`;
  const directory = config.rcloneBackupPath.replace(/^\/+|\/+$/g, "");
  return `${remote}${directory}/${filename}`;
}

function pruneLocal(directory: string, retentionCount: number): void {
  const snapshots = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("money-") && entry.name.endsWith(".sqlite"))
    .map((entry) => ({ name: entry.name, modifiedAt: statSync(path.join(directory, entry.name)).mtimeMs }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  for (const snapshot of snapshots.slice(Math.max(1, retentionCount))) {
    rmSync(path.join(directory, snapshot.name), { force: true });
  }
}

function pruneRemote(config: AppConfig, keep = 30): void {
  const remoteDirectory = remoteTarget(config, "").replace(/\/$/, "");
  const listing = spawnSync("rclone", ["lsjson", remoteDirectory, "--files-only", "--include", "*.sqlite.age"], {
    windowsHide: true,
    encoding: "utf8"
  });
  if (listing.status !== 0) return;
  try {
    const files = JSON.parse(listing.stdout) as Array<{ Name?: string; ModTime?: string }>;
    files.sort((a, b) => String(b.ModTime ?? "").localeCompare(String(a.ModTime ?? "")));
    for (const file of files.slice(keep)) {
      if (!file.Name || file.Name.includes("/") || file.Name.includes("\\")) continue;
      spawnSync("rclone", ["deletefile", `${remoteDirectory}/${file.Name}`], { windowsHide: true, encoding: "utf8" });
    }
  } catch {
    // 远端清理失败不影响已经完成的本地快照和上传。
  }
}

export class BackupService {
  private running = false;

  constructor(
    private readonly database: DatabaseSync,
    private readonly repository: LedgerRepository,
    private readonly config: AppConfig,
    private readonly runCommand: typeof spawnSync = spawnSync
  ) {}

  private upsertSetting(key: string, value: string, at = new Date().toISOString()): void {
    this.database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, at);
  }

  status(): { lastSuccessAt: string | null; remoteConfigured: boolean; local: BackupCheckStatus; remote: BackupCheckStatus; restoreVerification: BackupCheckStatus } {
    const rows = this.database.prepare("SELECT key, value FROM settings WHERE key LIKE 'backup.%'")
      .all() as unknown as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const configured = Boolean(this.config.backupAgeRecipient && this.config.rcloneRemote);
    const readStatus = (prefix: string, fallback: BackupCheckStatus["state"]): BackupCheckStatus => {
      const lastAttemptAt = map.get(`${prefix}.lastAttemptAt`) ?? null;
      const lastSuccessAt = map.get(`${prefix}.lastSuccessAt`) ?? null;
      let state = (map.get(`${prefix}.status`) as BackupCheckStatus["state"] | undefined) ?? fallback;
      if (state === "success" && lastSuccessAt && Date.now() - new Date(lastSuccessAt).getTime() > 48 * 60 * 60 * 1000) state = "stale";
      return { lastAttemptAt, lastSuccessAt, state };
    };
    const legacySuccess = map.get("backup.lastSuccessAt") ?? null;
    const local = readStatus("backup.local", legacySuccess ? "success" : "never");
    if (!local.lastSuccessAt && legacySuccess) local.lastSuccessAt = legacySuccess;
    return {
      lastSuccessAt: local.lastSuccessAt,
      remoteConfigured: configured,
      local,
      remote: readStatus("backup.remote", configured ? "never" : "not_configured"),
      restoreVerification: readStatus("backup.restore", "never")
    };
  }

  async createBackup(): Promise<BackupResult> {
    if (this.running) throw new AppError("备份正在进行，请稍后再试", 409, "BACKUP_RUNNING");
    this.running = true;
    const attemptedAt = new Date().toISOString();
    this.upsertSetting("backup.local.lastAttemptAt", attemptedAt, attemptedAt);
    let localSucceeded = false;
    try {
      mkdirSync(this.config.backupLocalDir, { recursive: true });
      const now = new Date();
      const stamp = now.toISOString().replace(/[:.]/g, "-");
      const localPath = path.join(this.config.backupLocalDir, `money-${stamp}.sqlite`);
      this.database.exec(`VACUUM INTO '${safeSqlitePath(localPath)}'`);

      const snapshot = new SnapshotDatabase(localPath, { readOnly: true });
      const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      const foreignKeyIssues = snapshot.prepare("PRAGMA foreign_key_check").all();
      snapshot.close();
      if (integrity.integrity_check !== "ok" || foreignKeyIssues.length > 0) {
        rmSync(localPath, { force: true });
        throw new AppError("SQLite 完整性或外键检查未通过，已取消备份", 500, "BACKUP_INTEGRITY_ERROR");
      }

      pruneLocal(this.config.backupLocalDir, this.config.backupRetentionCount);
      localSucceeded = true;
      let remoteUploaded = false;
      let remoteMessage = "尚未配置 Google Drive 加密备份";
      const createdAt = now.toISOString();
      this.upsertSetting("backup.lastSuccessAt", createdAt, createdAt);
      this.upsertSetting("backup.local.lastSuccessAt", createdAt, createdAt);
      this.upsertSetting("backup.local.status", "success", createdAt);

      if (this.config.backupAgeRecipient && this.config.rcloneRemote) {
        this.upsertSetting("backup.remote.lastAttemptAt", createdAt, createdAt);
        const encryptedPath = `${localPath}.age`;
        const age = this.runCommand("age", ["-r", this.config.backupAgeRecipient, "-o", encryptedPath, localPath], {
          windowsHide: true,
          encoding: "utf8"
        });
        if (age.status !== 0 || !existsSync(encryptedPath)) {
          remoteMessage = "本地备份成功，但未找到 age 或加密失败";
          this.upsertSetting("backup.remote.status", "failed", createdAt);
        } else {
          const remote = remoteTarget(this.config, path.basename(encryptedPath));
          const upload = this.runCommand("rclone", ["copyto", encryptedPath, remote, "--checksum"], {
            windowsHide: true,
            encoding: "utf8"
          });
          if (upload.status === 0) {
            remoteUploaded = true;
            remoteMessage = "加密副本已上传到 Google Drive";
            this.upsertSetting("backup.remote.lastSuccessAt", createdAt, createdAt);
            this.upsertSetting("backup.remote.status", "success", createdAt);
            pruneRemote(this.config, 30);
          } else {
            remoteMessage = "本地备份成功，但 Google Drive 上传失败";
            this.upsertSetting("backup.remote.status", "failed", createdAt);
          }
          rmSync(encryptedPath, { force: true });
        }
      }

      this.repository.audit("system", "backup.create", "database", null, { remoteUploaded });
      return { success: true, createdAt, localPath, remoteUploaded, remoteMessage };
    } catch (error) {
      if (!localSucceeded) this.upsertSetting("backup.local.status", "failed");
      throw error;
    } finally {
      this.running = false;
    }
  }

  startDailyScheduler(): NodeJS.Timeout {
    const runIfDue = async () => {
      const now = new Date();
      if (now.getHours() < 3) return;
      const last = this.status().lastSuccessAt;
      if (last && new Date(last).toDateString() === now.toDateString()) return;
      try {
        this.repository.purgeExpiredTrash();
        await this.createBackup();
      } catch {
        // 备份错误仅写入服务端健康状态，不记录账目或密钥。
      }
    };
    void runIfDue();
    return setInterval(() => void runIfDue(), 60 * 60 * 1000);
  }
}
