import { DEFAULT_ORISLOP_SETTINGS } from "../../shared/src/constants.ts";
import { clamp } from "../../shared/src/clamp.ts";
import type { OrislopSettings } from "../../shared/src/types.ts";

export const defaultSettings: OrislopSettings = DEFAULT_ORISLOP_SETTINGS;

export function normalizeSettings(settings?: Partial<OrislopSettings>): OrislopSettings {
  const merged: OrislopSettings = {
    ...DEFAULT_ORISLOP_SETTINGS,
    ...settings
  };

  return {
    ...merged,
    maxConsecutiveSkips: Math.round(clamp(merged.maxConsecutiveSkips, 0, 25)),
    lookaheadCount: Math.round(clamp(merged.lookaheadCount, 0, 10))
  };
}
