import { clamp01 } from "../../shared/src/clamp.ts";
import type { EvidenceItem, OrislopSettings, SignalResult } from "../../shared/src/types.ts";
import { POLICY_CATEGORY_SETTINGS } from "./policy/defaultPolicy.ts";
import type { ScoreBreakdown } from "./types.ts";

function scoreForCategory(signals: SignalResult[], categories: string[]): number | null {
  const scores = signals
    .filter((signal) => signal.applicable && signal.score !== null)
    .filter((signal) => signal.categories.some((category) => categories.includes(category)))
    .map((signal) => clamp01(signal.score ?? 0));

  if (scores.length === 0) {
    return null;
  }

  return Math.max(...scores);
}

export function fuseSignals(signals: SignalResult[], settings: OrislopSettings): ScoreBreakdown {
  const usableSignals = signals.filter((signal) => signal.applicable && signal.score !== null);
  const evidence: EvidenceItem[] = usableSignals.flatMap((signal) => signal.evidence);
  const categories = Array.from(new Set(usableSignals.flatMap((signal) => signal.categories)));
  const settingsApplied = categories
    .map((category) => POLICY_CATEGORY_SETTINGS[category])
    .filter((setting): setting is string => Boolean(setting));

  const slopScore = scoreForCategory(usableSignals, [
    "slop",
    "ai_slop",
    "engagement_bait",
    "template_brainrot",
    "tts_story",
    "reddit_story",
    "reddit_tts_story",
    "fake_text_story",
    "low_information",
    "repost_like",
    "ragebait"
  ]);

  const claimRiskScore = scoreForCategory(usableSignals, [
    "scammy",
    "scam_finance",
    "risky_educational",
    "miracle_health_claim",
    "high_risk_unsupported_claim",
    "unsupported_claims",
    "unsupported_claim",
    "serious_claim"
  ]);

  const aiGeneratedScore = scoreForCategory(usableSignals, [
    "ai_labeled",
    "platform_ai_labeled",
    "ai_slop",
    "ai_explainer",
    "useful_ai"
  ]);

  const possibleUnlabeledAiScore = scoreForCategory(usableSignals, [
    "possible_unlabeled_ai"
  ]);

  const enabledScores = usableSignals
    .filter((signal) => signal.categories.some((category) => isCategoryEnabled(category, settings)))
    .map((signal) => clamp01(signal.score ?? 0));

  const skipProbability = enabledScores.length > 0 ? Math.max(...enabledScores) : 0;
  const confidence = usableSignals.length > 0
    ? usableSignals.reduce((sum, signal) => sum + clamp01(signal.confidence), 0) / usableSignals.length
    : 0;

  return {
    slopScore: slopScore ?? 0,
    claimRiskScore: claimRiskScore ?? 0,
    aiGeneratedScore,
    possibleUnlabeledAiScore,
    skipProbability,
    confidence,
    categories,
    settingsApplied
  };
}

export function collectEvidence(signals: SignalResult[]): EvidenceItem[] {
  return signals
    .filter((signal) => signal.applicable)
    .flatMap((signal) => signal.evidence);
}

export function isCategoryEnabled(category: string, settings: OrislopSettings): boolean {
  const settingName = POLICY_CATEGORY_SETTINGS[category] as keyof OrislopSettings | undefined;
  if (!settingName) {
    return false;
  }

  return settings[settingName] === true;
}
