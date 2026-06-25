import type { SignalResult } from "../../shared/src/types";

export type {
  ContentIntent,
  EvidenceItem,
  ExtractedShort,
  OrislopAction,
  OrislopScoreResult,
  OrislopSettings,
  SignalResult,
  SkipMode
} from "../../shared/src/types.ts";

export type ScoreBreakdown = {
  slopScore: number;
  claimRiskScore: number;
  aiGeneratedScore: number | null;
  possibleUnlabeledAiScore: number | null;
  skipProbability: number;
  confidence: number;
  categories: string[];
  settingsApplied: string[];
};

export type UserPreferenceRules = {
  alwaysAllowChannels?: string[];
  alwaysBlockChannels?: string[];
  alwaysBlockCategories?: string[];
};

export type ScoreVideoOptions = {
  userPreferences?: UserPreferenceRules;
  adapterSignals?: SignalResult[];
  createdAt?: string;
};
