import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZipFromDirectoryContents, readZipEntries } from "./lib/zip.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "apps", "web");
const sourceRoot = path.join(webRoot, "src");
const distRoot = path.join(webRoot, "dist");
const assetRoot = path.join(distRoot, "assets");
const downloadsRoot = path.join(distRoot, "downloads");
const tscPath = findTscPath();
const releaseId = "orislop-web-local-ai-polish-2026-07-11";
const modelSource = readFileSync(path.join(repoRoot, "models", "orislop_ai_classifier_v1.json"), "utf8").replace(/\r\n?/g, "\n");
const modelArtifactHash = createHash("sha256").update(modelSource).digest("hex");
const modelFeatureCount = JSON.parse(modelSource).features.length;

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(assetRoot, { recursive: true });
mkdirSync(downloadsRoot, { recursive: true });

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "syncAiClassifierArtifacts.mjs"), "--check"], {
  cwd: repoRoot,
  stdio: "inherit"
});

execFileSync(process.execPath, [tscPath, "-p", path.join(webRoot, "tsconfig.json")], {
  cwd: repoRoot,
  stdio: "inherit"
});

rewriteModuleImports(assetRoot);

const css = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
writeFileSync(path.join(assetRoot, "styles.css"), css);
buildExtensionDownload();
writeReleaseInfo();

writeFileSync(path.join(distRoot, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Orislop is an early static browser prototype for detecting online slop before it wastes your time." />
    <meta name="orislop-release" content="${releaseId}" />
    <title>Orislop</title>
    <link rel="stylesheet" href="./assets/styles.css" />
  </head>
  <body>
    <div id="root">
      <noscript>
        <div class="no-script">Orislop needs JavaScript enabled for the static analyzer demo.</div>
      </noscript>
      <section class="static-load-fallback" aria-live="polite">
        <p class="eyebrow">Orislop preview</p>
        <h1>Serve this build over HTTP.</h1>
        <p>
          If this message stays on screen, the JavaScript module did not load. Do not open
          <code>index.html</code> directly with <code>file://</code>. Run
          <code>pnpm run web:preview</code> and open the printed local URL, or upload the
          build to normal HTTPS hosting.
        </p>
      </section>
    </div>
    <script type="module" src="./assets/main.js"></script>
  </body>
</html>
`);

writeFileSync(path.join(distRoot, "privacy.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Orislop privacy policy for the static web prototype and browser extension." />
    <meta name="orislop-release" content="${releaseId}" />
    <title>Orislop Privacy Policy</title>
    <link rel="stylesheet" href="./assets/styles.css" />
  </head>
  <body>
    <main class="site-shell">
      <section class="panel">
        <p class="eyebrow">Orislop</p>
        <h1>Privacy Policy</h1>
        <p>
          Orislop's static website and unpacked browser-extension prototype are designed to run locally.
          The hosted static site does not require an account, does not include a secret YouTube API key,
          does not scrape comments, and does not upload local video files.
        </p>
        <h2>Static Website</h2>
        <p>
          The analyzer scores YouTube URLs, optional titles, optional descriptions, and demo feed rows in
          your browser. Feedback such as Accurate or Wrong is stored in your browser's local storage on
          your device. The static site does not send those feedback records to an Orislop server.
        </p>
        <h2>Browser Extension</h2>
        <p>
          The extension stores settings, skipped items, and flagged items in Chrome or Edge extension
          storage. These records are local to your browser profile. They are used to show counts and recent
          reasons in the popup.
        </p>
        <h2>Local Video Demo</h2>
        <p>
          The optional local video demo samples a file selected from your device with browser video and
          canvas APIs. It reports simple frame-change, repetition, and pacing metrics locally. It is not the
          full PyTorch temporal detector and does not upload the selected file.
        </p>
        <h2>Deleting Data</h2>
        <p>
          On the website, clear browser site data for the Orislop domain to remove locally stored settings
          and feedback. In the extension popup, use Clear flagged, Clear skipped, or Clear all local Orislop data
          to remove extension logs.
        </p>
        <h2>Prototype Limitations</h2>
        <p>
          This public static build uses transparent heuristics. It can be wrong. It does not run the full
          spatial or temporal PyTorch model, and it should not be treated as a factual deepfake verdict.
        </p>
        <p><a class="primary-link" href="./index.html">Back to Orislop</a></p>
      </section>
    </main>
  </body>
</html>
`);

console.log(`Static web build ready: ${distRoot}`);

function rewriteModuleImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteModuleImports(fullPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    const original = readFileSync(fullPath, "utf8");
    const rewritten = original
      .replace(/from "(\.{1,2}\/[^"]+)(?<!\.js)";/g, 'from "$1.js";')
      .replace(/import\("(\.{1,2}\/[^"]+)(?<!\.js)"\)/g, 'import("$1.js")');
    if (rewritten !== original) {
      writeFileSync(fullPath, rewritten);
    }
  }
}

function buildExtensionDownload() {
  const extensionDist = path.join(repoRoot, "apps", "extension", "dist");
  const zipPath = path.join(downloadsRoot, "orislop-browser-extension.zip");

  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildBrowserExtension.mjs")], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  createZipFromDirectoryContents(extensionDist, zipPath);

  const entries = readZipEntries(zipPath);
  const requiredEntries = [
    "manifest.json",
    "aiClassifierModel.generated.js",
    "background.js",
    "contentScript.js",
    "contentStyles.css",
    "popup.html",
    "popup.css",
    "popup.js",
    "release-info.json"
  ];

  for (const requiredEntry of requiredEntries) {
    if (!entries.includes(requiredEntry)) {
      throw new Error(`Embedded extension ZIP is missing ${requiredEntry}.`);
    }
  }
  if (entries.some((entry) => entry.startsWith("dist/"))) {
    throw new Error("Embedded extension ZIP must contain extension files at the archive root, not under dist/.");
  }

  console.log(`Embedded browser extension ZIP ready: ${zipPath} (${entries.length} files)`);
}

function writeReleaseInfo() {
  writeFileSync(path.join(distRoot, "release-info.json"), `${JSON.stringify({
    releaseId,
    builtAt: new Date().toISOString(),
    app: "orislop-static-web",
    aiClassifierArtifactHash: modelArtifactHash,
    aiClassifierFeatureCount: modelFeatureCount,
    requiredQaFixes: [
      "fail-closed analyzer validation",
      "visible Watch/Questionable/Skip definitions",
      "visible strictness thresholds and multipliers",
      "score breakdown with base points, stacked boost, multiplier, and thresholds",
      "privacy.html included at archive root",
      "downloadable browser extension zip included under downloads/",
      "extension icons include 16/32/48/128/256 SVG sizes",
      "file:// fallback explains that the static app must be served over HTTP",
      "satisfying/ASMR content is calibrated as weaker evidence unless stacked with low-originality signals",
      "Orislop AI Classifier v1 runs locally over text/metadata",
      "AI classifier training excludes heuristic labels so fusion sources remain independent",
      "combined score reports heuristic, AI classifier, transcript, channel, and spatiotemporal source status",
      "primary result stays compact while technical evidence remains available on demand",
      "feedback shows a persistent local selected state",
      "placeholder demo IDs do not issue thumbnail or embed requests"
    ]
  }, null, 2)}\n`);
}

function findTscPath() {
  const candidates = [
    path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js"),
    path.join(repoRoot, "node_modules", ".pnpm", "typescript@6.0.3", "node_modules", "typescript", "lib", "tsc.js")
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("TypeScript is not installed. Run pnpm install from the repo root, then rerun pnpm run web:build.");
  }
  return found;
}
