from __future__ import annotations

import ast
import json
from pathlib import Path
import sys
import unittest


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BRIDGE_ROOT.parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

import server


class BridgeContractTests(unittest.TestCase):
    def test_model_ids_and_thresholds_are_production_values(self) -> None:
        self.assertEqual(server.SPATIAL_REPO_ID, "gonnerthetooner/orislop-fusion")
        self.assertEqual(server.TEMPORAL_REPO_ID, "gonnerthetooner/deepfake-temporal-moe")
        self.assertGreater(server.SPATIAL_THRESHOLD, 0.5)
        self.assertGreater(server.TEMPORAL_THRESHOLD, 0.5)
        health = server.SERVICE.health()
        self.assertEqual(health["models"]["spatial"], server.SPATIAL_REPO_ID)
        self.assertEqual(health["models"]["temporal"], server.TEMPORAL_REPO_ID)

    def test_page_url_allowlist_rejects_ssrf_inputs(self) -> None:
        self.assertTrue(server.is_supported_page("https://www.youtube.com/shorts/abc123"))
        self.assertTrue(server.is_supported_page("https://www.instagram.com/reel/abc123/"))
        self.assertTrue(server.is_supported_page("https://www.tiktok.com/@person/video/123456"))
        self.assertFalse(server.is_supported_page("http://www.youtube.com/watch?v=abc123"))
        self.assertFalse(server.is_supported_page("https://www.youtube.com.evil.example/watch?v=abc123"))
        self.assertFalse(server.is_supported_page("https://127.0.0.1/private"))

    def test_direct_media_allowlist_is_cdn_only(self) -> None:
        self.assertTrue(server.is_allowed_direct_media("https://r1---sn-a5mekn.googlevideo.com/videoplayback?id=1"))
        self.assertTrue(server.is_allowed_direct_media("https://scontent.cdninstagram.com/video.mp4"))
        self.assertFalse(server.is_allowed_direct_media("https://example.com/video.mp4"))
        self.assertFalse(server.is_allowed_direct_media("http://r1.googlevideo.com/video.mp4"))

    def test_temporal_runtime_and_spatial_architecture_are_shipped(self) -> None:
        required = [
            REPO_ROOT / "core" / "temporal_detector" / "temporal_deepfake_moe_hf_colab.py",
            REPO_ROOT / "core" / "temporal_detector" / "final_pipeline_core.py",
            REPO_ROOT / "core" / "temporal_detector" / "full_pipeline_utils.py",
        ]
        for path in required:
            self.assertTrue(path.is_file(), str(path))
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        spatial_tree = ast.parse((BRIDGE_ROOT / "spatial_runtime.py").read_text(encoding="utf-8"))
        class_names = {node.name for node in spatial_tree.body if isinstance(node, ast.ClassDef)}
        self.assertIn("VisionEncoder", class_names)
        self.assertIn("FusionDetector", class_names)
        self.assertIn("SpatialDetector", class_names)

    def test_adapter_config_namespaces_every_repo(self) -> None:
        config = json.loads((REPO_ROOT / "configs" / "model_adapters.json").read_text(encoding="utf-8"))
        adapters = config["adapters"]
        self.assertTrue(adapters["spatial_detector"]["enabled"])
        self.assertTrue(adapters["temporal_detector"]["enabled"])
        self.assertEqual(adapters["spatial_detector"]["hfRepoId"], server.SPATIAL_REPO_ID)
        self.assertEqual(adapters["temporal_detector"]["hfRepoId"], server.TEMPORAL_REPO_ID)
        self.assertEqual(len(adapters["temporal_detector"]["checkpointPaths"]), 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
