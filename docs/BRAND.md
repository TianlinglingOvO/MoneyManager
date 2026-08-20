# SMB Brand Guide

**SMB** expands to **Sutady Moneybook** and is positioned in Chinese as **私人账本**. The selected mark is candidate B, the shared-skeleton monogram: S remains independent, M and B share a structural stem, and a coral dot marks their junction.

## Assets

- `public/smb-mark-v2.svg`: editable standard source.
- `public/smb-favicon-v2.svg`: compact source with wider small-size gaps and heavier strokes.
- `public/smb-pwa-192-v2.png` and `public/smb-pwa-512-v2.png`: regular install icons.
- `public/smb-maskable-512-v2.png`: full-bleed maskable icon with the monogram inside the safe area.

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-brand-assets.ps1` after changing the compact geometry. The generated PNG set should remain under 200KB and must be inspected at 32px, 192px, and 512px.

## Fixed palette

- Ink purple: `#291D3A`
- Coral accent: `#F06B55`
- Cream mark: `#FFF3E4`

The mark never inherits the current theme accent. Do not replace it with a ledger, coin, currency symbol, piggy bank, or generic finance icon. Do not rename internal identifiers such as `sutady-money-manager`, the public domain, environment variables, cache keys, or export format during visual brand work.

The editable comparison board remains available in [Figma](https://www.figma.com/design/v7GUzicTIYBy9V2pfcVXB7); the repository assets are the production source of truth for the selected B direction.
