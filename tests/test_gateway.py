"""Offline contract tests for the Vercel CPU gateway."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from types import SimpleNamespace
import threading
import unittest
os.environ.setdefault("VAST_API_KEY", "test-only")
os.environ.setdefault("VAST_ENDPOINT_NAME", "test-endpoint")
os.environ.setdefault("ORISLOP_ALLOWED_EXTENSION_ORIGINS", "chrome-extension://fciiphjodcbdabpgfpdggdeaffjjnica")
os.environ.setdefault("DATABASE_URL", "postgresql://unused")
os.environ.setdefault("ORISLOP_GOOGLE_OAUTH_CLIENT_ID", "test-client")
os.environ.setdefault("ORISLOP_TOKEN_SECRET", "test-secret")
from api.contracts import make_envelope, unwrap_worker_response
from api.cloud_beta import MemoryBetaStore, PostgresBetaStore
from starlette.testclient import TestClient
from api.index import GatewayConfig, GatewayGuards, cors, create_app, shared_limit, validate_analysis
from api.rate_limit import SharedRateLimiter


ORIGIN = "chrome-extension://fciiphjodcbdabpgfpdggdeaffjjnica"
TEST_SECRET = "test-secret-that-is-at-least-32-bytes-long"


class FakeAuth:
    def authenticate_access(self, authorization):
        if authorization != "Bearer valid":
            from api.index import AuthError
            raise AuthError("Invalid access token")
        return {"claims": {"sid": "session-1"}, "user": {"id": "user-1", "email": "person@example.test", "name": "Person"}}

    def google_login(self, _body):
        return {"accessToken": "access", "refreshToken": "refresh", "expiresIn": 900, "user": {"id": "user-1"}}

    def refresh(self, _refresh_token):
        return self.google_login({})


class FakeQuota:
    def status(self, _user_id): return {"minuteRemaining": 30, "dayRemaining": 500}


class FakeServices:
    def __init__(self, store=None, rate_limit=None):
        self.auth = FakeAuth()
        self.quota = FakeQuota()
        self.store = store or MemoryBetaStore()
        self.rate_limit = rate_limit or SharedRateLimiter(self.store, TEST_SECRET)


class FailingRateLimiter:
    def allow(self, *_args, **_kwargs):
        raise RuntimeError("database unavailable")


class RecordingCursor:
    def __init__(self, connection):
        self.connection = connection
        self.last_sql = ""

    def __enter__(self): return self
    def __exit__(self, *_args): return False

    def execute(self, sql, params=None):
        self.last_sql = " ".join(str(sql).split())
        self.connection.driver.sequence += 1
        self.connection.records.append({
            "sequence": self.connection.driver.sequence,
            "sql": self.last_sql,
            "params": params,
            "isolation": self.connection.isolation_level,
        })

    def executemany(self, sql, params):
        self.execute(sql, list(params))

    def fetchone(self):
        if "clock_timestamp()" in self.last_sql:
            return (datetime(2026, 9, 19, tzinfo=timezone.utc),)
        if "to_regclass" in self.last_sql:
            return (
                "gateway_rate_limit_events",
                "gateway_rate_limit_events_key_time_idx",
                "gateway_rate_limit_events_expiry_idx",
            )
        return (None,)

    def fetchall(self): return []


class RecordingConnection:
    def __init__(self, driver):
        self.driver = driver
        self.isolation_level = None
        self.records = []
        self.exited_at = None

    def __enter__(self): return self
    def __exit__(self, *_args):
        self.driver.sequence += 1
        self.exited_at = self.driver.sequence
        return False

    def cursor(self): return RecordingCursor(self)


class RecordingPsycopg:
    class IsolationLevel:
        READ_COMMITTED = "read-committed"

    def __init__(self):
        self.connections = []
        self.connect_calls = []
        self.sequence = 0

    def connect(self, database_url, **kwargs):
        connection = RecordingConnection(self)
        self.connections.append(connection)
        self.connect_calls.append((database_url, kwargs))
        return connection


def recording_postgres_store():
    store = PostgresBetaStore.__new__(PostgresBetaStore)
    MemoryBetaStore.__init__(store)
    store.psycopg = RecordingPsycopg()
    store.database_url = "postgresql://recording"
    store._gateway_cleanup_lock = threading.Lock()
    store._gateway_last_cleanup = 0.0
    return store


class FakeVast:
    def __init__(self): self.invocations = []
    async def invoke(self, envelope, _timeout):
        self.invocations.append(envelope)
        body = base64.b64encode(json.dumps({"ok": True}).encode()).decode()
        return {"status": 200, "headers": {"content-type": "application/json"}, "bodyBase64": body}

class GatewayContractTests(unittest.TestCase):
    def setUp(self): self.config = GatewayConfig("test", frozenset({"chrome-extension://fciiphjodcbdabpgfpdggdeaffjjnica"}))
    def test_cors_is_exact_extension_origin_only(self):
        self.assertEqual(cors("chrome-extension://fciiphjodcbdabpgfpdggdeaffjjnica", self.config.allowed_origins)["Access-Control-Allow-Origin"], "chrome-extension://fciiphjodcbdabpgfpdggdeaffjjnica")
        self.assertEqual(cors("https://youtube.com", self.config.allowed_origins), {})
    def test_analysis_requires_approved_direct_media_host(self):
        valid = {"platform":"youtube", "itemIdentifier":"abc", "directMediaUrl":"https://r1---sn.googlevideo.com/videoplayback", "durationSeconds":601}
        self.assertEqual(validate_analysis("/v2/analyze", valid, self.config), (1, 2))
        with self.assertRaisesRegex(ValueError, "approved YouTube"): validate_analysis("/v2/analyze", {**valid, "directMediaUrl":"https://attacker.example/v"}, self.config)
    def test_gateway_envelope_strips_untrusted_headers_and_paths(self):
        envelope = make_envelope("POST", "/v2/analyze?debug=1", {"Authorization":"Bearer test", "X-Forwarded-For":"forged", "X-Injected":"x\r\ny"}, b"{}")
        self.assertEqual(envelope["headers"], {"authorization":"Bearer test"})
        with self.assertRaises(ValueError): make_envelope("POST", "/v2/../admin", {}, b"")
    def test_worker_response_cannot_inject_headers(self):
        self.assertEqual(unwrap_worker_response({"status":200,"headers":{"content-type":"application/json","x-secret":"no"},"bodyBase64":"e30="}), (200, {"content-type":"application/json"}, b"{}"))
    def test_per_user_rate_limit_and_concurrency_limit(self):
        config = GatewayConfig("test", self.config.allowed_origins, route_user_per_minute=1, route_global_concurrency=1, route_ip_concurrency=1, route_user_concurrency=1)
        guards = GatewayGuards(config)
        self.assertTrue(guards.route("127.0.0.1", "u1")); self.assertFalse(guards.route("127.0.0.1", "u1"))
        self.assertTrue(guards.route_concurrency.acquire("127.0.0.1", "u1")); self.assertFalse(guards.route_concurrency.acquire("127.0.0.1", "u1")); guards.route_concurrency.release("127.0.0.1", "u1")

    def test_shared_limiter_is_atomic_under_concurrency_and_stores_no_raw_ip(self):
        store = MemoryBetaStore()
        limiter_a = SharedRateLimiter(store, TEST_SECRET)
        limiter_b = SharedRateLimiter(store, TEST_SECRET)

        def consume(index):
            limiter = limiter_a if index % 2 else limiter_b
            return limiter.allow("auth", (("global", "all", 7), ("ip", "203.0.113.9", 7)))

        with ThreadPoolExecutor(max_workers=16) as pool:
            accepted = list(pool.map(consume, range(40)))

        self.assertEqual(sum(accepted), 7)
        self.assertTrue(store.gateway_rate_limits)
        self.assertNotIn("203.0.113.9", repr(store.gateway_rate_limits))

    def test_shared_quota_exhaustion_applies_across_app_instances(self):
        store = MemoryBetaStore()
        services = FakeServices(store)
        config = GatewayConfig(
            "test",
            self.config.allowed_origins,
            route_global_per_minute=10,
            route_ip_per_minute=10,
            route_user_per_minute=1,
        )
        vast_a, vast_b = FakeVast(), FakeVast()
        app_a = create_app(config, auth_services=services, vast_client=vast_a)
        app_b = create_app(config, auth_services=services, vast_client=vast_b)
        candidate = {"platform": "youtube", "itemIdentifier": "abc", "directMediaUrl": "https://r1---sn.googlevideo.com/videoplayback", "duration": 60}
        headers = {"Origin": ORIGIN, "Authorization": "Bearer valid"}
        with TestClient(app_a) as client_a, TestClient(app_b) as client_b:
            first = client_a.post("/v2/analyze", headers=headers, json=candidate)
            exhausted = client_b.post("/v2/analyze", headers=headers, json=candidate)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(exhausted.status_code, 429)
        self.assertEqual(len(vast_a.invocations) + len(vast_b.invocations), 1)

    def test_database_failure_fails_closed_before_billable_vast_call(self):
        vast = FakeVast()
        services = FakeServices(rate_limit=FailingRateLimiter())
        app = create_app(self.config, auth_services=services, vast_client=vast)
        candidate = {"platform": "youtube", "itemIdentifier": "abc", "directMediaUrl": "https://r1---sn.googlevideo.com/videoplayback", "duration": 60}
        with TestClient(app) as client:
            response = client.post(
                "/v2/analyze",
                headers={"Origin": ORIGIN, "Authorization": "Bearer valid"},
                json=candidate,
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(len(vast.invocations), 0)

    def test_health_routes_do_not_require_database_or_consume_rate_budget(self):
        services = FakeServices(rate_limit=FailingRateLimiter())
        app = create_app(self.config, auth_services=services, vast_client=FakeVast())
        with TestClient(app) as client:
            self.assertEqual(client.get("/healthz").status_code, 200)
            self.assertEqual(client.get("/health", headers={"Origin": ORIGIN}).status_code, 200)
            self.assertEqual(client.get("/ready", headers={"Origin": ORIGIN}).status_code, 200)

    def test_unauthenticated_auth_budget_is_shared_across_instances(self):
        store = MemoryBetaStore()
        services = FakeServices(store)
        config = GatewayConfig(
            "test",
            self.config.allowed_origins,
            auth_global_per_minute=1,
            auth_ip_per_minute=1,
        )
        app_a = create_app(config, auth_services=services, vast_client=FakeVast())
        app_b = create_app(config, auth_services=services, vast_client=FakeVast())
        with TestClient(app_a) as client_a, TestClient(app_b) as client_b:
            first = client_a.post("/v2/auth/google", headers={"Origin": ORIGIN}, json={})
            exhausted = client_b.post("/v2/auth/google", headers={"Origin": ORIGIN}, json={})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(exhausted.status_code, 429)

    def test_postgres_schema_init_is_serialized_bounded_and_verified(self):
        store = recording_postgres_store()
        store._initialize()
        driver = store.psycopg
        self.assertEqual(driver.connect_calls[0][1], {"connect_timeout": 5})
        records = driver.connections[0].records
        self.assertTrue(all(record["isolation"] == "read-committed" for record in records))
        self.assertIn("set_config('statement_timeout'", records[0]["sql"])
        self.assertEqual(records[0]["params"], ("2500ms", "750ms"))
        self.assertIn("pg_advisory_xact_lock", records[1]["sql"])
        self.assertEqual(records[1]["params"], ("orislop:postgres-schema:v1",))
        self.assertIn("CREATE TABLE IF NOT EXISTS gateway_rate_limit_events", records[2]["sql"])
        self.assertIn("to_regclass", records[3]["sql"])

    def test_postgres_admission_is_read_committed_and_cleanup_is_separate(self):
        store = recording_postgres_store()
        accepted = store.consume_gateway_rate_limit((("scope-a", 3), ("scope-b", 4)), 1)
        self.assertTrue(accepted)
        driver = store.psycopg
        self.assertEqual(len(driver.connections), 2)
        admission, cleanup = driver.connections
        self.assertTrue(all(record["isolation"] == "read-committed" for record in admission.records))
        self.assertIn("set_config('statement_timeout'", admission.records[0]["sql"])
        self.assertEqual(
            sum("pg_advisory_xact_lock" in record["sql"] for record in admission.records),
            2,
        )
        self.assertFalse(any("DELETE FROM gateway_rate_limit_events" in record["sql"] for record in admission.records))
        self.assertIsNotNone(admission.exited_at)
        cleanup_sql = " ".join(record["sql"] for record in cleanup.records)
        self.assertIn("FOR UPDATE SKIP LOCKED", cleanup_sql)
        self.assertIn("DELETE FROM gateway_rate_limit_events", cleanup_sql)
        self.assertLess(admission.exited_at, cleanup.records[0]["sequence"])

    def test_limiter_admission_is_bounded_before_thread_scheduling(self):
        started, release = threading.Event(), threading.Event()

        class BlockingLimiter:
            def __init__(self): self.calls = 0
            def allow(self, *_args):
                self.calls += 1
                started.set()
                release.wait(2)
                return True

        limiter = BlockingLimiter()
        request = SimpleNamespace(
            app=SimpleNamespace(
                state=SimpleNamespace(rate_limit_admission=asyncio.Semaphore(1))
            )
        )
        services = SimpleNamespace(rate_limit=limiter)

        async def exercise():
            first = asyncio.create_task(
                shared_limit(request, services, "auth", (("global", "all", 1),))
            )
            while not started.is_set():
                await asyncio.sleep(0.001)
            with self.assertRaisesRegex(RuntimeError, "busy"):
                await shared_limit(request, services, "auth", (("global", "all", 1),))
            self.assertEqual(limiter.calls, 1)
            release.set()
            self.assertTrue(await first)

        asyncio.run(exercise())

    def test_vast_is_never_called_before_origin_and_token_gates(self):
        vast = FakeVast()
        app = create_app(self.config, auth_services=FakeServices(), vast_client=vast)
        candidate = {"platform": "youtube", "itemIdentifier": "abc", "directMediaUrl": "https://r1---sn.googlevideo.com/videoplayback", "duration": 60}
        with TestClient(app) as client:
            self.assertEqual(client.post("/v2/analyze", json=candidate).status_code, 403)
            self.assertEqual(client.post("/v2/analyze", headers={"Origin": ORIGIN}, json=candidate).status_code, 401)
            accepted = client.post("/api/v2/analyze", headers={"Origin": ORIGIN, "Authorization": "Bearer valid"}, json=candidate)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(len(vast.invocations), 1)
        self.assertEqual(vast.invocations[0]["headers"]["authorization"], "Bearer valid")
        self.assertNotIn("x-forwarded-for", vast.invocations[0]["headers"])
        self.assertEqual(vast.invocations[0]["path"], "/v2/analyze")

    def test_vercel_single_function_rewrite_restores_public_path(self):
        vast = FakeVast()
        app = create_app(self.config, auth_services=FakeServices(), vast_client=vast)
        candidate = {"platform": "youtube", "itemIdentifier": "abc", "directMediaUrl": "https://r1---sn.googlevideo.com/videoplayback", "duration": 60}
        with TestClient(app) as client:
            health = client.get(
                "/api?__orislop_path=%2Fhealth",
                headers={"Origin": ORIGIN},
            )
            accepted = client.post(
                "/api?__orislop_path=%2Fv2%2Fanalyze&poll=1",
                headers={"Origin": ORIGIN, "Authorization": "Bearer valid"},
                json=candidate,
            )
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.headers["access-control-allow-origin"], ORIGIN)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(vast.invocations[0]["path"], "/v2/analyze?poll=1")
        self.assertNotIn("__orislop_path", vast.invocations[0]["path"])

if __name__ == "__main__": unittest.main()
