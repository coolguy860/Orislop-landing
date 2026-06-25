import type { ExtractedShort } from "../../../../packages/shared/src/types.ts";
import {
  extractHashtags,
  findAiDisclosure
} from "./youtubeShortsExtractor.ts";
import {
  extractShortsVideoId,
  normalizeShortsUrl,
  parseYouTubeShortsUrl
} from "./youtubeUrl.ts";
import type {
  LookaheadContainerSnapshot,
  LookaheadScanOptions,
  LookaheadShortCandidate
} from "./lookaheadTypes.ts";

export function scanLookaheadFromSnapshots(
  snapshots: LookaheadContainerSnapshot[],
  options: LookaheadScanOptions
): LookaheadShortCandidate[] {
  if (options.limit <= 0 || snapshots.length === 0) {
    return [];
  }

  const currentVideoId = options.currentUrl ? extractShortsVideoId(options.currentUrl) : null;
  const candidates = snapshots
    .map((snapshot, index) => candidateFromSnapshot(snapshot, index, currentVideoId))
    .filter((candidate): candidate is LookaheadShortCandidate => candidate !== null);

  return limitLookaheadCandidates(dedupeLookaheadCandidates(candidates), options.limit);
}

export function candidateToExtractedShort(candidate: LookaheadShortCandidate): ExtractedShort {
  const text = [candidate.title, candidate.visiblePageText].filter(Boolean).join(" ");
  const disclosure = findAiDisclosure(text);

  return {
    url: candidate.url ?? candidateUrlFallback(candidate),
    videoId: candidate.videoId,
    title: candidate.title,
    channelName: candidate.channelName,
    channelUrl: candidate.channelUrl,
    description: null,
    hashtags: extractHashtags(text),
    visiblePageText: candidate.visiblePageText,
    hasPlatformAiLabel: disclosure !== null,
    platformAiLabelText: disclosure,
    transcript: null
  };
}

export function dedupeLookaheadCandidates(
  candidates: LookaheadShortCandidate[]
): LookaheadShortCandidate[] {
  const seen = new Set<string>();
  const deduped: LookaheadShortCandidate[] = [];

  for (const candidate of candidates) {
    const key = dedupeKey(candidate);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

export function limitLookaheadCandidates(
  candidates: LookaheadShortCandidate[],
  lookaheadCount: number
): LookaheadShortCandidate[] {
  return candidates.slice(0, Math.max(0, Math.floor(lookaheadCount)));
}

export function getYouTubeLookaheadScannerScript(limit: number): string {
  const safeLimit = Math.max(0, Math.min(10, Math.floor(limit)));
  return `(${browserScanLookahead.toString()})(${safeLimit});`;
}

function candidateFromSnapshot(
  snapshot: LookaheadContainerSnapshot,
  index: number,
  currentVideoId: string | null
): LookaheadShortCandidate | null {
  const url = normalizeNullable(snapshot.url);
  const videoId = normalizeNullable(snapshot.videoId) ?? (url ? extractShortsVideoId(url) : null);
  const visiblePageText = normalizeWhitespace(snapshot.visiblePageText ?? "");
  const title = normalizeNullable(snapshot.title);

  if (!url && !videoId && !title && !visiblePageText) {
    return null;
  }

  const position = snapshot.position
    ?? inferPosition(snapshot, index, videoId, currentVideoId);
  const normalizedUrl = url ?? (videoId ? normalizeShortsUrl(videoId) : null);

  return {
    extractionId: extractionIdFor({
      url: normalizedUrl,
      videoId,
      title,
      visiblePageText
    }, index),
    url: normalizedUrl,
    videoId,
    title,
    channelName: normalizeNullable(snapshot.channelName),
    channelUrl: normalizeNullable(snapshot.channelUrl),
    visiblePageText,
    position,
    confidence: confidenceForCandidate({
      url: normalizedUrl,
      videoId,
      title,
      channelName: snapshot.channelName,
      visiblePageText,
      position
    })
  };
}

function inferPosition(
  snapshot: LookaheadContainerSnapshot,
  index: number,
  videoId: string | null,
  currentVideoId: string | null
): LookaheadShortCandidate["position"] {
  if (snapshot.isActive || (videoId && videoId === currentVideoId)) {
    return "current";
  }

  if (index === 1) {
    return "next";
  }

  return index > 1 ? "nearby" : "unknown";
}

function extractionIdFor(
  input: Pick<LookaheadShortCandidate, "url" | "videoId" | "title" | "visiblePageText">,
  index: number
): string {
  if (input.videoId) {
    return `video:${input.videoId}`;
  }

  if (input.url) {
    return `url:${input.url}`;
  }

  return `text:${smallHash(`${input.title ?? ""}:${input.visiblePageText}`)}:${index}`;
}

function confidenceForCandidate(input: {
  url: string | null;
  videoId: string | null;
  title: string | null;
  channelName: string | null | undefined;
  visiblePageText: string;
  position: LookaheadShortCandidate["position"];
}): number {
  let score = 0.2;
  if (input.url) score += 0.2;
  if (input.videoId) score += 0.3;
  if (input.title) score += 0.15;
  if (input.channelName) score += 0.05;
  if (input.visiblePageText) score += 0.05;
  if (input.position === "current" || input.position === "next") score += 0.05;
  return Math.min(1, Number(score.toFixed(2)));
}

function dedupeKey(candidate: LookaheadShortCandidate): string {
  return candidate.videoId
    ? `video:${candidate.videoId}`
    : candidate.url
      ? `url:${candidate.url}`
      : candidate.extractionId;
}

function candidateUrlFallback(candidate: LookaheadShortCandidate): string {
  return candidate.videoId
    ? normalizeShortsUrl(candidate.videoId)
    : `orislop://lookahead/${encodeURIComponent(candidate.extractionId)}`;
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value ?? "");
  return normalized || null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function smallHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function browserScanLookahead(limit) {
  try {
    if (limit <= 0) {
      return [];
    }

    const containers = Array.from(document.querySelectorAll(
      "ytd-reel-video-renderer, ytd-shorts ytd-reel-video-renderer, #shorts-container ytd-reel-video-renderer, [data-orislop-short]"
    ));
    if (containers.length === 0) {
      return [];
    }

    const activeIndex = Math.max(0, containers.findIndex((node) => (
      node.hasAttribute("is-active")
      || node.getAttribute("is-active") === "true"
      || node.getAttribute("aria-current") === "true"
    )));
    const nearby = containers
      .slice(Math.max(0, activeIndex - 1), activeIndex + limit + 3)
      .map((container, index) => containerToCandidate(container, index, activeIndex))
      .filter(Boolean);

    return dedupePlain(nearby).slice(0, limit);
  } catch {
    return [];
  }

  function containerToCandidate(container, index, activeIndex) {
    const anchor = container.querySelector("a[href*='/shorts/']");
    const channel = container.querySelector("ytd-channel-name a[href], #channel-name a[href], a[href^='/@'], a[href*='youtube.com/@']");
    const url = anchor?.href ?? null;
    const videoId = plainVideoIdFromUrl(url);
    const title = firstText([
      container.querySelector("h1")?.textContent,
      container.querySelector("[id='title']")?.textContent,
      anchor?.getAttribute("title"),
      anchor?.textContent
    ]);
    const visiblePageText = visibleTextWithoutComments(container).slice(0, 4000);
    const position = container.hasAttribute("is-active") || index === activeIndex
      ? "current"
      : index === activeIndex + 1
        ? "next"
        : "nearby";

    if (!url && !videoId && !title && !visiblePageText) {
      return null;
    }

    return {
      extractionId: videoId ? `video:${videoId}` : url ? `url:${url}` : `text:${plainHash(`${title ?? ""}:${visiblePageText}`)}:${index}`,
      url,
      videoId,
      title,
      channelName: normalizePlain(channel?.textContent ?? "") || null,
      channelUrl: channel?.href ?? null,
      visiblePageText,
      position,
      confidence: confidence({
        url,
        videoId,
        title,
        visiblePageText,
        channelName: channel?.textContent ?? null,
        position
      })
    };
  }

  function firstText(values) {
    for (const value of values) {
      const normalized = normalizePlain(value ?? "");
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  function visibleTextWithoutComments(container) {
    const clone = container.cloneNode(true);
    clone.querySelectorAll("ytd-comments, #comments, [id*='comment'], [class*='comment']").forEach((node) => node.remove());
    return normalizePlain(clone.innerText || clone.textContent || "");
  }

  function plainVideoIdFromUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[0] === "shorts" && parts[1] ? decodeURIComponent(parts[1]) : null;
    } catch {
      return null;
    }
  }

  function confidence(input) {
    let score = 0.2;
    if (input.url) score += 0.2;
    if (input.videoId) score += 0.3;
    if (input.title) score += 0.15;
    if (input.channelName) score += 0.05;
    if (input.visiblePageText) score += 0.05;
    if (input.position === "current" || input.position === "next") score += 0.05;
    return Math.min(1, Number(score.toFixed(2)));
  }

  function dedupePlain(candidates) {
    const seen = new Set();
    const deduped = [];
    for (const candidate of candidates) {
      const key = candidate.videoId ? `video:${candidate.videoId}` : candidate.url ? `url:${candidate.url}` : candidate.extractionId;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(candidate);
    }
    return deduped;
  }

  function normalizePlain(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function plainHash(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}
