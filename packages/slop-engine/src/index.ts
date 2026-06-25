export { scoreVideo, actionAllowsAutoScroll } from "./scoreVideo.ts";
export { fuseSignals, collectEvidence, isCategoryEnabled } from "./fuseSignals.ts";
export { defaultSettings, normalizeSettings } from "./settings.ts";
export {
  STRICTNESS_THRESHOLDS,
  actionFromProbability,
  getThresholds
} from "./thresholds.ts";
export {
  comedySatireScore,
  factualIntentScore,
  inferContentIntent,
  isComedyProtectedIntent
} from "./policy/contentIntent.ts";
export {
  POLICY_CATEGORY_SETTINGS,
  userFacingReasonForCategory
} from "./policy/defaultPolicy.ts";
export { contentIntentSignal } from "./signals/contentIntentSignal.ts";
export { metadataRulesSignal } from "./signals/metadataRulesSignal.ts";
export { platformAiLabelSignal } from "./signals/platformAiLabelSignal.ts";
export { transcriptRulesSignal } from "./signals/transcriptRulesSignal.ts";
export { userPreferenceSignal } from "./signals/userPreferenceSignal.ts";
export type {
  ContentIntent,
  EvidenceItem,
  ExtractedShort,
  OrislopAction,
  OrislopScoreResult,
  OrislopSettings,
  ScoreVideoOptions,
  ScoreBreakdown,
  SignalResult,
  SkipMode,
  UserPreferenceRules
} from "./types.ts";
