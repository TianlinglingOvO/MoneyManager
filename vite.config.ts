import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { APP_DESCRIPTION, APP_FULL_NAME, APP_BRAND_NAME, BRAND_COLORS, PWA_ICONS } from "./shared/app-metadata";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: [
        "smb-mark-v2.svg",
        "smb-favicon-v2.svg",
        "smb-pwa-192-v2.png",
        "smb-pwa-512-v2.png",
        "smb-maskable-512-v2.png"
      ],
      manifest: {
        name: APP_FULL_NAME,
        short_name: APP_BRAND_NAME,
        description: APP_DESCRIPTION,
        theme_color: BRAND_COLORS.ink,
        background_color: BRAND_COLORS.cream,
        display: "standalone",
        start_url: "/",
        lang: "zh-CN",
        icons: [...PWA_ICONS]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp(?:\/|$)/, /^\/auth(?:\/|$)/, /^\/cdn-cgi(?:\/|$)/],
        runtimeCaching: []
      }
    })
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared")
    }
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8788",
      "/health": "http://127.0.0.1:8788"
    }
  },
  build: {
    sourcemap: false
  }
});
