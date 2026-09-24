# 备份与恢复

## 首次设置

1. 安装 `age` 和 `rclone`：

   ```powershell
   winget install --id FiloSottile.age
   winget install --id Rclone.Rclone
   ```

2. 运行 `rclone config`，新建 Google Drive remote，建议命名为 `money-drive`。浏览器授权是 Google Drive 唯一需要的账号操作。
3. 插入 U 盘或选择另一台设备可保存的位置，再生成离线恢复密钥：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\initialize-backup.ps1 -RecoveryKeyPath "E:\SMB恢复密钥.txt" -RcloneRemote "money-drive"
   ```

4. 把恢复密钥移出笔记本并妥善保存。应用只保留公钥，Google Drive 只保存加密文件；私钥丢失后远端备份无法解密。
5. 重启 SMB 服务，在设置页点击“立即备份”，确认显示“加密副本已上传到 Google Drive”。

## 验证普通快照

```powershell
node .\scripts\verify-sqlite.mjs ".\backups\local\money-某个时间.sqlite"
```

输出 `ok` 才表示 SQLite 完整性与外键检查通过。

## 执行真实恢复演练

先完成生产构建，再让 SMB 在独立临时目录中恢复并启动一份快照：

```powershell
npm.cmd run build
npm.cmd run backup:verify-restore
```

不提供路径时会选择 `backups/local` 中最新的快照；也可把具体快照路径作为最后一个参数。演练会启动随机回环端口，核对账目、事项、预算、资金账户与流水、AI 报告和 OpenClaw 操作的数量与身份摘要，再在临时服务中创建、读回、软删除并永久清理一笔测试账目，确认资金影响回到原值，最后重复执行完整性与外键检查。它不会替换正式数据库，也不会向正式账本写入测试数据。

设置页分别显示“本地快照”“Google Drive 加密上传”和“恢复验证”。这些状态只包含最近尝试、最近成功和结果，不包含本机路径、命令输出、令牌或密钥。

## 从 Google Drive 恢复

1. 用 `rclone copy` 把需要的 `.sqlite.age` 下载到本机临时目录。
2. 停止旧版兼容名称“寸金记账”的计划任务和正在运行的 SMB 服务。
3. 执行恢复；PowerShell 会再次询问确认：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-backup.ps1 `
     -BackupPath "D:\Downloads\money-时间.sqlite.age" `
     -IdentityPath "E:\SMB恢复密钥.txt"
   ```

4. 脚本会先解密到临时目录、做完整性和外键检查，再把当前数据库复制到 `backups\pre-restore`，最后替换主库并再次检查。
5. 重新启动任务，确认首页、设置状态和最近账目正常。

6. 打开“资金”核对总额、账户和最近流水，再抽查借款、订阅、计划、预算和账本体检。完整数据库恢复会同时恢复账户、别名、资金流水、转账、校准、退款状态、事项（含计划）、预算、体检核对和 OpenClaw 的 30 天撤销快照；当前设备专属的个人背景图片仍只存在于浏览器 IndexedDB，不包含在 SQLite 备份中。

   资金恢复后还应核对启用日期、默认收入/支出账户、每个账户的初始余额与最近一笔资金流水。恢复不会重新执行启用向导，也不会重新生成历史流水；若恢复出的账本体检出现“启用资金追踪后的账目缺少账户”，请按 [资金追踪指南](FUNDS.md) 区分启用后的漏绑账目与启用当天已经包含在初始余额中的旧账。

恢复脚本默认只允许替换项目内的 `data\money-manager.sqlite`，避免误覆盖其他数据库。需要把旧库迁到不同磁盘时，请先修改 `.env` 并人工核对路径，不要直接绕过这一保护。

恢复旧版本数据库后启动当前程序时，缺少的结构会自动迁移到最新版本。迁移前仍会额外生成一份本地快照；若迁移失败，应保留错误现场并恢复迁移前快照，不要手工删除 `schema_migrations` 记录。

永久删除只影响当前正式数据库、之后生成的导出和仍有效的 OpenClaw 操作快照。删除前已经生成的本地或 Google Drive 备份仍可能包含历史账目，直至分别超过 14 份和 30 份的保留周期；如需恢复旧备份，应先确认其中是否包含后来永久删除的数据。
