# Changelog

All notable SMB changes are recorded here. The version in `package.json` is canonical.

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
