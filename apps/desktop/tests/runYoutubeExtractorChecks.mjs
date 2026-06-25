import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopMockService } from "../electron/desktopService.ts";
import {
  createShortsNavigationObserver
} from "../src/youtube/youtubeNavigationObserver.ts";
import {
  extractHashtags,
  extractShortFromSnapshot,
  findAiDisclosure,
  getYouTubeShortsExtractorScript
} from "../src/youtube/youtubeShortsExtractor.ts";
import {
  parseYouTubeShortsUrl,
  YOUTUBE_SHORTS_HOME_URL
} from "../src/youtube/youtubeUrl.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "orislop-youtube-"));

try {
  await runChecks(tempRoot);
  console.log("Phase 6 YouTube extractor checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runChecks(storagePath) {
  const parsed = parseYouTubeShortsUrl("https://www.youtube.com/shorts/abc_123-XYZ?feature=share");
  assertEqual("Shorts URL detected", parsed.isShortsUrl, true);
  assertEqual("Shorts videoId parsed", parsed.videoId, "abc_123-XYZ");
  assertEqual("Shorts URL normalized", parsed.normalizedUrl, "https://www.youtube.com/shorts/abc_123-XYZ");
  assertEqual("Shorts home is allowed", parseYouTubeShortsUrl(YOUTUBE_SHORTS_HOME_URL).isShortsUrl, true);
  assertEqual("General watch URL rejected", parseYouTubeShortsUrl("https://www.youtube.com/watch?v=abc").isShortsUrl, false);

  const extracted = extractShortFromSnapshot({
    url: "https://www.youtube.com/shorts/ai-explainer",
    titleCandidates: [null, "AI-generated explainer #Transformers"],
    channelCandidates: [{
      name: "Model Notes",
      url: "https://www.youtube.com/@modelnotes"
    }],
    descriptionCandidates: ["Made with AI. A compact lesson. #Education"],
    visibleText: "Altered or synthetic content visible on page #Learn",
    transcriptCandidates: []
  });
  assertEqual("Extracted videoId", extracted.videoId, "ai-explainer");
  assertEqual("Extracted title", extracted.title, "AI-generated explainer #Transformers");
  assertEqual("Extracted channel", extracted.channelName, "Model Notes");
  assertEqual("AI disclosure detected", extracted.hasPlatformAiLabel, true);
  assert(extracted.hashtags.includes("transformers"), "Hashtag from title extracted");
  assert(extracted.hashtags.includes("education"), "Hashtag from description extracted");
  assert(extracted.hashtags.includes("learn"), "Hashtag from visible text extracted");

  const partial = extractShortFromSnapshot({
    url: "https://www.youtube.com/shorts/missing-fields",
    visibleText: ""
  });
  assertEqual("Partial extraction title is null", partial.title, null);
  assertEqual("Partial extraction channel is null", partial.channelName, null);
  assertEqual("Partial extraction transcript is null", partial.transcript, null);
  assertEqual("Partial extraction visible text is safe", partial.visiblePageText, "");

  assert(extractHashtags("#One #two #One").length === 2, "Hashtags are deduplicated");
  assertEqual("AI disclosure helper", findAiDisclosure("Altered or synthetic content"), "Altered");
  assert(getYouTubeShortsExtractorScript().includes("browserExtractCurrentShort"), "Webview extractor script is generated");

  await assertNavigationObserver();

  const service = createDesktopMockService({ storagePath });
  const firstScore = await service.scoreShort({ short: extracted });
  assertEqual("Extracted Short scores through service", firstScore.cacheHit, false);
  assert(firstScore.result.action === "skip" || firstScore.result.action === "warn", "Extracted Short produces an action");
  const cachedScore = await service.scoreShort({ short: extracted });
  assertEqual("Extracted Short reuses cache", cachedScore.cacheHit, true);
  const forcedScore = await service.forceRescan({ short: extracted });
  assertEqual("Extracted Short forceRescan bypasses cache", forcedScore.cacheHit, false);
}

async function assertNavigationObserver() {
  const events = [];
  let currentUrl = "https://www.youtube.com/shorts/first";
  const observer = createShortsNavigationObserver({
    debounceMs: 5,
    getCurrentUrl: () => currentUrl,
    onSettledShortChange: (event) => {
      events.push(event);
    }
  });

  observer.notifyNavigation();
  observer.notifyNavigation();
  await wait(20);
  assertEqual("Debounced navigation fires once", events.length, 1);
  assertEqual("First navigation videoId", events[0].videoId, "first");

  observer.notifyNavigation();
  await wait(20);
  assertEqual("Same video is not rescored endlessly", events.length, 1);

  currentUrl = "https://www.youtube.com/shorts/second";
  observer.notifyNavigation();
  await wait(20);
  assertEqual("New video triggers observer", events.length, 2);
  assertEqual("Second navigation videoId", events[1].videoId, "second");

  observer.analyzeCurrent();
  await wait(20);
  assertEqual("Manual analyze fallback can rescore same video", events.length, 3);
  observer.dispose();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, label) {
  if (!condition) {
    throw new Error(`${label}: assertion failed.`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}.`);
  }
}
