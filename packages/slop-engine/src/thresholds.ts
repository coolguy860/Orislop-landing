import type { OrislopAction, OrislopSettings } from "../../shared/src/types.ts";

export type Strictness = OrislopSettings["strictness"];

export type StrictnessThresholds = {
  allowBelow: number;
  warnAt: number;
  skipAt: number;
};

export const STRICTNESS_THRESHOLDS: Record<Strictness, StrictnessThresholds> = {
  lenient: {
    allowBelow: 0.45,
    warnAt: 0.45,
    skipAt: 0.7
  },
  medium: {
    allowBelow: 0.35,
    warnAt: 0.35,
    skipAt: 0.6
  },
  strict: {
    allowBelow: 0.25,
    warnAt: 0.25,
    skipAt: 0.5
  }
};

export function getThresholds(strictness: Strictness): StrictnessThresholds {
  return STRICTNESS_THRESHOLDS[strictness] ?? STRICTNESS_THRESHOLDS.medium;
}

export function actionFromProbability(
  probability: number,
  settings: OrislopSettings
): OrislopAction {
  const thresholds = getThresholds(settings.strictness);

  if (probability < thresholds.warnAt) {
    return "allow";
  }

  if (probability < thresholds.skipAt) {
    return "warn";
  }

  if (!settings.autoSkip || settings.skipMode === "off" || settings.skipMode === "warn_only") {
    return "warn";
  }

  return "skip";
}
