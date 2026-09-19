# `api.orislop.com` CPU gateway

`api/index.py` is a Vercel ASGI gateway. It contains no model weights or inference logic. Requests from the exact configured Chrome-extension origins are authenticated against the shared PostgreSQL beta store, checked against atomic shared rate budgets, account quotas, and local concurrency/duration/body limits, and then forwarded to Vast Serverless as a header-filtered, base64-encoded envelope. The GPU worker is the only component that handles model data or inference.

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

Rolling 60-second rate budgets are enforced globally through PostgreSQL. Each request atomically checks and consumes its global, keyed-IP, and (when authenticated) keyed-account scopes in one explicit `READ COMMITTED` transaction. Advisory transaction locks cover concurrent requests and the absent-row race. Database connect, statement, and lock waits are finite, and each function instance admits at most eight limiter operations to the worker pool; excess admission fails closed before scheduling database work. Stored limiter keys are HMAC digests derived with a domain-separated secret; raw IP addresses and bearer tokens are never persisted.

Cold-start schema initialization is serialized by a dedicated transaction advisory lock and verifies the limiter table and both indexes before committing. Expired events are retained for five minutes and removed in bounded 500-row batches in a separate best-effort transaction using a fixed database timestamp and `FOR UPDATE SKIP LOCKED`. Cleanup therefore never runs while the global/IP/account admission locks are held and cannot reverse an already committed admission decision.

The limiter fails closed for authentication/account traffic and every Vast-backed route. If PostgreSQL is unavailable, the gateway returns its ordinary temporary-unavailable `503` before it can wake or charge a Vast worker. `/healthz`, extension-origin `/health` and `/ready`, and CORS preflight do not access PostgreSQL, so dependency failure does not make the YouTube page itself unavailable. The extension must continue its local path when Cloud Heavy returns `429` or `503`.

Concurrency guards remain deliberately per Vercel instance. The global minute and weighted-analysis ceilings are strict across instances; the concurrency settings are only local overload protection, not a claimed distributed in-flight ceiling. A true distributed concurrency lease would need crash-safe expirations and request ownership, and is outside this rate-limiter change.

Before production claims are finalized, run a live Neon/PostgreSQL concurrency check against a non-production branch or database. The offline suite validates policy behavior and SQL sequencing, but it cannot prove the managed service's advisory-lock permissions, timeout settings, or concurrent DDL behavior.
