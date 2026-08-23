# Changelog

All notable SMB changes are recorded here. The version in `package.json` is canonical.

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
