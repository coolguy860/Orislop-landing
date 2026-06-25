import { clamp01 } from "../../../shared/src/clamp.ts";
import type { EvidenceItem, ExtractedShort, SignalResult } from "../../../shared/src/types.ts";
import { CLAIM_RISK_TERMS, CONSPIRACY_FRAMING_TERMS } from "../rules/claimRiskTerms.ts";
import { SCAM_TERMS } from "../rules/scamTerms.ts";
import { SERIOUS_CLAIM_TERMS } from "../rules/seriousClaimTerms.ts";

type Hit = {
  reasonId: string;
  label: string;
  detail: string;
  weight: number;
  confidence: number;
  category: string;
};

export function transcriptRulesSignal(short: ExtractedShort): SignalResult {
  const started = Date.now();
  const transcript = short.transcript?.trim();

  if (!transcript) {
    return {
      name: "transcript_rules",
      score: null,
      confidence: 0,
      applicable: false,
      categories: [],
      evidence: [],
      reason: "Transcript is unavailable.",
      runtimeMs: Date.now() - started,
      error: null
    };
  }

  const text = transcript.toLowerCase();
  const hits: Hit[] = [];
  const words = text.match(/[a-z0-9']+/g) ?? [];
  const uniqueRatio = words.length === 0 ? 1 : new Set(words).size / words.length;

  if (words.length >= 30 && uniqueRatio < 0.34) {
    hits.push(makeHit("transcript_low_information_density", "Low information density", "Transcript repeats a small set of words.", "low_information", 0.55));
  }

  if (/\b(um+|uh+|like like|you know you know|so basically so basically)\b/i.test(transcript)) {
    hits.push(makeHit("transcript_repeated_filler", "Repeated filler", "Transcript contains repeated filler phrases.", "low_information", 0.5));
  }

  if (/\b(aita|ask reddit|subreddit|r\/|upvote|tifu|relationship advice)\b/i.test(transcript)) {
    hits.push(makeHit("transcript_reddit_story_pattern", "Reddit story pattern", "Transcript uses Reddit-story framing.", "reddit_story", 0.68));
  }

  if (/\b(text to speech|tts|ai voice|minecraft parkour|subway surfers|voiceover story)\b/i.test(transcript)) {
    hits.push(makeHit("transcript_tts_story_pattern", "TTS story pattern", "Transcript suggests a TTS/story-template format.", "tts_story", 0.62));
  }

  if (/(^|\n)\s*(me|mom|dad|bro|girl|boyfriend|girlfriend|teacher|boss)\s*:/i.test(transcript)) {
    hits.push(makeHit("transcript_fake_text_story_pattern", "Fake text story pattern", "Transcript is formatted like a staged text conversation.", "fake_text_story", 0.66));
  }

  collectPhraseHits(text, SCAM_TERMS, "scammy", "Possible scam language", 0.82, hits);
  collectPhraseHits(text, CLAIM_RISK_TERMS, "unsupported_claims", "Unsupported absolute claim", 0.75, hits);
  collectPhraseHits(text, CONSPIRACY_FRAMING_TERMS, "unsupported_claims", "Conspiracy framing", 0.68, hits);
  collectPhraseHits(text, SERIOUS_CLAIM_TERMS, "serious_claim", "Serious factual claim", 0.45, hits);

  if (/\b(cures|miracle cure|doctors hate|never eat this|detox)\b/i.test(transcript)) {
    hits.push(makeHit("transcript_miracle_health_claim", "Miracle health claim", "Transcript contains high-risk health advice wording.", "risky_educational", 0.82));
  }

  if (hits.length === 0) {
    return {
      name: "transcript_rules",
      score: 0,
      confidence: 0.45,
      applicable: true,
      categories: [],
      evidence: [],
      reason: "No Tier 1 transcript rules matched.",
      runtimeMs: Date.now() - started,
      error: null
    };
  }

  return {
    name: "transcript_rules",
    score: scoreHits(hits),
    confidence: confidenceHits(hits),
    applicable: true,
    categories: categoriesFromHits(hits),
    evidence: evidenceFromHits(hits),
    reason: "Tier 1 transcript rules matched.",
    runtimeMs: Date.now() - started,
    error: null
  };
}

function collectPhraseHits(
  text: string,
  phrases: readonly string[],
  category: string,
  label: string,
  weight: number,
  hits: Hit[]
): void {
  for (const phrase of phrases) {
    if (text.includes(phrase.toLowerCase())) {
      hits.push(makeHit(`transcript_${slug(phrase)}`, label, phrase, category, weight));
    }
  }
}

function makeHit(reasonId: string, label: string, detail: string, category: string, weight: number): Hit {
  return {
    reasonId,
    label,
    detail,
    weight,
    confidence: clamp01(weight + 0.1),
    category
  };
}

function scoreHits(hits: Hit[]): number {
  const max = Math.max(...hits.map((hit) => hit.weight));
  return clamp01(max + Math.max(0, hits.length - 1) * 0.04);
}

function confidenceHits(hits: Hit[]): number {
  return clamp01(hits.reduce((sum, hit) => sum + hit.confidence, 0) / hits.length);
}

function categoriesFromHits(hits: Hit[]): string[] {
  return Array.from(new Set(hits.map((hit) => hit.category)));
}

function evidenceFromHits(hits: Hit[]): EvidenceItem[] {
  return hits.map((hit) => ({
    reasonId: hit.reasonId,
    label: hit.label,
    detail: hit.detail,
    weight: hit.weight,
    confidence: hit.confidence,
    source: "transcript"
  }));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
