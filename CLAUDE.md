# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) is the authoritative list of domain and safety invariants: funds, matters, budgets, health, OpenClaw, UI and motion rules, and versioning. Read it before changing behavior. If you change an invariant, update `AGENTS.md`, `CHANGELOG.md`, and the relevant `docs/*.md` in the same change. This file adds only what `AGENTS.md` does not cover: commands, the production topology, and the operational hazards.

SMB — Sutady Moneybook is a single-owner personal ledger, and most of the docs and UI copy are in Chinese. Machine-specific notes, if any, live in the gitignored `CLAUDE.local.md`.

## Commands (Windows; use `npm.cmd`, Node 22+ for `node:sqlite`)

```powershell
npm.cmd test                                   # vitest run (all)
npm.cmd test -- tests/funds.test.ts            # single file
npm.cmd test -- tests/funds.test.ts -t "baseline"   # single test by name
npm.cmd run typecheck                          # browser tsconfig + tsconfig.server.json
npm.cmd run build                              # fonts → tsc → vite build → esbuild server to dist-server/index.js
npm.cmd run backup:snapshot -- pre-deploy      # integrity-checked SQLite snapshot into backups/local/
npm.cmd run backup:verify-restore              # restore latest snapshot into a temp dir and verify
```

There is no linter; `typecheck` is the static gate. Run PowerShell scripts in `scripts/` with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\<name>.ps1`, because the machine's execution policy blocks direct `.ps1` runs.

Tests never touch the real ledger. `tests/helpers.ts#createTestContext` builds a fresh temp-dir SQLite database with `authMode: "disabled"`. API tests use Supertest against `createApp(config, database)`.

## Dev and production share `.env`

On a deployed machine, `.env` is the production configuration: `AUTH_MODE=cloudflare`, `PORT=8788`, and `DATABASE_PATH=./data/money-manager.sqlite`, which is the real ledger. `server/config.ts` loads it through `dotenv/config`, so **`npm.cmd run dev` uses the same database and port as the running production service**:

- Port 8788 is normally already taken by the production service, so `dev:server` fails to bind. `vite.config.ts` hard-codes the proxy `/api` → `127.0.0.1:8788`, so `dev:web` on its own talks to the **production** API.
- Any server start, dev or prod, applies pending migrations in `db/migrations.ts` to whatever `DATABASE_PATH` points at. It takes a verified pre-migration snapshot first.
- With `AUTH_MODE=cloudflare`, direct localhost requests have no Access JWT and return 401.

`dotenv` does not override variables that are already set. To run a throwaway server, set `$env:AUTH_MODE`, `$env:DATABASE_PATH` (for example under `output/`), and `$env:PORT` in the shell first. Check with the owner before starting anything that could write to `data/money-manager.sqlite`, and prefer covering changes with tests.

Never read or print values from `.env` or `~/.openclaw/.env`. Key names are fine.

## Production topology (Cloudflare, OpenClaw)

```
Browser / Android PWA ──HTTPS──► Cloudflare Access app "web" (root hostname; email OTP; Allow = one email)
                                   │
OpenClaw (WSL) ──HTTPS /mcp──► Cloudflare Access app "mcp" (path /mcp; Service Auth = service token)
                                   │
                            Cloudflare Tunnel ──► cloudflared Windows service ──► http://127.0.0.1:8788 (Node)
```

- **Tunnel.** `cloudflared` runs as its own Windows service. For a dashboard-created (remotely managed) tunnel, the public hostname and ingress live in the Cloudflare Zero Trust dashboard, not in this repo. `deploy/cloudflared-config.yml.example` applies only to a locally managed tunnel. The Node server must keep listening on `127.0.0.1`; `validateProductionConfig` enforces the auth settings.
- **Access** has two apps with different Audience tags. The more specific `/mcp` path app overrides the root app. `server/auth.ts` verifies `Cf-Access-Jwt-Assertion` against `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`:
  - `createUserAuth` (all of `/api/v1`): audience `CF_ACCESS_AUD`, and the JWT `email` must equal `ALLOWED_EMAIL`.
  - `createMcpAuth` (`/mcp`): `Authorization: Bearer MCP_API_TOKEN` (constant-time compare, at least 32 chars in production) **and** a JWT with audience `CF_ACCESS_MCP_AUD`.
- **OpenClaw** runs in WSL and connects with `deploy/openclaw-money-manager.json` (streamable-http). It sends the Bearer token plus `CF-Access-Client-Id` and `CF-Access-Client-Secret` from `~/.openclaw/.env`. `scripts/configure-openclaw-wsl.sh`, launched by `配置OpenClaw凭据.cmd`, writes those values.
- **Coupled values.** Renaming the domain, recreating an Access app (which changes its AUD), changing the team domain, or rotating the service token or `MCP_API_TOKEN` requires matching updates in `.env` and/or `~/.openclaw/.env`, then a service restart. Changing any one side alone breaks login or MCP.
- Session expiry is handled by the `/auth/refresh`, `/auth/complete`, and `/auth/refresh-boot.js` routes in `server/app.ts`, together with the PWA. This is why `/api`, `/auth`, `/cdn-cgi`, and `/mcp` must stay out of service-worker navigation caching.
- Claude cannot see or change the Cloudflare dashboard. Don't guess its state. Treat `docs/DEPLOYMENT.md` as the intended configuration and ask the owner to check the dashboard when something doesn't match.

## Running and deploying production

- `打开 SMB.cmd`, `npm.cmd start`, and `scripts/start-production.ps1` all run `scripts/start-server.mjs`. It is a supervisor that spawns `dist-server/index.js` with `SMB_SUPERVISED=1` and restarts it when the child exits with code **82** (`RELOAD_EXIT_CODE` in `server/reload.ts`; the two values must stay equal). `scripts/install-startup-task.ps1` registers a Windows logon task. The tunnel is a separate Windows service.
- Deploy flow: `backup:snapshot` → `test`, `typecheck`, `build` → in the app, Settings → 检查并刷新 (`POST /api/v1/system/reload`, same-origin only), which restarts onto the new `dist-server` → confirm `http://127.0.0.1:8788/health` reports the `package.json` version. The reload never compiles; it only loads what `build` produced.
- Backups: a daily scheduler in production (`server/backup.ts`) writes local snapshots plus `age`-encrypted uploads to Google Drive via `rclone`. Restore steps are in `docs/RECOVERY.md`.

## Architecture

- **Server** (`server/`, Express 5, ESM, bundled with esbuild). `server/index.ts` loads config, opens the `node:sqlite` `DatabaseSync` singleton (`server/database.ts`: WAL, `synchronous=FULL`, ordered migrations from `db/migrations.ts`), and calls `createApp`. `server/app.ts` builds the domain services and wires all REST routes under `/api/v1` behind the rate limiter and `userAuth`. It also attaches `/mcp` and serves `dist/` with an SPA fallback.
  - The domain services are `repository.ts` (transactions and categories), `funds.ts`, `matters.ts`, `budgets.ts`, `health.ts`, `ai.ts` (DeepSeek), `backup.ts`, and `openclaw-control.ts`. Routes and MCP tools call the same service methods, so business rules belong in the services, never in route or tool handlers.
  - `db/schema.ts` (Drizzle) is only for `drizzle-kit`. The runtime uses raw SQL. Schema changes go in a new numbered entry in `db/migrations.ts` and need a matching update to the "current version" in `AGENTS.md`.
- **MCP** (`server/mcp.ts`). `attachMcpRoutes` keeps one `StreamableHTTPServerTransport` per `mcp-session-id`, and `createLedgerMcpServer` registers about 77 tools. `openclaw-control.ts` owns the `confirm`/`direct` mode, proposals, `requestId` idempotency and request hashes, reversible operation snapshots, and the 15-minute stale-operation sweep. New write tools must follow that pattern. Tool descriptions are the contract OpenClaw's model reads, so keep them accurate. `scripts/mcp-smoke.mjs` is a smoke client.
- **Shared** (`shared/`). Zod schemas and types are used by the API, MCP, and client. `app-metadata.ts` re-exports the version from `package.json`.
- **Client** (`src/`, React 19, React Router 7, TanStack Query, Vite PWA). `src/api.ts` is the single fetch layer; writes send `expectedUpdatedAt`. `App.tsx` defines routes and `components/AppShell.tsx` provides the navigation and badges. Pages live in `src/pages/`. The ledger "today" comes from `ledger-clock.tsx` (the server timezone setting), never from the browser clock.

## Repo notes

- The repository is published publicly as an open-source template. Keep real domains, emails, Access AUD tags, tokens, and personal screenshots or notes out of tracked files, including test fixtures; use `money.example.com`-style placeholders.