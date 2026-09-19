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

// Recreate derived classifier sources in the build environment. Exact floating-point
// serialization can differ between Node patch releases, so a source checkout that
// passes locally may otherwise fail on Vercel before TypeScript compilation.
execFileSync(process.execPath, [path.join(repoRoot, "scripts", "syncAiClassifierArtifacts.mjs")], {
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
    <meta name="description" content="Orislop privacy policy for the website and YouTube browser extension." />
    <meta name="orislop-release" content="${releaseId}" />
    <title>Orislop Privacy Policy</title>
    <link rel="stylesheet" href="./assets/styles.css" />
  </head>
  <body>
    <main class="site-shell">
      <section class="panel">
        <p class="eyebrow">Orislop</p>
        <h1>Privacy Policy</h1>
        <p><strong>Last updated: September 18, 2026</strong></p>
        <p>
          This policy explains what the Orislop website and YouTube extension handle. The website demo stays in
          your browser. The extension stores your preferences and recent activity in Chrome, and sends only the
          YouTube and account data needed to run signed-in visual checks.
        </p>
        <h2>The Website</h2>
        <p>
          The website does not require an account. YouTube links, titles, descriptions, transcripts, sample-feed
          rows, local videos, and feedback entered into the website tools are processed in your browser. Local
          videos are not uploaded. The static site does not send those tool inputs or feedback records to the
          Orislop API.
        </p>
        <h2>What the Extension Keeps in Chrome</h2>
        <p>
          The extension stores whether filtering is on, your 12 filter choices, display and performance settings,
          account details shown in the popup, authentication tokens, and a recent activity history capped at 300
          records. An activity record can include a YouTube item ID or derived key, URL, title, score, short reason,
          duration, timestamp, and whether the item was hidden or shown again. You can clear local Orislop data
          from the popup.
        </p>
        <h2>What the Orislop API Receives</h2>
        <p>
          Extension 1.4.0 runs only on YouTube and YouTube Shorts. For a deeper check, it can send the YouTube item
          identifier, a temporary public media URL or one-time upload ID, duration, playback position, language,
          lookahead priority, and a small device-capability summary to https://api.orislop.com. Requests use a
          short-lived signed-in session. No permanent backend secret is stored in the extension.
        </p>
        <p>
          Orislop does not receive your Google password, browser cookies, private messages, or activity on unrelated
          sites. This release does not request access to Instagram, TikTok, or LinkedIn.
        </p>
        <h2>Account and Service Records</h2>
        <p>
          Google sign-in provides a Google account identifier, email address, and display name. Orislop stores these
          in its account database to identify the account and enforce per-user quotas. It also stores hashed session
          credentials, quota timestamps, analysis and filtering decisions tied to an HMAC-derived content key, and
          feedback you choose to send. The raw media URL is not written into the decision table.
        </p>
        <h2>How Long Data Is Kept</h2>
        <ul>
          <li>Access tokens expire after 15 minutes. Refresh sessions expire after 30 days.</li>
          <li>Operational analysis and filtering decision records expire after 30 days.</li>
          <li>Feedback and security/audit records associated with feedback expire after 90 days.</li>
          <li>Quota timestamps older than two days and service rollout records older than 30 days are removed during later service activity.</li>
          <li>A fallback media upload can wait in temporary storage for up to 10 minutes. Once attached to a decision, the analysis copy is kept for no more than 60 seconds.</li>
        </ul>
        <p>
          Expired database rows are removed by later service activity, so cleanup may happen after the listed window
          rather than at the exact second it expires. Session rows remain until account deletion even after the
          session can no longer be used.
        </p>
        <h2>Diagnostic Clips</h2>
        <p>
          Ordinary analysis media is not placed in Orislop's diagnostic bucket. If an explicit diagnostic report
          requests a clip, the service can keep at most eight seconds at 360p, with audio removed and encryption at
          rest, for seven days. The normal extension feedback flow does not request diagnostic clips.
        </p>
        <h2>Service Providers and Security</h2>
        <p>
          Production can use Google for sign-in, Cloudflare for HTTPS and tunnel routing, a GPU hosting provider for
          analysis, Postgres for account and service records, S3-compatible storage for explicitly requested
          diagnostic clips, and Hugging Face to download private model files during worker setup. Information is
          encrypted in transit. Cloudflare and hosting providers may keep infrastructure logs under their own
          settings and policies.
        </p>
        <h2>Fact Checking</h2>
        <p>
          When source-backed fact checking is configured, the selected service sends a claim search query to Brave
          Search or Google Fact Check. Provider keys stay on the server. Search results can include source titles,
          links, snippets, ratings, and an evidence decision. Media, cookies, and browsing credentials are not sent
          with the search query.
        </p>
        <h2>Your Choices and Deletion</h2>
        <p>
          Clear local extension records from the popup. Delete your cloud account from the account controls to remove
          the account and its linked sessions, decisions, feedback, and quota records. Signing out only revokes the
          current session; it is not account deletion. Clear site data for the Orislop domain to remove website data.
        </p>
        <h2>Use and Sharing</h2>
        <p>
          Orislop does not sell user data or use it for behavioral advertising. Information received from Chrome APIs
          is used only to provide and improve Orislop's user-facing filtering features. Orislop's use and transfer of
          information received from Google APIs follows the Google API Services User Data Policy, including the
          Limited Use requirements.
        </p>
        <h2>Contact</h2>
        <p>
          For privacy questions or a deletion request, contact Orislop through the support contact listed in the
          Chrome Web Store listing for the installed extension.
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
