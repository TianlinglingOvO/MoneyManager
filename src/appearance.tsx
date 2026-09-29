import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppearancePreferences, AppearancePreset } from "@shared/types";
import { api } from "./api";
import { useDeviceBackground, type DeviceBackgroundState } from "./device-background";

const storageKey = "money-manager.appearance.v1";

const fallbackAppearance: AppearancePreferences = {
  preset: "warm-paper",
  accent: "#B85C3B",
  backgroundPreset: "paper",
  updatedAt: new Date(0).toISOString()
};

function normalizeAppearance(value: Partial<AppearancePreferences> | null | undefined, base = fallbackAppearance): AppearancePreferences {
  const rawPreset = value?.preset as string | undefined;
  // porcelain and sage-ledger were retired in 2.8.0 and fold into warm-paper.
  const preset: AppearancePreset = rawPreset === "porcelain" || rawPreset === "sage-ledger" ? "warm-paper"
    : rawPreset === "warm-paper" || rawPreset === "ink-night" || rawPreset === "auto" ? rawPreset
      : base.preset;
  const accent = value?.accent && /^#[0-9a-fA-F]{6}$/.test(value.accent) ? value.accent.toUpperCase() as `#${string}` : base.accent;
  const backgroundPreset = value?.backgroundPreset && ["plain", "paper", "linen", "mist"].includes(value.backgroundPreset)
    ? value.backgroundPreset
    : base.backgroundPreset;
  return {
    preset,
    accent,
    backgroundPreset,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : base.updatedAt
  };
}

function readCachedAppearance(): AppearancePreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<AppearancePreferences> | null;
    return normalizeAppearance(parsed);
  } catch {
    return fallbackAppearance;
  }
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [red, green, blue] = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

function mix(hex: string, target: "#000000" | "#FFFFFF", amount: number): string {
  const source = rgb(hex);
  const destination = rgb(target);
  return `#${source.map((value, index) => Math.round(value + (destination[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function readableAccent(hex: string, surface: string): string {
  if (contrast(hex, surface) >= 4.5) return hex;
  const target = luminance(surface) > 0.45 ? "#000000" : "#FFFFFF";
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(hex, target, step / 20);
    if (contrast(candidate, surface) >= 4.5) return candidate;
  }
  return target;
}

/** The CSS theme actually shown: `auto` follows the device's light/dark preference. */
export function resolveTheme(preset: AppearancePreset, prefersDark: boolean): "warm-paper" | "ink-night" {
  if (preset === "auto") return prefersDark ? "ink-night" : "warm-paper";
  return preset;
}

function darkSchemeQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
}

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => darkSchemeQuery()?.matches ?? false);
  useEffect(() => {
    const query = darkSchemeQuery();
    if (!query) return;
    const update = () => setDark(query.matches);
    // Phones often flip to dark mode while the PWA is in the background; re-check when it returns too.
    const updateWhenVisible = () => { if (document.visibilityState === "visible") update(); };
    update();
    query.addEventListener?.("change", update);
    document.addEventListener("visibilitychange", updateWhenVisible);
    window.addEventListener("focus", update);
    return () => {
      query.removeEventListener?.("change", update);
      document.removeEventListener("visibilitychange", updateWhenVisible);
      window.removeEventListener("focus", update);
    };
  }, []);
  return dark;
}

function applyAppearance(appearance: AppearancePreferences, prefersDark: boolean): void {
  const root = document.documentElement;
  const theme = resolveTheme(appearance.preset, prefersDark);
  root.dataset.theme = theme;
  root.dataset.background = appearance.backgroundPreset;
  root.style.setProperty("--accent", appearance.accent);
  const paper = theme === "ink-night" ? "#242521" : "#FEFCF7";
  const onAccent = contrast(appearance.accent, "#FFFFFF") >= contrast(appearance.accent, "#000000") ? "#FFFFFF" : "#000000";
  root.style.setProperty("--on-accent", onAccent);
  root.style.setProperty("--accent-strong", readableAccent(appearance.accent, paper));
  root.style.setProperty("--accent-text", readableAccent(appearance.accent, paper));
  root.style.setProperty("--focus-ring", readableAccent(appearance.accent, paper));
  const themeColor = theme === "ink-night" ? "#1B1C1A" : "#F3EFE7";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
  localStorage.setItem(storageKey, JSON.stringify(appearance));
}

interface AppearanceContextValue {
  appearance: AppearancePreferences;
  updateAppearance: (input: Partial<Pick<AppearancePreferences, "preset" | "accent" | "backgroundPreset">>) => Promise<AppearancePreferences>;
  isSaving: boolean;
  deviceBackground: DeviceBackgroundState;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  // Keep one IndexedDB reader and one object URL for the whole document. A
  // second hook instance can otherwise revoke the URL still used by another
  // page after a reload because IndexedDB returns cloned Blob objects.
  const deviceBackground = useDeviceBackground();
  const cached = useMemo(readCachedAppearance, []);
  const query = useQuery({
    queryKey: ["appearance"],
    queryFn: async () => normalizeAppearance(await api.appearance(), cached),
    initialData: cached,
    initialDataUpdatedAt: 0,
    staleTime: 0
  });
  const mutation = useMutation({
    mutationFn: async (input: Partial<Pick<AppearancePreferences, "preset" | "accent" | "backgroundPreset">>) => {
      const current = queryClient.getQueryData<AppearancePreferences>(["appearance"]) ?? cached;
      const response = await api.updateAppearance(input);
      // Merge the requested field as a compatibility guard while a previous
      // service worker or server process is still being replaced.
      return normalizeAppearance({ ...response, ...input }, current);
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["appearance"] });
      const previous = queryClient.getQueryData<AppearancePreferences>(["appearance"]) ?? cached;
      queryClient.setQueryData(["appearance"], normalizeAppearance({ ...previous, ...input }, previous));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(["appearance"], context.previous);
    },
    onSuccess: (value) => queryClient.setQueryData(["appearance"], value)
  });
  const appearance = query.data ?? cached;
  const prefersDark = usePrefersDark();

  useEffect(() => applyAppearance(appearance, prefersDark), [appearance, prefersDark]);

  useEffect(() => {
    const root = document.documentElement;
    const background = deviceBackground.background;
    if (background?.active && background.url) {
      root.dataset.deviceBackground = "custom";
      root.style.setProperty("--device-background-image", `url(${JSON.stringify(background.url)})`);
    } else {
      delete root.dataset.deviceBackground;
      root.style.removeProperty("--device-background-image");
    }
  }, [deviceBackground.background]);

  return (
    <AppearanceContext.Provider value={{
      appearance,
      updateAppearance: async (input) => mutation.mutateAsync(input),
      isSaving: mutation.isPending,
      deviceBackground
    }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("AppearanceProvider is missing");
  return value;
}
