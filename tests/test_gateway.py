"""Offline contract tests for the Vercel CPU gateway."""
import base64
import json
import os
import unittest
os.environ.setdefault("VAST_API_KEY", "test-only")
os.environ.setdefault("VAST_ENDPOINT_NAME", "test-endpoint")
os.environ.setdefault("ORISLOP_ALLOWED_EXTENSION_ORIGINS", "chrome-extension://fciiphjodcbdabpgfpdggdeaffjjnica")
os.environ.setdefault("DATABASE_URL", "postgresql://unused")
os.environ.setdefault("ORISLOP_GOOGLE_OAUTH_CLIENT_ID", "test-client")
os.environ.setdefault("ORISLOP_TOKEN_SECRET", "test-secret")
from api.contracts import make_envelope, unwrap_worker_response
from starlette.testclient import TestClient
from api.index import GatewayConfig, GatewayGuards, cors, create_app, validate_analysis


ORIGIN = "chrome-extension://fciiphjodcbdabpgfpdggdeaffjjnica"


class FakeAuth:
    def authenticate_access(self, authorization):
        if authorization != "Bearer valid":
            from api.index import AuthError
            raise AuthError("Invalid access token")
        return {"claims": {"sid": "session-1"}, "user": {"id": "user-1", "email": "person@example.test", "name": "Person"}}


class FakeQuota:
    def status(self, _user_id): return {"minuteRemaining": 30, "dayRemaining": 500}


class FakeServices:
    auth = FakeAuth()
    quota = FakeQuota()


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

if __name__ == "__main__": unittest.main()
