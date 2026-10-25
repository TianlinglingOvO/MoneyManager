# Changelog

All notable SMB changes are recorded here. The version in `package.json` is canonical.

## 2.9.1 — 2026-10-25

### Bills

- The category filter is an in-app list instead of the browser's native select, whose popup ignored the theme and whose arrow sat off-centre. It follows Warm Paper and Ink Night, shows each category's icon chip, groups options under 支出 and 收入 when 全部 is selected, lists archived categories last with a 已停用 tag, and highlights the trigger while a category filter is active. On desktop it floats over the list and opens upwards when there is no room below; in the phone filter sheet it opens inline as a two-column list. Arrow keys, Home/End, and Escape work as in the account picker, and Escape closes only the list, not the sheet. Tab moves on to the next control and Shift+Tab returns to the filter, and the list closes whenever focus leaves it. A category passed in the URL reads 已选分类 until the categories load, instead of 全部分类.

### Fixes

- Settings shows a UTC ledger timezone as “UTC” again. The ICU data in Node.js 22.23.4 writes a zero offset as `GMT+0`, so the label read “UTC+0”.

### Security and dependencies

- Updated runtime dependencies for published advisories: `@modelcontextprotocol/sdk` 1.32.2 (request-validation memory exhaustion, among others), `express` 5.3.0 with `body-parser` 2.4.0 (compressed-body DoS), `proxy-addr` 2.0.8, and `qs` 6.16.1, plus `zod` 4.6.7, `express-rate-limit` 8.7.1 with `ip-address` 10.7.5, and `fast-uri`/`hono` under the MCP SDK. `npm audit --omit=dev` now reports no issues.
- Dev-only advisories remain in `vite`, `vitest`, and the `drizzle-kit`/`drizzle-orm` schema tooling; none of them ship in `dist-server` or run in production.

### Upgrade notes

- Run SMB on a Node.js release that includes the 2026-10-21 security fixes (22.23.4, 24.22.1, 26.12.1, or later). They patch a Brotli decoder out-of-bounds write (CVE-2026-111497) that Express request-body decompression and `fetch` can reach, plus TLS hostname-check bypasses.
- `dist-server` loads its packages from `node_modules` when the process starts. After `npm.cmd run build`, Settings → 检查并刷新 restarts onto 2.9.1, which also loads the updated dependencies.

## 2.9.0 — 2026-10-12

### Fixes

- Accounts with a zero or negative balance can be renamed, edited, and calibrated again. The balance fields used the entry-amount parser, which rejects anything not above zero, so a ¥0.00 account failed to save with “请输入当前余额”, calibrating to 0 was impossible, and a negative opening balance in the activation wizard was silently saved as 0.
- “查看/隐藏停用账户” and deleted transfers work again. The server parsed `?includeArchived=false` and `?includeDeleted=false` with `z.coerce.boolean()`, which turns the string `"false"` into `true`, so archived accounts and deleted transfers always showed. Query flags are now true only for `true` or `1`. Deleted transfers have their own “显示已删除” switch in the transfer list.
- Closing an untouched 记一笔 sheet no longer asks “放弃这次修改？”. The dirty check compared two JSON strings built with different key orders, so it always saw a change.
- Cancelling a subscription no longer makes it disappear. It acts immediately with an undo toast, and cancelled subscriptions stay listed under a collapsible 已取消 group where they can be reactivated. Paused subscriptions no longer count as due.
- Switching 记一笔 to 收入 picks the default income account unless you already chose one.
- “今天/昨天” in bill groups follow the ledger timezone instead of the device clock.
- Every editable sheet now asks before discarding unsaved input: loans, repayments, subscriptions, renewals, plans, plan completion, transfers, calibration, and categories.
- Matter lists load every page, so borrowers past 30 and loans, subscriptions, or plans past 100 no longer drop off silently.
- Several inline text buttons (查看停用账户, 显示字段值, and others) rendered as grey browser-default buttons; `.text-button` now has a base style and keeps 44px targets on phones.

### Budgets and ledger health

- New **固定支出** flag on expense categories (migration 12). The month-end forecast counts fixed categories such as rent as recorded and extrapolates only the other spending per elapsed day, so paying rent on the 5th no longer predicts a budget overrun. The budget sheet and Settings explain the forecast.
- Large-expense findings flag a fixed category only when the amount is at least 1.5× its usual payment; other categories keep the existing rules, and a large expense found only by the 20%-of-budget rule suggests marking the category as fixed.
- Health text formats money with thousands separators (`¥3,200.00`) and spaces Latin names (`Netflix 即将续费`).

### Insights

- The summary card adds the other kind and the balance (`收入 ¥… · 结余 ¥…`).
- The trend card switches between 每日 and 累计; the cumulative view draws the previous period's same-progress total as a dashed line. The choice lives in the URL (`trend=cumulative`). Axis labels keep thousands separators.
- The overview counts match their breakdowns: health lists 需要处理, 建议核对, and 提示; renewals separate 待确认 (billing date reached) from 即将续费 and name the next one; plans show 需留意 versus 未完成.
- 回到本月/本周/今年 appears when viewing another period. On phones the pinned bar condenses to one row after scrolling; tap 「月 · 支出」 to expand it.
- Percent changes use the true minus sign, and a signed amount never wraps away from its number.

### Bills and entry

- Search matches the note, the category name, or an exact amount (`35`, `35.5`), and can widen from 本月 to 全部时间.
- The month and year card merges the period switcher with the income/expense/balance strip; phones show the three totals in one row and hide the page description. “导出当前视图” downloads a CSV of the filtered list (`GET /api/v1/transactions.csv`); full exports stay in Settings.
- 全额退款 moved from every row into the transaction edit sheet. A refunded entry is locked until 撤销退款, and refunding an untracked entry asks for a CNY account (USD accounts are no longer offered).
- Account names show as a small chip instead of “账户：微 微信”. 最近录入 metadata wraps between segments, never inside a date.
- 记一笔 adds 保存并再记一笔, which keeps the kind, category, date, and account. On phones the date shortcuts share one row with the date picker, so the note field is visible above the save bar.

### Funds

- Phones get a 资金 tab in the bottom bar.
- Each movement names its source (category and note, transfer route, or borrower) and tags follow-up appends as 修改差额, 冲销, or 恢复; tapping a row opens the transaction or transfer. Tapping an account card filters the movement list to that account.
- The transfer form uses the in-app account picker. Account cards stack name, balance, and actions below 1280px so names stay visible.

### Categories, settings, and OpenClaw

- Category add/edit and 分类处理 use the shared sheet (Escape, Android back, focus return, unsaved-change prompt). Icons have quick suggestions, rows show a 固定 badge, and reordering writes the whole order in one request (`PUT /api/v1/categories/order`).
- Enabling OpenClaw direct mode and undoing an operation now ask first. Proposals show the target entry and a before → after list instead of an ID; operation types read as “账目 · 新增”. Removed the outdated “AI” from the direct-mode description.
- MCP: `direct_create_category` and `direct_update_category` accept `isFixed`, and undo restores it; `list_transactions`, `get_budget_summary`, and `get_subscription_summary` describe the new search, forecast, `confirmCount`, and `monthlyEquivalent` fields.
- Removed the unused `/api/v1/dashboard` endpoint.

### Upgrade notes

- Migration 12 adds `categories.is_fixed` (default off) and runs on the next service start after a verified pre-migration snapshot. Mark rent, insurance, or other monthly fixed categories in 分类 afterwards.
- `npm.cmd run build` updates the served web files before the service reloads; use Settings → 检查并刷新 right after building so the page and the API match.

## 2.8.1 — 2026-09-29

- Fixed: page backgrounds and personal wallpapers disappeared in 2.8.0. The new fixed background layer sat underneath `body`'s own background colour; `body` now isolates its stacking context so the layer paints above it and below all content. A stylesheet test guards the layer.
- Category management moved out of Settings into its own **分类** page (`/categories`), listed under 资金 in the sidebar and as an icon in the phone header. The entry sheet's “去添加分类” link opens it. Settings now covers appearance, budget, status, backup, and connections.

## 2.8.0 — 2026-09-29

### Settings

- Themes are now 温暖纸张, 墨夜, and a new 跟随系统 (`auto`) that follows the device's light/dark mode, live and when the app returns to the foreground. The near-identical 瓷白 and 鼠尾草账本 themes were retired; saved or cached values fold into 温暖纸张 without losing the accent or background.
- The desktop density switch is gone; it only shortened a few desktop rows and showed no change on the Settings page. Older clients that still send `density` are accepted and ignored.
- The ledger timezone is shown read-only in 运行状态 (for example `UTC+8` · `Asia/Shanghai`). Change it through OpenClaw if you ever need to; first-run initialization still sets it automatically.

### Insights

- Period, 周/月/年, and 支出/收入 live in one bar that stays pinned at the top while scrolling, so you can switch them from the category breakdown. The period label is the page heading.
- Wide screens (≥1280px) use two columns: trend and category breakdown on the left; one compact overview list (budget, health, funds, receivables, renewals, plans) plus recent entries on the right. The six separate cards are gone. Narrow screens keep the overview right below the summary.
- The category donut eases out instead of moving linearly, the breakdown panel only fades in while the donut grows, chart data is memoized so background refreshes don't re-render it mid-animation, and sector highlights no longer use SVG filters.
- Page backgrounds, including personal images, render on a fixed composited layer instead of `background-attachment: fixed`, avoiding full-page repaints while scrolling or animating.

### Plans

- Removed the 有日期/无日期 switch. It was meant for phones, but a CSS ordering bug showed it on desktop, where both columns are already visible. Desktop keeps two columns; phones stack dated then undated plans.

### Backup

- New `配置Google Drive授权.cmd` / `scripts/set-drive-client.ps1`: connects the `money-drive` rclone remote with the owner's own Google OAuth desktop client (`drive.file` scope). It checks the client secret with Google before opening the browser, waits for a newly created secret to take effect, and verifies afterwards that the token was issued to that client. rclone's shared client_id is being retired and often runs out of quota.

### Maintenance

- Removed styles for the retired dashboard hero, metric cards, today card, quick-record button, trash toggle, three-tab switcher, proposal banner and other markup that no longer exists, plus unused exports and imports. `typecheck` now enables `noUnusedLocals` so unused imports fail the gate.
- Test contexts blank the backup upload and OpenClaw hook settings from `.env`, so running tests on a configured machine never uploads to Google Drive or calls OpenClaw.
- Insights UI tests allow 15 seconds for the first Recharts load when the full suite runs in parallel.

## 2.7.0 — 2026-09-27

### Removed: built-in AI analysis

- The AI page, the header AI button, and the health sheet's “让 AI 解释” button are gone. Old `/ai` links redirect to the insights page. Analysis is now OpenClaw's job: it reads the same deterministic numbers through the read-only MCP tools (`get_finance_summary`, `list_transactions`, `get_budget_summary`, `get_ledger_health`, matters summaries).
- Removed the DeepSeek service, `/api/v1/ai/*` and `/api/v1/reports/health/explain`, the MCP tools `direct_generate_ai_analysis` and `list_ai_analyses`, the DeepSeek entries in status/settings, `配置DeepSeek密钥.cmd`, and `scripts/set-deepseek-key.ps1`. `DEEPSEEK_*` variables are now ignored.
- The `ai_reports` table and its existing rows are kept untouched; there is no migration.

## 2.6.0 — 2026-09-24

### OpenClaw daily reminder

- New opt-in `OpenClawReminderService`: once per ledger day after `OPENCLAW_REMINDER_TIME` (default 09:00, ledger timezone), SMB counts subscriptions needing renewal confirmation and due/overdue plans. Only when something is pending does it call the OpenClaw Gateway `/hooks/agent` endpoint, with a dedicated hook token and a per-day `Idempotency-Key`. The message carries counts only; OpenClaw reads details through the read-only MCP tools and delivers a short reminder to the configured channel.
- Failed hook calls retry on later checks (at most 6 per day). The feature is off unless `OPENCLAW_HOOK_URL`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_REMINDER_CHANNEL`, and `OPENCLAW_REMINDER_TO` are set.
- Settings → 运行状态 and MCP `get_app_status` show the reminder state without the hook address or token.

### MCP

- Every MCP tool now declares safety annotations: `get_`/`list_` tools are read-only, delete/permanent/undo tools are destructive, and other `direct_` writes are idempotent via `requestId`. Clients such as OpenClaw can auto-allow lookups instead of prompting for every call. Tool names and schemas are unchanged.

### Mobile

- In mobile browsers (Chrome without installing the PWA), the bottom navigation no longer slips below the screen on first load: the document no longer scrolls behind the app shell, and the shell height follows the measured viewport.
- The 事项 badge sits on the icon instead of falling below the navigation bar.

## 2.5.4 — 2026-09-24

### Interaction

- Every remaining browser-native `window.confirm` is gone. Refund / undo-refund, transfer delete, and category migrate-then-delete use the in-app confirm sheet; deleting a monthly budget asks inside the budget sheet.
- Closing a dirty budget or account form shows the in-sheet “放弃这次修改？” prompt (Escape, backdrop, close button, and Android back). Escape or 继续编辑 returns to the form.
- Moving a transaction, loan, repayment, subscription, or subscription payment to trash happens immediately and shows a toast with **撤销** for 6 seconds (paused while hovered or focused). Plans keep their existing confirm sheet; permanent deletes keep explicit confirmation.
- Saving a transaction or closing a matter, transfer, adjustment, account, or category form no longer waits for every page query to refetch; data refreshes in the background.

### Insights

- The 近期续费 card no longer labels not-yet-due subscriptions as “近期需要确认”. It shows 待确认续费 only for due or overdue renewals, otherwise the total subscription count.

## 2.5.3 — 2026-09-01

### Insights

- Same-progress comparison is unchanged: a month in progress is compared with the matching days of the previous month, not the whole previous month.
- The summary card now says **较上月同期** (or week/year equivalents) and shows the actual previous date range, e.g. `8月1日–8月1日`.
- Category detail rows show the previous-period amount next to the percentage so a +200% change is readable against last period’s ¥10.00.
- Finance reports use the ledger timezone’s today instead of the process clock.
- Documented the same-progress labels in AGENTS, deployment acceptance, the roadmap, and the OpenClaw `get_finance_summary` tool description.

## 2.5.2 — 2026-08-29

### Operations

- Settings **检查并刷新** now reloads the local Node process when a newer production build is already on disk, then updates the PWA. `打开 SMB.cmd` / `npm start` / `start-production.ps1` run a supervisor so that restart does not require closing the SMB Service window.
- The first time this version is installed, the SMB Service still needs one manual restart so the supervisor and reload API are loaded. After that, the button keeps the running service aligned with `dist-server`.
- Reload does not compile source. Change code, run `npm.cmd run build`, then tap 检查并刷新. Unsupervised processes (including `tsx` dev) only refresh the webpage.
- Status exposes whether the launcher is supervising the process, without paths or commands.

## 2.5.1 — 2026-08-29

### Ledger health

- Budget warning fingerprints now use month, scope, and near/over band instead of spent or forecast amounts, so acknowledging an overspend survives later entries in the same band. Crossing from near-limit to overspend still creates a new finding.
- The health sheet lists only unacknowledged issues. Acknowledged items stay in the API payload and as a count, but no longer occupy the list.

### Funds

- Recent movements default to occurrence date descending. The funds page uses a fixed-height scrolling list with “load more”, so newer dates are no longer hidden behind the first page of oldest rows.
- Full JSON / CSV funds dumps keep creation order for archival stability.

### Plans

- The plans tab splits **未完成** and **已结束**. On desktop, open plans are two columns (dated | undated); on mobile they switch with a segmented control.
- Completing a plan without an amount, and moving a plan to trash, use in-app sheets instead of the browser `confirm` bar.

### Appearance

- Desktop ranking rows in Insights 分类明细 are larger from 901px. From 1200px the UI type tokens bump one pixel and the main column uses a bit more of the leftover side space, without filling the whole viewport.

## 2.5.0 — 2026-08-27

### Plans

- Added a one-shot **计划** tab under Matters for preorders, remaining payments, and undated financial follow-ups that do not belong in subscriptions.
- Creating a plan records title, optional due date, optional CNY amount, and reminder days. It does not bind an account or write the ledger.
- Completing a plan without an amount only marks it done. Completing with an amount requires creating or linking an expense, and after funds activation also requires a payment account (foreign accounts still need the actual `accountAmount`).
- Reminder attention appears on the plan tab, the Matters nav badge (subscription + plan), the Insights summary card, and health `plan_due` findings.
- OpenClaw can list, create, update, complete, delete, and restore plans in direct mode with `requestId` and reversible snapshots. Confirm mode stays query-only.
- Added migration 11 (`plans`) and `/api/v1/export.plans.csv`. Full JSON export includes plans without stopping at the page limit.
- Clarified that Settings “检查并刷新” only updates the PWA cache; API and migration upgrades still require restarting the local Node process. The Matters nav badge now names subscription and plan attention separately.

## 2.4.2 — 2026-08-27

### Reliability

- Returned JSON-RPC errors for malformed `/mcp` JSON, missing or stale MCP sessions, and GET/DELETE session failures instead of the generic HTTP 500 page copy.
- Logged only the HTTP method, path, and error name for those failures, without request bodies, amounts, notes, or tokens.

## 2.4.1 — 2026-08-26

### Funds activation baseline and currencies

- Added migration 10: activation snapshots existing transactions into `funds_baseline_transactions`, accounts store `CNY`/`USD`/`USDT`, and ordinary entries can keep a separate foreign `accountAmount`.
- Same-day records that already existed at activation stay baseline: no required account, no movements, and no missing-account health finding. New records after activation still require an account.
- Health reports one aggregated missing-account issue per month with related IDs; the health sheet can preview net funds impact and batch-assign a CNY account.
- Ledger amount remains CNY. Foreign-account writes must supply the actual foreign debit or credit and must not infer an exchange rate.
- Added the in-app account picker, dual-amount entry, and funds missing-account review in the health sheet.

### Packaging

- Replaced production hostnames in deploy templates with `money.example.com` and removed the obsolete `打开寸金记账.cmd` launcher alias.

## 2.3.0 — 2026-08-23

### Lightweight funds tracking

- Added opt-in CNY accounts whose balances are derived from opening balances and append-only movements rather than a mutable balance field.
- Added account aliases, transfers with explicit fees, balance adjustments, transaction account assignment, full refunds, and refund undo.
- Kept transfers and adjustments outside income, expense, charts, and budgets; refunded transactions are excluded while their original records remain visible.
- Integrated post-activation loans, repayments, and subscription payments with funds while preserving all pre-activation history.

### Reliability and automation

- Added migration 9, funds-aware complete JSON and CSV exports, restore verification, and deterministic health findings for missing, orphaned, duplicated, or unbalanced money movements.
- Added OpenClaw account, funds summary, transfer, adjustment, refund, and refund-undo tools with exact account resolution, idempotent request IDs, snapshots, and reversible operations.
- Added the responsive Funds page, activation wizard, account management, movement history, transfer editor, ledger account labels, and refund actions.

### Known 2.3.0 limitation

- Funds activation currently stores only the ledger date. The health check can therefore report pre-existing transactions from the activation day as missing an account, and it emits one finding per transaction. Do not attach those historical records blindly when their effect is already included in opening balances; the activation baseline and grouped review flow are scheduled for 2.3.x maintenance.

## 2.2.1 — 2026-08-23

### Borrower picker

- Changed the borrower search results from an absolutely positioned overlay to an inline, independently scrolling panel.
- Preserved keyboard dismissal, archived-borrower recovery, fixed sheet actions, and responsive desktop/Android behavior.

## 2.2.0 — 2026-08-23

### Trustworthy OpenClaw loop

- Made all three pending-proposal MCP writes require an idempotent `requestId`; retries return the original proposal and conflicting reuse is rejected.
- Added on-demand operation details with changed-field summaries, deliberately folded snapshots, safe failure reasons, and startup recovery for operations left running longer than 15 minutes.
- Added the read-only `get_ledger_health` MCP tool and contract coverage for write IDs, optimistic versions, and permanent-delete confirmations.

### Loan and ledger reliability

- Replaced the split borrower controls with one searchable, keyboard-accessible picker that can reuse active names or restore archived borrowers.
- Made new-borrower plus new-loan creation one atomic SQLite operation.
- Added future-date and near-duplicate OpenClaw findings to the deterministic ledger check; the check remains read-only and does not return notes.
- Changed persistent SQLite writes to WAL plus `synchronous=FULL`.

### Privacy and backup observability

- Kept transaction notes out of DeepSeek requests and separated no-note report caching; note transmission remains blocked until the user gives a separate explicit privacy approval.
- Added foreign-key verification to local snapshots and pre-migration backups.
- Split settings status into local snapshot, encrypted remote upload, and isolated restore verification without exposing paths or credentials.
- Extended the restore drill to compare table identity summaries and create, read, soft-delete, and permanently remove a test transaction inside the disposable service.
- Added migration 8 for proposal request identities, AI note-policy metadata, and explicit failed OpenClaw operation state.

## 2.1.2 — 2026-08-22

### Interaction reliability

- Fixed ledger-health actions so budget warnings open the matching budget editor and other findings drill down only after the health dialog has closed.
- Clarified that Matters badges belong to subscriptions, mirrored the count on the subscription tab, and defaulted new Matters visits to subscriptions only while attention is required.
- Replaced the native budget-category select with a theme-aware, keyboard-accessible in-app picker that remains legible in Ink Night.

## 2.1.1 — 2026-08-22

### Interface reliability

- Restored centered desktop dialogs while keeping Android bottom sheets, safe areas, drag-to-close, and system back behavior.
- Separated dialog headers, scrolling bodies, and action footers so long budgets, health reports, and matter forms no longer clip their controls.
- Fixed stretched health-check actions, misleading close labels, initial focus, dirty-budget close protection, SPA drill-down, and operation feedback.
- Moved production `NODE_ENV` setup out of Vite-loaded environment files to remove the build warning without changing secrets.

## 2.1.0 — 2026-08-21

### Product

- Added independent monthly total and expense-category budgets with progress, forecast, drill-down, conflict protection, and OpenClaw undo.
- Added deterministic ledger health checks for suspected duplicates, unusual large expenses, budget risk, subscriptions awaiting confirmation, and foreign-key issues.
- Added an installed-PWA “记一笔” shortcut and atomic OpenClaw batch entry for up to 20 transactions.

### Reliability and security

- Added `updatedAt` conflict protection to ordinary browser edits and deletes.
- Added same-origin validation for browser writes while preserving Cloudflare Service Token MCP access.
- Added isolated restore drills that boot a temporary SMB service from a snapshot, compare core table counts, and rerun SQLite integrity checks.
- Added migration 7 for budgets, health acknowledgements, and budget-aware OpenClaw operation snapshots.

## 2.0.0 — 2026-08-21

### Brand

- Renamed the user-facing product to **SMB — Sutady Moneybook**, positioned as a private ledger.
- Introduced the fixed-color shared-skeleton SMB monogram, versioned favicon, regular PWA icons, and a dedicated maskable icon.
- Unified the desktop sidebar, mobile header, boot splash, browser metadata, connection messages, launcher, and settings version display.

### Product accumulated in 2.0

- Added warm/dark themes, device-only backgrounds, responsive insight-first navigation, and reliable chart motion.
- Added OpenClaw direct control with idempotency, conflict checks, audit history, and reversible operations.
- Added DeepSeek analysis, global trash and guarded permanent deletion, loans, repayments, subscriptions, renewals, and optional ledger links.
- Kept SQLite authoritative, Cloudflare Access protected, and PWA data caching separate from ledger records.

### Maintenance

- Established local Git history and a pre-rebrand baseline without adding a remote.
- Made `package.json` the single version source for health, status, settings, and MCP metadata.
- Removed obsolete unreferenced icon sources from production output and added brand asset generation and verification coverage.

## Versioning

- **Patch**: fixes, visual polish, and compatible maintenance.
- **Minor**: backward-compatible user features or API additions.
- **Major**: product identity changes or incompatible contracts.
