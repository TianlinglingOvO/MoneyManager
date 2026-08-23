# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the React/Vite PWA. `InsightsPage.tsx` owns `/`; `/analytics` redirects there. `BillsPage.tsx` owns the flat recent, monthly, and yearly bill views.
- Reuse shared components in `src/components/`; keep Recharts imports inside lazy-loaded `FinanceCharts.tsx`.
- Keep category composition filtering, percentage calculation, and adaptive sector spacing in `src/category-composition.ts`; do not duplicate those rules in page components.
- `src/appearance.tsx`, `src/device-background.ts`, and `src/ledger-clock.tsx` own appearance, local backgrounds, and ledger date. Tokens and responsive layouts live in `src/styles.css`.
- `server/` contains app services; `server/funds.ts` owns accounts, movements, transfers, adjustments, refunds, reconciliation, and funds exports. `server/matters.ts` owns borrowers, loans, repayments, subscriptions, payments, ledger links, and matter exports. `server/budgets.ts` owns budget aggregates and `server/health.ts` owns deterministic ledger checks. `shared/` holds Zod schemas/types; `db/` holds migrations; `tests/` holds coverage.
- `shared/app-metadata.ts` exposes the external SMB brand and reads the canonical version from `package.json`. Editable brand SVGs and generated PWA icons live in `public/`; regenerate PNGs with `scripts/build-brand-assets.ps1`.
- Treat `data/`, `backups/`, `.env`, `output/`, `dist/`, and `dist-server/` as generated or private.

## Build, Test, and Development Commands

Use Node.js 22+; prefer `npm.cmd` on Windows:

- `npm.cmd run dev`: start API and Vite.
- `npm.cmd test`: run Vitest once.
- `npm.cmd run typecheck`: validate browser and server TypeScript.
- `npm.cmd run build`: create production output; `npm.cmd start` serves it.
- `npm.cmd run backup:snapshot -- <label>`: create and integrity-check a pre-deployment SQLite snapshot.
- `npm.cmd run backup:verify-restore -- [snapshot]`: restore a snapshot in a disposable directory, boot an isolated service, compare counts, and recheck SQLite.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, semicolons, and double quotes. Use `PascalCase` for components/types and `camelCase` for functions/variables. Prefer `@/` and `@shared/` imports. Validate with Zod and store currency in integer minor units. Extend semantic CSS tokens; preserve 44px mobile targets, visible focus, WCAG AA, and `prefers-reduced-motion`.

## Architecture & Safety Invariants

- SQLite is authoritative. Browser storage may contain appearance, device layout, scroll/filter state, and device-only images, but never ledger copies or amount/note drafts.
- `localDate` is the occurrence date; `createdAt` is recording time. Period boundaries, “today,” AI defaults, and relative dates must use `LedgerClock` from `/api/v1/settings`, not the browser timezone.
- Matters are statistically separate from the ledger. Only an explicit `LedgerLink` may create or reference a transaction; that transaction and the matter never synchronize afterward. CNY loan links must match amount and kind, while USD subscription links represent the actual CNY charge.
- Funds tracking is opt-in. Never backfill or require accounts for records before `funds_started_on`; post-activation effective income/expense records require an active CNY account.
- Account balance is opening balance plus append-only `account_movements`. Never add or mutate a separate balance field. Business edits, account changes, soft delete/restore, refunds, loans, repayments, subscription payments, transfers, and undo must reconcile movements in the same SQLite transaction.
- Transfers and adjustments never affect income, expense, budgets, or charts. A transfer moves credited principal and records only the debit-credit difference as one expense fee. Full refunds preserve the original transaction, exclude it from statistics, and append compensating movements; partial refunds remain unsupported.
- Funds-aware loans and repayments change account cash and receivables without creating ordinary income/expense entries. USD subscription payments require the actual CNY charge, an expense category, and a payment account.
- Accounts accept normalized exact IDs, names, or aliases for OpenClaw; ambiguous references must fail. An account cannot be archived while nonzero, default, or actively referenced, and only an account with no funds history may be permanently deleted.
- Loan repayments belong to one loan and cannot exceed its outstanding amount. Subscription renewals never advance automatically: only a recorded payment advances the anchored month/year/custom cycle. Keep CNY and USD summaries separate.
- New-loan UI must use the searchable in-app borrower picker. Creating a new borrower and its first loan is one matter transaction; normalized active names are reused and archived names must be restored explicitly.
- Preserve soft-deleted borrowers, loans, repayments, subscriptions, and payments for 30 days. Full JSON and matter CSV exports must not silently stop at the API page limit.
- Keep matter writes and optional ledger creation in one SQLite savepoint/transaction. OpenClaw matter writes require `direct` mode, a unique `requestId`, version checks, and reversible operation snapshots.
- Budgets are independent per natural month, use integer CNY minor units, never roll over, never block entries, and remain statistically separate from matters. Archived categories may retain unchanged budget values but cannot receive new ones. Merge category budgets on category migration.
- Ledger health rules must remain deterministic and read-only. Acknowledgements store only rule fingerprints and timestamps. Neither health MCP results nor health explanations may receive transaction notes. Ordinary AI analysis defaults to no notes; never add a persistent note-consent preference.
- Browser transaction writes require `expectedUpdatedAt` and same-origin validation. MCP Service Token requests remain isolated under `/mcp`.
- OpenClaw batch entry is all-or-nothing, accepts at most 20 explicit transactions, uses one `requestId`, and produces one reversible operation. Never infer missing amount, date, kind, or category.
- All OpenClaw proposal writes require a unique `requestId` and stable request hash. Same-ID replays return the original proposal; different content conflicts. Operations left `running` for over 15 minutes become `failed` with a sanitized reason.
- Persistent SQLite databases use WAL plus `synchronous=FULL`. Snapshots and pre-migration backups must pass both `integrity_check` and `foreign_key_check`. Status exposes local, remote, and restore-verification timestamps/states, never paths, commands, or credentials.
- Keep insight period/kind in shareable URL parameters. Preserve drill-down return context and bill scroll/filter state.
- Keep insight category panels mutually exclusive: detail shows rank, amount, and period change; composition shows every current positive-value category in the donut and legend with amount, share, and drill-down. Never collapse categories into an `other` slice.
- Keep bill navigation flat and URL-compatible: `/bills` is recent, `view=ledger&period=month` is monthly, `view=ledger&period=year` is yearly, and `view=trash` is the global period-independent trash. Never persist trash mode in session state or inherit it during insight drill-down.
- A normal transaction delete is always soft. Permanent transaction deletion is allowed only from trash with `updatedAt` conflict protection. Category purge requires a fresh impact revision plus exact-name confirmation, removes all category transactions atomically, detaches matter links, rejects affected pending proposals, and invalidates related undo snapshots. It is deliberately non-undoable; do not add a bulk “empty trash” action.
- Shared sheets/dialogs are centered with at least 32px viewport clearance above 900px and become full-width bottom sheets at 900px or below. Keep their header and footer fixed, scroll only the body, hide the drag handle on desktop, and preserve Android safe-area/back behavior.
- Shared sheets/dialogs must manage and restore focus, support Escape/Android back, use content-specific close labels, and confirm before discarding dirty forms. Background polling must not replay entry animations.
- Health-check drill-down actions must close the current sheet before opening another sheet or navigating. Root budget warnings open the matching `BudgetSheet`; category budgets, transactions, subscriptions, and foreign-key findings use explicit destinations.
- Matters badges count subscription attention only. Mirror the same count on the subscription tab, default new Matters visits to subscriptions while attention exists, and never force-switch a user already viewing loans.
- Keep the budget category adder as a themed in-app picker with keyboard focus return; do not regress it to an OS-native select whose popup ignores Ink Night tokens.
- Keep motion centralized in `src/motion.ts`: micro feedback is 120–160ms, panels/routes are 220–280ms, trend charts are 800ms, and donut charts are 900ms. Start chart motion only after matching non-placeholder data arrives, play it once on session entry or deliberate user changes, and disable both CSS and Recharts animation for `prefers-reduced-motion`. Recharts completion must use its lifecycle callbacks; never stop chart animation with a wall-clock timer.
- Personal image bytes stay in IndexedDB. OpenClaw cannot modify appearance. Never log credentials, notes, amounts, or sensitive request bodies.
- The in-app boot splash is decorative, pointer-free, session-once, shorter than 800ms, and skipped for `prefers-reduced-motion`; it must never delay data initialization or replay on routing/background refresh.
- Keep `/api`, `/auth`, `/cdn-cgi`, and `/mcp` outside PWA navigation caching.
- The external product is `SMB — Sutady Moneybook`, positioned as `私人账本`. The mark always uses `#291D3A`, `#F06B55`, and `#FFF3E4`; themes must not recolor it. Keep domain, database paths, environment variables, Cloudflare configuration, MCP name `sutady-money-manager`, cache keys, and export format unchanged.
- `package.json` is the only version source. Increment patch for fixes/polish, minor for backward-compatible features, and major for product identity or incompatible contracts. Health, status, settings, and MCP metadata must import the shared version instead of hard-coding it.

## Testing & Change Review

Name tests `*.test.ts` or `*.test.tsx`; use Supertest and React Testing Library. Cover precision, authorization, timezone boundaries, URL state, sorting, focus behavior, undo conflicts, and mobile layouts. For visible changes, inspect 1440×900, 1024×768, and 412×915; assert dialog bounding boxes, edge clearance, handle visibility, fixed actions, and 44px mobile targets instead of relying only on semantic snapshots. Capture stable Playwright completion-state screenshots only after chart `data-animation-running` becomes `false`; keep comparison artifacts under `output/playwright/`. Then run tests, typecheck, and build.

Use imperative commits such as `Refine insights navigation`. PRs should describe behavior/data changes, verification, migration/configuration impact, and screenshots. Maintain local Git history on `main`; never configure or push a remote without explicit authorization. Back up production SQLite before deployment; never commit databases, backups, tokens, keys, or `.env`.
