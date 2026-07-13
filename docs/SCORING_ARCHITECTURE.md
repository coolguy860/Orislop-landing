# Orislop Scoring Architecture

## Product Principle

Orislop combines multiple evidence sources without hiding what ran. The UI and logs must distinguish:

- heuristic evidence
- lightweight AI text/metadata classifier evidence
- required Ollama transcript/metadata evidence in the extension
- required spatial and temporal video evidence through the extension companion

If a detector is unavailable or not wired into the active product path, Orislop reports that plainly.

## Current Public Static Web Path

The static website runs entirely in the browser:

1. Parse YouTube URL with `apps/web/src/lib/youtube.ts`.
2. Run heuristic rules with `apps/web/src/lib/staticSlopScore.ts`.
3. Run Orislop AI Classifier v1 with `apps/web/src/lib/aiClassifier.ts`.
4. Combine sources with `apps/web/src/lib/combinedScore.ts`.
5. Display final score, verdict, source scores, AI classifier features, and unavailable spatiotemporal status in `apps/web/src/App.tsx`.

The static website does not run PyTorch, Hugging Face checkpoints, temporal video inference, spatial frame inference, YouTube scraping, or paid APIs.

The classifier artifact is trained from text and metadata only. Heuristic score columns and matched rule names remain in the seed CSV for audit but are excluded from model features. During combined scoring, transcript text is evaluated by the transcript source and is not also fed into the AI source. These boundaries keep the weighted sources independent.

## Current Browser Extension Path

Extension 0.4.0 runs on YouTube, Instagram Reels, and TikTok:

1. `apps/extension/src/contentScript.js` extracts visible card/current-video metadata.
2. It extracts the item URL/ID, visible metadata/transcript, and a direct approved CDN URL when the page exposes one.
3. It scores up to the next 10 candidates with heuristics and Orislop AI Classifier v1.
4. `apps/extension/src/background.js` sends every non-hard-AI item to required Ollama and the loopback detector bridge.
5. The bridge runs `gonnerthetooner/orislop-fusion` plus `gonnerthetooner/deepfake-temporal-moe`, queues uncached visual scans, and returns spatial and temporal probabilities.
6. Skip hides future feed items; it never scrolls or navigates to the next item.

The Chrome process does not execute PyTorch. The required companion binds to `127.0.0.1:4317`, may download supported media into a temporary directory, deletes it after inference, and keeps only an in-memory decision cache. The browser service worker calls no remote HTTPS APIs; public model weights are downloaded by the companion during local setup/use.

## Combined Score Formula

Without spatiotemporal score:

```text
finalScore =
  0.35 * heuristicScore
  0.45 * aiClassifierScore
  0.15 * transcriptScore
  0.05 * channelRiskScore
```

If transcript is missing, its weight is assigned to the heuristic score. If the AI classifier is unavailable, its weight is assigned to the heuristic score. Channel risk remains lightweight and low-weight.

The extension uses binary decision fusion instead of the static website formula. Ollama determines Skip/Don't skip for slop. A visual synthetic result overrides either text verdict and sets the final score to 100. A visual real result never vetoes an Ollama Skip.

## Verdict Thresholds

- `Don't skip`: keep the item visible.
- `Skip`: hide the item or cover the current media surface.

Explicit AI/synthetic disclosure text and strong spatial/temporal synthetic results are non-vetoable 100/100 Skip decisions. Thresholds are versioned in `configs/detector_thresholds.json`.

## Spatiotemporal Detector Status

The static website still reports spatiotemporal inference as unavailable. The extension requires the separate companion and reports `pending`, `available`, or `unavailable` in its popup. Unavailable models fail open so a missing local service cannot hide normal content.
