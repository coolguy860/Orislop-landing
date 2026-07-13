# Build and load Orislop 0.4.0

Orislop is a Manifest V3 extension for YouTube, Instagram Reels, and TikTok. It uses two required localhost services:

- Ollama with `qwen2.5:1.5b-instruct` for transcript and metadata slop decisions.
- The Orislop detector bridge for `gonnerthetooner/orislop-fusion` and `gonnerthetooner/deepfake-temporal-moe`.

Chrome cannot run Python or PyTorch inside an extension, so the visual models run in a companion bound only to `127.0.0.1:4317`. The companion queues scans and the extension polls for results without scrolling the page.

## First-time local setup

Install and start Ollama:

```powershell
ollama run qwen2.5:1.5b-instruct
```

In a second PowerShell window, install the detector environment:

```powershell
Set-Location "C:\path\to\orislop"
pnpm detector:setup
pnpm detector:start
```

The first detector scan downloads the public Hugging Face weights and base vision models. This is a large one-time download. An NVIDIA GPU is strongly recommended for the temporal model; CPU inference is supported by the runtime but can be very slow.

The visual bridge:

- Accepts only YouTube, Instagram, and TikTok page URLs or approved media-CDN URLs.
- Listens on loopback only.
- Rejects normal website origins.
- Keeps model inference and decisions local.
- Deletes temporary media after each scan and caches only the decision in memory.

## Build

```powershell
pnpm install
pnpm extension:test
pnpm extension:zip
pnpm release:verify
```

The loadable folder is `apps/extension/dist`. The Chrome Web Store upload is `dist/orislop-browser-extension.zip`.

Confirm that `manifest.json` and `release-info.json` both report version `0.4.0`.

## Load unpacked

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `apps/extension/dist`.
5. Keep both Ollama and `pnpm detector:start` running.
6. Open a supported feed and use the extension popup to test both local engines.

## Decision behavior

- The only user-facing verdicts are **Don't skip** and **Skip**.
- Explicit AI/synthetic text is a non-vetoable 100/100 Skip.
- A strong spatial, temporal, or combined visual synthetic signal is also a non-vetoable 100/100 Skip.
- Ollama decides whether remaining transcript/metadata feels like low-value slop.
- A visual “real” result never vetoes an Ollama slop decision.
- Skip-rated future feed items are hidden instead of auto-scrolled.
- Current videos receive a yellow cover constrained to the media surface.
- Unavailable models fail open: the item remains visible and the popup reports the missing engine.

## Model configuration

Visual thresholds live in `configs/detector_thresholds.json`. Production checkpoint paths live in `configs/model_adapters.json`.

The temporal runtime uses:

- Stage-1 micro, mid, long, and extra-long experts from `a100_high_vram_60gb_v1`.
- Fusion and calibration from `a100_balanced_fusion_v4`.

Do not commit downloaded `.pt` files, the detector virtual environment, caches, ZIPs, or temporary videos.
