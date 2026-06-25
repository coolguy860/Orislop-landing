import type {
  ExtractedShort,
  OrislopScoreResult,
  OrislopSettings
} from "../../../packages/shared/src/types.ts";
import type { UserFeedbackAction } from "../../../packages/storage/src/types.ts";
import type {
  LookaheadPosition,
  LookaheadShortCandidate,
  ScoreLookaheadPayload
} from "../src/youtube/lookaheadTypes.ts";

export type ScoreRequestPayload = {
  fixtureId?: string;
  short?: ExtractedShort;
  forceRescan?: boolean;
};

export type FeedbackPayload = {
  fixtureId?: string;
  short?: ExtractedShort;
  scoreResult: OrislopScoreResult;
  userFeedback: UserFeedbackAction;
};

const FEEDBACK_ACTIONS = new Set<UserFeedbackAction>([
  "correct",
  "not_slop",
  "always_allow_channel",
  "always_block_channel",
  "always_block_format",
  "watch_anyway",
  "show_anyway"
]);

const LOOKAHEAD_POSITIONS = new Set<LookaheadPosition>([
  "current",
  "next",
  "nearby",
  "unknown"
]);

export function readScorePayload(payload: unknown): ScoreRequestPayload {
  if (!isRecord(payload)) {
    throw new Error("Score payload must be an object.");
  }

  const fixtureId = optionalString(payload.fixtureId, "fixtureId");
  const short = payload.short === undefined ? undefined : readExtractedShort(payload.short);
  const forceRescan = optionalBoolean(payload.forceRescan, "forceRescan");

  if (!fixtureId && !short) {
    throw new Error("Score payload requires fixtureId or short.");
  }

  return {
    fixtureId,
    short,
    forceRescan
  };
}

export function readFeedbackPayload(payload: unknown): FeedbackPayload {
  if (!isRecord(payload)) {
    throw new Error("Feedback payload must be an object.");
  }

  const userFeedback = payload.userFeedback;
  if (typeof userFeedback !== "string" || !FEEDBACK_ACTIONS.has(userFeedback as UserFeedbackAction)) {
    throw new Error("Feedback payload has an invalid userFeedback value.");
  }

  if (!isScoreResult(payload.scoreResult)) {
    throw new Error("Feedback payload requires a scoreResult.");
  }

  return {
    fixtureId: optionalString(payload.fixtureId, "fixtureId"),
    short: payload.short === undefined ? undefined : readExtractedShort(payload.short),
    scoreResult: payload.scoreResult,
    userFeedback: userFeedback as UserFeedbackAction
  };
}

export function readSettingsPatch(payload: unknown): Partial<OrislopSettings> {
  if (!isRecord(payload)) {
    throw new Error("Settings patch must be an object.");
  }

  const patch: Partial<OrislopSettings> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      (patch as Record<string, unknown>)[key] = value;
    }
  }

  return patch;
}

export function readScoreLookaheadPayload(payload: unknown): ScoreLookaheadPayload {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    throw new Error("Lookahead payload requires a candidates array.");
  }

  return {
    candidates: payload.candidates.slice(0, 10).map(readLookaheadCandidate)
  };
}

function readExtractedShort(value: unknown): ExtractedShort {
  if (!isRecord(value)) {
    throw new Error("short must be an object.");
  }

  return {
    url: requiredString(value.url, "short.url"),
    videoId: nullableString(value.videoId, "short.videoId"),
    title: nullableString(value.title, "short.title"),
    channelName: nullableString(value.channelName, "short.channelName"),
    channelUrl: nullableString(value.channelUrl, "short.channelUrl"),
    description: nullableString(value.description, "short.description"),
    hashtags: readStringArray(value.hashtags, "short.hashtags"),
    visiblePageText: requiredString(value.visiblePageText, "short.visiblePageText"),
    hasPlatformAiLabel: requiredBoolean(value.hasPlatformAiLabel, "short.hasPlatformAiLabel"),
    platformAiLabelText: nullableString(value.platformAiLabelText, "short.platformAiLabelText"),
    transcript: nullableString(value.transcript, "short.transcript")
  };
}

function isScoreResult(value: unknown): value is OrislopScoreResult {
  return isRecord(value)
    && typeof value.url === "string"
    && "action" in value
    && Array.isArray(value.evidence)
    && Array.isArray(value.categories);
}

function readLookaheadCandidate(value: unknown): LookaheadShortCandidate {
  if (!isRecord(value)) {
    throw new Error("Lookahead candidate must be an object.");
  }

  const position = value.position;
  if (typeof position !== "string" || !LOOKAHEAD_POSITIONS.has(position as LookaheadPosition)) {
    throw new Error("Lookahead candidate has invalid position.");
  }

  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0;

  return {
    extractionId: requiredString(value.extractionId, "candidate.extractionId"),
    url: nullableString(value.url, "candidate.url"),
    videoId: nullableString(value.videoId, "candidate.videoId"),
    title: nullableString(value.title, "candidate.title"),
    channelName: nullableString(value.channelName, "candidate.channelName"),
    channelUrl: nullableString(value.channelUrl, "candidate.channelUrl"),
    visiblePageText: requiredString(value.visiblePageText, "candidate.visiblePageText"),
    position: position as LookaheadPosition,
    confidence
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }

  return requiredString(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }

  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredBoolean(value, field);
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a string array.`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
