# Orislop detector bridge

This loopback-only Python service connects the browser extension to:

- `gonnerthetooner/orislop-fusion`
- `gonnerthetooner/deepfake-temporal-moe`

Run from the repository root:

```powershell
pnpm detector:setup
pnpm detector:start
```

Health endpoint:

```text
GET http://127.0.0.1:4317/health
```

Batch endpoint:

```text
POST http://127.0.0.1:4317/v1/analyze
```

Unknown items are queued and initially return `pending`. Repeating the same item ID and URL returns the cached `ready` result after local inference finishes.

Environment overrides:

- `ORISLOP_DETECTOR_PORT`
- `ORISLOP_DETECTOR_CACHE`
- `ORISLOP_SPATIAL_DEVICE=cpu|cuda`
- `ORISLOP_SPATIAL_THRESHOLD`
- `ORISLOP_TEMPORAL_THRESHOLD`
- `ORISLOP_VISUAL_THRESHOLD`
- `ORISLOP_DETECTOR_VERBOSE=1`
