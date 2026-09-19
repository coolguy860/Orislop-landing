from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import threading
import time
from typing import Any, Callable
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import uuid


ACCESS_TOKEN_SECONDS = 15 * 60
REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
PER_MINUTE_CANDIDATES = 30
PER_DAY_CANDIDATES = 500
MAX_ANALYZE_BATCH_SIZE = 10
MAX_MEDIA_DURATION_SECONDS = min(
    max(int(os.environ.get("ORISLOP_MAX_MEDIA_DURATION_SECONDS", str(2 * 60 * 60))), 60),
    6 * 60 * 60,
)
MAX_PENDING_ANALYSES_PER_USER = min(
    max(int(os.environ.get("ORISLOP_MAX_PENDING_ANALYSES_PER_USER", "10")), 1),
    50,
)
MAX_PENDING_ANALYSES_GLOBAL = min(
    max(int(os.environ.get("ORISLOP_MAX_PENDING_ANALYSES_GLOBAL", "100")), MAX_PENDING_ANALYSES_PER_USER),
    500,
)
PENDING_ANALYSIS_TTL_SECONDS = min(
    max(int(os.environ.get("ORISLOP_PENDING_ANALYSIS_TTL_SECONDS", "300")), 60),
    900,
)
GATEWAY_DB_CONNECT_TIMEOUT_SECONDS = 5
GATEWAY_DB_STATEMENT_TIMEOUT_MS = 2500
GATEWAY_DB_LOCK_TIMEOUT_MS = 750
GATEWAY_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS = 5.0
GATEWAY_RATE_LIMIT_CLEANUP_BATCH_SIZE = 500
GATEWAY_SCHEMA_LOCK_KEY = "orislop:postgres-schema:v1"
SUPPORTED_PLATFORMS = {"youtube", "instagram", "tiktok", "linkedin"}


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _json_b64(payload: dict[str, Any]) -> str:
    return _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def _utc_iso(timestamp: float | None = None) -> str:
    return datetime.fromtimestamp(timestamp or time.time(), tz=timezone.utc).isoformat()


class AuthError(ValueError):
    pass


class QuotaError(ValueError):
    pass


class AccessTokens:
    def __init__(self, secret: str) -> None:
        if len(secret.encode("utf-8")) < 32:
            raise RuntimeError("ORISLOP_TOKEN_SECRET must contain at least 32 bytes")
        self.secret = secret.encode("utf-8")

    def issue(self, user_id: str, session_id: str) -> tuple[str, int]:
        now = int(time.time())
        payload = {
            "sub": user_id,
            "sid": session_id,
            "iat": now,
            "exp": now + ACCESS_TOKEN_SECONDS,
            "iss": "https://api.orislop.com",
            "aud": "orislop-extension",
            "typ": "access",
        }
        header = _json_b64({"alg": "HS256", "typ": "JWT"})
        encoded_payload = _json_b64(payload)
        signing_input = f"{header}.{encoded_payload}".encode("ascii")
        signature = _b64url(hmac.new(self.secret, signing_input, hashlib.sha256).digest())
        return f"{header}.{encoded_payload}.{signature}", ACCESS_TOKEN_SECONDS

    def verify(self, token: str) -> dict[str, Any]:
        try:
            header, encoded_payload, signature = token.split(".", 2)
            signing_input = f"{header}.{encoded_payload}".encode("ascii")
            expected = _b64url(hmac.new(self.secret, signing_input, hashlib.sha256).digest())
            if not hmac.compare_digest(signature, expected):
                raise AuthError("Invalid access token")
            token_header = json.loads(_b64decode(header))
            payload = json.loads(_b64decode(encoded_payload))
        except AuthError:
            raise
        except Exception as error:
            raise AuthError("Malformed access token") from error
        if token_header != {"alg": "HS256", "typ": "JWT"}:
            raise AuthError("Invalid access token header")
        if (
            payload.get("typ") != "access"
            or payload.get("aud") != "orislop-extension"
            or payload.get("iss") != "https://api.orislop.com"
            or not isinstance(payload.get("sub"), str)
            or not payload.get("sub")
            or not isinstance(payload.get("sid"), str)
            or not payload.get("sid")
        ):
            raise AuthError("Invalid access token claims")
        try:
            issued_at = int(payload.get("iat", 0))
            expires_at = int(payload.get("exp", 0))
        except (TypeError, ValueError) as error:
            raise AuthError("Invalid access token timestamps") from error
        now = int(time.time())
        if issued_at <= 0 or issued_at > now + 60 or expires_at <= issued_at:
            raise AuthError("Invalid access token timestamps")
        if expires_at <= now:
            raise AuthError("Access token expired")
        return payload


class MemoryBetaStore:
    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.sessions: dict[str, dict[str, Any]] = {}
        self.decisions: dict[str, dict[str, Any]] = {}
        self.feedback: dict[str, dict[str, Any]] = {}
        self.gateway_rate_limits: dict[str, deque[tuple[float, int]]] = {}
        self.lock = threading.RLock()

    def consume_gateway_rate_limit(
        self,
        limits: tuple[tuple[str, int], ...],
        cost: int,
    ) -> bool:
        """Atomically check and consume an exact rolling one-minute budget."""
        if cost < 1 or not limits or any(not key or limit < 1 for key, limit in limits):
            raise ValueError("Invalid gateway rate-limit request")
        now = time.monotonic()
        normalized: dict[str, int] = {}
        for key, limit in limits:
            normalized[key] = min(normalized.get(key, limit), limit)
        with self.lock:
            for key in list(self.gateway_rate_limits):
                events = self.gateway_rate_limits[key]
                while events and now - events[0][0] >= 60:
                    events.popleft()
                if not events:
                    self.gateway_rate_limits.pop(key, None)
            if any(
                sum(event_cost for _, event_cost in self.gateway_rate_limits.get(key, ())) + cost > limit
                for key, limit in normalized.items()
            ):
                return False
            for key in normalized:
                self.gateway_rate_limits.setdefault(key, deque()).append((now, cost))
            return True

    def upsert_user(self, google_subject: str, email: str, name: str) -> dict[str, Any]:
        user_id = hashlib.sha256(f"google:{google_subject}".encode()).hexdigest()[:32]
        with self.lock:
            existing = self.users.get(user_id, {})
            user = {
                "id": user_id,
                "google_subject": google_subject,
                "email": email,
                "name": name,
                "revoked": bool(existing.get("revoked", False)),
                "created_at": existing.get("created_at", _utc_iso()),
            }
            self.users[user_id] = user
            return dict(user)

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self.lock:
            value = self.users.get(user_id)
            return dict(value) if value else None

    def get_active_user(self, session_id: str, user_id: str) -> dict[str, Any] | None:
        with self.lock:
            session = self.sessions.get(session_id)
            user = self.users.get(user_id)
            if not (
                session and user and session["user_id"] == user_id and not session["revoked"]
                and not user["revoked"] and session["expires_at"] > time.time()
            ):
                return None
            return dict(user)

    def create_session(self, user_id: str, refresh_hash: str, expires_at: float, session_id: str | None = None) -> str:
        session_id = session_id or uuid.uuid4().hex
        with self.lock:
            self.sessions[session_id] = {
                "id": session_id,
                "user_id": user_id,
                "refresh_hash": refresh_hash,
                "previous_hash": "",
                "expires_at": expires_at,
                "revoked": False,
            }
        return session_id

    def session_active(self, session_id: str, user_id: str) -> bool:
        with self.lock:
            session = self.sessions.get(session_id)
            user = self.users.get(user_id)
            return bool(
                session and user and session["user_id"] == user_id and not session["revoked"]
                and not user["revoked"] and session["expires_at"] > time.time()
            )

    def rotate_refresh(self, session_id: str, presented_hash: str, replacement_hash: str, expires_at: float) -> str:
        with self.lock:
            session = self.sessions.get(session_id)
            if not session or session["revoked"] or session["expires_at"] <= time.time():
                raise AuthError("Refresh session is expired or revoked")
            if hmac.compare_digest(presented_hash, session.get("previous_hash", "")):
                raise AuthError("Refresh token was already rotated")
            if not hmac.compare_digest(presented_hash, session["refresh_hash"]):
                raise AuthError("Invalid refresh token")
            session["previous_hash"] = session["refresh_hash"]
            session["refresh_hash"] = replacement_hash
            session["expires_at"] = expires_at
            return session["user_id"]

    def revoke_session(self, session_id: str) -> None:
        with self.lock:
            if session_id in self.sessions:
                self.sessions[session_id]["revoked"] = True

    def revoke_user(self, user_id: str) -> None:
        with self.lock:
            if user_id in self.users:
                self.users[user_id]["revoked"] = True
            for session in self.sessions.values():
                if session["user_id"] == user_id:
                    session["revoked"] = True

    def delete_user(self, user_id: str) -> None:
        with self.lock:
            self.users.pop(user_id, None)
            self.sessions = {key: value for key, value in self.sessions.items() if value["user_id"] != user_id}
            decision_ids = {key for key, value in self.decisions.items() if value.get("userId") == user_id}
            self.decisions = {key: value for key, value in self.decisions.items() if key not in decision_ids}
            self.feedback = {key: value for key, value in self.feedback.items() if value.get("userId") != user_id}

    def save_decisions(self, decisions: list[dict[str, Any]]) -> None:
        with self.lock:
            for decision in decisions:
                self.decisions[decision["decisionId"]] = json.loads(json.dumps(decision))

    def save_decision(self, decision: dict[str, Any]) -> None:
        self.save_decisions([decision])

    def get_decision(self, decision_id: str) -> dict[str, Any] | None:
        with self.lock:
            value = self.decisions.get(decision_id)
            return json.loads(json.dumps(value)) if value else None

    def save_feedback(self, feedback: dict[str, Any]) -> None:
        with self.lock:
            self.feedback[feedback["feedbackId"]] = json.loads(json.dumps(feedback))


class PostgresBetaStore(MemoryBetaStore):
    """Managed-Postgres persistence. In-memory maps retain only transient media jobs."""

    def __init__(self, database_url: str) -> None:
        super().__init__()
        try:
            import psycopg
        except ImportError as error:
            raise RuntimeError("psycopg is required when DATABASE_URL is configured") from error
        self.psycopg = psycopg
        self.database_url = database_url
        self._gateway_cleanup_lock = threading.Lock()
        self._gateway_last_cleanup = 0.0
        self._initialize()

    def _connect(self, *, connect_timeout_seconds: int | None = None):
        if connect_timeout_seconds is None:
            return self.psycopg.connect(self.database_url)
        return self.psycopg.connect(
            self.database_url,
            connect_timeout=connect_timeout_seconds,
        )

    def _configure_bounded_transaction(self, connection: Any, cursor: Any) -> None:
        """Set isolation before the first query and bound all later waits."""
        connection.isolation_level = self.psycopg.IsolationLevel.READ_COMMITTED
        cursor.execute(
            """SELECT set_config('statement_timeout', %s, true),
                      set_config('lock_timeout', %s, true)""",
            (
                f"{GATEWAY_DB_STATEMENT_TIMEOUT_MS}ms",
                f"{GATEWAY_DB_LOCK_TIMEOUT_MS}ms",
            ),
        )

    def _initialize(self) -> None:
        statements = """
        CREATE TABLE IF NOT EXISTS beta_users (
          id TEXT PRIMARY KEY, google_subject TEXT UNIQUE NOT NULL, email TEXT NOT NULL,
          display_name TEXT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS beta_sessions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES beta_users(id) ON DELETE CASCADE,
          refresh_hash TEXT NOT NULL, previous_hash TEXT NOT NULL DEFAULT '',
          expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS beta_decisions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES beta_users(id) ON DELETE CASCADE,
          content_key TEXT NOT NULL, platform TEXT NOT NULL, model_bundle_version TEXT,
          outcome JSONB NOT NULL, feedback_state TEXT NOT NULL DEFAULT 'none',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS beta_feedback (
          id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES beta_decisions(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES beta_users(id) ON DELETE CASCADE,
          payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS beta_candidate_events (
          id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES beta_users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS beta_candidate_events_user_created_idx
          ON beta_candidate_events (user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS beta_rollout_events (
          id BIGSERIAL PRIMARY KEY, event_type TEXT NOT NULL,
          latency_ms INTEGER, failed BOOLEAN, revealed BOOLEAN, confirmed_wrong BOOLEAN,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS beta_rollout_events_type_created_idx
          ON beta_rollout_events (event_type, created_at DESC);
        CREATE TABLE IF NOT EXISTS gateway_rate_limit_events (
          id BIGSERIAL PRIMARY KEY, key_hash TEXT NOT NULL,
          request_cost INTEGER NOT NULL CHECK (request_cost > 0),
          occurred_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gateway_rate_limit_events_key_time_idx
          ON gateway_rate_limit_events (key_hash, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS gateway_rate_limit_events_expiry_idx
          ON gateway_rate_limit_events (expires_at);
        """
        with self._connect(
            connect_timeout_seconds=GATEWAY_DB_CONNECT_TIMEOUT_SECONDS
        ) as connection:
            with connection.cursor() as cursor:
                self._configure_bounded_transaction(connection, cursor)
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    (GATEWAY_SCHEMA_LOCK_KEY,),
                )
                cursor.execute(statements)
                cursor.execute(
                    """SELECT to_regclass('gateway_rate_limit_events'),
                              to_regclass('gateway_rate_limit_events_key_time_idx'),
                              to_regclass('gateway_rate_limit_events_expiry_idx')"""
                )
                if any(value is None for value in cursor.fetchone()):
                    raise RuntimeError("Gateway rate-limit schema verification failed")

    def upsert_user(self, google_subject: str, email: str, name: str) -> dict[str, Any]:
        user_id = hashlib.sha256(f"google:{google_subject}".encode()).hexdigest()[:32]
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """INSERT INTO beta_users (id,google_subject,email,display_name) VALUES (%s,%s,%s,%s)
                ON CONFLICT (google_subject) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name
                RETURNING id,google_subject,email,display_name,revoked,created_at""",
                (user_id, google_subject, email, name),
            )
            row = cursor.fetchone()
        return {"id": row[0], "google_subject": row[1], "email": row[2], "name": row[3], "revoked": row[4], "created_at": row[5].isoformat()}

    def consume_gateway_rate_limit(
        self,
        limits: tuple[tuple[str, int], ...],
        cost: int,
    ) -> bool:
        """Atomically check and consume all rolling one-minute scopes.

        Transaction-scoped advisory locks serialize the absent-row case as
        well as existing buckets.  Sorted lock order prevents deadlocks when
        requests contain overlapping global, IP, and account scopes.
        """
        if cost < 1 or not limits or any(not key or limit < 1 for key, limit in limits):
            raise ValueError("Invalid gateway rate-limit request")
        normalized: dict[str, int] = {}
        for key, limit in limits:
            normalized[key] = min(normalized.get(key, int(limit)), int(limit))
        keys = sorted(normalized)
        with self._connect(
            connect_timeout_seconds=GATEWAY_DB_CONNECT_TIMEOUT_SECONDS
        ) as connection, connection.cursor() as cursor:
            self._configure_bounded_transaction(connection, cursor)
            for key in keys:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    (key,),
                )
            cursor.execute("SELECT clock_timestamp()")
            now = cursor.fetchone()[0]
            cursor.execute(
                """SELECT key_hash,coalesce(sum(request_cost),0)
                FROM gateway_rate_limit_events
                WHERE occurred_at>%s-interval '60 seconds' AND key_hash=ANY(%s)
                GROUP BY key_hash""",
                (now, keys),
            )
            counts = {str(key): int(value) for key, value in cursor.fetchall()}
            if any(counts.get(key, 0) + cost > normalized[key] for key in keys):
                return False
            cursor.executemany(
                """INSERT INTO gateway_rate_limit_events
                (key_hash,request_cost,occurred_at,expires_at)
                VALUES (%s,%s,%s,%s+interval '5 minutes')""",
                [(key, cost, now, now) for key in keys],
            )
        self._maybe_cleanup_gateway_rate_limits(now)
        return True

    def _maybe_cleanup_gateway_rate_limits(self, fixed_now: datetime) -> None:
        """Best-effort cleanup outside the admission-lock transaction.

        Cleanup is throttled per process and skips rows locked by another
        cleaner. A cleanup failure never reverses an already committed limiter
        decision; expired rows remain excluded from admission by occurred_at.
        """
        monotonic_now = time.monotonic()
        with self._gateway_cleanup_lock:
            if (
                monotonic_now - self._gateway_last_cleanup
                < GATEWAY_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS
            ):
                return
            self._gateway_last_cleanup = monotonic_now
        try:
            with self._connect(
                connect_timeout_seconds=GATEWAY_DB_CONNECT_TIMEOUT_SECONDS
            ) as connection, connection.cursor() as cursor:
                self._configure_bounded_transaction(connection, cursor)
                cursor.execute(
                    """WITH expired AS (
                      SELECT id FROM gateway_rate_limit_events
                      WHERE expires_at<=%s ORDER BY expires_at,id
                      LIMIT %s FOR UPDATE SKIP LOCKED
                    )
                    DELETE FROM gateway_rate_limit_events AS events
                    USING expired WHERE events.id=expired.id""",
                    (fixed_now, GATEWAY_RATE_LIMIT_CLEANUP_BATCH_SIZE),
                )
        except Exception:
            # Cleanup must not turn an already committed admission into a 503.
            return

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT id,google_subject,email,display_name,revoked,created_at FROM beta_users WHERE id=%s", (user_id,))
            row = cursor.fetchone()
        return None if row is None else {"id": row[0], "google_subject": row[1], "email": row[2], "name": row[3], "revoked": row[4], "created_at": row[5].isoformat()}

    def get_active_user(self, session_id: str, user_id: str) -> dict[str, Any] | None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """SELECT u.id,u.google_subject,u.email,u.display_name,u.revoked,u.created_at
                FROM beta_sessions s JOIN beta_users u ON u.id=s.user_id
                WHERE s.id=%s AND s.user_id=%s AND NOT s.revoked AND NOT u.revoked AND s.expires_at>now()""",
                (session_id, user_id),
            )
            row = cursor.fetchone()
        return None if row is None else {"id": row[0], "google_subject": row[1], "email": row[2], "name": row[3], "revoked": row[4], "created_at": row[5].isoformat()}

    def create_session(self, user_id: str, refresh_hash: str, expires_at: float, session_id: str | None = None) -> str:
        session_id = session_id or uuid.uuid4().hex
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO beta_sessions (id,user_id,refresh_hash,expires_at) VALUES (%s,%s,%s,to_timestamp(%s))",
                (session_id, user_id, refresh_hash, expires_at),
            )
        return session_id

    def session_active(self, session_id: str, user_id: str) -> bool:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """SELECT 1 FROM beta_sessions s JOIN beta_users u ON u.id=s.user_id
                WHERE s.id=%s AND s.user_id=%s AND NOT s.revoked AND NOT u.revoked AND s.expires_at>now()""",
                (session_id, user_id),
            )
            return cursor.fetchone() is not None

    def rotate_refresh(self, session_id: str, presented_hash: str, replacement_hash: str, expires_at: float) -> str:
        user_id = ""
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT user_id,refresh_hash,previous_hash,revoked,expires_at>now() FROM beta_sessions WHERE id=%s FOR UPDATE", (session_id,))
            row = cursor.fetchone()
            if not row or row[3] or not row[4]:
                raise AuthError("Refresh session is expired or revoked")
            if row[2] and hmac.compare_digest(presented_hash, row[2]):
                raise AuthError("Refresh token was already rotated")
            elif not hmac.compare_digest(presented_hash, row[1]):
                raise AuthError("Invalid refresh token")
            else:
                cursor.execute(
                    "UPDATE beta_sessions SET previous_hash=refresh_hash,refresh_hash=%s,expires_at=to_timestamp(%s) WHERE id=%s",
                    (replacement_hash, expires_at, session_id),
                )
                user_id = row[0]
        return user_id

    def revoke_session(self, session_id: str) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("UPDATE beta_sessions SET revoked=TRUE WHERE id=%s", (session_id,))

    def revoke_user(self, user_id: str) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("UPDATE beta_users SET revoked=TRUE WHERE id=%s", (user_id,))
            cursor.execute("UPDATE beta_sessions SET revoked=TRUE WHERE user_id=%s", (user_id,))

    def delete_user(self, user_id: str) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("DELETE FROM beta_users WHERE id=%s", (user_id,))

    def save_decisions(self, decisions: list[dict[str, Any]]) -> None:
        if not decisions:
            return
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("DELETE FROM beta_feedback WHERE expires_at<=now()")
            cursor.execute("DELETE FROM beta_decisions WHERE expires_at<=now()")
            cursor.executemany(
                """INSERT INTO beta_decisions (id,user_id,content_key,platform,model_bundle_version,outcome,expires_at)
                VALUES (%s,%s,%s,%s,%s,%s::jsonb,now()+interval '30 days')
                ON CONFLICT (id) DO UPDATE SET model_bundle_version=EXCLUDED.model_bundle_version,outcome=EXCLUDED.outcome""",
                [
                    (
                        decision["decisionId"], decision["userId"], decision["contentKey"], decision["platform"],
                        decision.get("modelBundleVersion"), json.dumps(decision),
                    )
                    for decision in decisions
                ],
            )

    def save_decision(self, decision: dict[str, Any]) -> None:
        self.save_decisions([decision])

    def get_decision(self, decision_id: str) -> dict[str, Any] | None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT outcome FROM beta_decisions WHERE id=%s AND expires_at>now()", (decision_id,))
            row = cursor.fetchone()
        return None if row is None else dict(row[0])

    def save_feedback(self, feedback: dict[str, Any]) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("DELETE FROM beta_feedback WHERE expires_at<=now()")
            cursor.execute("DELETE FROM beta_decisions WHERE expires_at<=now()")
            cursor.execute(
                """INSERT INTO beta_feedback (id,decision_id,user_id,payload,expires_at)
                VALUES (%s,%s,%s,%s::jsonb,now()+interval '90 days')""",
                (feedback["feedbackId"], feedback["decisionId"], feedback["userId"], json.dumps(feedback)),
            )
            cursor.execute("UPDATE beta_decisions SET feedback_state=%s WHERE id=%s", (feedback["kind"], feedback["decisionId"]))

    def consume_candidate_quota(self, user_id: str) -> dict[str, int]:
        return self.consume_candidate_quota_batch(user_id, 1)

    def consume_candidate_quota_batch(self, user_id: str, count: int) -> dict[str, int]:
        """Atomically enforce quotas across restarts and multiple API processes."""
        if not 1 <= count <= MAX_ANALYZE_BATCH_SIZE:
            raise ValueError(f"candidate count must be between 1 and {MAX_ANALYZE_BATCH_SIZE}")
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT id FROM beta_users WHERE id=%s FOR UPDATE", (user_id,))
            if cursor.fetchone() is None:
                raise QuotaError("Account is unavailable")
            cursor.execute("DELETE FROM beta_candidate_events WHERE created_at < now()-interval '2 days'")
            cursor.execute(
                """SELECT
                  count(*) FILTER (WHERE created_at >= now()-interval '60 seconds'),
                  count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                FROM beta_candidate_events WHERE user_id=%s""",
                (user_id,),
            )
            minute_count, day_count = (int(value) for value in cursor.fetchone())
            if minute_count + count > PER_MINUTE_CANDIDATES:
                raise QuotaError("30-candidate per-minute quota exceeded")
            if day_count + count > PER_DAY_CANDIDATES:
                raise QuotaError("500-candidate daily quota exceeded")
            cursor.execute(
                "INSERT INTO beta_candidate_events (user_id) SELECT %s FROM generate_series(1,%s)",
                (user_id, count),
            )
        return {
            "minuteRemaining": PER_MINUTE_CANDIDATES - minute_count - count,
            "dayRemaining": PER_DAY_CANDIDATES - day_count - count,
        }

    def candidate_quota_status(self, user_id: str) -> dict[str, int]:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """SELECT
                  count(*) FILTER (WHERE created_at >= now()-interval '60 seconds'),
                  count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                FROM beta_candidate_events WHERE user_id=%s""",
                (user_id,),
            )
            minute_count, day_count = (int(value) for value in cursor.fetchone())
        return {
            "minuteRemaining": max(0, PER_MINUTE_CANDIDATES - minute_count),
            "dayRemaining": max(0, PER_DAY_CANDIDATES - day_count),
        }

    def record_rollout_job(self, latency_ms: int, failed: bool) -> None:
        self.record_rollout_jobs([{"latency_ms": latency_ms, "failed": failed}])

    def record_rollout_jobs(self, jobs: list[dict[str, Any]]) -> None:
        if not jobs:
            return
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO beta_rollout_events (event_type,latency_ms,failed) VALUES ('job',%s,%s)",
                [(int(job["latency_ms"]), bool(job.get("failed"))) for job in jobs],
            )
            cursor.execute("DELETE FROM beta_rollout_events WHERE created_at < now()-interval '30 days'")

    def record_rollout_feedback(self, revealed: bool, confirmed_wrong: bool) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO beta_rollout_events (event_type,revealed,confirmed_wrong) VALUES ('feedback',%s,%s)",
                (revealed, confirmed_wrong),
            )

    def rollout_guard_state(self) -> dict[str, Any]:
        reasons: list[str] = []
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT latency_ms,failed FROM beta_rollout_events WHERE event_type='job' ORDER BY id DESC LIMIT 100"
            )
            jobs = cursor.fetchall()
            cursor.execute(
                "SELECT revealed FROM beta_rollout_events WHERE event_type='feedback' ORDER BY id DESC LIMIT 100"
            )
            hides = cursor.fetchall()
            cursor.execute(
                """SELECT count(*) FROM beta_rollout_events
                WHERE event_type='feedback' AND confirmed_wrong=TRUE AND created_at>=now()-interval '24 hours'"""
            )
            wrong_hides = int(cursor.fetchone()[0])
        if len(jobs) == 100:
            failures = sum(1 for _, failed in jobs if failed)
            warm = sorted(int(latency) for latency, failed in jobs if not failed and latency is not None)
            p95 = warm[min(len(warm) - 1, math.ceil(len(warm) * 0.95) - 1)] if warm else 999999
            if failures / 100 > 0.05:
                reasons.append("GPU OOM/5xx exceeded 5% over 100 jobs")
            elif p95 > 5000:
                reasons.append("Warm P95 exceeded five seconds over 100 jobs")
        if len(hides) == 100 and sum(1 for (revealed,) in hides if revealed) / 100 > 0.20:
            reasons.append("Reveal-after-hide exceeded 20% over 100 hides")
        if wrong_hides >= 5:
            reasons.append("Five confirmed wrong-hide reports arrived within 24 hours")
        return {"forcedShadow": bool(reasons), "reason": "; ".join(reasons)}


class GoogleOidc:
    def __init__(
        self,
        client_id: str,
        token_exchange: Callable[[dict[str, str]], dict[str, Any]] | None = None,
        verifier: Callable[..., dict[str, Any]] | None = None,
        allowed_extension_ids: set[str] | None = None,
    ) -> None:
        self.client_id = client_id
        self.token_exchange = token_exchange or self._exchange
        self.verifier = verifier
        self.allowed_extension_ids = set(allowed_extension_ids or ())

    def _exchange(self, fields: dict[str, str]) -> dict[str, Any]:
        request = Request(
            "https://oauth2.googleapis.com/token",
            data=urlencode(fields).encode("utf-8"),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))

    def authenticate(self, body: dict[str, Any]) -> dict[str, str]:
        code = str(body.get("code") or "")
        verifier = str(body.get("codeVerifier") or "")
        redirect_uri = str(body.get("redirectUri") or "")
        expected_nonce = str(body.get("nonce") or "")
        if not code or len(verifier) < 43 or not expected_nonce:
            raise AuthError("OAuth code, PKCE verifier, and nonce are required")
        redirect = urlparse(redirect_uri)
        host = (redirect.hostname or "").lower()
        extension_match = re.fullmatch(r"([a-p]{32})\.chromiumapp\.org", host)
        try:
            redirect_port = redirect.port
        except ValueError as error:
            raise AuthError("OAuth redirect URI is malformed") from error
        if (
            redirect.scheme != "https"
            or extension_match is None
            or redirect_port is not None
            or redirect.path != "/oauth2"
            or redirect.query
            or redirect.fragment
            or redirect.username is not None
            or redirect.password is not None
        ):
            raise AuthError("OAuth redirect URI is not a Chrome extension redirect")
        extension_id = extension_match.group(1)
        if self.allowed_extension_ids and extension_id not in self.allowed_extension_ids:
            raise AuthError("OAuth redirect URI is not registered for this Orislop release")
        token_payload = self.token_exchange({
            "code": code,
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        })
        id_token_value = str(token_payload.get("id_token") or "")
        if not id_token_value:
            raise AuthError("Google did not return an ID token")
        if self.verifier is not None:
            claims = self.verifier(id_token_value, self.client_id)
        else:
            try:
                from google.auth.transport import requests as google_requests
                from google.oauth2 import id_token
            except ImportError as error:
                raise RuntimeError("google-auth is required for Google sign-in") from error
            claims = id_token.verify_oauth2_token(id_token_value, google_requests.Request(), self.client_id)
        if claims.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}:
            raise AuthError("Invalid Google token issuer")
        if claims.get("aud") != self.client_id or int(claims.get("exp", 0)) <= int(time.time()):
            raise AuthError("Google ID token is expired or for a different client")
        if not hmac.compare_digest(str(claims.get("nonce") or ""), expected_nonce):
            raise AuthError("Google ID token nonce mismatch")
        if claims.get("email_verified") is not True:
            raise AuthError("A verified Google account is required")
        return {
            "subject": str(claims["sub"]),
            "email": str(claims["email"]),
            "name": str(claims.get("name") or claims["email"]),
        }


class AuthManager:
    def __init__(self, store: MemoryBetaStore, google_oidc: GoogleOidc, token_secret: str) -> None:
        self.store = store
        self.google_oidc = google_oidc
        self.tokens = AccessTokens(token_secret)
        self.refresh_pepper = hashlib.sha256((token_secret + ":refresh").encode()).digest()

    def _refresh_hash(self, token: str) -> str:
        return hmac.new(self.refresh_pepper, token.encode("utf-8"), hashlib.sha256).hexdigest()

    def _new_refresh(self, session_id: str) -> str:
        return f"{session_id}.{secrets.token_urlsafe(48)}"

    def google_login(self, body: dict[str, Any]) -> dict[str, Any]:
        identity = self.google_oidc.authenticate(body)
        user = self.store.upsert_user(identity["subject"], identity["email"], identity["name"])
        if user["revoked"]:
            raise AuthError("This beta account has been revoked")
        session_id = uuid.uuid4().hex
        refresh = self._new_refresh(session_id)
        self.store.create_session(
            user["id"], self._refresh_hash(refresh), time.time() + REFRESH_TOKEN_SECONDS, session_id=session_id
        )
        access, expires_in = self.tokens.issue(user["id"], session_id)
        return {"accessToken": access, "expiresIn": expires_in, "refreshToken": refresh, "user": public_user(user)}

    def refresh(self, refresh_token: str) -> dict[str, Any]:
        session_id, separator, _ = refresh_token.partition(".")
        if not separator or not session_id:
            raise AuthError("Malformed refresh token")
        replacement = self._new_refresh(session_id)
        user_id = self.store.rotate_refresh(
            session_id,
            self._refresh_hash(refresh_token),
            self._refresh_hash(replacement),
            time.time() + REFRESH_TOKEN_SECONDS,
        )
        user = self.store.get_user(user_id)
        if not user or user["revoked"]:
            raise AuthError("Account is unavailable")
        access, expires_in = self.tokens.issue(user_id, session_id)
        return {"accessToken": access, "expiresIn": expires_in, "refreshToken": replacement, "user": public_user(user)}

    def authenticate_access(self, authorization: str) -> dict[str, Any]:
        if not authorization.startswith("Bearer "):
            raise AuthError("Access token required")
        claims = self.tokens.verify(authorization[7:].strip())
        session_id = str(claims["sid"])
        user_id = str(claims["sub"])
        active_user = getattr(self.store, "get_active_user", None)
        if callable(active_user):
            user = active_user(session_id, user_id)
        else:
            if not self.store.session_active(session_id, user_id):
                raise AuthError("Session is expired or revoked")
            user = self.store.get_user(user_id)
        if not user:
            raise AuthError("Session is expired, revoked, or unavailable")
        return {"claims": claims, "user": user}

    def logout(self, session_id: str) -> None:
        self.store.revoke_session(session_id)


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "email": user["email"], "name": user["name"]}


class CandidateQuota:
    def __init__(self, store: MemoryBetaStore | None = None) -> None:
        self.store = store
        self.minute: dict[str, deque[float]] = defaultdict(deque)
        self.day: dict[tuple[str, str], int] = defaultdict(int)
        self.lock = threading.Lock()

    def consume(self, user_id: str) -> dict[str, int]:
        return self.consume_many(user_id, 1)

    def consume_many(self, user_id: str, count: int) -> dict[str, int]:
        if not 1 <= count <= MAX_ANALYZE_BATCH_SIZE:
            raise ValueError(f"candidate count must be between 1 and {MAX_ANALYZE_BATCH_SIZE}")
        persistent_batch_consumer = getattr(self.store, "consume_candidate_quota_batch", None)
        if callable(persistent_batch_consumer):
            return persistent_batch_consumer(user_id, count)
        persistent_consumer = getattr(self.store, "consume_candidate_quota", None)
        if callable(persistent_consumer):
            result = None
            for _ in range(count):
                result = persistent_consumer(user_id)
            return result
        now = time.time()
        day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.lock:
            window = self.minute[user_id]
            while window and now - window[0] >= 60:
                window.popleft()
            if len(window) + count > PER_MINUTE_CANDIDATES:
                raise QuotaError("30-candidate per-minute quota exceeded")
            if self.day[(user_id, day_key)] + count > PER_DAY_CANDIDATES:
                raise QuotaError("500-candidate daily quota exceeded")
            window.extend([now] * count)
            self.day[(user_id, day_key)] += count
            return {
                "minuteRemaining": PER_MINUTE_CANDIDATES - len(window),
                "dayRemaining": PER_DAY_CANDIDATES - self.day[(user_id, day_key)],
            }

    def status(self, user_id: str) -> dict[str, int]:
        persistent_status = getattr(self.store, "candidate_quota_status", None)
        if callable(persistent_status):
            return persistent_status(user_id)
        now = time.time()
        day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.lock:
            window = self.minute[user_id]
            while window and now - window[0] >= 60:
                window.popleft()
            return {
                "minuteRemaining": max(0, PER_MINUTE_CANDIDATES - len(window)),
                "dayRemaining": max(0, PER_DAY_CANDIDATES - self.day[(user_id, day_key)]),
            }


class RolloutGuard:
    def __init__(self, store: MemoryBetaStore | None = None) -> None:
        self.store = store
        self.jobs: deque[dict[str, Any]] = deque(maxlen=100)
        self.hides: deque[bool] = deque(maxlen=100)
        self.wrong_hide_times: deque[float] = deque()
        self.forced_shadow_reason = ""
        self.lock = threading.Lock()

    def record_job(self, *, latency_ms: int, failed: bool = False, oom: bool = False) -> None:
        self.record_jobs([{"latency_ms": latency_ms, "failed": failed or oom}])

    def record_jobs(self, jobs: list[dict[str, Any]]) -> None:
        if not jobs:
            return
        persistent_batch_recorder = getattr(self.store, "record_rollout_jobs", None)
        if callable(persistent_batch_recorder):
            persistent_batch_recorder(jobs)
            return
        persistent_recorder = getattr(self.store, "record_rollout_job", None)
        if callable(persistent_recorder):
            for job in jobs:
                persistent_recorder(int(job["latency_ms"]), bool(job.get("failed")))
            return
        with self.lock:
            self.jobs.extend({"latency_ms": int(job["latency_ms"]), "failed": bool(job.get("failed"))} for job in jobs)
            if len(self.jobs) == 100:
                failures = sum(1 for job in self.jobs if job["failed"])
                warm_latencies = sorted(job["latency_ms"] for job in self.jobs if not job["failed"])
                p95 = warm_latencies[min(len(warm_latencies) - 1, math.ceil(len(warm_latencies) * 0.95) - 1)] if warm_latencies else 999999
                if failures / 100 > 0.05:
                    self.forced_shadow_reason = "GPU OOM/5xx exceeded 5% over 100 jobs"
                elif p95 > 5000:
                    self.forced_shadow_reason = "Warm P95 exceeded five seconds over 100 jobs"

    def record_hide_feedback(self, revealed: bool, confirmed_wrong: bool) -> None:
        persistent_recorder = getattr(self.store, "record_rollout_feedback", None)
        if callable(persistent_recorder):
            persistent_recorder(revealed, confirmed_wrong)
            return
        now = time.time()
        with self.lock:
            self.hides.append(revealed)
            if len(self.hides) == 100 and sum(self.hides) / 100 > 0.20:
                self.forced_shadow_reason = "Reveal-after-hide exceeded 20% over 100 hides"
            if confirmed_wrong:
                self.wrong_hide_times.append(now)
                while self.wrong_hide_times and now - self.wrong_hide_times[0] > 24 * 60 * 60:
                    self.wrong_hide_times.popleft()
                if len(self.wrong_hide_times) >= 5:
                    self.forced_shadow_reason = "Five confirmed wrong-hide reports arrived within 24 hours"

    def state(self) -> dict[str, Any]:
        persistent_state = getattr(self.store, "rollout_guard_state", None)
        if callable(persistent_state):
            return persistent_state()
        with self.lock:
            return {"forcedShadow": bool(self.forced_shadow_reason), "reason": self.forced_shadow_reason}


@dataclass
class PendingDecision:
    user_id: str
    platform: str
    candidate: dict[str, Any]
    content_key: str
    submitted_at: float


class CloudBetaController:
    def __init__(self, store: MemoryBetaStore, content_secret: str) -> None:
        if len(content_secret.encode("utf-8")) < 32:
            raise RuntimeError("ORISLOP_CONTENT_HMAC_SECRET must contain at least 32 bytes")
        self.store = store
        self.content_secret = content_secret.encode("utf-8")
        self.pending: dict[str, PendingDecision] = {}
        self.pending_reservations: dict[str, int] = defaultdict(int)
        self.quota = CandidateQuota(store)
        self.guard = RolloutGuard(store)
        self.lock = threading.Lock()

    def _content_key(self, platform: str, item_identifier: str) -> str:
        return hmac.new(self.content_secret, f"{platform}:{item_identifier}".encode(), hashlib.sha256).hexdigest()

    def analyze(
        self,
        user_id: str,
        body: dict[str, Any],
        service: Any,
        direct_media_validator: Callable[[str], bool],
        media_upload_validator: Callable[[str, str], bool] | None = None,
        *,
        quota_override: dict[str, int] | None = None,
        persist: bool = True,
    ) -> dict[str, Any]:
        platform = str(body.get("platform") or "").lower()
        item_identifier = str(body.get("itemIdentifier") or "")[:300]
        media_url = str(body.get("directMediaUrl") or "")[:4000]
        media_upload_id = str(body.get("mediaUploadId") or "").lower()[:80]
        raw_duration = body.get("duration", body.get("durationSeconds"))
        try:
            duration_seconds = float(raw_duration or 0)
        except (TypeError, ValueError) as error:
            raise ValueError("duration must be a finite non-negative number") from error
        if not math.isfinite(duration_seconds) or duration_seconds < 0:
            raise ValueError("duration must be a finite non-negative number")
        if duration_seconds > MAX_MEDIA_DURATION_SECONDS:
            raise ValueError(f"Video exceeds the {MAX_MEDIA_DURATION_SECONDS / 3600:g}-hour analysis limit")
        try:
            playback_position = float(body.get("playbackPosition") or 0)
        except (TypeError, ValueError) as error:
            raise ValueError("playbackPosition must be a finite non-negative number") from error
        if not math.isfinite(playback_position) or playback_position < 0:
            raise ValueError("playbackPosition must be a finite non-negative number")
        if platform not in SUPPORTED_PLATFORMS or not item_identifier:
            raise ValueError("platform and itemIdentifier are required")
        upload_allowed = bool(
            media_upload_validator is not None
            and re.fullmatch(r"[0-9a-f]{32}", media_upload_id)
            and media_upload_validator(media_upload_id, user_id)
        )
        if not direct_media_validator(media_url) and not upload_allowed:
            raise ValueError("An approved direct media URL or authenticated temporary media upload is required")
        with self.lock:
            stale_before = time.time() - PENDING_ANALYSIS_TTL_SECONDS
            for stale_id in [key for key, pending in self.pending.items() if pending.submitted_at < stale_before]:
                self.pending.pop(stale_id, None)
            user_pending = sum(1 for pending in self.pending.values() if pending.user_id == user_id)
            if user_pending + self.pending_reservations.get(user_id, 0) >= MAX_PENDING_ANALYSES_PER_USER:
                raise QuotaError("Too many analyses are already pending for this account")
            if len(self.pending) + sum(self.pending_reservations.values()) >= MAX_PENDING_ANALYSES_GLOBAL:
                raise QuotaError("The analysis queue is full; retry shortly")
            self.pending_reservations[user_id] += 1
        try:
            quota = quota_override if quota_override is not None else self.quota.consume(user_id)
        except Exception:
            with self.lock:
                self.pending_reservations[user_id] -= 1
                if self.pending_reservations[user_id] <= 0:
                    self.pending_reservations.pop(user_id, None)
            raise
        decision_id = uuid.uuid4().hex
        priority = 0 if str(body.get("priority") or "current").lower() in {"current", "0", "high"} else 10
        candidate = {
            "id": decision_id,
            "url": "",
            "mediaUrl": media_url,
            "mediaUploadId": media_upload_id if upload_allowed else "",
            "language": str(body.get("language") or "unknown")[:20],
            "priority": priority,
            "durationSeconds": duration_seconds,
            "playbackPositionSeconds": min(playback_position, duration_seconds or MAX_MEDIA_DURATION_SECONDS),
        }
        pending = PendingDecision(user_id, platform, candidate, self._content_key(platform, item_identifier), time.time())
        with self.lock:
            self.pending[decision_id] = pending
            self.pending_reservations[user_id] -= 1
            if self.pending_reservations[user_id] <= 0:
                self.pending_reservations.pop(user_id, None)
        try:
            result = service.submit([candidate], "heavy")[0]
        except Exception:
            with self.lock:
                self.pending.pop(decision_id, None)
            raise
        terminal = result.get("status") in {"ready", "error"}
        response = self._format(
            decision_id,
            pending,
            result,
            guard_state=None if terminal else {"forcedShadow": False, "reason": ""},
        )
        if terminal:
            with self.lock:
                self.pending.pop(decision_id, None)
        if persist:
            self.store.save_decision(response)
        return {**response, "quota": quota}

    def analyze_batch(
        self,
        user_id: str,
        body: dict[str, Any],
        service: Any,
        direct_media_validator: Callable[[str], bool],
        media_upload_validator: Callable[[str, str], bool] | None = None,
    ) -> dict[str, Any]:
        candidates = body.get("candidates")
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= MAX_ANALYZE_BATCH_SIZE:
            raise ValueError(f"candidates must contain 1 to {MAX_ANALYZE_BATCH_SIZE} items")
        batch_quota = self.quota.consume_many(user_id, len(candidates))
        results: list[dict[str, Any]] = []
        decisions_to_persist: list[dict[str, Any]] = []
        for raw in candidates:
            if not isinstance(raw, dict):
                results.append({"clientId": "", "status": "unavailable", "error": "Candidate must be an object"})
                continue
            client_id = str(raw.get("clientId") or "")[:80]
            try:
                result = self.analyze(
                    user_id,
                    raw,
                    service,
                    direct_media_validator,
                    media_upload_validator,
                    quota_override=batch_quota,
                    persist=False,
                )
                results.append({"clientId": client_id, **result})
                decisions_to_persist.append({key: value for key, value in result.items() if key != "quota"})
            except (QuotaError, ValueError) as error:
                results.append({
                    "clientId": client_id,
                    "status": "unavailable",
                    "automaticSkipEligible": False,
                    "error": str(error)[:240],
                })
        self.store.save_decisions(decisions_to_persist)
        return {"results": results, "quota": batch_quota}

    def get_analysis(self, user_id: str, decision_id: str, service: Any) -> dict[str, Any]:
        return self.get_analyses(user_id, [decision_id], service)[0]

    def get_analyses(self, user_id: str, decision_ids: Any, service: Any) -> list[dict[str, Any]]:
        if not isinstance(decision_ids, list) or not 1 <= len(decision_ids) <= MAX_ANALYZE_BATCH_SIZE:
            raise ValueError(f"decisionIds must contain 1 to {MAX_ANALYZE_BATCH_SIZE} items")
        normalized_ids = [str(value or "")[:80] for value in decision_ids]
        if any(not value for value in normalized_ids) or len(set(normalized_ids)) != len(normalized_ids):
            raise ValueError("decisionIds must contain unique non-empty strings")

        with self.lock:
            pending_by_id = {decision_id: self.pending.get(decision_id) for decision_id in normalized_ids}
        for pending in pending_by_id.values():
            if pending is not None and pending.user_id != user_id:
                raise ValueError("Decision not found")

        stored_by_id: dict[str, dict[str, Any]] = {}
        for decision_id in normalized_ids:
            if pending_by_id[decision_id] is not None:
                continue
            stored = self.store.get_decision(decision_id)
            if not stored or stored.get("userId") != user_id:
                raise ValueError("Decision not found")
            stored_by_id[decision_id] = stored

        live_ids = [decision_id for decision_id in normalized_ids if pending_by_id[decision_id] is not None]
        live_results: dict[str, dict[str, Any]] = {}
        if live_ids:
            candidates = [pending_by_id[decision_id].candidate for decision_id in live_ids]
            submitted = service.submit(candidates, "heavy")
            if not isinstance(submitted, list) or len(submitted) != len(live_ids):
                raise RuntimeError("Detector returned an incomplete batch status response")
            for decision_id, result in zip(live_ids, submitted):
                if not isinstance(result, dict) or result.get("id") not in {None, "", decision_id}:
                    raise RuntimeError("Detector returned a mismatched batch status response")
                live_results[decision_id] = result

        terminal_guard_state: dict[str, Any] | None = None
        responses: list[dict[str, Any]] = []
        terminal_jobs: list[dict[str, Any]] = []
        terminal_responses: list[dict[str, Any]] = []
        for decision_id in normalized_ids:
            pending = pending_by_id[decision_id]
            if pending is None:
                stored = stored_by_id[decision_id]
                if stored.get("status") in {"pending", "provisional"}:
                    interrupted = {
                        **stored,
                        "status": "error",
                        "automaticSkipEligible": False,
                        "rolloutMode": "fail_open",
                        "fallbackActive": True,
                        "reason": "Cloud Heavy analysis was interrupted; Local Fast remained active",
                        "shadowFallbackReason": "Analysis worker restarted before completion; resubmit the item",
                    }
                    self.store.save_decision(interrupted)
                    responses.append(interrupted)
                else:
                    responses.append(stored)
                continue

            result = live_results[decision_id]
            terminal = result.get("status") in {"ready", "error"}
            if terminal and terminal_guard_state is None:
                terminal_guard_state = self.guard.state()
            response = self._format(
                decision_id,
                pending,
                result,
                guard_state=terminal_guard_state if terminal else {"forcedShadow": False, "reason": ""},
            )
            if terminal:
                with self.lock:
                    if self.pending.get(decision_id) is pending:
                        self.pending.pop(decision_id, None)
                latency = response["latency"]["completionMs"]
                cloud_error = result.get("cloudHeavy", {}) if isinstance(result.get("cloudHeavy"), dict) else {}
                error_text = f"{result.get('error') or ''} {cloud_error.get('error') or ''}".lower()
                failed = result.get("status") == "error" or cloud_error.get("available") is False
                terminal_jobs.append({
                    "latency_ms": latency,
                    "failed": failed or "out of memory" in error_text or "oom" in error_text,
                })
                terminal_responses.append(response)
            responses.append(response)
        self.guard.record_jobs(terminal_jobs)
        self.store.save_decisions(terminal_responses)
        return responses

    def _format(
        self,
        decision_id: str,
        pending: PendingDecision,
        result: dict[str, Any],
        *,
        guard_state: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        guard_state = guard_state or self.guard.state()
        status = result.get("status", "pending")
        automatic = status == "ready" and bool(result.get("automaticSkipEligible")) and not guard_state["forcedShadow"]
        rollout = "fail_open" if guard_state["forcedShadow"] else result.get("rolloutMode", "aggressive")
        completion_ms = round((time.time() - pending.submitted_at) * 1000)
        return {
            "decisionId": decision_id,
            "userId": pending.user_id,
            "contentKey": pending.content_key,
            "platform": pending.platform,
            "status": status,
            "modelBundleVersion": result.get("modelBundleVersion"),
            "spatialFamilyProbability": result.get("spatialFamilyProbability"),
            "componentSpatialScores": result.get("componentSpatialScores"),
            "motionProbability": result.get("motionProbability"),
            "thresholds": result.get("thresholds"),
            "consensusBasis": result.get("consensusBasis"),
            "rolloutMode": rollout,
            "latency": {"completionMs": completion_ms},
            "automaticSkipEligible": automatic,
            "synthetic": bool(result.get("synthetic")),
            "reason": result.get("reason", "Cloud Heavy analysis pending"),
            "fallbackActive": (
                guard_state["forcedShadow"]
                or result.get("status") == "error"
                or (isinstance(result.get("cloudHeavy"), dict) and result["cloudHeavy"].get("available") is False)
            ),
            "shadowFallbackReason": guard_state["reason"],
            "createdAt": _utc_iso(pending.submitted_at),
        }

    def feedback(
        self,
        user_id: str,
        body: dict[str, Any],
        diagnostic_promoter: Callable[[str, str], dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        decision_id = str(body.get("decisionId") or "")
        kind = str(body.get("kind") or "")[:40]
        decision = self.store.get_decision(decision_id)
        if not decision or decision.get("userId") != user_id:
            raise ValueError("Decision not found")
        if kind not in {"reveal", "undo", "correct", "wrong_hide", "wrong_keep", "report"}:
            raise ValueError("Unsupported feedback kind")
        feedback = {
            "feedbackId": uuid.uuid4().hex,
            "decisionId": decision_id,
            "userId": user_id,
            "kind": kind,
            "note": str(body.get("note") or "")[:1000],
            "createdAt": _utc_iso(),
        }
        if body.get("includeDiagnosticClip") is True:
            if kind not in {"wrong_hide", "wrong_keep", "report"}:
                raise ValueError("Diagnostic clips are allowed only for explicit error reports")
            if diagnostic_promoter is None:
                raise RuntimeError("Diagnostic clip promotion is unavailable")
            feedback["diagnosticClip"] = diagnostic_promoter(decision_id, user_id)
        self.store.save_feedback(feedback)
        if decision.get("automaticSkipEligible"):
            self.guard.record_hide_feedback(kind in {"reveal", "undo", "wrong_hide"}, kind == "wrong_hide")
        return feedback


def build_beta_services() -> tuple[MemoryBetaStore, AuthManager, CloudBetaController] | tuple[None, None, None]:
    client_id = os.environ.get("ORISLOP_GOOGLE_OAUTH_CLIENT_ID", "").strip()
    token_secret = os.environ.get("ORISLOP_TOKEN_SECRET", "").strip()
    content_secret = os.environ.get("ORISLOP_CONTENT_HMAC_SECRET", token_secret).strip()
    if not client_id or not token_secret or not content_secret:
        return None, None, None
    if secrets.compare_digest(token_secret, content_secret):
        raise RuntimeError("ORISLOP_TOKEN_SECRET and ORISLOP_CONTENT_HMAC_SECRET must be different")
    database_url = os.environ.get("DATABASE_URL", "").strip()
    store: MemoryBetaStore = PostgresBetaStore(database_url) if database_url else MemoryBetaStore()
    allowed_extension_ids = {
        parsed.hostname
        for origin in os.environ.get("ORISLOP_ALLOWED_EXTENSION_ORIGINS", "").split(",")
        if (parsed := urlparse(origin.strip())).scheme == "chrome-extension"
        and parsed.hostname is not None
        and re.fullmatch(r"[a-p]{32}", parsed.hostname)
    }
    oidc = GoogleOidc(client_id, allowed_extension_ids=allowed_extension_ids)
    return store, AuthManager(store, oidc, token_secret), CloudBetaController(store, content_secret)
