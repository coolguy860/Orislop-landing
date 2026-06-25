import type { OrislopSettings } from "./types.ts";

export const ORISLOP_APP_NAME = "Orislop Browser";

export const ORISLOP_MVP_SCOPE = {
  platform: "youtube_shorts_desktop",
  localFirst: true,
  defaultBehavior: "auto_scroll",
  unsupportedTargets: [
    "general_browser",
    "chrome_extension",
    "mobile",
    "tiktok",
    "cloud_service",
    "truth_engine"
  ]
} as const;

export const CAUTIOUS_REASON_LABELS = {
  aiBlocked: "Skipped: AI content blocked by your settings",
  possibleAi: "Skipped: possible AI-generated content",
  lowValue: "Skipped: likely low-value content",
  engagementBait: "Skipped: possible engagement bait",
  templateRepost: "Skipped: possible template/repost format",
  scamFinance: "Skipped: possible scam finance content",
  highRiskClaim: "Skipped: possible high-risk unsupported claim",
  flagged: "Orislop flagged this because:"
} as const;

export const DEFAULT_ORISLOP_SETTINGS: OrislopSettings = {
  autoSkip: true,
  skipMode: "auto_scroll_with_banner",
  allowScrollBack: true,
  showSkippedBanner: true,
  showFlaggedBannerOnScrollBack: true,
  maxConsecutiveSkips: 5,

  enableLookaheadScan: true,
  lookaheadCount: 2,

  strictness: "medium",

  skipAllAiLabeled: true,
  skipPossibleUnlabeledAi: true,
  skipUsefulAiExplainers: true,
  skipAiSlop: true,

  skipAllSlop: true,
  skipEngagementBait: true,
  skipTemplateBrainrot: true,
  skipRedditTtsStories: true,
  skipFakeTextStories: true,
  skipLowInformation: true,
  skipRepostLike: true,

  skipScamFinance: true,
  skipMiracleHealthClaims: true,
  skipHighRiskUnsupportedClaims: true,
  skipUnsupportedClaims: false,

  doNotSkipComedyForFactualWrongness: true,
  doNotClaimTruthVerification: true,

  enableDeepScan: false,
  enableLocalLlm: false,
  enableOcr: false,
  enableOpenClip: false,
  enableWhisper: false,
  enableExistingAiDetector: false,
  enableTemporalDetector: false,

  forceRescan: false
};
