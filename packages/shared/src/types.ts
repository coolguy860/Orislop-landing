export type ExtractedShort = {
  url: string;
  videoId: string | null;
  title: string | null;
  channelName: string | null;
  channelUrl: string | null;
  description: string | null;
  hashtags: string[];
  visiblePageText: string;
  hasPlatformAiLabel: boolean;
  platformAiLabelText: string | null;
  transcript: string | null;
};

export type EvidenceItem = {
  reasonId: string;
  label: string;
  detail: string;
  weight: number;
  confidence: number;
  source: string;
};

export type SignalResult = {
  name: string;
  score: number | null;
  confidence: number;
  applicable: boolean;
  categories: string[];
  evidence: EvidenceItem[];
  reason: string;
  runtimeMs?: number;
  error?: string | null;
};

export type ContentIntent =
  | "comedy_satire"
  | "fiction_story"
  | "normal_entertainment"
  | "serious_education"
  | "news_current_events"
  | "health_advice"
  | "finance_advice"
  | "legal_advice"
  | "political_claim"
  | "science_claim"
  | "history_claim"
  | "scam_promo"
  | "unknown";

export type OrislopAction =
  | "allow"
  | "warn"
  | "skip"
  | "pre_skip";

export type SkipMode =
  | "off"
  | "warn_only"
  | "auto_scroll_with_banner"
  | "auto_scroll_silent";

export type OrislopSettings = {
  autoSkip: boolean;
  skipMode: SkipMode;
  allowScrollBack: boolean;
  showSkippedBanner: boolean;
  showFlaggedBannerOnScrollBack: boolean;
  maxConsecutiveSkips: number;

  enableLookaheadScan: boolean;
  lookaheadCount: number;

  strictness: "lenient" | "medium" | "strict";

  skipAllAiLabeled: boolean;
  skipPossibleUnlabeledAi: boolean;
  skipUsefulAiExplainers: boolean;
  skipAiSlop: boolean;

  skipAllSlop: boolean;
  skipEngagementBait: boolean;
  skipTemplateBrainrot: boolean;
  skipRedditTtsStories: boolean;
  skipFakeTextStories: boolean;
  skipLowInformation: boolean;
  skipRepostLike: boolean;

  skipScamFinance: boolean;
  skipMiracleHealthClaims: boolean;
  skipHighRiskUnsupportedClaims: boolean;
  skipUnsupportedClaims: boolean;

  doNotSkipComedyForFactualWrongness: boolean;
  doNotClaimTruthVerification: boolean;

  enableDeepScan: boolean;
  enableLocalLlm: boolean;
  enableOcr: boolean;
  enableOpenClip: boolean;
  enableWhisper: boolean;
  enableExistingAiDetector: boolean;
  enableTemporalDetector: boolean;

  forceRescan: boolean;
};

export type OrislopScoreResult = {
  videoId: string | null;
  url: string;

  slopScore: number;
  claimRiskScore: number;
  aiGeneratedScore: number | null;
  possibleUnlabeledAiScore: number | null;

  contentIntent: ContentIntent;
  factualIntentScore: number;
  comedySatireScore: number;

  skipProbability: number;
  confidence: number;

  categories: string[];
  evidence: EvidenceItem[];

  action: OrislopAction;
  skipReason: string | null;
  userFacingReason: string | null;

  thresholdUsed: number;
  settingsApplied: string[];
  signals: SignalResult[];
  createdAt: string;
};
