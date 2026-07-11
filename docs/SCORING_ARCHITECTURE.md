# Orislop Scoring Architecture

## Product Principle

Orislop combines multiple evidence sources without hiding what ran. The UI and logs must distinguish:

- heuristic evidence
- lightweight AI text/metadata classifier evidence
- optional transcript evidence
- optional spatiotemporal/video evidence

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

The extension runs locally on YouTube pages:

1. `apps/extension/src/contentScript.js` extracts visible card/current-video metadata.
2. It extracts title, URL/video ID, visible text, channel name where visible, duration where visible, and visible AI/synthetic disclosure text.
3. It scores up to the next 10 visible candidates with heuristic rules plus the generated Orislop AI Classifier v1 artifact loaded before the content script.
4. `apps/extension/src/background.js` mirrors the same scoring path for the batch fallback.
5. Skip/current-warning behavior remains controlled by extension settings.

The generated artifact is also imported by the extension service worker before background scoring starts. If that artifact is missing or invalid, both paths report `aiClassifierUsed: false`, return a null AI source score, and reassign the unavailable source weight to explainable heuristic evidence. The extension does not download videos, inspect video pixels, run PyTorch, or call remote APIs.

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

With a real spatiotemporal score available later:

```text
finalScore =
  0.25 * heuristicScore
  0.35 * aiClassifierScore
  0.15 * transcriptScore
  0.25 * spatiotemporalScore
```

The public web and extension paths currently set `spatiotemporalUsed: false`.

## Verdict Thresholds

- `Watch`: 0-29
- `Questionable`: 30-59
- `Skip`: 60-100

The extension preserves a hard Skip for visible YouTube AI/synthetic disclosure text.

## Spatiotemporal Detector Status

Local inference adapters exist in `packages/local-inference/src/adapters/`, but they are not called by the static website or browser extension. They remain optional and unavailable-safe. A future local companion app could call them only when:

- metadata/text confidence is low,
- the item is already suspicious,
- transcript/metadata is missing,
- or advanced detection is enabled.

The extension includes an `advancedDetection` setting flag for future escalation. It is off by default and does not run any heavy detector in the current build.
