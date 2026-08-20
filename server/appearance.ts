import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { AppearanceColorDerivatives, AppearancePreferences } from "../shared/types";
import { appearancePatchSchema } from "../shared/schemas";
import { LedgerRepository } from "./repository";

type AppearancePatch = z.infer<typeof appearancePatchSchema>;

export const defaultAppearance: AppearancePreferences = {
  preset: "warm-paper",
  accent: "#B85C3B",
  density: "comfortable",
  backgroundPreset: "paper",
  updatedAt: new Date(0).toISOString()
};

function channel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
}

function luminance(hex: string): number {
  const values = [channel(hex, 1), channel(hex, 3), channel(hex, 5)]
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

export function contrastRatio(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

type Rgb = { red: number; green: number; blue: number };
type Hsl = { hue: number; saturation: number; lightness: number };

function hexToRgb(hex: string): Rgb {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16)
  };
}

function rgbToHex({ red, green, blue }: Rgb): `#${string}` {
  return `#${[red, green, blue].map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")).join("")}`.toUpperCase() as `#${string}`;
}

function rgbToHsl({ red, green, blue }: Rgb): Hsl {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, saturation, lightness };
}

function hslToRgb({ hue, saturation, lightness }: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const match = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (section < 1) [red, green, blue] = [chroma, secondary, 0];
  else if (section < 2) [red, green, blue] = [secondary, chroma, 0];
  else if (section < 3) [red, green, blue] = [0, chroma, secondary];
  else if (section < 4) [red, green, blue] = [0, secondary, chroma];
  else if (section < 5) [red, green, blue] = [secondary, 0, chroma];
  else [red, green, blue] = [chroma, 0, secondary];
  return { red: (red + match) * 255, green: (green + match) * 255, blue: (blue + match) * 255 };
}

function adjustLightnessForContrast(hex: `#${string}`, surface: string, direction: "lighter" | "darker"): `#${string}` {
  if (contrastRatio(hex, surface) >= 4.5) return hex;
  const hsl = rgbToHsl(hexToRgb(hex));
  let low = direction === "lighter" ? hsl.lightness : 0;
  let high = direction === "lighter" ? 1 : hsl.lightness;
  for (let attempt = 0; attempt < 28; attempt += 1) {
    const lightness = (low + high) / 2;
    const candidate = rgbToHex(hslToRgb({ ...hsl, lightness }));
    if (contrastRatio(candidate, surface) >= 4.5) {
      if (direction === "lighter") high = lightness;
      else low = lightness;
    } else if (direction === "lighter") low = lightness;
    else high = lightness;
  }
  const result = rgbToHex(hslToRgb({ ...hsl, lightness: direction === "lighter" ? high : low }));
  return contrastRatio(result, surface) >= 4.5 ? result : direction === "lighter" ? "#FFFFFF" : "#000000";
}

export function normalizeAccent(value: string): `#${string}` {
  return value.toUpperCase() as `#${string}`;
}

export function deriveAccentColors(value: string): AppearanceColorDerivatives {
  const accent = normalizeAccent(value);
  const whiteContrast = contrastRatio(accent, "#FFFFFF");
  const blackContrast = contrastRatio(accent, "#000000");
  return {
    accent,
    onAccent: whiteContrast >= blackContrast ? "#FFFFFF" : "#000000",
    accentTextOnLight: adjustLightnessForContrast(accent, "#FFFFFF", "darker"),
    accentTextOnDark: adjustLightnessForContrast(accent, "#1B1C1A", "lighter")
  };
}

export class AppearanceService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly repository: LedgerRepository
  ) {}

  get(): AppearancePreferences {
    const rows = this.database.prepare("SELECT key, value, updated_at FROM settings WHERE key LIKE 'appearance.%'").all() as Array<{
      key: string;
      value: string;
      updated_at: string;
    }>;
    const values = new Map(rows.map((row) => [row.key, row]));
    const candidate = {
      preset: values.get("appearance.preset")?.value ?? defaultAppearance.preset,
      accent: values.get("appearance.accent")?.value ?? defaultAppearance.accent,
      density: values.get("appearance.density")?.value ?? defaultAppearance.density,
      backgroundPreset: values.get("appearance.backgroundPreset")?.value ?? defaultAppearance.backgroundPreset
    };
    const parsed = appearancePatchSchema.safeParse(candidate);
    const updatedAt = rows.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, defaultAppearance.updatedAt);
    if (!parsed.success) return { ...defaultAppearance, updatedAt };
    return {
      preset: parsed.data.preset ?? defaultAppearance.preset,
      accent: normalizeAccent(parsed.data.accent ?? defaultAppearance.accent),
      density: parsed.data.density ?? defaultAppearance.density,
      backgroundPreset: parsed.data.backgroundPreset ?? defaultAppearance.backgroundPreset,
      updatedAt
    };
  }

  update(rawPatch: unknown): AppearancePreferences {
    const patch = appearancePatchSchema.parse(rawPatch);
    const normalized: AppearancePatch = {
      ...patch,
      ...(patch.accent ? { accent: normalizeAccent(patch.accent) } : {})
    };
    const now = new Date().toISOString();
    const statement = this.database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const [field, value] of Object.entries(normalized)) statement.run(`appearance.${field}`, value, now);
      this.repository.audit("user", "settings.appearance", "settings", "appearance", { fields: Object.keys(normalized) });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.get();
  }
}
