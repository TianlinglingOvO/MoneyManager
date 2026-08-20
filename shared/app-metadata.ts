import packageMetadata from "../package.json";

export const APP_VERSION = packageMetadata.version;
export const APP_BRAND_NAME = "SMB";
export const APP_FULL_NAME = "SMB — Sutady Moneybook";
export const APP_SUBTITLE = "Sutady Moneybook";
export const APP_POSITIONING = "私人账本";
export const APP_DESCRIPTION = "Sutady 的私人账本";

export const PWA_ICONS = [
  { src: "/smb-pwa-192-v2.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/smb-pwa-512-v2.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/smb-maskable-512-v2.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
] as const;

export const BRAND_COLORS = {
  ink: "#291D3A",
  coral: "#F06B55",
  cream: "#FFF3E4"
} as const;
