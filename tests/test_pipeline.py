"""Tests for the CAPTCHA pipeline: line removal, recognition, end-to-end.

Run with:  python -m pytest -q   (or)   python tests/test_pipeline.py
"""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from captcha.preprocess import to_binary, remove_strike_line, preprocess
from captcha.recognizer import KNNRecognizer
from captcha.solver import Solver
from train.generate import make_captcha

MODEL = os.path.join(os.path.dirname(__file__), "..", "models", "knn.npz")


def _max_horizontal_run(binary: np.ndarray) -> int:
    best = 0
    for row in binary:
        run = 0
        for v in row:
            run = run + 1 if v else 0
            best = max(best, run)
    return best


def test_strike_line_is_removed():
    """The full-width line is broken while the separated bars (letters) survive."""
    import cv2

    h, w = 64, 200
    canvas = np.zeros((h, w), np.uint8)
    for x in (30, 70, 110, 150):  # four "letters"
        canvas[18:46, x : x + 8] = 255
    before_comps = cv2.connectedComponents(canvas)[0] - 1
    assert before_comps == 4

    with_line = canvas.copy()
    cv2.line(with_line, (5, 32), (195, 30), 255, 2)  # strike line across all bars
    assert _max_horizontal_run(with_line) > w * 0.8  # line spans the width

    cleaned = remove_strike_line(with_line, max_thickness=4)
    assert _max_horizontal_run(cleaned) < 20  # line no longer spans
    assert cv2.connectedComponents(cleaned)[0] - 1 == 4  # all four bars intact


def test_strike_line_preserves_glyph_mass():
    """On a real-style captcha, removing the line keeps most glyph ink."""
    img, _ = make_captcha(text="axovpm", seed=3)
    binary = to_binary(img)
    cleaned = remove_strike_line(binary, max_thickness=4)
    assert (cleaned > 0).sum() > (binary > 0).sum() * 0.4


def test_no_line_is_safe():
    """A clean image without a dominant line is returned essentially unchanged."""
    blank = np.zeros((64, 200), np.uint8)
    blank[20:44, 30:50] = 255  # a single blob, no line
    out = remove_strike_line(blank, 4)
    assert (out > 0).sum() > 0


def test_per_character_recognition():
    """Trained recognizer identifies isolated glyphs with high accuracy."""
    model = KNNRecognizer.load(MODEL)
    import string
    from captcha.segment import segment_characters

    ok = tot = 0
    for i, ch in enumerate(string.ascii_lowercase * 4):
        img, _ = make_captcha(text=ch, seed=700000 + i)
        parts = segment_characters(preprocess(img), expected=1)
        if len(parts) != 1:
            continue
        tot += 1
        ok += model.predict_char(parts[0]) == ch
    assert ok / tot > 0.95, ok / tot


def test_end_to_end_accuracy():
    """End-to-end word accuracy on held-out synthetic captchas stays high."""
    solver = Solver.from_model(MODEL)
    n = word_ok = 0
    for i in range(120):
        img, text = make_captcha(seed=990000 + i)
        n += 1
        word_ok += solver.solve(img, length=len(text)) == text
    assert word_ok / n > 0.80, word_ok / n


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all tests passed")
