"""Asynchronous fire detection for the camera relay.

The detector intentionally keeps only the newest JPEG.  Camera uploads must not
queue behind inference when the Raspberry Pi is temporarily busy.
"""

from __future__ import annotations

import io
import os
import queue
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class FireStatus:
    enabled: bool
    ready: bool
    alarm: bool
    detected: bool
    confidence: float
    label: str | None
    positives: int
    window_size: int
    inference_ms: float | None
    last_result_age_seconds: float | None
    frames_processed: int
    error: str | None


class FireDetector:
    """Run an Ultralytics detection or classification model off-thread."""

    def __init__(self) -> None:
        model_value = os.getenv("FIRE_MODEL_PATH", "").strip()
        self.model_path = Path(model_value).expanduser() if model_value else None
        self.threshold = float(os.getenv("FIRE_CONFIDENCE", "0.60"))
        self.image_size = int(os.getenv("FIRE_IMAGE_SIZE", "320"))
        self.interval = float(os.getenv("FIRE_INFERENCE_INTERVAL_SECONDS", "1.0"))
        self.window_size = max(1, int(os.getenv("FIRE_WINDOW_SIZE", "5")))
        self.min_positives = max(1, int(os.getenv("FIRE_MIN_POSITIVES", "3")))
        if self.min_positives > self.window_size:
            raise ValueError("FIRE_MIN_POSITIVES darf FIRE_WINDOW_SIZE nicht überschreiten")
        labels = os.getenv("FIRE_LABELS", "fire,flame")
        self.fire_labels = {label.strip().casefold() for label in labels.split(",") if label.strip()}

        self._frames: queue.Queue[bytes] = queue.Queue(maxsize=1)
        self._lock = threading.Lock()
        self._history: deque[bool] = deque(maxlen=self.window_size)
        self._ready = False
        self._detected = False
        self._confidence = 0.0
        self._label: str | None = None
        self._inference_ms: float | None = None
        self._last_result_at: float | None = None
        self._frames_processed = 0
        self._error: str | None = None
        self._thread: threading.Thread | None = None

    @property
    def enabled(self) -> bool:
        return self.model_path is not None

    def start(self) -> None:
        if not self.enabled or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="fire-detector", daemon=True)
        self._thread.start()

    def submit(self, jpeg: bytes) -> None:
        if not self.enabled:
            return
        try:
            self._frames.put_nowait(jpeg)
        except queue.Full:
            try:
                self._frames.get_nowait()
            except queue.Empty:
                pass
            try:
                self._frames.put_nowait(jpeg)
            except queue.Full:
                pass

    def status(self) -> dict[str, object]:
        with self._lock:
            age = time.monotonic() - self._last_result_at if self._last_result_at else None
            positives = sum(self._history)
            status = FireStatus(
                enabled=self.enabled,
                ready=self._ready,
                alarm=len(self._history) == self.window_size and positives >= self.min_positives,
                detected=self._detected,
                confidence=round(self._confidence, 4),
                label=self._label,
                positives=positives,
                window_size=self.window_size,
                inference_ms=round(self._inference_ms, 1) if self._inference_ms is not None else None,
                last_result_age_seconds=round(age, 3) if age is not None else None,
                frames_processed=self._frames_processed,
                error=self._error,
            )
        return asdict(status)

    def _run(self) -> None:
        try:
            if self.model_path is None or not self.model_path.is_file():
                raise FileNotFoundError(f"Modelldatei nicht gefunden: {self.model_path}")
            from PIL import Image
            from ultralytics import YOLO

            model = YOLO(str(self.model_path))
            with self._lock:
                self._ready = True
                self._error = None
            last_inference_at = 0.0
            while True:
                jpeg = self._frames.get()
                remaining = self.interval - (time.monotonic() - last_inference_at)
                if remaining > 0:
                    time.sleep(remaining)
                    while True:
                        try:
                            jpeg = self._frames.get_nowait()
                        except queue.Empty:
                            break
                started = time.monotonic()
                try:
                    image = Image.open(io.BytesIO(jpeg)).convert("RGB")
                    result = model.predict(image, imgsz=self.image_size, verbose=False)[0]
                    detected, confidence, label = self._extract_result(result)
                except Exception as exc:
                    with self._lock:
                        self._error = f"{type(exc).__name__}: {exc}"
                    continue
                else:
                    finished = time.monotonic()
                    last_inference_at = finished
                    with self._lock:
                        self._detected = detected
                        self._confidence = confidence
                        self._label = label
                        self._history.append(detected)
                        self._inference_ms = (finished - started) * 1000
                        self._last_result_at = finished
                        self._frames_processed += 1
                        self._error = None
        except Exception as exc:
            with self._lock:
                self._ready = False
                self._error = f"{type(exc).__name__}: {exc}"

    def _extract_result(self, result: object) -> tuple[bool, float, str | None]:
        names = getattr(result, "names", {})
        candidates: list[tuple[float, str]] = []

        boxes = getattr(result, "boxes", None)
        if boxes is not None:
            classes = boxes.cls.cpu().tolist()
            confidences = boxes.conf.cpu().tolist()
            for class_id, confidence in zip(classes, confidences):
                label = str(names.get(int(class_id), class_id))
                if label.casefold() in self.fire_labels:
                    candidates.append((float(confidence), label))

        probabilities = getattr(result, "probs", None)
        if probabilities is not None:
            for class_id, confidence in enumerate(probabilities.data.cpu().tolist()):
                label = str(names.get(class_id, class_id))
                if label.casefold() in self.fire_labels:
                    candidates.append((float(confidence), label))

        confidence, label = max(candidates, default=(0.0, None))
        return confidence >= self.threshold, confidence, label
