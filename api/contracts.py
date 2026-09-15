"""Dependency-free validation and encoding for the serverless gateway."""

from __future__ import annotations

import base64
import json
from typing import Any, Mapping


REQUEST_HEADER_ALLOWLIST = {
    "accept",
    "authorization",
    "content-type",
    "origin",
    "x-orislop-media-platform",
    "x-orislop-media-partial",
}
RESPONSE_HEADER_ALLOWLIST = {
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-origin",
    "cache-control",
    "content-security-policy",
    "content-type",
    "referrer-policy",
    "retry-after",
    "vary",
    "x-content-type-options",
    "x-frame-options",
    "x-orislop-request-id",
}


def valid_cloud_path(path: str) -> bool:
    return (
        path in {"/health", "/ready"}
        or path.startswith("/v2/")
    ) and not any(segment in {".", ".."} for segment in path.split("/"))


def clean_headers(headers: Mapping[str, Any], allowlist: set[str]) -> dict[str, str]:
    cleaned: dict[str, str] = {}
    for key, value in headers.items():
        normalized = str(key).strip().lower()
        text = str(value).strip()
        if normalized in allowlist and text and "\r" not in text and "\n" not in text:
            cleaned[normalized] = text
    return cleaned


def make_envelope(method: str, path_qs: str, headers: Mapping[str, Any], body: bytes) -> dict[str, Any]:
    method = method.upper()
    if method not in {"GET", "POST", "DELETE"}:
        raise ValueError("unsupported method")
    path = path_qs.split("?", 1)[0]
    if not valid_cloud_path(path):
        raise ValueError("unsupported path")
    return {
        "method": method,
        "path": path_qs,
        "headers": clean_headers(headers, REQUEST_HEADER_ALLOWLIST),
        "bodyBase64": base64.b64encode(body).decode("ascii"),
    }


def request_cost(envelope: Mapping[str, Any]) -> int:
    path = str(envelope.get("path", "")).split("?", 1)[0]
    if path in {"/health", "/ready", "/v2/me"} or path.startswith("/v2/auth/"):
        return 1
    body_base64 = str(envelope.get("bodyBase64", ""))
    candidates = 1
    if path == "/v2/analyze/batch" and body_base64:
        try:
            body = json.loads(base64.b64decode(body_base64).decode("utf-8"))
            candidates = max(1, min(10, len(body.get("candidates", []))))
        except (ValueError, TypeError, json.JSONDecodeError):
            pass
    upload_mib = len(body_base64) / (1024 * 1024 * 4 / 3)
    return max(1, min(200, int(candidates * 10 + upload_mib)))


def unwrap_worker_response(result: Any) -> tuple[int, dict[str, str], bytes]:
    candidate = result
    if isinstance(candidate, Mapping) and candidate.get("ok") is False:
        raise ValueError("Vast did not complete the worker request")
    if isinstance(candidate, Mapping) and "response" in candidate:
        candidate = candidate["response"]
    if isinstance(candidate, Mapping) and "result" in candidate:
        candidate = candidate["result"]
    if isinstance(candidate, str):
        candidate = json.loads(candidate)
    if not isinstance(candidate, Mapping):
        raise ValueError("Vast worker returned an invalid response")
    status = int(candidate.get("status", 502))
    if status < 100 or status > 599:
        raise ValueError("Vast worker returned an invalid status")
    headers = candidate.get("headers", {})
    if not isinstance(headers, Mapping):
        raise ValueError("Vast worker returned invalid headers")
    try:
        body = base64.b64decode(str(candidate.get("bodyBase64", "")), validate=True)
    except Exception as error:
        raise ValueError("Vast worker returned an invalid body") from error
    return status, clean_headers(headers, RESPONSE_HEADER_ALLOWLIST), body
