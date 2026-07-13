import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries, readZipEntry } from "./lib/zip.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteZip = path.join(repoRoot, "dist", "orislop-namecheap-static.zip");
const extensionZip = path.join(repoRoot, "dist", "orislop-browser-extension.zip");
const embeddedExtensionZip = path.join(repoRoot, "apps", "web", "dist", "downloads", "orislop-browser-extension.zip");
const webDist = path.join(repoRoot, "apps", "web", "dist");
const extensionDist = path.join(repoRoot, "apps", "extension", "dist");

assertFile(siteZip, "static website deploy ZIP");
assertFile(extensionZip, "browser extension ZIP");
assertFile(embeddedExtensionZip, "embedded extension ZIP in web build");

const siteEntries = readZipEntries(siteZip);
const extensionEntries = readZipEntries(extensionZip);
const embeddedExtensionEntries = readZipEntries(embeddedExtensionZip);

assertRequiredEntries("static website ZIP", siteEntries, [
  "index.html",
  "privacy.html",
  "release-info.json",
  "assets/App.js",
  "assets/styles.css",
  "downloads/orislop-browser-extension.zip"
]);

assertRequiredEntries("browser extension ZIP", extensionEntries, [
  "manifest.json",
  "aiClassifierModel.generated.js",
  "background.js",
  "contentScript.js",
  "contentStyles.css",
  "popup.html",
  "popup.css",
  "popup.js",
  "release-info.json",
  "icons/icon16.svg",
  "icons/icon32.svg",
  "icons/icon48.svg",
  "icons/icon128.svg",
  "icons/icon256.svg"
]);

assertRequiredEntries("embedded browser extension ZIP", embeddedExtensionEntries, [
  "manifest.json",
  "aiClassifierModel.generated.js",
  "release-info.json",
  "icons/icon128.svg",
  "icons/icon256.svg"
]);

assertNoForbiddenEntries("browser extension ZIP", extensionEntries, [
  /^node_modules\//i,
  /^\.git\//i,
  /\.env($|\.)/i,
  /\.map$/i,
  /(^|\/)tests?\//i,
  /(^|\/)src\//i,
  /checkpoint/i,
  /pytorch_model/i,
  /model\.safetensors/i
]);

assertNoForbiddenEntries("static website ZIP", siteEntries, [
  /^node_modules\//i,
  /^\.git\//i,
  /\.env($|\.)/i,
  /\.map$/i,
  /^apps\//i,
  /^packages\//i,
  /^scripts\//i,
  /checkpoint/i,
  /pytorch_model/i,
  /model\.safetensors/i
]);

const webRelease = readZipJson(siteZip, "release-info.json");
assert.equal(webRelease.releaseId, "orislop-web-local-ai-polish-2026-07-11");
assert.ok(webRelease.requiredQaFixes.includes("fail-closed analyzer validation"));
assert.ok(webRelease.requiredQaFixes.includes("score breakdown with base points, stacked boost, multiplier, and thresholds"));
assert.ok(webRelease.requiredQaFixes.includes("file:// fallback explains that the static app must be served over HTTP"));
assert.ok(webRelease.requiredQaFixes.includes("Orislop AI Classifier v1 runs locally over text/metadata"));
assert.equal(webRelease.aiClassifierFeatureCount, 220);
assert.match(webRelease.aiClassifierArtifactHash, /^[a-f0-9]{64}$/);

const extensionRelease = readZipJson(extensionZip, "release-info.json");
assert.equal(extensionRelease.version, "0.4.0");
assert.equal(extensionRelease.releaseId, "orislop-extension-spatiotemporal-0.4.0-2026-07-13");
assert.ok(Array.isArray(extensionRelease.requiredQaFixes) && extensionRelease.requiredQaFixes.length > 0);

const manifest = readZipJson(extensionZip, "manifest.json");
assert.equal(manifest.version, "0.4.0");
assert.equal(manifest.icons["128"], "icons/icon128.svg");
assert.equal(manifest.icons["256"], "icons/icon256.svg");

const appBundle = readZipEntry(siteZip, "assets/App.js").toString("utf8");
const webJavaScript = siteEntries
  .filter((entry) => entry.startsWith("assets/") && entry.endsWith(".js"))
  .map((entry) => readZipEntry(siteZip, entry).toString("utf8"))
  .join("\n");
assert.ok(appBundle.includes("url: \"\""), "Analyzer must start with empty URL");
assert.ok(appBundle.includes("Enter a YouTube URL before analyzing."), "Analyzer must show invalid URL guidance");
assert.ok(appBundle.includes("Fails closed"), "Analyzer must state invalid URLs never score");
assert.ok(appBundle.includes("Base points"), "Score breakdown must be visible");
assert.ok(appBundle.includes("AI classifier v1 - local and active"), "Release marker must be visible in the app bundle");
assert.ok(appBundle.includes("AI classifier predicted"), "AI classifier explanation must be visible in the app bundle");
assert.ok(webJavaScript.includes("Spatiotemporal detector was not run"), "Unavailable spatiotemporal status must be present in a shipped web module");

const indexHtml = readZipEntry(siteZip, "index.html").toString("utf8");
const privacyHtml = readZipEntry(siteZip, "privacy.html").toString("utf8");
assert.ok(indexHtml.includes("orislop-web-local-ai-polish-2026-07-11"));
assert.ok(indexHtml.includes("Serve this build over HTTP."));
assert.ok(privacyHtml.includes("Privacy Policy"));
assert.ok(privacyHtml.includes("does not upload local video files"));

assertArchiveMatchesDirectory(siteZip, webDist, siteEntries, "static website ZIP");
assertArchiveMatchesDirectory(extensionZip, extensionDist, extensionEntries, "browser extension ZIP");
assert.deepEqual(
  readZipEntry(siteZip, "downloads/orislop-browser-extension.zip"),
  readFileSync(embeddedExtensionZip),
  "Website archive must contain the exact embedded extension ZIP from web dist"
);
for (const entry of extensionEntries.filter((name) => name !== "release-info.json")) {
  assert.ok(embeddedExtensionEntries.includes(entry), `Embedded extension ZIP missing ${entry}`);
  assert.deepEqual(
    readZipEntry(extensionZip, entry),
    readZipEntry(embeddedExtensionZip, entry),
    `Standalone and embedded extension differ at ${entry}`
  );
}
assertNoSensitiveText(siteZip, siteEntries, "static website ZIP", false);
assertNoSensitiveText(extensionZip, extensionEntries, "browser extension ZIP", true);

console.log("release artifact verification passed");
console.log(`static website ZIP: ${siteZip} (${statSync(siteZip).size} bytes)`);
console.log(`browser extension ZIP: ${extensionZip} (${statSync(extensionZip).size} bytes)`);

function assertFile(filePath, label) {
  assert.ok(existsSync(filePath), `Missing ${label}: ${filePath}`);
  assert.ok(statSync(filePath).size > 0, `${label} is empty: ${filePath}`);
}

function assertRequiredEntries(label, entries, requiredEntries) {
  for (const entry of requiredEntries) {
    assert.ok(entries.includes(entry), `${label} missing ${entry}`);
  }
}

function assertNoForbiddenEntries(label, entries, forbiddenPatterns) {
  const forbiddenEntry = entries.find((entry) => forbiddenPatterns.some((pattern) => pattern.test(entry)));
  assert.equal(forbiddenEntry, undefined, `${label} contains forbidden entry: ${forbiddenEntry}`);
}

function readZipJson(zipPath, entry) {
  return JSON.parse(readZipEntry(zipPath, entry).toString("utf8"));
}

function assertArchiveMatchesDirectory(zipPath, directory, entries, label) {
  for (const entry of entries) {
    const livePath = path.join(directory, ...entry.split("/"));
    assert.ok(existsSync(livePath), `${label} entry has no matching live artifact: ${entry}`);
    assert.deepEqual(readZipEntry(zipPath, entry), readFileSync(livePath), `${label} contains stale ${entry}`);
  }
}

function assertNoSensitiveText(zipPath, entries, label, allowLocalhost) {
  const textExtensions = new Set([".html", ".js", ".css", ".json", ".svg", ".txt"]);
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"']{12,}/i
  ];
  if (!allowLocalhost) secretPatterns.push(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i);
  for (const entry of entries) {
    if (!textExtensions.has(path.extname(entry).toLowerCase())) continue;
    const text = readZipEntry(zipPath, entry).toString("utf8");
    const match = secretPatterns.find((pattern) => pattern.test(text));
    assert.equal(match, undefined, `${label} contains sensitive or local-only text in ${entry}`);
  }
}
