"""ASGI CPU gateway from the Orislop extension to Vast Serverless.

This module deliberately contains no model code.  It authenticates and limits
extension requests before forwarding the narrowly defined worker envelope.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
import json
import math
import os
import re
import threading
import time
from typing import Any, Protocol
from urllib.parse import urlencode, urlparse

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .cloud_beta import AuthError, AuthManager, CandidateQuota, GoogleOidc, PostgresBetaStore, RolloutGuard, public_user
from .contracts import make_envelope, request_cost, unwrap_worker_response


WORKER_ROUTE = "/orislop/v1/invoke"
LOCAL_GET_ROUTES = frozenset({"/health", "/ready", "/v2/me"})
LOCAL_POST_ROUTES = frozenset({"/v2/auth/google", "/v2/auth/refresh", "/v2/auth/logout"})
LOCAL_DELETE_ROUTES = frozenset({"/v2/me"})
VAST_POST_ROUTES = frozenset({"/v2/media-upload", "/v2/analyze", "/v2/analyze/batch", "/v2/feedback"})
ANALYSIS_RESULT_PATH = re.compile(r"/v2/analyze/[A-Za-z0-9_-]{1,160}\Z")
SUPPORTED_ANALYSIS_PLATFORMS = frozenset({"youtube"})
DIRECT_MEDIA_HOST_SUFFIXES = (".googlevideo.com",)
VERCEL_PUBLIC_PATH_QUERY = "__orislop_path"


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    value = int(os.environ.get(name, str(default)))
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


def _env_float(name: str, default: float, minimum: float = 0.1) -> float:
    value = float(os.environ.get(name, str(default)))
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


@dataclass(frozen=True)
class GatewayConfig:
    endpoint_name: str
    allowed_origins: frozenset[str]
    max_body_bytes: int = 36 * 1024 * 1024
    body_read_timeout_seconds: float = 45.0
    request_timeout_seconds: float = 118.0
    route_global_per_minute: int = 120
    route_ip_per_minute: int = 30
    route_user_per_minute: int = 30
    route_global_concurrency: int = 12
    route_ip_concurrency: int = 3
    route_user_concurrency: int = 2
    max_media_duration_seconds: float = 2 * 60 * 60
    analysis_unit_seconds: float = 10 * 60
    analysis_global_units_per_minute: int = 240
    analysis_ip_units_per_minute: int = 60
    analysis_user_units_per_minute: int = 30
    auth_global_per_minute: int = 60
    auth_ip_per_minute: int = 6
    auth_global_concurrency: int = 8
    auth_ip_concurrency: int = 2
    cloud_heavy_rollout_mode: str = "aggressive"

    @classmethod
    def from_environment(cls) -> "GatewayConfig":
        endpoint_name = os.environ.get("VAST_ENDPOINT_NAME", "").strip()
        origins = frozenset(item.strip().rstrip("/") for item in os.environ.get("ORISLOP_ALLOWED_EXTENSION_ORIGINS", "").split(",") if item.strip())
        if not endpoint_name or not os.environ.get("VAST_API_KEY", "").strip():
            raise RuntimeError("VAST_ENDPOINT_NAME and VAST_API_KEY are required")
        if not origins or any(not item.startswith("chrome-extension://") for item in origins):
            raise RuntimeError("ORISLOP_ALLOWED_EXTENSION_ORIGINS must contain exact Chrome extension origins")
        rollout = os.environ.get("ORISLOP_GATEWAY_CLOUD_HEAVY_ROLLOUT_MODE", "aggressive").strip().lower()
        if rollout not in {"aggressive", "disabled"}:
            raise RuntimeError("ORISLOP_GATEWAY_CLOUD_HEAVY_ROLLOUT_MODE must be aggressive or disabled")
        return cls(endpoint_name, origins,
            max_body_bytes=_env_int("ORISLOP_GATEWAY_MAX_BODY_BYTES", 36 * 1024 * 1024),
            body_read_timeout_seconds=_env_float("ORISLOP_GATEWAY_BODY_READ_TIMEOUT_SECONDS", 45),
            request_timeout_seconds=_env_float("ORISLOP_GATEWAY_REQUEST_TIMEOUT_SECONDS", 118),
            route_global_per_minute=_env_int("ORISLOP_GATEWAY_ROUTE_GLOBAL_PER_MINUTE", 120), route_ip_per_minute=_env_int("ORISLOP_GATEWAY_ROUTE_IP_PER_MINUTE", 30), route_user_per_minute=_env_int("ORISLOP_GATEWAY_ROUTE_USER_PER_MINUTE", 30),
            route_global_concurrency=_env_int("ORISLOP_GATEWAY_ROUTE_GLOBAL_CONCURRENCY", 12), route_ip_concurrency=_env_int("ORISLOP_GATEWAY_ROUTE_IP_CONCURRENCY", 3), route_user_concurrency=_env_int("ORISLOP_GATEWAY_ROUTE_USER_CONCURRENCY", 2),
            max_media_duration_seconds=min(_env_float("ORISLOP_MAX_MEDIA_DURATION_SECONDS", 7200, 60), 21600), analysis_unit_seconds=_env_float("ORISLOP_GATEWAY_ANALYSIS_UNIT_SECONDS", 600, 30),
            analysis_global_units_per_minute=_env_int("ORISLOP_GATEWAY_ANALYSIS_GLOBAL_UNITS_PER_MINUTE", 240), analysis_ip_units_per_minute=_env_int("ORISLOP_GATEWAY_ANALYSIS_IP_UNITS_PER_MINUTE", 60), analysis_user_units_per_minute=_env_int("ORISLOP_GATEWAY_ANALYSIS_USER_UNITS_PER_MINUTE", 30),
            auth_global_per_minute=_env_int("ORISLOP_GATEWAY_AUTH_GLOBAL_PER_MINUTE", 60), auth_ip_per_minute=_env_int("ORISLOP_GATEWAY_AUTH_IP_PER_MINUTE", 6), auth_global_concurrency=_env_int("ORISLOP_GATEWAY_AUTH_GLOBAL_CONCURRENCY", 8), auth_ip_concurrency=_env_int("ORISLOP_GATEWAY_AUTH_IP_CONCURRENCY", 2), cloud_heavy_rollout_mode=rollout)


class GatewayAuthServices:
    def __init__(self, store: Any, auth: Any) -> None:
        self.store, self.auth = store, auth
        self.quota, self.guard = CandidateQuota(store), RolloutGuard(store)

    @classmethod
    def from_environment(cls, origins: frozenset[str]) -> "GatewayAuthServices":
        database_url, client_id, secret = (os.environ.get(key, "").strip() for key in ("DATABASE_URL", "ORISLOP_GOOGLE_OAUTH_CLIENT_ID", "ORISLOP_TOKEN_SECRET"))
        if not database_url or not client_id or not secret:
            raise RuntimeError("DATABASE_URL, ORISLOP_GOOGLE_OAUTH_CLIENT_ID, and ORISLOP_TOKEN_SECRET are required")
        extension_ids = {parsed.hostname for origin in origins if (parsed := urlparse(origin)).scheme == "chrome-extension" and parsed.hostname and re.fullmatch(r"[a-p]{32}", parsed.hostname)}
        if not extension_ids:
            raise RuntimeError("No valid Chrome extension ID is configured")
        store = PostgresBetaStore(database_url)
        return cls(store, AuthManager(store, GoogleOidc(client_id, allowed_extension_ids=extension_ids), secret))


class SlidingWindowLimiter:
    def __init__(self, seconds: float = 60) -> None:
        self.seconds, self.events, self.lock = seconds, defaultdict(deque), threading.Lock()
    def allow(self, limits: tuple[tuple[str, int], ...], cost: int = 1) -> bool:
        if cost < 1: raise ValueError("Rate-limit cost must be positive")
        now = time.monotonic()
        with self.lock:
            for key, _ in limits:
                while self.events[key] and now - self.events[key][0] >= self.seconds: self.events[key].popleft()
            if any(len(self.events[key]) + cost > limit for key, limit in limits): return False
            for key, _ in limits: self.events[key].extend([now] * cost)
            return True


class ConcurrencyLimiter:
    def __init__(self, global_limit: int, ip_limit: int, user_limit: int | None = None) -> None:
        self.global_limit, self.ip_limit, self.user_limit = global_limit, ip_limit, user_limit
        self.active_global, self.active_ip, self.active_user, self.lock = 0, defaultdict(int), defaultdict(int), threading.Lock()
    def acquire(self, ip: str, user: str = "") -> bool:
        with self.lock:
            if self.active_global >= self.global_limit or self.active_ip[ip] >= self.ip_limit or (self.user_limit is not None and user and self.active_user[user] >= self.user_limit): return False
            self.active_global += 1; self.active_ip[ip] += 1
            if user: self.active_user[user] += 1
            return True
    def release(self, ip: str, user: str = "") -> None:
        with self.lock:
            self.active_global = max(0, self.active_global - 1); self.active_ip[ip] = max(0, self.active_ip[ip] - 1)
            if user: self.active_user[user] = max(0, self.active_user[user] - 1)


class GatewayGuards:
    def __init__(self, c: GatewayConfig) -> None:
        self.c, self.route_rate, self.analysis_rate, self.auth_rate = c, SlidingWindowLimiter(), SlidingWindowLimiter(), SlidingWindowLimiter()
        self.route_concurrency, self.auth_concurrency = ConcurrencyLimiter(c.route_global_concurrency, c.route_ip_concurrency, c.route_user_concurrency), ConcurrencyLimiter(c.auth_global_concurrency, c.auth_ip_concurrency)
    def route(self, ip: str, user: str) -> bool: return self.route_rate.allow((("global", self.c.route_global_per_minute), (f"ip:{ip}", self.c.route_ip_per_minute), (f"user:{user}", self.c.route_user_per_minute)))
    def analysis(self, ip: str, user: str, cost: int) -> bool: return self.analysis_rate.allow((("global", self.c.analysis_global_units_per_minute), (f"ip:{ip}", self.c.analysis_ip_units_per_minute), (f"user:{user}", self.c.analysis_user_units_per_minute)), cost)
    def auth(self, ip: str) -> bool: return self.auth_rate.allow((("global", self.c.auth_global_per_minute), (f"ip:{ip}", self.c.auth_ip_per_minute)))
    @asynccontextmanager
    async def auth_slot(self, ip: str):
        acquired = self.auth_concurrency.acquire(ip)
        try: yield acquired
        finally:
            if acquired: self.auth_concurrency.release(ip)
    @asynccontextmanager
    async def route_slot(self, ip: str, user: str):
        acquired = self.route_concurrency.acquire(ip, user)
        try: yield acquired
        finally:
            if acquired: self.route_concurrency.release(ip, user)


class VastEndpointClient:
    def __init__(self, config: GatewayConfig) -> None: self.config, self.client, self.endpoint, self.lock = config, None, None, asyncio.Lock()
    async def invoke(self, envelope: dict[str, Any], timeout: float) -> Any:
        async with self.lock:
            if self.endpoint is None:
                from vastai import Serverless
                self.client = Serverless(api_key=os.environ["VAST_API_KEY"], default_request_timeout=self.config.request_timeout_seconds)
                self.endpoint = await self.client.get_endpoint(name=self.config.endpoint_name)
        return await self.endpoint.request(WORKER_ROUTE, envelope, cost=request_cost(envelope), timeout=timeout, retry=True)


def cors(origin: str, allowed: frozenset[str]) -> dict[str, str]:
    if origin.rstrip("/") not in allowed: return {}
    return {"Access-Control-Allow-Origin": origin.rstrip("/"), "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Orislop-Media-Platform, X-Orislop-Media-Partial", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer", "Vary": "Origin", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"}


def json_response(value: Any, status: int = 200, headers: dict[str, str] | None = None) -> JSONResponse: return JSONResponse(value, status, headers=headers or {})
def client_ip(request: Request) -> str:
    # Vercel supplies this header after accepting the client connection.  Do not
    # trust caller-provided forwarding headers in local/self-hosted deployments.
    if os.environ.get("VERCEL") == "1":
        forwarded = request.headers.get("x-vercel-forwarded-for", "").split(",", 1)[0].strip()
        if forwarded: return forwarded
    return request.client.host if request.client else "unknown"
async def read_body(request: Request, config: GatewayConfig, required: bool = True) -> bytes:
    length = request.headers.get("content-length")
    if length and int(length) > config.max_body_bytes: raise OverflowError()
    try: body = await asyncio.wait_for(request.body(), config.body_read_timeout_seconds)
    except asyncio.TimeoutError: raise TimeoutError() from None
    if len(body) > config.max_body_bytes: raise OverflowError()
    if required and not body: raise ValueError("Invalid request size")
    return body
def json_body(body: bytes) -> dict[str, Any]:
    try: value = json.loads(body.decode("utf-8"))
    except Exception: raise ValueError("Invalid JSON body") from None
    if not isinstance(value, dict): raise ValueError("JSON object required")
    return value


def validate_analysis(path: str, body: dict[str, Any], config: GatewayConfig) -> tuple[int, int]:
    def candidate(value: Any) -> int:
        if not isinstance(value, dict): raise ValueError("Candidate must be an object")
        platform, identifier, media_url, upload_id = value.get("platform"), value.get("itemIdentifier"), value.get("directMediaUrl"), value.get("mediaUploadId")
        if not isinstance(platform, str) or platform.lower() not in SUPPORTED_ANALYSIS_PLATFORMS or not isinstance(identifier, str) or not identifier or len(identifier) > 300: raise ValueError("platform and itemIdentifier are required")
        has_url, has_upload = isinstance(media_url, str) and bool(media_url) and len(media_url) <= 4000, isinstance(upload_id, str) and re.fullmatch(r"[0-9a-fA-F]{32}", upload_id) is not None
        if not has_url and not has_upload: raise ValueError("A direct media URL or temporary media upload is required")
        if has_url:
            parsed, host = urlparse(media_url), (urlparse(media_url).hostname or "").lower()
            if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in {None, 443} or not any(host.endswith(s) for s in DIRECT_MEDIA_HOST_SUFFIXES): raise ValueError("directMediaUrl must use an approved YouTube media host")
        try: duration = float(value.get("duration", value.get("durationSeconds")) or 0)
        except (ValueError, TypeError): raise ValueError("duration must be a finite non-negative number") from None
        if not math.isfinite(duration) or duration < 0: raise ValueError("duration must be a finite non-negative number")
        if duration > config.max_media_duration_seconds: raise ValueError(f"Video exceeds the {round(config.max_media_duration_seconds / 3600, 1):g}-hour analysis limit")
        return max(1, math.ceil(duration / config.analysis_unit_seconds))
    if path == "/v2/analyze": return 1, candidate(body)
    candidates = body.get("candidates")
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 10: raise ValueError("candidates must contain 1 to 10 items")
    return len(candidates), sum(candidate(item) for item in candidates)


async def authenticate(request: Request) -> dict[str, Any]: return await asyncio.to_thread(request.app.state.auth.auth.authenticate_access, request.headers.get("authorization", ""))
def is_vast(method: str, path: str) -> bool: return (method == "POST" and path in VAST_POST_ROUTES) or (method == "GET" and ANALYSIS_RESULT_PATH.fullmatch(path) is not None)


async def auth_services(request: Request) -> Any:
    """Create the database-backed auth gate only when an API route needs it.

    Vercel imports the ASGI app during cold start. Deferring this connection
    keeps imports offline-testable and makes a temporarily unavailable database
    fail the request closed instead of failing the entire function import.
    """
    services = request.app.state.auth
    if services is not None:
        return services
    async with request.app.state.auth_lock:
        services = request.app.state.auth
        if services is None:
            services = await asyncio.to_thread(
                GatewayAuthServices.from_environment,
                request.app.state.config.allowed_origins,
            )
            request.app.state.auth = services
        return services


def gateway_path(request: Request) -> str:
    """Translate Vercel's single `/api` function mount to the public contract."""
    rewritten = request.query_params.getlist(VERCEL_PUBLIC_PATH_QUERY)
    if rewritten:
        path = str(rewritten[-1]).strip()
        if (
            len(rewritten) != 1
            or len(path) > 512
            or not path.startswith("/")
            or any(marker in path for marker in ("\\", "?", "#"))
        ):
            return "/__invalid_vercel_route__"
        return path
    path = request.url.path
    if path == "/api":
        return "/"
    return path[4:] if path.startswith("/api/") else path


def gateway_query(request: Request) -> str:
    """Remove Vercel's private routing parameter before forwarding to Vast."""
    return urlencode([
        (name, value)
        for name, value in request.query_params.multi_items()
        if name != VERCEL_PUBLIC_PATH_QUERY
    ])


async def endpoint(request: Request) -> Response:
    config, guards = request.app.state.config, request.app.state.guards
    path = gateway_path(request)
    if request.method == "GET" and path == "/healthz":
        return json_response({"ok": True, "service": "orislop-serverless-gateway"}, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    origin = request.headers.get("origin", "").rstrip("/")
    if origin not in config.allowed_origins: return json_response({"ok": False, "error": "Origin not allowed"}, 403)
    headers, ip = cors(origin, config.allowed_origins), client_ip(request)
    if request.method == "OPTIONS": return Response(status_code=204, headers=headers)
    if path in {"/health", "/ready"} and request.method == "GET": return json_response({"ok": True, "ready": True, "service": "orislop-serverless-gateway", "state": "ready", "phase": "gateway", "dependencies": "available", "accelerator": "cloud-serverless"}, headers=headers)
    try:
        if path in {"/v2/auth/google", "/v2/auth/refresh"} and request.method == "POST":
            services = await auth_services(request)
            if not guards.auth(ip): return json_response({"ok": False, "error": "Authentication rate limit exceeded; retry in one minute"}, 429, {**headers, "Retry-After": "60"})
            async with guards.auth_slot(ip) as acquired:
                if not acquired: return json_response({"ok": False, "error": "Authentication is busy; retry shortly"}, 429, {**headers, "Retry-After": "1"})
                body = json_body(await read_body(request, config))
                result = await asyncio.to_thread(services.auth.google_login if path.endswith("google") else services.auth.refresh, body if path.endswith("google") else str(body.get("refreshToken") or "")[:1000])
                return json_response({"ok": True, **result}, headers=headers)
        if path in {"/v2/me", "/v2/auth/logout"}:
            services = await auth_services(request)
            if not guards.auth(ip): return json_response({"ok": False, "error": "Account rate limit exceeded; retry in one minute"}, 429, {**headers, "Retry-After": "60"})
            async with guards.auth_slot(ip) as acquired:
                if not acquired: return json_response({"ok": False, "error": "Account service is busy; retry shortly"}, 429, {**headers, "Retry-After": "1"})
                principal, user_id = await authenticate(request), ""
                user_id = str(principal["user"]["id"])
                if path == "/v2/me" and request.method == "GET":
                    quota, rollout = await asyncio.gather(asyncio.to_thread(services.quota.status, user_id), asyncio.to_thread(services.guard.state))
                    return json_response({"ok": True, "user": public_user(principal["user"]), "quota": quota, "cloudHeavy": {"ready": config.cloud_heavy_rollout_mode == "aggressive" and not bool(rollout.get("forcedShadow")), "rolloutMode": config.cloud_heavy_rollout_mode, "rollout": rollout}}, headers=headers)
                if path == "/v2/me" and request.method == "DELETE": await asyncio.to_thread(services.store.delete_user, user_id); return json_response({"ok": True, "deleted": True}, headers=headers)
                if path == "/v2/auth/logout" and request.method == "POST": json_body(await read_body(request, config)); await asyncio.to_thread(services.auth.logout, str(principal["claims"]["sid"])); return json_response({"ok": True, "loggedOut": True}, headers=headers)
        if not is_vast(request.method, path): return json_response({"ok": False, "error": "Not found"}, 404, headers)
        services = await auth_services(request)
        principal, user_id = await authenticate(request), ""
        user_id = str(principal["user"]["id"])
        if not guards.route(ip, user_id): return json_response({"ok": False, "error": "Gateway rate limit exceeded; retry in one minute"}, 429, {**headers, "Retry-After": "60"})
        async with guards.route_slot(ip, user_id) as acquired:
            if not acquired: return json_response({"ok": False, "error": "Gateway is busy; retry shortly"}, 429, {**headers, "Retry-After": "1"})
            body = await read_body(request, config, request.method == "POST")
            if path in {"/v2/analyze", "/v2/analyze/batch"}:
                count, units = validate_analysis(path, json_body(body), config)
                if not guards.analysis(ip, user_id, units): return json_response({"ok": False, "error": "Analysis budget exceeded; retry in one minute"}, 429, {**headers, "Retry-After": "60"})
                quota = await asyncio.to_thread(services.quota.status, user_id)
                if int(quota.get("minuteRemaining", 0)) < count or int(quota.get("dayRemaining", 0)) < count: return json_response({"ok": False, "error": "Candidate quota exceeded"}, 429, {**headers, "Retry-After": "60"})
            query = gateway_query(request)
            envelope = make_envelope(request.method, path + (f"?{query}" if query else ""), request.headers, body)
            timeout = min(58.0, config.request_timeout_seconds) if path == "/v2/media-upload" else config.request_timeout_seconds
            result = await asyncio.wait_for(request.app.state.vast.invoke(envelope, timeout), timeout + .5)
            status, worker_headers, response_body = unwrap_worker_response(result)
            for key in ("access-control-allow-headers", "access-control-allow-methods", "access-control-allow-origin", "cache-control", "vary"): worker_headers.pop(key, None)
            return Response(response_body, status, {**worker_headers, **headers})
    except AuthError as error: return json_response({"ok": False, "error": str(error)[:240]}, 401, headers)
    except OverflowError: return json_response({"ok": False, "error": "Request is too large"}, 413, headers)
    except TimeoutError: return json_response({"ok": False, "error": "Request body deadline exceeded"}, 408, headers)
    except ValueError as error: return json_response({"ok": False, "error": str(error)[:240]}, 400, headers)
    except asyncio.TimeoutError: return json_response({"ok": False, "error": "Orislop is waking up", "retryAfterMs": 5000}, 503, {**headers, "Retry-After": "5"})
    except Exception: return json_response({"ok": False, "error": "Orislop is temporarily unavailable", "retryAfterMs": 5000}, 503, {**headers, "Retry-After": "5"})


def create_app(config: GatewayConfig | None = None, auth_services: Any = None, vast_client: Any = None, *, lazy_auth: bool = False) -> Starlette:
    resolved = config or GatewayConfig.from_environment()
    application = Starlette(routes=[Route("/{path:path}", endpoint, methods=["GET", "POST", "DELETE", "OPTIONS"])])
    application.state.config = resolved
    application.state.auth = auth_services if lazy_auth or auth_services is not None else GatewayAuthServices.from_environment(resolved.allowed_origins)
    application.state.auth_lock = asyncio.Lock()
    application.state.guards, application.state.vast = GatewayGuards(resolved), vast_client or VastEndpointClient(resolved)
    return application


app = create_app(lazy_auth=True)
