import { clamp01 } from "../../shared/src/clamp.ts";
import type {
  ExtractedShort,
  OrislopAction,
  OrislopScoreResult,
  OrislopSettings
} from "../../shared/src/types.ts";
import { collectEvidence, fuseSignals } from "./fuseSignals.ts";
import { userFacingReasonForCategory } from "./policy/defaultPolicy.ts";
import {
  comedySatireScore,
  factualIntentScore,
  inferContentIntent,
  isComedyProtectedIntent
} from "./policy/contentIntent.ts";
import { normalizeSettings } from "./settings.ts";
import { contentIntentSignal } from "./signals/contentIntentSignal.ts";
import { metadataRulesSignal } from "./signals/metadataRulesSignal.ts";
import { platformAiLabelSignal } from "./signals/platformAiLabelSignal.ts";
import { transcriptRulesSignal } from "./signals/transcriptRulesSignal.ts";
import { userPreferenceSignal } from "./signals/userPreferenceSignal.ts";
import { actionFromProbability, getThresholds } from "./thresholds.ts";
import type { ScoreVideoOptions, SignalResult } from "./types.ts";

export function scoreVideo(
  short: ExtractedShort,
  settingsInput?: Partial<OrislopSettings>,
  options: ScoreVideoOptions = {}
): OrislopScoreResult {
  const settings = normalizeSettings(settingsInput);
  const baseSignals = [
    platformAiLabelSignal(short, settings),
    metadataRulesSignal(short),
    transcriptRulesSignal(short),
    contentIntentSignal(short),
    ...(options.adapterSignals ?? [])
  ];
  const preliminary = fuseSignals(baseSignals, settings);
  const preferenceSignal = userPreferenceSignal(
    short,
    options.userPreferences,
    preliminary.categories
  );
  const signals = preferenceSignal.applicable
    ? [preferenceSignal, ...baseSignals]
    : baseSignals;
  const fused = fuseSignals(signals, settings);
  const contentIntent = inferContentIntent(short);
  const thresholds = getThresholds(settings.strictness);
  const preferenceOverride = getPreferenceOverride(signals, fused.categories, settings);
  const protectedFromClaimOnlySkip = shouldProtectFromClaimOnlySkip(
    contentIntent,
    fused.categories,
    settings
  );

  const effectiveSkipProbability = protectedFromClaimOnlySkip
    ? Math.min(fused.skipProbability, Math.max(0, thresholds.skipAt - 0.01))
    : fused.skipProbability;

  const action = actionFromPreferenceOrProbability(
    preferenceOverride,
    effectiveSkipProbability,
    settings
  );
  const primaryCategory = fused.categories[0] ?? null;
  const userFacingReason = action === "allow" || primaryCategory === null
    ? null
    : userFacingReasonForCategory(primaryCategory);

  return {
    videoId: short.videoId,
    url: short.url,

    slopScore: clamp01(fused.slopScore),
    claimRiskScore: clamp01(fused.claimRiskScore),
    aiGeneratedScore: fused.aiGeneratedScore === null ? null : clamp01(fused.aiGeneratedScore),
    possibleUnlabeledAiScore: fused.possibleUnlabeledAiScore === null
      ? null
      : clamp01(fused.possibleUnlabeledAiScore),

    contentIntent,
    factualIntentScore: factualIntentScore(contentIntent),
    comedySatireScore: comedySatireScore(contentIntent),

    skipProbability: clamp01(effectiveSkipProbability),
    confidence: clamp01(fused.confidence),

    categories: fused.categories,
    evidence: collectEvidence(signals),

    action,
    skipReason: action === "allow" ? null : primaryCategory,
    userFacingReason,

    thresholdUsed: thresholds.skipAt,
    settingsApplied: fused.settingsApplied,
    signals,
    createdAt: options.createdAt ?? new Date().toISOString()
  };
}

function shouldProtectFromClaimOnlySkip(
  contentIntent: ReturnType<typeof inferContentIntent>,
  categories: string[],
  settings: OrislopSettings
): boolean {
  if (!settings.doNotSkipComedyForFactualWrongness || !isComedyProtectedIntent(contentIntent)) {
    return false;
  }

  if (categories.length === 0) {
    return false;
  }

  return categories.every((category) => (
    category === "unsupported_claim"
    || category === "unsupported_claims"
    || category === "serious_claim"
    || category === "high_risk_unsupported_claim"
  ));
}

export function actionAllowsAutoScroll(action: OrislopAction): boolean {
  return action === "skip" || action === "pre_skip";
}

function getPreferenceOverride(
  signals: SignalResult[],
  categories: string[],
  settings: OrislopSettings
): "allow" | "block" | null {
  const preferenceSignal = signals.find((signal) => signal.name === "user_preference");
  const reasonIds = preferenceSignal?.evidence.map((item) => item.reasonId) ?? [];

  if (reasonIds.some((reasonId) => reasonId.includes("always_allow"))) {
    if (hasStrictHighRiskChannelAllowException(categories, settings)) {
      return null;
    }

    return "allow";
  }

  if (reasonIds.some((reasonId) => reasonId.includes("always_block"))) {
    return "block";
  }

  return null;
}

function hasStrictHighRiskChannelAllowException(
  categories: string[],
  settings: OrislopSettings
): boolean {
  const exceptions: Array<[string, keyof OrislopSettings]> = [
    ["scammy", "skipScamFinance"],
    ["scam_finance", "skipScamFinance"],
    ["risky_educational", "skipHighRiskUnsupportedClaims"],
    ["miracle_health_claim", "skipMiracleHealthClaims"],
    ["high_risk_unsupported_claim", "skipHighRiskUnsupportedClaims"]
  ];

  return exceptions.some(([category, setting]) => categories.includes(category) && settings[setting] === true);
}

function actionFromPreferenceOrProbability(
  preferenceOverride: "allow" | "block" | null,
  probability: number,
  settings: OrislopSettings
): OrislopAction {
  if (preferenceOverride === "allow") {
    return "allow";
  }

  if (preferenceOverride === "block") {
    return actionFromProbability(1, settings);
  }

  return actionFromProbability(probability, settings);
}
