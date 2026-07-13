from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import importlib
import json
import os
from pathlib import Path
import queue
import sys
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


HOST = "127.0.0.1"
PORT = int(os.environ.get("ORISLOP_DETECTOR_PORT", "4317"))
MAX_BATCH_SIZE = 10
MAX_REQUEST_BYTES = 64 * 1024
MAX_DIRECT_MEDIA_BYTES = 120 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[2]
CACHE_ROOT = Path(os.environ.get("ORISLOP_DETECTOR_CACHE", ROOT / ".cache" / "detector-bridge")).resolve()
TEMPORAL_ROOT = ROOT / "core" / "temporal_detector"
TEMPORAL_REPO_ID = "gonnerthetooner/deepfake-temporal-moe"
SPATIAL_REPO_ID = "gonnerthetooner/orislop-fusion"
SUPPORTED_PAGE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
    "instagram.com", "www.instagram.com", "tiktok.com", "www.tiktok.com",
}
DIRECT_MEDIA_SUFFIXES = (
    ".googlevideo.com", ".cdninstagram.com", ".fbcdn.net", ".tiktokcdn.com",
    ".tiktokv.com", ".muscdn.com", ".akamaized.net",
)
with (ROOT / "configs" / "detector_thresholds.json").open("r", encoding="utf-8") as threshold_file:
    THRESHOLD_CONFIG = json.load(threshold_file)
SPATIAL_THRESHOLD = float(os.environ.get("ORISLOP_SPATIAL_THRESHOLD", THRESHOLD_CONFIG["spatialSynthetic"]))
TEMPORAL_THRESHOLD = float(os.environ.get("ORISLOP_TEMPORAL_THRESHOLD", THRESHOLD_CONFIG["temporalSynthetic"]))
COMBINED_THRESHOLD = float(os.environ.get("ORISLOP_VISUAL_THRESHOLD", THRESHOLD_CONFIG["combinedSynthetic"]))
SPATIAL_WEIGHT = float(THRESHOLD_CONFIG["combinedWeights"]["spatial"])
TEMPORAL_WEIGHT = float(THRESHOLD_CONFIG["combinedWeights"]["temporal"])


@dataclass(frozen=True)
class ScanJob:
    key: str
    item_id: str
    page_url: str
    media_url: str


class TemporalDetector:
    def __init__(self, cache_dir: Path) -> None:
        sys.path.insert(0, str(TEMPORAL_ROOT))
        self.module = importlib.import_module("temporal_deepfake_moe_hf_colab")
        arguments = [
            "--mode", "predict",
            "--predict-video", "bridge-placeholder.mp4",
            "--hf-repo-id", TEMPORAL_REPO_ID,
            "--local-cache-dir", str(cache_dir),
            "--micro-checkpoint", f"hf:{TEMPORAL_REPO_ID}/a100_high_vram_60gb_v1/stage1_micro_latest.pt",
            "--mid-checkpoint", f"hf:{TEMPORAL_REPO_ID}/a100_high_vram_60gb_v1/stage1_mid_latest.pt",
            "--long-checkpoint", f"hf:{TEMPORAL_REPO_ID}/a100_high_vram_60gb_v1/stage1_long_latest.pt",
            "--extra-long-checkpoint", f"hf:{TEMPORAL_REPO_ID}/a100_high_vram_60gb_v1/stage1_extra_long_latest.pt",
            "--fusion-checkpoint", f"hf:{TEMPORAL_REPO_ID}/a100_balanced_fusion_v4/stage2_fusion_latest.pt",
            "--calibration-checkpoint", f"hf:{TEMPORAL_REPO_ID}/a100_balanced_fusion_v4/stage3_calibration.pt",
            "--predict-use-extra-long", "true",
            "--precision", "auto",
            "--clip-frame-chunk-size", "auto",
        ]
        args = self.module.build_arg_parser().parse_args(arguments)
        args.hf_token = self.module.resolve_hf_token(args.hf_token)
        self.runtime = self.module.detect_runtime()
        self.args = self.module.apply_device_safe_defaults(args, self.runtime)
        self.module.validate_args(self.args, self.runtime)
        self.module.set_seed(int(self.args.seed))
        self.module.ensure_dir(self.args.local_cache_dir)
        self.module.configure_cache_environment(self.args.local_cache_dir)
        self.hf = self.module.HFStore(
            repo_id=self.args.hf_repo_id,
            token=self.args.hf_token,
            private=False,
            checkpoint_dir=self.args.hf_checkpoint_dir,
            local_cache_dir=self.args.local_cache_dir,
            strict_upload=False,
        )
        self.device = self.module.torch.device(self.runtime.device)
        self.bundle = self.module.build_fusion_bundle(self.args, self.hf, self.device, load_experts=True)
        self.module.freeze_bundle_experts(self.bundle)
        if self.bundle.fusion is None:
            raise RuntimeError("Temporal fusion checkpoint did not load")
        self.bundle.fusion.eval()
        if self.bundle.temperature is not None:
            self.bundle.temperature.eval()

    def analyze_video(self, video_path: str | Path) -> dict[str, Any]:
        m = self.module
        rng = m.random.Random(int(self.args.seed))
        stage0 = m.decode_video_views(str(video_path), ["micro", "mid", "long"], self.args, train=False, rng=rng)
        if stage0 is None:
            raise RuntimeError("Temporal detector could not decode the video")
        views = {name: value.unsqueeze(0).to(self.device) for name, value in stage0.items()}
        with m.torch.no_grad(), m.autocast_context(self.device, self.args.precision):
            outputs = m.run_experts(self.bundle, views, include_extra_long=False, include_spatial=False, include_lip=False)
            disagreement = m.DisagreementComputer.compute(outputs)
            escalation_stage = 0
            routing_bias = None
            if float(disagreement.mean().detach().cpu()) > float(self.args.disagreement_t1) and self.bundle.extra_long is not None:
                extra = m.decode_video_views(str(video_path), ["extra_long"], self.args, train=False, rng=rng)
                if extra is not None:
                    views["extra_long"] = extra["extra_long"].unsqueeze(0).to(self.device)
                    escalation_stage = 1
                    outputs = m.run_experts(self.bundle, views, include_extra_long=True, include_spatial=False, include_lip=False)
                    disagreement = m.DisagreementComputer.compute(outputs)
                    if float(disagreement.mean().detach().cpu()) > float(self.args.disagreement_t2):
                        escalation_stage = 2
                        routing_bias = {
                            "long": self.args.stage2_long_bias,
                            "extra_long": self.args.stage2_extra_long_bias,
                            "lip_sync": self.args.stage2_lip_bias,
                            "micro": self.args.stage2_micro_bias,
                            "mid": self.args.stage2_mid_bias,
                        }
            disagreement = m.DisagreementComputer.compute(outputs)
            fusion = self.bundle.fusion(outputs, routing_bias=routing_bias)
            raw_logit = fusion["logit"]
            probability = m.torch.sigmoid(self.bundle.temperature(raw_logit)) if self.bundle.temperature is not None else fusion["probability"]
        fake_probability = float(probability.squeeze().detach().cpu())
        return {
            "available": True,
            "repo_id": TEMPORAL_REPO_ID,
            "fake_probability": fake_probability,
            "confidence": fake_probability if fake_probability >= 0.5 else 1.0 - fake_probability,
            "disagreement_score": float(disagreement.mean().detach().cpu()),
            "escalation_stage": escalation_stage,
            "device": str(self.device),
        }


class DetectorService:
    def __init__(self) -> None:
        CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        self.jobs: queue.Queue[ScanJob] = queue.Queue(maxsize=100)
        self.results: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.queued: set[str] = set()
        self.lock = threading.Lock()
        self.state = "idle"
        self.last_error = ""
        self.spatial: Any = None
        self.temporal: TemporalDetector | None = None
        self.spatial_attempted = False
        self.temporal_attempted = False
        threading.Thread(target=self._worker, name="orislop-detector-worker", daemon=True).start()

    def health(self) -> dict[str, Any]:
        try:
            import torch
            accelerator = "cuda" if torch.cuda.is_available() else "cpu"
            dependencies = "available"
        except Exception:
            accelerator = "unknown"
            dependencies = "missing"
        with self.lock:
            return {
                "ok": True,
                "state": self.state,
                "last_error": self.last_error,
                "queue_depth": self.jobs.qsize(),
                "dependencies": dependencies,
                "accelerator": accelerator,
                "models": {"spatial": SPATIAL_REPO_ID, "temporal": TEMPORAL_REPO_ID},
                "thresholds": {
                    "spatial": SPATIAL_THRESHOLD,
                    "temporal": TEMPORAL_THRESHOLD,
                    "combined": COMBINED_THRESHOLD,
                },
            }

    def submit(self, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        response: list[dict[str, Any]] = []
        for candidate in candidates[:MAX_BATCH_SIZE]:
            item_id = clean_text(candidate.get("id"), 180)
            page_url = clean_text(candidate.get("url"), 2000)
            media_url = clean_text(candidate.get("mediaUrl"), 4000)
            key = hashlib.sha256(f"{item_id}|{page_url}".encode("utf-8")).hexdigest()
            with self.lock:
                cached = self.results.get(key)
                if cached is not None:
                    self.results.move_to_end(key)
                    response.append({"id": item_id, **cached})
                    continue
                if key not in self.queued:
                    try:
                        self.jobs.put_nowait(ScanJob(key=key, item_id=item_id, page_url=page_url, media_url=media_url))
                        self.queued.add(key)
                    except queue.Full:
                        response.append({"id": item_id, "status": "error", "error": "Detector queue is full"})
                        continue
            response.append({"id": item_id, "status": "pending"})
        return response

    def _worker(self) -> None:
        while True:
            job = self.jobs.get()
            try:
                with self.lock:
                    self.state = "analyzing"
                    self.last_error = ""
                result = self._analyze(job)
            except Exception as error:
                result = {"status": "error", "error": clean_text(error, 500)}
                with self.lock:
                    self.last_error = result["error"]
            finally:
                with self.lock:
                    self.results[job.key] = result
                    self.results.move_to_end(job.key)
                    while len(self.results) > 500:
                        self.results.popitem(last=False)
                    self.queued.discard(job.key)
                    self.state = "idle" if self.jobs.empty() else "analyzing"
                self.jobs.task_done()

    def _load_models(self) -> None:
        if not self.spatial_attempted:
            self.spatial_attempted = True
            try:
                from spatial_runtime import SpatialDetector
                self.spatial = SpatialDetector(CACHE_ROOT / "spatial")
            except Exception as error:
                self.last_error = f"Spatial model unavailable: {clean_text(error, 400)}"
        if not self.temporal_attempted:
            self.temporal_attempted = True
            try:
                self.temporal = TemporalDetector(CACHE_ROOT / "temporal")
            except Exception as error:
                suffix = f"Temporal model unavailable: {clean_text(error, 400)}"
                self.last_error = f"{self.last_error}; {suffix}".strip("; ")

    def _analyze(self, job: ScanJob) -> dict[str, Any]:
        self._load_models()
        with tempfile.TemporaryDirectory(prefix="orislop-media-") as temporary:
            video_path = acquire_media(job, Path(temporary))
            spatial_result: dict[str, Any]
            temporal_result: dict[str, Any]
            if self.spatial is not None:
                try:
                    spatial_result = self.spatial.analyze_video(video_path)
                except Exception as error:
                    spatial_result = {"available": False, "error": clean_text(error, 400), "repo_id": SPATIAL_REPO_ID}
            else:
                spatial_result = {"available": False, "error": "Spatial model failed to initialize", "repo_id": SPATIAL_REPO_ID}
            if self.temporal is not None:
                try:
                    temporal_result = self.temporal.analyze_video(video_path)
                except Exception as error:
                    temporal_result = {"available": False, "error": clean_text(error, 400), "repo_id": TEMPORAL_REPO_ID}
            else:
                temporal_result = {"available": False, "error": "Temporal model failed to initialize", "repo_id": TEMPORAL_REPO_ID}

        spatial_probability = float(spatial_result.get("ai_probability", 0.0)) if spatial_result.get("available") else None
        temporal_probability = float(temporal_result.get("fake_probability", 0.0)) if temporal_result.get("available") else None
        available = [value for value in (spatial_probability, temporal_probability) if value is not None]
        if not available:
            return {
                "status": "error",
                "error": "Both visual detectors were unavailable",
                "spatial": spatial_result,
                "temporal": temporal_result,
            }
        if spatial_probability is not None and temporal_probability is not None:
            combined = spatial_probability * SPATIAL_WEIGHT + temporal_probability * TEMPORAL_WEIGHT
        else:
            combined = available[0]
        synthetic = (
            (spatial_probability is not None and spatial_probability >= SPATIAL_THRESHOLD)
            or (temporal_probability is not None and temporal_probability >= TEMPORAL_THRESHOLD)
            or (len(available) == 2 and combined >= COMBINED_THRESHOLD)
        )
        if synthetic and temporal_probability is not None and temporal_probability >= TEMPORAL_THRESHOLD:
            reason = "Temporal detector found synthetic video patterns"
        elif synthetic and spatial_probability is not None and spatial_probability >= SPATIAL_THRESHOLD:
            reason = "Spatial detector found AI-generated frames"
        elif synthetic:
            reason = "Spatial and temporal detectors jointly found synthetic media"
        else:
            reason = "No strong synthetic-media signal"
        return {
            "status": "ready",
            "synthetic": synthetic,
            "score": round(combined * 100),
            "reason": reason,
            "spatial": spatial_result,
            "temporal": temporal_result,
        }


def acquire_media(job: ScanJob, destination: Path) -> Path:
    if is_allowed_direct_media(job.media_url):
        return download_direct_media(job.media_url, destination / "media.mp4")
    if not is_supported_page(job.page_url):
        raise ValueError("Only YouTube, Instagram, and TikTok media URLs are accepted")
    try:
        import yt_dlp
    except Exception as error:
        raise RuntimeError("yt-dlp is not installed; run pnpm detector:setup") from error
    template = str(destination / "media.%(ext)s")
    options = {
        "format": "worstvideo[height<=360][ext=mp4]/worstvideo[height<=360]/worst[height<=360]/worst",
        "outtmpl": template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
        "retries": 2,
        "max_filesize": MAX_DIRECT_MEDIA_BYTES,
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        information = downloader.extract_info(job.page_url, download=True)
        requested = information.get("requested_downloads") or []
        candidates = [entry.get("filepath") for entry in requested if entry.get("filepath")]
        candidates.append(downloader.prepare_filename(information))
    for candidate in candidates:
        path = Path(candidate)
        if path.exists() and path.is_file():
            return path
    files = [path for path in destination.iterdir() if path.is_file()]
    if not files:
        raise RuntimeError("Media downloader produced no video file")
    return files[0]


def download_direct_media(url: str, destination: Path) -> Path:
    request = Request(url, headers={"User-Agent": "Orislop/0.4 local detector"})
    total = 0
    opener = build_opener(SafeMediaRedirectHandler())
    with opener.open(request, timeout=45) as response, destination.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_DIRECT_MEDIA_BYTES:
                raise RuntimeError("Direct media exceeded the 120 MB local scan limit")
            output.write(chunk)
    return destination


class SafeMediaRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request: Request, file_pointer: Any, code: int, message: str, headers: Any, new_url: str) -> Request:
        if not is_allowed_direct_media(new_url):
            raise HTTPError(new_url, code, "Direct media redirect left the approved CDN allowlist", headers, file_pointer)
        return super().redirect_request(request, file_pointer, code, message, headers, new_url)


def is_supported_page(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme == "https" and (parsed.hostname or "").lower() in SUPPORTED_PAGE_HOSTS
    except Exception:
        return False


def is_allowed_direct_media(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        return parsed.scheme == "https" and any(host.endswith(suffix) for suffix in DIRECT_MEDIA_SUFFIXES)
    except Exception:
        return False


def clean_text(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


SERVICE = DetectorService()


class Handler(BaseHTTPRequestHandler):
    server_version = "OrislopDetectorBridge/0.4"

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if not self._origin_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Origin not allowed"})
            return
        if self.path == "/health":
            self._json(HTTPStatus.OK, SERVICE.health())
            return
        self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:
        if not self._origin_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Origin not allowed"})
            return
        if self.path != "/v1/analyze":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_REQUEST_BYTES:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            candidates = body.get("candidates")
            if not isinstance(candidates, list):
                raise ValueError("candidates must be an array")
            results = SERVICE.submit(candidates)
            statuses = {result.get("status") for result in results}
            state = "available" if statuses == {"ready"} else "pending" if "pending" in statuses else "unavailable"
            self._json(HTTPStatus.OK, {"ok": True, "state": state, "results": results})
        except Exception as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": clean_text(error, 500)})

    def log_message(self, format_string: str, *args: Any) -> None:
        if os.environ.get("ORISLOP_DETECTOR_VERBOSE") == "1":
            super().log_message(format_string, *args)

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin", "")
        return not origin or origin.startswith("chrome-extension://")

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    print(f"Orislop detector bridge listening on http://{HOST}:{PORT}", flush=True)
    print(f"Spatial: {SPATIAL_REPO_ID}", flush=True)
    print(f"Temporal: {TEMPORAL_REPO_ID}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
