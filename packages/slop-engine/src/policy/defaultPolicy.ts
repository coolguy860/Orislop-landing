import { CAUTIOUS_REASON_LABELS } from "../../../shared/src/constants.ts";

export const POLICY_CATEGORY_SETTINGS: Record<string, string> = {
  ai_labeled: "skipAllAiLabeled",
  platform_ai_labeled: "skipAllAiLabeled",
  possible_unlabeled_ai: "skipPossibleUnlabeledAi",
  useful_ai: "skipUsefulAiExplainers",
  ai_explainer: "skipUsefulAiExplainers",
  ai_slop: "skipAiSlop",
  slop: "skipAllSlop",
  engagement_bait: "skipEngagementBait",
  template_brainrot: "skipTemplateBrainrot",
  tts_story: "skipRedditTtsStories",
  reddit_story: "skipRedditTtsStories",
  reddit_tts_story: "skipRedditTtsStories",
  fake_text_story: "skipFakeTextStories",
  low_information: "skipLowInformation",
  repost_like: "skipRepostLike",
  ragebait: "skipEngagementBait",
  scammy: "skipScamFinance",
  scam_finance: "skipScamFinance",
  risky_educational: "skipHighRiskUnsupportedClaims",
  miracle_health_claim: "skipMiracleHealthClaims",
  high_risk_unsupported_claim: "skipHighRiskUnsupportedClaims",
  unsupported_claims: "skipUnsupportedClaims",
  unsupported_claim: "skipUnsupportedClaims"
} as const;

export const CLAIM_ONLY_CATEGORIES = new Set([
  "unsupported_claim",
  "unsupported_claims",
  "serious_claim",
  "high_risk_unsupported_claim"
]);

export const NON_CLAIM_SKIP_CATEGORIES = new Set([
  "ai_labeled",
  "platform_ai_labeled",
  "possible_unlabeled_ai",
  "useful_ai",
  "ai_explainer",
  "ai_slop",
  "slop",
  "engagement_bait",
  "template_brainrot",
  "tts_story",
  "reddit_story",
  "reddit_tts_story",
  "fake_text_story",
  "low_information",
  "repost_like",
  "ragebait",
  "scammy",
  "scam_finance",
  "risky_educational",
  "miracle_health_claim"
]);

export function userFacingReasonForCategory(category: string): string {
  switch (category) {
    case "ai_labeled":
    case "platform_ai_labeled":
      return CAUTIOUS_REASON_LABELS.aiBlocked;
    case "possible_unlabeled_ai":
    case "useful_ai":
    case "ai_slop":
      return CAUTIOUS_REASON_LABELS.possibleAi;
    case "engagement_bait":
    case "ragebait":
      return CAUTIOUS_REASON_LABELS.engagementBait;
    case "template_brainrot":
    case "repost_like":
      return CAUTIOUS_REASON_LABELS.templateRepost;
    case "scammy":
    case "scam_finance":
      return CAUTIOUS_REASON_LABELS.scamFinance;
    case "risky_educational":
    case "unsupported_claims":
    case "high_risk_unsupported_claim":
    case "miracle_health_claim":
      return CAUTIOUS_REASON_LABELS.highRiskClaim;
    default:
      return CAUTIOUS_REASON_LABELS.lowValue;
  }
}
