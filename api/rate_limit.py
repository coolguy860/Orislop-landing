"""Privacy-preserving shared gateway rate-limit keys and policy adapter."""

from __future__ import annotations

import hashlib
import hmac
from typing import Any


class SharedRateLimiter:
    """Apply one atomic rate-limit decision across all Vercel instances.

    The persistence layer receives only keyed digests.  In particular, client
    IP addresses are never written to PostgreSQL in raw or reversibly hashed
    form.  The token signing secret is domain-separated before it is used as
    the HMAC key, so rate-limit rows cannot help validate token signatures.
    """

    def __init__(self, store: Any, token_secret: str) -> None:
        if len(token_secret.encode("utf-8")) < 32:
            raise RuntimeError("ORISLOP_TOKEN_SECRET must contain at least 32 bytes")
        self.store = store
        self.pepper = hashlib.sha256(
            (token_secret + ":gateway-rate-limit:v1").encode("utf-8")
        ).digest()

    def _key(self, policy: str, dimension: str, value: str) -> str:
        payload = f"v1\0{policy}\0{dimension}\0{value}".encode("utf-8")
        return hmac.new(self.pepper, payload, hashlib.sha256).hexdigest()

    def allow(
        self,
        policy: str,
        limits: tuple[tuple[str, str, int], ...],
        cost: int = 1,
    ) -> bool:
        if not policy or not limits:
            raise ValueError("Rate-limit policy and scopes are required")
        if cost < 1:
            raise ValueError("Rate-limit cost must be positive")
        keyed_limits = tuple(
            (self._key(policy, dimension, value), int(limit))
            for dimension, value, limit in limits
        )
        return bool(self.store.consume_gateway_rate_limit(keyed_limits, cost))
