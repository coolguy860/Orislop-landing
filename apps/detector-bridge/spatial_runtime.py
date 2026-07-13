from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image
import torch
from torch import nn
from transformers import AutoImageProcessor, AutoModel, CLIPModel, CLIPProcessor, pipeline
from huggingface_hub import hf_hub_download


SPATIAL_REPO_ID = "gonnerthetooner/orislop-fusion"
SPATIAL_CHECKPOINT = "fusion_model_final.pt"
VISION_MODEL_ID = "google/vit-base-patch16-224"
AI_MODEL_ID = "umm-maybe/AI-image-detector"
CLIP_MODEL_ID = "openai/clip-vit-base-patch32"
TEXT_PROMPTS = ["a real photograph", "an AI generated image"]


class VisionEncoder(nn.Module):
    def __init__(self, pretrained_id: str = VISION_MODEL_ID) -> None:
        super().__init__()
        self.processor = AutoImageProcessor.from_pretrained(pretrained_id)
        self.backbone = AutoModel.from_pretrained(pretrained_id)
        for parameter in self.backbone.parameters():
            parameter.requires_grad = False
        self.backbone.eval()
        self.embedding_dim = int(getattr(self.backbone.config, "hidden_size", 768))

    @torch.no_grad()
    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        output = self.backbone(pixel_values=pixel_values)
        if getattr(output, "pooler_output", None) is not None:
            return output.pooler_output
        return output.last_hidden_state[:, 0, :]


class FusionDetector(nn.Module):
    def __init__(self, vision_dim: int, aux_dim: int = 3) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(vision_dim + aux_dim, 512),
            nn.LayerNorm(512),
            nn.GELU(),
            nn.Dropout(0.3),
            nn.Linear(512, 256),
            nn.LayerNorm(256),
            nn.GELU(),
            nn.Dropout(0.2),
            nn.Linear(256, 128),
            nn.LayerNorm(128),
            nn.GELU(),
            nn.Dropout(0.1),
            nn.Linear(128, 1),
        )

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        return self.net(features)


def _safe_torch_load(path: str, device: torch.device) -> dict[str, torch.Tensor]:
    try:
        return torch.load(path, map_location=device, weights_only=True)
    except TypeError:
        return torch.load(path, map_location=device)


class SpatialDetector:
    """Exact inference architecture used to train gonnerthetooner/orislop-fusion."""

    def __init__(self, cache_dir: str | Path) -> None:
        requested_device = os.environ.get("ORISLOP_SPATIAL_DEVICE", "cpu").strip().lower()
        if requested_device == "cuda" and torch.cuda.is_available():
            self.device = torch.device("cuda")
        else:
            self.device = torch.device("cpu")
        self.cache_dir = str(Path(cache_dir).expanduser().resolve())
        self.vision = VisionEncoder().to(self.device).eval()
        self.fusion = FusionDetector(self.vision.embedding_dim, aux_dim=3).to(self.device).eval()
        checkpoint = hf_hub_download(
            repo_id=SPATIAL_REPO_ID,
            filename=SPATIAL_CHECKPOINT,
            cache_dir=self.cache_dir,
        )
        self.fusion.load_state_dict(_safe_torch_load(checkpoint, self.device), strict=True)
        # The auxiliary AI classifier stays on CPU to leave accelerator memory for the temporal MoE.
        self.ai_classifier = pipeline("image-classification", model=AI_MODEL_ID, device=-1)
        self.clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_ID, cache_dir=self.cache_dir)
        self.clip = CLIPModel.from_pretrained(CLIP_MODEL_ID, cache_dir=self.cache_dir).to(self.device).eval()

    @torch.no_grad()
    def analyze_video(self, video_path: str | Path, max_frames: int = 5) -> dict[str, Any]:
        images = sample_video_frames(video_path, max_frames=max_frames)
        if not images:
            raise RuntimeError("Spatial detector could not decode any video frames")
        probabilities = [self.analyze_image(image) for image in images]
        probability = float(sum(probabilities) / len(probabilities))
        return {
            "available": True,
            "repo_id": SPATIAL_REPO_ID,
            "ai_probability": probability,
            "confidence": probability if probability >= 0.5 else 1.0 - probability,
            "frames_analyzed": len(probabilities),
            "frame_probabilities": probabilities,
            "device": str(self.device),
        }

    @torch.no_grad()
    def analyze_image(self, image: Image.Image) -> float:
        image = image.convert("RGB")
        ai_score = self._ai_score(image)
        clip_score = self._clip_score(image)
        texture_score = self._texture_score(image)
        pixels = self.vision.processor(images=image, return_tensors="pt")["pixel_values"].to(self.device)
        embedding = self.vision(pixels).to(dtype=torch.float32)
        auxiliary = torch.tensor(
            [[ai_score, clip_score, texture_score]],
            dtype=torch.float32,
            device=self.device,
        )
        logit = self.fusion(torch.cat([embedding, auxiliary], dim=1))
        return float(torch.sigmoid(logit).squeeze().detach().cpu())

    def _ai_score(self, image: Image.Image) -> float:
        results = self.ai_classifier(image)
        result = results[0] if results else {}
        score = float(result.get("score", 0.5))
        label = str(result.get("label", "")).lower()
        synthetic = any(token in label for token in ("fake", "ai", "synthetic", "generated", "artificial"))
        return float(np.clip(score if synthetic else 1.0 - score, 0.0, 1.0))

    @torch.no_grad()
    def _clip_score(self, image: Image.Image) -> float:
        inputs = self.clip_processor(
            text=TEXT_PROMPTS,
            images=image,
            return_tensors="pt",
            padding=True,
        ).to(self.device)
        probabilities = self.clip(**inputs).logits_per_image.softmax(dim=1)
        return float(probabilities[0, 1].detach().cpu())

    @staticmethod
    def _texture_score(image: Image.Image) -> float:
        grayscale = np.array(image.convert("L"))
        variance = float(np.var(cv2.Laplacian(grayscale, cv2.CV_64F)))
        return float(np.clip(variance / 500.0, 0.0, 1.0))


def sample_video_frames(video_path: str | Path, max_frames: int) -> list[Image.Image]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        return []
    try:
        frame_count = max(0, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
        if frame_count > 0:
            count = min(max_frames, frame_count)
            positions = np.linspace(0, frame_count - 1, num=count, dtype=int).tolist()
        else:
            positions = list(range(max_frames))
        images: list[Image.Image] = []
        for position in positions:
            if frame_count > 0:
                capture.set(cv2.CAP_PROP_POS_FRAMES, int(position))
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            images.append(Image.fromarray(rgb))
        return images
    finally:
        capture.release()
