"""End-to-end CAPTCHA solving: image path/array -> recognised text."""

from __future__ import annotations

import os

import cv2
import numpy as np

from .preprocess import preprocess, for_ocr
from .segment import segment_characters
from .split import guided_segment
from .recognizer import KNNRecognizer, tesseract_text

DEFAULT_MODEL = os.path.join(os.path.dirname(__file__), "..", "models", "knn.npz")


class Solver:
    def __init__(self, recognizer: KNNRecognizer | None = None, max_thickness: int = 4):
        self.recognizer = recognizer
        self.max_thickness = max_thickness

    @classmethod
    def from_model(cls, path: str = DEFAULT_MODEL, **kw) -> "Solver":
        return cls(recognizer=KNNRecognizer.load(path), **kw)

    def clean(self, image: np.ndarray) -> np.ndarray:
        return preprocess(image, max_thickness=self.max_thickness)

    def solve(self, image: str | np.ndarray, length: int | None = None) -> str:
        img = _load(image)
        cleaned = self.clean(img)

        if self.recognizer is not None:
            if length is not None:
                # Recognition-guided DP split is most robust for known length.
                text, crops = guided_segment(cleaned, self.recognizer, length)
                if text:
                    return text
            crops = segment_characters(cleaned, expected=length)
            if crops:
                return self.recognizer.predict(crops)

        # Fall back to Tesseract when no trained model is supplied.
        text = tesseract_text(for_ocr(img, max_thickness=self.max_thickness))
        if text is not None:
            return text
        raise RuntimeError(
            "No recognizer available: train a KNN model (see train/train.py) "
            "or install pytesseract + the tesseract binary."
        )


def _load(image: str | np.ndarray) -> np.ndarray:
    if isinstance(image, str):
        img = cv2.imread(image, cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(image)
        return img
    return image


def solve(image: str | np.ndarray, model: str = DEFAULT_MODEL, length: int | None = None) -> str:
    """Convenience one-shot solve using the default trained model if present."""
    solver = Solver.from_model(model) if os.path.exists(model) else Solver()
    return solver.solve(image, length=length)
