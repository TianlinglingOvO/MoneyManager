# Changelog

All notable SMB changes are recorded here. The version in `package.json` is canonical.

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
