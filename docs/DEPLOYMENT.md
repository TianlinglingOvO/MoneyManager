# SMB 部署指南

> 💡 **提示**：如果你仅打算在单机个人电脑上使用，无需阅读本指南，直接双击根目录 `打开 SMB.cmd` 即可开箱即用。本指南面向需要通过 Cloudflare Tunnel 实现手机跨网外网记账的高级部署场景。

下面的账号授权步骤必须由账本所有者亲自完成。所有模板都不含真实密钥，也不会修改 OpenClaw 的 18789 端口。

## 1. 本机配置

先在 Cloudflare Access 中创建两个应用并记下它们各自的 Audience Tag：

1. 网页应用：`money.example.com`，不填写路径。
2. MCP 应用：`money.example.com/mcp`。更具体的路径规则会覆盖根应用规则。

然后运行：

当前电脑的 PowerShell 执行策略会阻止直接运行 `.ps1`。以下命令只对这一次脚本运行使用 `Bypass`，不会修改系统策略：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\initialize-local-config.ps1 `
  -AllowedEmail "你的 Gmail 地址" `
  -CloudflareTeamDomain "你的团队名.cloudflareaccess.com" `
  -WebAudience "网页应用 Audience Tag" `
  -McpAudience "MCP 应用 Audience Tag"
```

脚本会生成一枚随机 MCP 应用令牌。真实值只写入已忽略的本机 `.env`。

完成后构建：

```powershell
npm.cmd install
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

更新已经在使用的正式环境前，先创建并校验一份即时快照：

```powershell
npm.cmd run backup:snapshot -- pre-deploy
npm.cmd run backup:verify-restore
```

该命令使用 SQLite 一致性快照，并同时执行完整性与外键检查；快照保存在 `backups/local/`。

构建完成后，若生产进程已由 `打开 SMB.cmd` / `npm.cmd start` / `scripts/start-production.ps1` 托管，可在设置页点「检查并刷新」：它会比较正在运行的版本与磁盘 `package.json` / `dist-server`，过期则优雅退出并由启动器拉起新进程（启动时仍会做迁移前快照），再更新 PWA。首次装上 2.5.2 时仍需手动重启一次，以便加载托管脚本和重新加载接口。未托管的 Node（例如直接运行 `dist-server` 或开发用 `tsx watch`）不会被该按钮重启。完成后确认 `http://127.0.0.1:8788/health` 的 `version` 与 `package.json` 一致。

当前生产库使用数据库迁移版本 12。2.3.0（版本 9）新增账户、别名、资金流水、转账、余额校准以及账目退款字段；2.4.1（版本 10）再补账户币种、账目实际账户金额，以及启用瞬间的历史基线；2.5.0（版本 11）新增一次性计划表，并把 OpenClaw 操作快照的实体类型扩到 `plan`；2.9.0（版本 12）给分类加上“固定支出”标记 `is_fixed`，默认全部为否，升级后需要时在「分类」页手动勾选。不要手工改表；生产构建首次启动会先生成并验证迁移前快照，再自动补齐结构。升级只增加能力，不会自动启用资金追踪，也不会追溯或改写现有账目、事项、预算和操作历史。

### 首次启用资金追踪

迁移成功并不等于已经启用资金追踪。账本所有者需要在 SMB 的“资金”页面完成向导：保留或调整预设账户、填写启用当下的现实余额，并确认默认收入/支出人民币账户。初始余额应已经包含启用前发生的资金变化；不要根据旧账再次扣减或补录。账户也可以是美元或 USDT；外币账户记账时必须另填实际扣款或到账金额。

启用瞬间会把当时已有账目记为历史基线。只有启用后新增、且未计入基线的账目才应补账户；基线旧账不要补账户。缺少账户的启用后账目在“账本体检”中按月聚合显示。详细说明及开发注意事项见 [资金追踪指南](FUNDS.md)。

## 2. Cloudflare Tunnel

在 Cloudflare Zero Trust 中新建 Tunnel，选择 Windows 连接器，并按页面给出的管理员命令安装 `cloudflared` 服务。为 Tunnel 添加公共主机名：

- 主机名：`money.example.com`
- 服务：`HTTP`
- 地址：`127.0.0.1:8788`

应用本身只监听 `127.0.0.1`，不要改成 `0.0.0.0`，也不要在家庭路由器上开放端口。若使用本地管理 Tunnel，可参考 [cloudflared-config.yml.example](../deploy/cloudflared-config.yml.example)。

## 3. Cloudflare Access

网页应用设置：

- Session duration：建议 1 个月；到期后网页会提示重新登录，不影响 OpenClaw 的 Service Token。
- 登录方式：One-time PIN。
- Policy action：Allow。
- Include：Emails，精确填写你的 Gmail 地址；不要使用 Everyone，也不要只按“任何有效邮箱”放行。

MCP 路径应用设置：

- 创建一枚可撤销 Service Token。
- Policy action：Service Auth。
- Include：刚创建的 Service Token。
- OpenClaw 每次请求都发送 `CF-Access-Client-Id` 与 `CF-Access-Client-Secret`。

来源服务仍会验证 Cloudflare 签名 JWT，并额外验证独立的 `MCP_API_TOKEN`。两个 Access 应用的 Audience 不同，因此 `.env` 中分别保存 `CF_ACCESS_AUD` 与 `CF_ACCESS_MCP_AUD`。

## 4. 账本解读（交给 OpenClaw）

SMB 自 2.7.0 起不再内置 AI 分析，也不保存任何大模型密钥。需要解读账本时，直接问接入的 OpenClaw：它通过只读 MCP 工具（`get_finance_summary`、`list_transactions`、`get_budget_summary`、`get_ledger_health` 以及事项汇总）读取程序算好的数字。旧 `.env` 中的 `DEEPSEEK_*` 会被忽略，可以删除。

## 5. OpenClaw

OpenClaw 需要支持 `transport: "streamable-http"`（2026.7 及以后的版本均可，本机当前为 2026.9.4）。`money-manager` 不会与已有的 `filesystem`、`memory-kg` 等 MCP 名称冲突。OpenClaw 的网关服务不继承代理环境变量，因此不要给它添加需要联网下载的 `npx -y` MCP 服务，否则启动超时会让网关崩溃。

在 WSL 的 `~/.openclaw/.env` 中加入三项；不要把真实值写进项目文件：

```dotenv
MONEY_MANAGER_MCP_TOKEN=与应用 .env 中 MCP_API_TOKEN 相同
MONEY_CF_ACCESS_CLIENT_ID=Cloudflare Service Token Client ID
MONEY_CF_ACCESS_CLIENT_SECRET=Cloudflare Service Token Client Secret
```

然后在 WSL 中执行：

```bash
openclaw mcp set money-manager "$(cat ./deploy/openclaw-money-manager.json)"
openclaw mcp doctor money-manager --probe
openclaw mcp reload
```

探测成功后应看到原有账本、事项（含 `list_plans` / `direct_create_plan` / `direct_complete_plan`）、备份、时区和撤销工具，以及 `list_accounts`、`get_funds_summary`、账户管理、转账、校准、退款和撤销退款工具。选择外币账户时必须另传实际账户金额。有金额的计划完成必须带支出分类，资金启用后还必须带支付账户。永久删除仍使用独立的显式确认工具。

Telegram 等新会话在 SMB 当时没开时，可能拿不到 `money-manager` 原生工具，模型有时会改用 curl 手搓 `/mcp`。这种情况下应 `openclaw mcp reload` 并新开会话，不要手搓 JSON-RPC。原生工具可用后，调错请求会返回 JSON-RPC 错误，而不是通用 500。

网页“OpenClaw 操作中心”可以选择：

- `confirm`：写入只生成待确认提案。
- `direct`：普通请求立即执行；只有明确要求“先让我确认”时才使用提案工具。

直接写入必须携带唯一 `requestId`；修改或删除还会校验最近查询到的更新时间。账户可使用 ID 或标准化后的精确名称/别名，歧义时必须先询问用户。可逆操作保留 30 天撤销期，且不会覆盖后来发生的新修改。永久删除必须显式调用专用工具并携带确认字段；密钥、Access 配置和服务启停永不开放给 OpenClaw。

### 每日待办提醒（SMB → OpenClaw）

可选功能。每天到了 `OPENCLAW_REMINDER_TIME`（默认 09:00，按账本时区），SMB 会检查是否有待确认的订阅续费或临近/逾期的计划；只有存在待办时，才调用 OpenClaw Gateway 的 `/hooks/agent`，由 OpenClaw 通过 MCP 只读工具查看详情并发消息提醒。没有待办时不会调用 OpenClaw。

1. 在 OpenClaw 中启用 HTTP hooks（专用随机令牌，不要复用 Gateway 令牌），只允许 `main` agent，然后 `openclaw config validate` 并 `openclaw gateway restart`：`hooks.enabled=true`、`hooks.path=/hooks`、`hooks.token=<随机值>`、`hooks.allowedAgentIds=["main"]`、`hooks.allowRequestSessionKey=false`。
2. 在 SMB 的 `.env` 中填写 `OPENCLAW_HOOK_URL=http://127.0.0.1:18789/hooks/agent`、`OPENCLAW_HOOK_TOKEN`（与上一步相同）、`OPENCLAW_REMINDER_CHANNEL=telegram`、`OPENCLAW_REMINDER_TO=<Telegram chat id>`，可选 `OPENCLAW_REMINDER_TIME`。
3. 重启 SMB 服务。设置 → 运行状态会显示「OpenClaw 每日提醒」的当天状态；页面和 MCP 都不会显示 hook 地址或令牌。

Gateway 只监听本机回环地址；WSL 需使用 mirrored 网络（或能从 Windows 访问 WSL 的 18789 端口）。

## 6. Windows 自动启动

先手动验证生产服务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-production.ps1
```

确认 `https://money.example.com` 可访问后，关闭手动进程并注册登录任务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup-task.ps1
```

任务只在当前 Windows 用户登录后运行，窗口隐藏，失败后每分钟重启。Cloudflare Tunnel 使用它自己的 Windows 服务，不与应用任务混在一起。

## 7. 备份

按照 [恢复指南](RECOVERY.md) 配置 `age` 和 `rclone`。应用每天 03:00 后生成一次一致快照并做 `PRAGMA integrity_check`：

- 本地仅保留最新 14 份 SQLite 快照。建议用 `BACKUP_LOCAL_DIR` 把快照放到与账本不同的物理硬盘。
- Google Drive 仅保存 `.sqlite.age` 加密文件，保留最新 30 份。必须使用自己的 Google OAuth 桌面客户端（见恢复指南），rclone 的公用 client_id 正在停用且额度经常耗尽。
- rclone 不读取 Windows 系统代理。若本机访问 Google 需要代理，在 `.env` 中设置 `HTTPS_PROXY` 与 `NO_PROXY=127.0.0.1,localhost`；SMB 自身不使用它，只会传给 rclone。
- 上传失败不影响本地快照，当天不会重试，第二天随下一次备份再上传。
- 数据库迁移前额外生成并校验一份本地快照。

## 8. 上线验收

- 未授权邮箱无法通过 Access；浏览器开发者工具中看不到 MCP 令牌或备份密钥。
- 局域网其他设备无法用笔记本 IP 加 `:8788` 访问，但可以通过 HTTPS 域名访问。
- Windows、Linux 浏览器以及 Android Chrome 均可安装 PWA。
- 重启 Windows 并登录后，应用任务与 Tunnel 服务会自动恢复。
- 在 1440×900、1024×768 和 412×915 下分别切换“分类明细/分类构成”：两个面板必须互斥。明细显示名次、本期金额、上期同进度金额和涨跌幅；进行中的月份环比卡片写「较上月同期」并标出实际上期日期（例如 9 月 1 日为 `8月1日–8月1日`），不是「环比整个上月」。构成完整显示全部有金额分类、金额和占比，且占比合计为 100%。
- 账单页应直接显示“最近录入、月账单、年账单、回收站”四个平级入口；回收站跨月份按删除时间倒序，月、年网址参数和洞察分类下钻保持兼容。搜索能按备注、分类名或金额找到账目，切到「全部时间」后跨月份返回结果；「导出当前视图」下载的 CSV 与列表筛选一致。
- 手机底栏显示洞察、账单、事项、资金和记一笔；滚动洞察页后，吸顶期间栏收成一行，点「月 · 支出」可展开切换。
- 洞察趋势图可切换「每日 / 累计」，累计视图同时画出上期同期累计虚线。标为固定支出的分类按实际计入「预计月底」，不会因为月初交房租就提示“预计超预算”。
- OpenClaw 在 `direct` 模式下可以直接新增、修改、删除并撤销账目；重复 `requestId` 不会产生重复账。明确要求先确认时仍可走原有待确认流程。
- “事项”可以新增两笔同一借款人的独立借款、记录部分还款并正确汇总余额；订阅到期后不会自动生成付款，记录续费后才推进下一日期。
- 计划录入不绑账户；无金额完成只改状态；有金额完成必须创建或关联支出，资金启用后必须选择支付账户。
- 未主动建立普通账目关联时，借款、订阅和未完成的计划不会改变洞察或月账单。人民币关联金额必须一致，美元订阅创建账目时使用实际人民币扣款金额。
- 完整 JSON、借款、订阅、计划、账户流水与转账 CSV 均可导出；恢复演练会核对资金表并确认临时写入、读回与清理后余额一致。
- 完成资金追踪向导后，新账必须带账户；转账本金与校准不进入收支，手续费只扣一次，全额退款（在账目编辑弹窗里）会排除原账统计并恢复账户余额。余额为 0 或负数的账户可以改名和校准；资金流水每行写明来源，修改产生的差额带「修改差额」标签。
- 资金启用日若存在旧账，逐笔确认它们没有被重复计入账户流水；初始余额与账户流水相加后的结果必须等于现实余额。
- 下载一份 Drive 加密备份，按恢复指南解密并通过完整性检查。

## 官方参考

- Cloudflare Tunnel（Windows 服务）：https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/windows/
- Cloudflare Access 路径规则：https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- Cloudflare OTP：https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- Cloudflare Service Token：https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- OpenClaw MCP：https://docs.openclaw.ai/cli/mcp
- rclone Google Drive：https://rclone.org/drive/
