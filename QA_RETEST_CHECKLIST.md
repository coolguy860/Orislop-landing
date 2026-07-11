# Orislop QA Retest Checklist

Use this checklist for the fixed static website and extension artifacts.

## Required Artifact Identity

- Static ZIP: `dist/orislop-namecheap-static.zip`
- Extension ZIP: `dist/orislop-browser-extension.zip`
- Static release ID: `orislop-web-local-ai-polish-2026-07-11`
- Extension release ID: `orislop-extension-local-ai-0.2.0-2026-07-11`
- Extension manifest version: `0.2.0`

Run:

```powershell
pnpm run web:deploy:zip
pnpm run extension:zip
pnpm run release:verify
```

Do not retest browser-renamed stale files such as `orislop-namecheap-static(1).zip`,
`orislop-namecheap-static(2).zip`, or `orislop-browser-extension(1).zip` unless their
release info matches the IDs above.

## Website Must-Pass Checks

- `/release-info.json` exists and contains `orislop-web-local-ai-polish-2026-07-11`.
- `/privacy.html` exists.
- Analyzer starts with an empty URL field.
- Blank, whitespace, malformed, or non-YouTube URLs keep Analyze disabled.
- Optional title/description fields cannot produce a score without a valid YouTube URL.
- Watch, Questionable, and Skip definitions are visible.
- Strictness explanation and multipliers are visible.
- The compact source breakdown is visible after analysis; base points, stacked bonus, multiplier, thresholds, and per-signal points are available under `How Orislop made this score`.
- AI classifier source score is visible after analysis.
- Spatiotemporal status clearly says not used when unavailable.
- If `index.html` is opened through `file://`, a visible fallback explains to run `pnpm run web:preview` instead of showing a blank page.

## Expected Static Scoring Examples

Use Strict mode unless noted:

- `1 Hour Reddit Stories for the Coziest Sleep + Silent Minecraft Parkour` -> `Skip 100/100`
- `Minecraft Parkour Reddit story` -> `Skip 100/100`
- `This finance trick banks hate` -> `Questionable`, about `44/100`
- `Ranking the most satisfying videos` -> `Questionable`, about `30/100`
- `You won't believe this satisfying background` plus `Follow for more` -> `Questionable`, not `Skip`
- `How rainfall forms in mountain regions` -> `Watch`, about `8/100` for Shorts
- `Chorus practice la la la la la la la la` with song/lyrics context should not trigger `Repetitive title/caption`

## Extension Must-Pass Checks

- Manifest version is `0.2.0`.
- Icons exist at `16`, `32`, `48`, `128`, and `256`.
- `release-info.json` exists in the ZIP.
- Popup opens and shows local storage controls.
- Current Skip-rated Shorts/watch videos show an Orislop skip shield and attempt next-video navigation.
- Shorts autoskip attempts button, ArrowDown, PageDown, wheel, and scroll fallbacks.
- Visible YouTube AI/synthetic disclosure text scores as `Skip 100`.
- Feed/list cards with visible AI/synthetic disclosure text are hidden and logged as `hidden_ai_disclosure`.
- Likely bot comments are hidden and logged as `hidden_bot_comment`.
- Bot-comment hiding catches obvious external-contact, scam, crypto, suspicious-link, and giveaway patterns.
- The old worker/debug status bar is not visible on YouTube.
- Questionable videos never auto-skip and render as a right-side overlay that does not push layout.
- Scan loop uses the local fast scoring path first.
- Scan loop is throttled, uses IntersectionObserver where available, and still caps lookahead at 10 candidates.
- Popup switches expose accessible labels and `aria-checked`.
- Orislop AI Classifier v1 runs locally in extension scoring.
- Extension content/background paths load `aiClassifierModel.generated.js`; removing it produces an honest heuristic-only fallback.
- Advanced detector escalation flag is visible and off by default; it must not claim spatiotemporal inference is running.
- YouTube scanning can only be fully verified in an unrestricted Chrome, Edge, or Brave profile where `chrome://extensions` is not blocked.
