import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distRoot = path.join(repoRoot, "apps", "extension", "dist");

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildBrowserExtension.mjs")], { cwd: repoRoot, stdio: "inherit" });

const requiredFiles = [
  "manifest.json", "aiClassifierModel.generated.js", "classifier.js", "controlCore.js", "background.js",
  "contentScript.js", "contentStyles.css", "popup.html", "popup.css", "popup.js", "release-info.json",
  "icons/icon16.svg", "icons/icon32.svg", "icons/icon48.svg", "icons/icon128.svg", "icons/icon256.svg"
];
for (const file of requiredFiles) assert.ok(existsSync(path.join(distRoot, file)), `Expected ${file} in extension dist`);

const manifest = readJson("manifest.json");
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.4.0");
assert.deepEqual(manifest.permissions, ["storage"]);
for (const origin of ["https://www.youtube.com/*", "https://www.instagram.com/*", "https://www.tiktok.com/*"]) {
  assert.ok(manifest.host_permissions.includes(origin), `host permission missing: ${origin}`);
  assert.ok(manifest.content_scripts[0].matches.includes(origin), `content-script match missing: ${origin}`);
}
assert.ok(manifest.host_permissions.includes("http://127.0.0.1:11434/*"));
assert.ok(manifest.host_permissions.includes("http://127.0.0.1:4317/*"));
assert.equal(manifest.optional_host_permissions, undefined, "Ollama localhost access must be required, not optional");
assert.deepEqual(manifest.content_scripts[0].js, ["aiClassifierModel.generated.js", "classifier.js", "controlCore.js", "contentScript.js"]);

const generatedModel = read("aiClassifierModel.generated.js");
const classifierSource = read("classifier.js");
const controlCoreSource = read("controlCore.js");
const contentSource = read("contentScript.js");
const styles = read("contentStyles.css");
const background = read("background.js");
const popupHtml = read("popup.html");
const popupJs = read("popup.js");

for (const [name, source] of [["classifier", classifierSource], ["control core", controlCoreSource], ["content script", contentSource], ["background", background], ["popup", popupJs]]) {
  assert.doesNotThrow(() => new Function(source), `${name} should parse as JavaScript`);
}

const classifier = createClassifierRuntime(generatedModel, classifierSource);
const obviousSlop = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "slop123",
  url: "https://www.youtube.com/shorts/slop123",
  title: "AI voice Reddit story over Minecraft parkour",
  visibleText: "Text to speech over looping gameplay. Follow for part 2.",
  channelName: "Story Bot"
});
assert.equal(obviousSlop.recommendation, "skip");
assert.equal(obviousSlop.score, 100);
assert.equal(obviousSlop.hardAiSynthetic, true);
assert.ok(obviousSlop.strongEvidenceCount >= 2);

const recycledAiClips = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "clips123",
  url: "https://www.tiktok.com/@farm/video/clips123",
  title: "Viral clips compilation",
  visibleText: "AI voice narration. Reposted clips with no commentary.",
  channelName: "Viral Vault"
});
assert.equal(recycledAiClips.recommendation, "skip");

const educationalShort = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "edu123",
  url: "https://www.youtube.com/shorts/edu123",
  title: "How black holes bend light",
  visibleText: "A physics professor explains gravitational lensing with evidence and a classroom diagram.",
  channelName: "Minute Science Lab"
});
assert.equal(educationalShort.recommendation, "watch");
assert.equal(educationalShort.educationalProtected, true);

const aiDisclosureOnly = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "art123",
  url: "https://www.youtube.com/shorts/art123",
  title: "Animating a watercolor landscape",
  visibleText: "Created or altered with AI. Original artist process and commentary.",
  channelName: "Mira Studio"
});
assert.equal(aiDisclosureOnly.recommendation, "skip", "AI disclosure must trigger the hard Skip override");
assert.equal(aiDisclosureOnly.score, 100);
assert.equal(aiDisclosureOnly.hardAiSynthetic, true);

const explicitAiGenerated = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "aicat123",
  url: "https://www.tiktok.com/@farm/video/aicat123",
  title: "AI generated cat video",
  visibleText: "Made with AI",
  channelName: "Cat Factory"
});
assert.equal(explicitAiGenerated.recommendation, "skip");
assert.equal(explicitAiGenerated.score, 100);

const normalPersonalShort = classifier.scoreCandidate({
  platform: "instagram",
  itemId: "normal123",
  url: "https://www.instagram.com/reel/normal123/",
  title: "Morning run",
  visibleText: "A quick clip from my trail run before work.",
  channelName: "maya"
});
assert.equal(normalPersonalShort.recommendation, "watch", "short or ordinary titles must stay visible");

const protectedByOllama = classifier.mergeOllamaDecision(obviousSlop, {
  available: true, verdict: "dont_skip", confidence: 0.9, reason: "Original educational commentary was detected"
});
assert.equal(protectedByOllama.recommendation, "skip", "Ollama cannot veto the hard AI/synthetic rule");
assert.equal(protectedByOllama.score, 100);
assert.equal(protectedByOllama.ollamaUsed, false);

const nonAiSlop = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "farm123",
  url: "https://www.youtube.com/shorts/farm123",
  title: "Reddit story over Minecraft parkour",
  visibleText: "Follow for part two. Wait for the ending.",
  channelName: "Story Vault"
});
assert.equal(nonAiSlop.recommendation, "watch", "non-AI heuristics must wait for required Ollama");
const ollamaSkipped = classifier.mergeOllamaDecision(nonAiSlop, {
  available: true, verdict: "skip", confidence: 0.82, reason: "Recycled story over unrelated gameplay"
});
assert.equal(ollamaSkipped.recommendation, "skip");
assert.equal(ollamaSkipped.ollamaUsed, true);

const detectorSkipped = classifier.mergeDetectorDecision(educationalShort, {
  status: "ready",
  synthetic: true,
  score: 84,
  reason: "Temporal detector found synthetic video patterns",
  spatial: { available: true, ai_probability: 0.71 },
  temporal: { available: true, fake_probability: 0.84 }
});
assert.equal(detectorSkipped.recommendation, "skip", "visual synthetic detection must override educational/text protection");
assert.equal(detectorSkipped.score, 100);
assert.equal(detectorSkipped.hardAiSynthetic, true);
assert.equal(detectorSkipped.visualAiSynthetic, true);

const detectorKept = classifier.mergeDetectorDecision(ollamaSkipped, {
  status: "ready",
  synthetic: false,
  score: 18,
  reason: "No strong synthetic-media signal",
  spatial: { available: true, ai_probability: 0.15 },
  temporal: { available: true, fake_probability: 0.2 }
});
assert.equal(detectorKept.recommendation, "skip", "visual detector must not veto an Ollama slop verdict");
assert.equal(detectorKept.detectorUsed, true);

const detectorPending = classifier.mergeDetectorDecision(normalPersonalShort, { status: "pending" });
assert.equal(detectorPending.recommendation, "watch");
assert.equal(detectorPending.detectorStatus, "pending");

const parsedInstagram = classifier.parsePlatformUrl("https://www.instagram.com/reel/C123abc/", "instagram");
const parsedTikTok = classifier.parsePlatformUrl("https://www.tiktok.com/@person/video/741234567890", "tiktok");
assert.equal(parsedInstagram.itemId, "C123abc");
assert.equal(parsedInstagram.itemKind, "short");
assert.equal(parsedTikTok.itemId, "741234567890");

const core = createCoreRuntime(controlCoreSource);
const cache = core.createDecisionCache({ limit: 2 });
cache.set("youtube:a", obviousSlop);
assert.equal(cache.get("youtube:a").recommendation, "skip");
cache.allow("youtube:a");
assert.equal(cache.get("youtube:a"), null);
assert.equal(cache.isAllowed("youtube:a"), true);

assert.ok(contentSource.includes("LOOKAHEAD_LIMIT = 10"));
assert.ok(contentSource.includes("decisionCache.get"));
assert.ok(contentSource.includes("DETECTOR_STATUS_KEY"));
assert.ok(contentSource.includes("mediaUrl"));
assert.ok(contentSource.includes("orislop-skip-hidden"));
assert.ok(contentSource.includes("Don't skip"));
assert.ok(contentSource.includes("Instagram".toLowerCase()) || contentSource.includes('platform === "instagram"'));
assert.ok(contentSource.includes('platform === "tiktok"'));
assert.ok(!contentSource.includes("WheelEvent"));
assert.ok(!contentSource.includes("PageDown"));
assert.ok(!contentSource.includes("ArrowDown"));
assert.ok(!contentSource.includes("scrollIntoView"));
assert.ok(!contentSource.includes("attemptAutoSkip"));
assert.ok(!contentSource.includes("questionable"));
assert.ok(!contentSource.includes("ollamaEnabled"));

assert.ok(styles.includes(".orislop-decision-cover"));
assert.ok(styles.includes("position: absolute"));
assert.ok(styles.includes("inset: 0"));
assert.ok(!styles.includes("position: fixed"), "the yellow cover must never cover the viewport");

assert.ok(background.includes('http://127.0.0.1:11434'));
assert.ok(background.includes('http://127.0.0.1:4317'));
assert.ok(background.includes('mergeDetectorDecision'));
assert.ok(background.includes("format: schema"));
assert.ok(background.includes("temperature: 0"));
assert.ok(background.includes("dont_skip"));
assert.ok(background.includes("required Orislop classifier"));
assert.ok(!/https:\/\//.test(background), "background must not call any remote HTTPS API");

assert.ok(popupHtml.includes("Don't skip"));
assert.ok(popupHtml.includes("Skip"));
assert.ok(popupHtml.includes("hideSkippedToggle"));
assert.ok(popupHtml.includes("Local engines required"));
assert.ok(popupHtml.includes("gonnerthetooner/orislop-fusion"));
assert.ok(popupHtml.includes("deepfake-temporal-moe"));
assert.ok(popupHtml.includes("testDetectorButton"));
assert.ok(!popupHtml.includes("ollamaToggle"));
assert.ok(popupHtml.includes("qwen2.5:1.5b-instruct"));
assert.ok(!popupHtml.toLowerCase().includes("questionable"));
assert.ok(!popupHtml.includes("autoSkipToggle"));
assert.ok(!popupJs.includes("chrome.permissions.request"));

const releaseInfo = readJson("release-info.json");
assert.equal(releaseInfo.version, "0.4.0");
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("exactly 10")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("never emits scroll")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("required Ollama classifier")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("100/100 Skip")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("orislop-fusion")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("deepfake-temporal-moe")));

console.log("extension checks passed");

function read(file) {
  return readFileSync(path.join(distRoot, file), "utf8");
}

function readJson(file) {
  return JSON.parse(read(file));
}

function createClassifierRuntime(modelSource, source) {
  const context = vm.createContext({ URL, console });
  context.globalThis = context;
  vm.runInContext(modelSource, context, { filename: "aiClassifierModel.generated.js" });
  vm.runInContext(source, context, { filename: "classifier.js" });
  return context.OrislopClassifier;
}

function createCoreRuntime(source) {
  const context = vm.createContext({ console, setTimeout, clearTimeout });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "controlCore.js" });
  return context.OrislopExtensionCore;
}
