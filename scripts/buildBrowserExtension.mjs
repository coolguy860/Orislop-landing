import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repoRoot, "apps", "extension");
const sourceRoot = path.join(extensionRoot, "src");
const distRoot = path.join(extensionRoot, "dist");
const releaseId = "orislop-extension-local-ai-0.2.0-2026-07-11";

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });
mkdirSync(path.join(distRoot, "icons"), { recursive: true });

const files = [
  ["manifest.json", "manifest.json"],
  ["src/aiClassifierModel.generated.js", "aiClassifierModel.generated.js"],
  ["src/controlCore.js", "controlCore.js"],
  ["src/background.js", "background.js"],
  ["src/contentScript.js", "contentScript.js"],
  ["src/contentStyles.css", "contentStyles.css"],
  ["src/popup.html", "popup.html"],
  ["src/popup.css", "popup.css"],
  ["src/popup.js", "popup.js"],
  ["src/icons/icon16.svg", "icons/icon16.svg"],
  ["src/icons/icon32.svg", "icons/icon32.svg"],
  ["src/icons/icon48.svg", "icons/icon48.svg"],
  ["src/icons/icon128.svg", "icons/icon128.svg"],
  ["src/icons/icon256.svg", "icons/icon256.svg"]
];

for (const [from, to] of files) {
  const source = path.join(extensionRoot, from);
  if (!existsSync(source)) {
    throw new Error(`Missing extension source file: ${source}`);
  }
  copyFileSync(source, path.join(distRoot, to));
}

writeFileSync(path.join(distRoot, "release-info.json"), `${JSON.stringify({
  releaseId,
  builtAt: new Date().toISOString(),
  app: "orislop-browser-extension",
  version: "0.2.0",
  requiredQaFixes: [
    "manifest declares 16/32/48/128/256 icons",
    "background scorer includes expanded slop-pattern heuristics",
    "content script scans YouTube cards and current videos",
    "only Skip-rated current videos auto-skip, and only after the user enables auto-skip",
    "Questionable videos are marked for review and are never auto-skipped",
    "AI/synthetic disclosures contribute to local scoring without bypassing user controls",
    "feed cards hide only while feed hiding is enabled",
    "likely bot comments hide only after the user enables comment hiding",
    "visible worker/debug status pill is removed",
    "scan loop is throttled and uses IntersectionObserver when available",
    "candidate scan still caps lookahead at 10 videos",
    "background scoring uses an adaptive worker lane cap instead of a fixed 10-lane loop",
    "video-bound navigation retries cancel after success, video change, or Watch anyway",
    "session revisit suppression and a consecutive-skip limit prevent skip loops",
    "first-run auto-skip and bot-comment hiding are off",
    "setting changes cancel pending skips and restore disabled hidden UI",
    "flagged and skipped history writes are serialized to prevent lost updates",
    "warning UI renders as a side overlay instead of a top banner",
    "content scoring uses local fast path before background scoring",
    "popup preview uses local storage fallback outside extension context",
    "injected controls expose live-region semantics, focus handling, and Escape cancellation",
    "popup switches expose aria-checked state and keyboard focus styling",
    "popup data clearing requires confirmation and reports an accessible status",
    "Orislop AI Classifier v1 runs locally over visible text and metadata",
    "content and background scoring load the canonical generated AI model artifact",
    "missing generated AI model uses an honest heuristic-only fallback",
    "visible metadata is not mislabeled as a transcript source",
    "extension source scores expose heuristic, AI classifier, transcript, channel, and spatiotemporal status",
    "advanced detector escalation flag exists and remains off by default",
    "no remote API calls or model downloads"
  ]
}, null, 2)}\n`);

console.log(`Browser extension build ready: ${distRoot}`);
