# Orislop

Orislop is a static web demo plus a Manifest V3 browser-extension prototype for filtering low-value YouTube content with local heuristic scoring.

This repo also contains earlier Electron, storage, slop-engine, and local-inference prototype packages. The public static web build does not run Electron, Python, PyTorch, local checkpoints, or secret API keys.

## Prerequisites

- Node.js 22 or newer
- PNPM

Install dependencies from the repo root:

```powershell
pnpm install
```

Do not commit `node_modules`, `.env` files, model checkpoints, generated ZIPs, or build output.

## Common Commands

```powershell
pnpm run web:dev
pnpm run web:build
pnpm run web:preview
pnpm run web:test
pnpm run extension:build
pnpm run extension:test
pnpm run extension:zip
pnpm run ai:train
pnpm run ai:evaluate
pnpm run test:ai-classifier
pnpm run web:deploy:zip
pnpm run release:verify
pnpm run check
```

## Static Website

The static website source is in `apps/web`.

Build it:

```powershell
pnpm run web:build
```

Preview it locally:

```powershell
pnpm run web:preview
```

Open the printed `http://127.0.0.1:4173` URL. Do not double-click `apps/web/dist/index.html` and expect the full app to run from `file://`; browser ES module and storage behavior differs from real hosting. The generated HTML includes a visible fallback explaining this if the module does not load.

Create the Namecheap/cPanel upload ZIP:

```powershell
pnpm run web:deploy:zip
```

Upload `dist/orislop-namecheap-static.zip`. Its contents are meant to be extracted directly into `public_html`.

## Browser Extension

The extension source is in `apps/extension`.

Build the load-unpacked folder:

```powershell
pnpm run extension:build
```

Then load `apps/extension/dist` in Chrome, Edge, or Brave:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select `apps/extension/dist`.
5. Open YouTube and test in an unrestricted browser profile.

Create the extension ZIP:

```powershell
pnpm run extension:zip
```

The ZIP is written to `dist/orislop-browser-extension.zip`.

## Current Scoring Scope

The static website and extension use local transparent heuristics plus Orislop AI Classifier v1, a small TF-IDF logistic-regression metadata model. They inspect URL, title, channel name where available, visible text, captions/descriptions when available, optional transcript text, YouTube AI/synthetic disclosure text, feed-card text, and obvious bot-comment patterns. They do not download YouTube videos, call remote APIs, scrape private data, or run the full temporal/spatial detector in the browser.

The larger temporal/spatial detector pipeline is represented in the repo as optional future integration work. The browser-hosted build must not claim it is running the full PyTorch detector unless a separate local companion or server-side inference path is explicitly added.

See:

- `docs/SCORING_ARCHITECTURE.md`
- `docs/AI_CLASSIFIER_V1.md`
- `docs/SCORING_FLOW_AUDIT_2026-07-08.md`

## QA

Run the lightweight checks:

```powershell
pnpm run web:test
pnpm run extension:test
pnpm run test:ai-classifier
pnpm run release:verify
pnpm run check
```

Real YouTube scan and auto-skip behavior still needs manual testing in a browser profile where extension installation is allowed, because this workspace cannot drive `chrome://extensions` or YouTube layout changes end to end.
