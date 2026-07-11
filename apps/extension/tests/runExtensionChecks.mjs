import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distRoot = path.join(repoRoot, "apps", "extension", "dist");

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildBrowserExtension.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});

const requiredFiles = [
  "manifest.json",
  "aiClassifierModel.generated.js",
  "controlCore.js",
  "background.js",
  "contentScript.js",
  "contentStyles.css",
  "icons/icon16.svg",
  "icons/icon32.svg",
  "icons/icon48.svg",
  "icons/icon128.svg",
  "icons/icon256.svg",
  "release-info.json",
  "popup.html",
  "popup.css",
  "popup.js"
];

for (const file of requiredFiles) {
  assert.ok(existsSync(path.join(distRoot, file)), `Expected ${file} in extension dist`);
}

const manifest = JSON.parse(readFileSync(path.join(distRoot, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.2.0");
assert.deepEqual(manifest.permissions, ["storage"]);
assert.ok(manifest.host_permissions.includes("https://www.youtube.com/*"));
assert.ok(manifest.content_scripts[0].matches.includes("https://www.youtube.com/*"));
assert.deepEqual(manifest.content_scripts[0].js, ["aiClassifierModel.generated.js", "controlCore.js", "contentScript.js"]);
assert.ok(manifest.content_scripts[0].css.includes("contentStyles.css"));
assert.equal(manifest.background.service_worker, "background.js");
assert.equal(manifest.icons["16"], "icons/icon16.svg");
assert.equal(manifest.icons["32"], "icons/icon32.svg");
assert.equal(manifest.icons["48"], "icons/icon48.svg");
assert.equal(manifest.icons["128"], "icons/icon128.svg");
assert.equal(manifest.icons["256"], "icons/icon256.svg");
assert.equal(manifest.action.default_icon["48"], "icons/icon48.svg");
assert.equal(manifest.action.default_icon["128"], "icons/icon128.svg");

const contentScript = readFileSync(path.join(distRoot, "contentScript.js"), "utf8");
const generatedAiModel = readFileSync(path.join(distRoot, "aiClassifierModel.generated.js"), "utf8");
const contentStyles = readFileSync(path.join(distRoot, "contentStyles.css"), "utf8");
assert.doesNotThrow(() => new Function(contentScript), "content script should parse as JavaScript");
assert.ok(contentScript.includes("MutationObserver"));
assert.ok(contentScript.includes("orislop-hidden-card"));
assert.ok(contentScript.includes("orislop-callout-card"));
assert.ok(!contentScript.includes("orislop-status-pill"), "content script should not render the old worker/debug status pill");
assert.ok(contentScript.includes("orislop-autoskip-toast"));
assert.ok(contentScript.includes("chrome.storage.local"));
assert.ok(contentScript.includes("scoreStaticSlop"));
assert.ok(contentScript.includes("orislop.extension.skippedLog"));
assert.ok(contentScript.includes("orislop.extension.settings"));
assert.ok(contentScript.includes("attemptAutoSkip"));
assert.ok(contentScript.includes("showCurrentSkipShield"));
assert.ok(contentScript.includes("CURRENT_SKIP_SHIELD_ID"));
assert.ok(contentScript.includes("auto_skipped_short"));
assert.ok(contentScript.includes("auto_skipped_watch"));
assert.ok(contentScript.includes("hidden_bot_comment"));
assert.ok(contentScript.includes("hidden_card"));
assert.ok(contentScript.includes("LOOKAHEAD_LIMIT"));
assert.ok(contentScript.includes("MAX_SCAN_PER_PASS = 28"));
assert.ok(contentScript.includes("COMMENT_SCAN_LIMIT = 10"));
assert.ok(contentScript.includes("SCAN_DEBOUNCE_MS = 280"));
assert.ok(contentScript.includes("WORKER_POOL_SIZE"));
assert.ok(contentScript.includes("Math.min(4"));
assert.ok(contentScript.includes("IntersectionObserver"));
assert.ok(contentScript.includes("observeCandidateElements"));
assert.ok(contentScript.includes('backgroundScoringState = "unknown"'));
assert.ok(contentScript.includes("backgroundRetryAfter"));
assert.ok(contentScript.includes("BACKGROUND_RESPONSE_TIMEOUT_MS"));
assert.ok(contentScript.includes("orislop-ai-classifier-v1"));
assert.ok(contentScript.includes("AI_MODEL_INTERCEPT"));
assert.ok(contentScript.includes("globalThis.ORISLOP_AI_CLASSIFIER_V1"));
assert.ok(generatedAiModel.includes('"trainingExamples": 111'));
assert.ok(contentScript.includes("aiClassifierUsed"));
assert.ok(contentScript.includes("spatiotemporalUsed: false"));
assert.ok(contentScript.includes("sourceScores"));
assert.ok(contentScript.includes("findChannelName"));
assert.ok(contentScript.includes("findDurationSeconds"));
assert.ok(contentScript.includes("advancedDetection"));
assert.ok(contentScript.includes("BOT_COMMENT_RULES"));
assert.ok(contentScript.includes("scanLikelyBotComments"));
assert.ok(contentScript.includes("scoreBotComment"));
assert.ok(contentScript.includes("hideBotComment"));
assert.ok(contentScript.includes("hideBotComments"));
assert.ok(contentScript.includes("orislop-side-callout-host"));
assert.ok(!contentScript.includes("Warning-level auto-skip"));
assert.ok(!contentScript.includes("if (settingsCache.autoSkip ||"));
assert.ok(!contentScript.includes("workers ${"), "content script should not display worker count UI");
assert.ok(contentScript.includes("findLookaheadCandidateElements"));
assert.ok(contentScript.includes("scoreWithWorkers"));
assert.ok(contentScript.includes("signalBreakdown"));
assert.ok(contentScript.includes("isSongOrLyricsContext"));
assert.ok(contentScript.includes("orislop.scoreBatch"));
assert.ok(contentScript.includes("sendScoreBatchToBackground"));
assert.ok(!contentScript.includes("new Worker"), "content scripts should not create page-origin workers on YouTube");
assert.ok(contentScript.includes("scanQueued"), "scan events during active worker scoring should be queued");
assert.ok(contentScript.includes("isCurrentVideoCandidate"), "current videos should skip instead of being hidden in place");
assert.ok(contentScript.includes("preSkipScores"), "nearby Shorts should be pre-marked instead of hidden before they become current");
assert.ok(contentScript.includes("pre_skip"));
assert.ok(contentScript.includes("isActiveShortsScrollerCandidate"));
assert.ok(contentScript.includes("Auto-skip started for a Skip-rated video"));
assert.ok(contentScript.includes("ArrowDown"));
assert.ok(contentScript.includes("PageDown"));
assert.ok(contentScript.includes("WheelEvent"));
assert.ok(contentScript.includes(".ytp-next-button"));
assert.ok(contentScript.includes("SIGNATURE_ATTR"), "cards must be rescored when YouTube loads metadata late");
assert.ok(contentScript.includes("yt-page-data-updated"), "YouTube navigation/data updates should trigger rescans");
assert.ok(contentScript.includes("altered or synthetic content"), "platform AI disclosure text should be detected");
assert.ok(contentScript.includes("findVisibleAiDisclosureText"), "content script should extract visible AI disclosures");
assert.ok(contentScript.includes("hasPlatformAiDisclosure"), "content script should hard-detect AI disclosure text");
assert.ok(contentScript.includes("YouTube AI/synthetic disclosure"));
assert.ok(contentScript.includes("significantly edited or digitally generated"));
assert.ok(contentScript.includes("generated by ai"));
assert.ok(contentScript.includes('aria-live", "assertive"'));
assert.ok(contentScript.includes("handleEscapeKey"));
assert.ok(contentScript.includes("restoreHiddenCards"));
assert.ok(contentScript.includes("restoreHiddenComments"));
assert.ok(contentScript.includes("historyWriter.append"));
assert.ok(contentScript.includes("ytd-rich-grid-media"), "newer YouTube rich-grid cards should be scanned");
assert.ok(!contentScript.includes("fetch("), "Extension must not call remote APIs");
assert.ok(contentStyles.includes(".orislop-side-callout-host"));
assert.ok(contentStyles.includes("position: absolute"));
assert.ok(contentStyles.includes("right: 8px"));
assert.ok(!contentStyles.includes("orislop-status-pill"));

const extensionRuntime = createContentScriptRuntime({ generatedAiModel, contentScript });
const obviousSlop = extensionRuntime.scoreOneCandidate({
  url: "https://www.youtube.com/shorts/abcdefghijk",
  title: "AI voice Reddit story over Minecraft parkour",
  visibleText: "Text to speech over looping gameplay. Follow for part 2.",
  channelName: "Story Bot",
  durationSeconds: 58
});
assert.equal(obviousSlop.aiClassifierUsed, true, "Extension must load the generated AI artifact");
assert.equal(obviousSlop.aiClassifier.modelId, "orislop-ai-classifier-v1");
assert.equal(obviousSlop.recommendation, "skip");
assert.ok(obviousSlop.sourceScores.aiClassifier >= 60);

const usefulVideo = extensionRuntime.scoreOneCandidate({
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  title: "How rainfall forms in mountain regions",
  visibleText: "A sourced science lesson explaining evaporation and condensation.",
  channelName: "Earth Science Lab",
  durationSeconds: 480
});
assert.equal(usefulVideo.aiClassifierUsed, true);
assert.equal(usefulVideo.recommendation, "watch");

const fallbackRuntime = createContentScriptRuntime({ generatedAiModel: null, contentScript });
const fallbackScore = fallbackRuntime.scoreOneCandidate({
  url: "https://www.youtube.com/shorts/abcdefghijk",
  title: "AI voice Reddit story over Minecraft parkour",
  visibleText: "Text to speech over looping gameplay.",
  channelName: "Story Bot",
  durationSeconds: 58
});
assert.equal(fallbackScore.aiClassifierUsed, false, "Missing generated model must use an honest heuristic fallback");
assert.equal(fallbackScore.sourceScores.aiClassifier, null);
assert.ok(fallbackScore.fallbackReasons.some((reason) => reason.includes("not loaded")));

const background = readFileSync(path.join(distRoot, "background.js"), "utf8");
assert.doesNotThrow(() => new Function(background), "background script should parse as JavaScript");
assert.ok(background.includes("chrome.runtime.onMessage"));
assert.ok(background.includes('importScripts("aiClassifierModel.generated.js")'));
assert.ok(background.includes("globalThis.ORISLOP_AI_CLASSIFIER_V1"));
assert.ok(background.includes("Math.min(4"));
assert.ok(background.includes("orislop.scoreBatch"));
assert.ok(background.includes("orislop-ai-classifier-v1"));
assert.ok(background.includes("aiClassifierUsed"));
assert.ok(background.includes("spatiotemporalUsed: false"));
assert.ok(background.includes("sourceScores"));
assert.ok(background.includes("scoreBatch"));
assert.ok(background.includes("altered or synthetic content"));
assert.ok(background.includes("significantly edited or digitally generated"));
assert.ok(background.includes("generated by ai"));
assert.ok(background.includes("weight: 100"));
assert.ok(background.includes("Reddit/TTS background-video format"));
assert.ok(background.includes("AI voice or synthetic narration"));
assert.ok(background.includes("Stacked slop-format pattern"));
assert.ok(background.includes("Long low-originality compilation"));
assert.ok(background.includes("Satisfying/ASMR filler context"));
assert.ok(background.includes("THRESHOLDS"));
assert.ok(background.includes("signalBreakdown"));
assert.ok(background.includes("isSongOrLyricsContext"));
assert.ok(!background.includes("fetch("), "Background scorer must not call remote APIs");

const popupHtml = readFileSync(path.join(distRoot, "popup.html"), "utf8");
assert.ok(popupHtml.includes("autoSkipToggle"));
assert.ok(popupHtml.includes("hideFeedCardsToggle"));
assert.ok(popupHtml.includes("hideBotCommentsToggle"));
assert.ok(popupHtml.includes("advancedDetectionToggle"));
assert.ok(popupHtml.includes("role=\"switch\""));
assert.ok(popupHtml.includes("aria-label=\"Hide likely bot comments\""));
assert.ok(popupHtml.includes("skippedList"));
assert.ok(popupHtml.includes("flaggedList"));
assert.ok(popupHtml.includes("clearAllDataButton"));
assert.ok(popupHtml.includes("clearConfirmation"));
assert.ok(popupHtml.includes('role="status"'));
assert.ok(popupHtml.includes("contextWarning"));
assert.ok(popupHtml.includes("YouTube scanning is unavailable"));
assert.ok(popupHtml.includes("apps/extension/dist"));
assert.ok(popupHtml.includes("orislop-fusion"));
assert.ok(popupHtml.includes("deepfake-temporal-moe"));

const popupJs = readFileSync(path.join(distRoot, "popup.js"), "utf8");
assert.doesNotThrow(() => new Function(popupJs), "popup script should parse as JavaScript");
assert.ok(popupJs.includes("orislop.extension.skippedLog"));
assert.ok(popupJs.includes("orislop.extension.settings"));
assert.ok(popupJs.includes("hideBotComments"));
assert.ok(popupJs.includes("advancedDetection"));
assert.ok(popupJs.includes("createStorageAdapter"));
assert.ok(popupJs.includes("localStorage"));
assert.ok(popupJs.includes("renderFlaggedList"));
assert.ok(popupJs.includes("PREVIEW_FLAGGED_SAMPLE"));
assert.ok(popupJs.includes("PREVIEW_SKIPPED_SAMPLE"));
assert.ok(popupJs.includes("setToggleState"));
assert.ok(popupJs.includes("aria-checked"));
assert.ok(popupJs.includes("requestClear"));
assert.ok(popupJs.includes("confirmClear"));
assert.ok(popupJs.includes("setStatus"));

const popupCss = readFileSync(path.join(distRoot, "popup.css"), "utf8");
assert.ok(popupCss.includes(":focus-visible"));
assert.ok(popupCss.includes(":focus-within"));

const releaseInfo = JSON.parse(readFileSync(path.join(distRoot, "release-info.json"), "utf8"));
assert.equal(releaseInfo.version, "0.2.0");
assert.ok(releaseInfo.requiredQaFixes.includes("manifest declares 16/32/48/128/256 icons"));
assert.ok(releaseInfo.requiredQaFixes.includes("only Skip-rated current videos auto-skip, and only after the user enables auto-skip"));
assert.ok(releaseInfo.requiredQaFixes.includes("Questionable videos are marked for review and are never auto-skipped"));
assert.ok(releaseInfo.requiredQaFixes.includes("AI/synthetic disclosures contribute to local scoring without bypassing user controls"));
assert.ok(releaseInfo.requiredQaFixes.includes("first-run auto-skip and bot-comment hiding are off"));
assert.ok(releaseInfo.requiredQaFixes.includes("visible worker/debug status pill is removed"));
assert.ok(releaseInfo.requiredQaFixes.includes("warning UI renders as a side overlay instead of a top banner"));
assert.ok(releaseInfo.requiredQaFixes.includes("scan loop is throttled and uses IntersectionObserver when available"));
assert.ok(releaseInfo.requiredQaFixes.includes("popup switches expose aria-checked state and keyboard focus styling"));
assert.ok(releaseInfo.requiredQaFixes.includes("Orislop AI Classifier v1 runs locally over visible text and metadata"));
assert.ok(releaseInfo.requiredQaFixes.includes("content and background scoring load the canonical generated AI model artifact"));
assert.ok(releaseInfo.requiredQaFixes.includes("missing generated AI model uses an honest heuristic-only fallback"));
assert.ok(releaseInfo.requiredQaFixes.includes("advanced detector escalation flag exists and remains off by default"));

console.log("extension checks passed");

function createContentScriptRuntime({ generatedAiModel, contentScript }) {
  const context = vm.createContext({
    URL,
    console,
    navigator: { hardwareConcurrency: 4 },
    __ORISLOP_TEST__: true
  });
  context.globalThis = context;
  if (generatedAiModel) {
    vm.runInContext(generatedAiModel, context, { filename: "aiClassifierModel.generated.js" });
  }
  vm.runInContext(contentScript, context, { filename: "contentScript.js" });
  return context.__ORISLOP_EXTENSION_TEST_API__;
}
