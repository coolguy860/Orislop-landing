# Load The Orislop Browser Extension

This is the browser version that can run directly on YouTube pages. It is still a local prototype, but unlike the static website it can inspect visible YouTube cards and hide videos inside the page.

## Build

1. Run `pnpm install`.
2. Run `pnpm run extension:build`.
3. Run `pnpm run extension:zip`.
4. Run `pnpm run release:verify`.
5. Confirm the loadable folder exists at `apps/extension/dist`.

The fixed QA extension build is version `0.2.0` and includes `release-info.json` with release ID
`orislop-extension-local-ai-0.2.0-2026-07-11`. Do not test stale files such as
`orislop-browser-extension(1).zip` unless you have confirmed the manifest version and release info.

## Load In Chrome Or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select `apps/extension/dist`.
5. Open `https://www.youtube.com`.

## What It Does

- Runs only on YouTube pages.
- Scores visible YouTube cards and Shorts containers locally.
- Adds Orislop AI Classifier v1 metadata scoring on top of the existing heuristic score.
- Loads the same generated 111-example AI classifier artifact used by the static website.
- Reports source scores internally for heuristic, AI classifier, channel risk, and spatiotemporal status.
- Replaces Skip-scored videos with an Orislop hidden-card shield.
- Outlines Questionable videos.
- Attempts best-effort autoskip for the current flagged Short/watch video when enabled.
- Uses button, keyboard, wheel, and scroll fallbacks to move past Skip-rated current Shorts where YouTube exposes safe navigation.
- Treats visible YouTube altered/synthetic/AI disclosures as a hard Skip signal.
- Hides AI-disclosure cards even when ordinary feed-card hiding is disabled.
- Detects and hides likely bot comments using local spam/scam/contact/crypto patterns.
- Keeps the YouTube page UI simple; the old workers/debug status pill is removed.
- Uses IntersectionObserver when available and an adaptive worker-lane cap to reduce scan jank.
- Never auto-skips Questionable results; those render as a side overlay for review.
- Uses a faster local scoring path in the content script before falling back to background scoring.
- Saves a local flagged log in browser extension storage.
- Saves a local skipped/hidden cache showing which videos were hidden or auto-skipped.
- Adds a popup showing flagged count, skipped count, autoskip toggles, detector status, and clear-log buttons.

## What It Does Not Do

- It does not use a YouTube API key.
- It does not download videos.
- It does not scrape comments remotely; optional bot-comment rules inspect visible comment text locally.
- It does not run PyTorch or local model checkpoints.
- It does not run the spatial or temporal Hugging Face detectors inside the browser extension.
- The Advanced detector escalation toggle is a future/local-companion flag only; it does not run heavy detectors in this build.
- Spatial/temporal detector execution requires a local companion/Electron process that can run model code safely.
- It does not send data to a server.
- It does not block ads at the network level.

## ZIP

Run `pnpm run extension:zip` to create `dist/orislop-browser-extension.zip`.
The ZIP must contain `icons/icon128.svg`, `icons/icon256.svg`, and `release-info.json`.
