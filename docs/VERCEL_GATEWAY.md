# `api.orislop.com` CPU gateway

`api/index.py` is a Vercel ASGI gateway. It contains no model weights or inference logic. Requests from the exact configured Chrome-extension origins are authenticated against the shared PostgreSQL beta store, checked against account quotas, local rate/concurrency/duration/body limits, and then forwarded to Vast Serverless as a header-filtered, base64-encoded envelope. The GPU worker is the only component that handles model data or inference.

The checked-in Vercel rewrites map the public `/health`, `/ready`, and `/v2/*` contract to the single Python function mounted at `/api`. A private rewrite query parameter carries the original public path; the application validates and removes it before authorization and Vast forwarding, so the worker continues to receive only the canonical `/v2/*` path.

## Deploy setup

1. Import this repository into Vercel and keep the existing build command and output directory; they continue to deploy the static landing site.
2. Add `api.orislop.com` to that Vercel project, then set the DNS record Vercel provides for the subdomain.
3. Add every variable named in [`.env.example`](../.env.example) to the Production environment. `ORISLOP_ALLOWED_EXTENSION_ORIGINS` must be the exact installed extension ID.
4. Use PostgreSQL reachable from Vercel. It stores users, refresh-token revocations, quota state, decisions, and rollout state shared with the worker-side `cloud_beta.py` contract.
5. Deploy only after environment values and DNS are set. This repository contains no deployment credentials or secrets.

Run the offline API checks after installing the Python requirements:

```powershell
python -m unittest tests/test_gateway.py
```

## Required platform decision

The ASGI implementation preserves the source gateway's configured 36 MiB body cap and 118-second Vast request timeout, and `vercel.json` requests a 300-second function maximum. Vercel itself may impose a lower request-body ceiling and duration depends on the Vercel plan. A Vercel rejection happens before this gateway can apply its 36 MiB body rule. Use the direct `googlevideo.com` media URL path for long videos; do not treat Vercel as a general media-upload proxy.

The in-process rate and concurrency guards match the authoritative gateway implementation but are scoped to one Vercel function instance. They cannot enforce a true global cap when Vercel runs multiple instances. PostgreSQL-backed user quotas and rollout state remain shared. Strict global rate/concurrency enforcement requires an atomic shared limiter before it can be claimed in production.
