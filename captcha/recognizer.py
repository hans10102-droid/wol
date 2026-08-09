"""Character recognition for cleaned CAPTCHAs.

Two backends are provided behind one interface:

* :class:`KNNRecognizer` — a dependency-free (NumPy only) nearest-neighbour
  classifier over normalised glyph bitmaps.  It trains in seconds from the
  synthetic generator and is what the test-suite verifies end-to-end.
* :func:`tesseract_text` — an optional Tesseract backend (used only if
  ``pytesseract`` and the ``tesseract`` binary are installed) for quick
  baselines without training.

For maximum accuracy on the real captchas, train :class:`KNNRecognizer` on a
batch of *real* labelled samples (``train/train.py --real-dir``); the same
preprocessing keeps train and inference distributions aligned.
"""

from __future__ import annotations

import os

import cv2
import numpy as np

GLYPH = 28  # normalised glyph size


def normalize_glyph(crop: np.ndarray, size: int = GLYPH) -> np.ndarray:
    """Fit a char crop into a centred ``size``×``size`` blurred float vector.

    The crop is deskewed by its second moments, scaled to fit while preserving
    aspect ratio, centred, and lightly blurred.  Deskew undoes the per-glyph
    shear/rotation of the captcha font, and the blur makes the distance
    tolerant to a few pixels of residual misalignment — both markedly improve
    nearest-neighbour matching over raw binary bitmaps.
    """
    ys, xs = np.where(crop > 0)
    if xs.size == 0:
        return np.zeros(size * size, dtype=np.float32)
    crop = crop[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    crop = _deskew(crop)

    h, w = crop.shape
    scale = (size - 6) / max(h, w)
    resized = cv2.resize(crop, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((size, size), dtype=np.float32)
    y0 = (size - resized.shape[0]) // 2
    x0 = (size - resized.shape[1]) // 2
    canvas[y0 : y0 + resized.shape[0], x0 : x0 + resized.shape[1]] = resized.astype(np.float32)

    canvas = cv2.GaussianBlur(canvas, (3, 3), 0)
    norm = np.linalg.norm(canvas)
    if norm > 0:
        canvas /= norm
    return canvas.ravel()


def _deskew(crop: np.ndarray) -> np.ndarray:
    m = cv2.moments((crop > 0).astype(np.uint8))
    if abs(m["mu02"]) < 1e-2:
        return crop
    skew = m["mu11"] / m["mu02"]
    if abs(skew) < 1e-3:
        return crop
    h, w = crop.shape
    M = np.array([[1, -skew, 0.5 * w * skew], [0, 1, 0]], dtype=np.float32)
    return cv2.warpAffine(crop, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)


class KNNRecognizer:
    """Nearest-neighbour glyph classifier over normalised bitmaps."""

    def __init__(self, k: int = 3):
        self.k = k
        self.templates = np.empty((0, GLYPH * GLYPH), dtype=np.float32)
        self.labels: list[str] = []

    def fit(self, crops: list[np.ndarray], labels: list[str]) -> "KNNRecognizer":
        vecs = [normalize_glyph(c) for c in crops]
        self.templates = np.asarray(vecs, dtype=np.float32)
        self.labels = list(labels)
        return self

    def score_char(self, crop: np.ndarray) -> tuple[str, float]:
        """Return (best_label, confidence in [0, 1]) for a single char crop."""
        vec = normalize_glyph(crop)
        # Cosine similarity over L2-normalised blurred glyphs.
        sims = self.templates @ vec
        idx = np.argsort(sims)[::-1][: self.k]
        votes: dict[str, float] = {}
        for i in idx:
            votes[self.labels[i]] = votes.get(self.labels[i], 0.0) + float(sims[i])
        if not votes:
            return "", 0.0
        best = max(votes, key=votes.get)
        # Top-neighbour cosine similarity is the DP's per-segment confidence:
        # a well-formed single glyph matches a template closely, a crop holding
        # a fragment or two glyphs does not.
        return best, float(sims[idx[0]])

    def predict_char(self, crop: np.ndarray) -> str:
        return self.score_char(crop)[0]

    def predict(self, crops: list[np.ndarray]) -> str:
        return "".join(self.predict_char(c) for c in crops)

    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        np.savez_compressed(path, templates=self.templates, labels=np.array(self.labels), k=self.k)

    @classmethod
    def load(cls, path: str) -> "KNNRecognizer":
        data = np.load(path, allow_pickle=False)
        obj = cls(k=int(data["k"]))
        obj.templates = data["templates"].astype(np.float32)
        obj.labels = [str(x) for x in data["labels"]]
        return obj


def tesseract_text(ocr_ready: np.ndarray) -> str | None:
    """Recognise with Tesseract if available; else return None.

    ``ocr_ready`` should be black text on white (see ``preprocess.for_ocr``).
    """
    try:
        import pytesseract
    except ImportError:
        return None
    config = "--psm 7 -c tessedit_char_whitelist=abcdefghijklmnopqrstuvwxyz"
    try:
        text = pytesseract.image_to_string(ocr_ready, config=config)
    except Exception:
        return None
    return "".join(ch for ch in text.lower() if ch.isalpha()) or None
