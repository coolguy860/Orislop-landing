import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repoRoot, "apps", "extension");
const sourceRoot = path.join(extensionRoot, "src");
const distRoot = path.join(extensionRoot, "dist");
const releaseId = "orislop-extension-spatiotemporal-0.4.0-2026-07-13";

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });
mkdirSync(path.join(distRoot, "icons"), { recursive: true });

const files = [
  ["manifest.json", "manifest.json"],
  ["src/aiClassifierModel.generated.js", "aiClassifierModel.generated.js"],
  ["src/classifier.js", "classifier.js"],
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
  version: "0.4.0",
  requiredQaFixes: [
    "manifest declares 16/32/48/128/256 icons",
    "verdicts are binary: Don't skip or Skip",
    "candidate scanning caps lookahead at exactly 10 items",
    "Skip hides items and never emits scroll, wheel, PageDown, ArrowDown, or next-video actions",
    "explicit AI/synthetic disclosures and synthetic narration trigger a non-vetoable 100/100 Skip",
    "all non-AI verdicts come from the required Ollama classifier",
    "gonnerthetooner/orislop-fusion inspects sampled video frames through the local detector bridge",
    "gonnerthetooner/deepfake-temporal-moe inspects short-, mid-, long-, and extra-long frame windows",
    "strong spatial or temporal synthetic-media results trigger a non-vetoable 100/100 Skip",
    "uncached visual scans are queued locally and polled without blocking or scrolling the feed",
    "decisions are cached by stable platform item id for consistent behavior",
    "the yellow decision cover is absolutely constrained to the video or Short surface",
    "YouTube, Instagram Reels, and TikTok adapters are isolated by host",
    "Apache-2.0 Qwen2.5 1.5B Ollama classification uses structured local output",
    "localhost Ollama access is a required host permission rather than an optional toggle",
    "localhost detector bridge access is a required host permission",
    "background and content scoring share the same classifier implementation"
  ]
}, null, 2)}\n`);

console.log(`Browser extension build ready: ${distRoot}`);
