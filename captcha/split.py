"""Recognition-guided segmentation.

Straight vertical cuts cannot cleanly separate touching, sheared glyphs, so
instead of committing to a single projection-valley split we propose *many*
candidate cut columns and let the recognizer decide: dynamic programming picks
the division into ``length`` pieces whose combined recognition confidence is
highest.  This turns segmentation into a search the recogniser scores, which is
far more robust than a fixed heuristic.
"""

from __future__ import annotations

import cv2
import numpy as np

from .recognizer import KNNRecognizer


def _candidate_cuts(binary: np.ndarray, min_gap: int = 5) -> list[int]:
    """Interior columns that are plausible letter boundaries (profile minima)."""
    prof = (binary > 0).sum(axis=0).astype(float)
    w = prof.size
    cuts = []
    for x in range(min_gap, w - min_gap):
        lo = prof[x - 2 : x + 3].min()
        # A local minimum or a clear thin bridge is a boundary candidate.
        if prof[x] <= lo and prof[x] <= prof.mean():
            cuts.append(x)
    # Thin out cuts that sit right next to each other.
    thinned = []
    for x in cuts:
        if not thinned or x - thinned[-1] >= 2:
            thinned.append(x)
    return thinned


def _crop(binary: np.ndarray, x0: int, x1: int) -> np.ndarray | None:
    col = binary[:, x0:x1]
    rows = np.where(col.sum(axis=1) > 0)[0]
    if rows.size == 0:
        return None
    return binary[rows[0] : rows[-1] + 1, x0:x1]


def guided_segment(
    binary: np.ndarray,
    recognizer: KNNRecognizer,
    length: int,
    min_char_w: int = 6,
    max_char_w: int | None = None,
) -> tuple[str, list[np.ndarray]]:
    """Return (text, crops) for the best ``length``-way split by confidence."""
    xs = np.where(binary.sum(axis=0) > 0)[0]
    if xs.size == 0:
        return "", []
    left, right = int(xs[0]), int(xs[-1]) + 1
    if max_char_w is None:
        max_char_w = int((right - left) / max(1, length - 1)) + 12

    boundaries = [left] + _candidate_cuts(binary) + [right]
    boundaries = sorted(set(b for b in boundaries if left <= b <= right))

    # Cache per-segment (label, score) so DP reuses them.
    cache: dict[tuple[int, int], tuple[str, float]] = {}

    def seg_score(a: int, b: int):
        if (a, b) in cache:
            return cache[(a, b)]
        crop = _crop(binary, a, b)
        if crop is None:
            res = ("", -1e9)
        else:
            ch, sc = recognizer.score_char(crop)
            res = (ch, sc)
        cache[(a, b)] = res
        return res

    n = len(boundaries)
    NEG = -1e18
    # dp[k][i] = best total score using k chars ending exactly at boundaries[i]
    dp = [[NEG] * n for _ in range(length + 1)]
    back = [[-1] * n for _ in range(length + 1)]
    start = boundaries.index(left)
    dp[0][start] = 0.0

    for k in range(1, length + 1):
        for i in range(n):
            a = boundaries[i]
            if dp[k - 1][i] <= NEG / 2:
                continue
            for j in range(i + 1, n):
                b = boundaries[j]
                width = b - a
                if width < min_char_w:
                    continue
                if width > max_char_w:
                    break
                _, sc = seg_score(a, b)
                total = dp[k - 1][i] + sc
                if total > dp[k][j]:
                    dp[k][j] = total
                    back[k][j] = i

    end = boundaries.index(right)
    if dp[length][end] <= NEG / 2:
        # Fall back to even boundaries if no valid path (rare).
        return _even_split(binary, recognizer, left, right, length)

    # Reconstruct.
    cuts = [end]
    k, i = length, end
    while k > 0:
        i = back[k][i]
        cuts.append(i)
        k -= 1
    cuts = [boundaries[i] for i in reversed(cuts)]

    text, crops = "", []
    for a, b in zip(cuts[:-1], cuts[1:]):
        crop = _crop(binary, a, b)
        if crop is None:
            continue
        crops.append(crop)
        text += recognizer.score_char(crop)[0]
    return text, crops


def _even_split(binary, recognizer, left, right, length):
    step = (right - left) / length
    text, crops = "", []
    for k in range(length):
        a = int(left + k * step)
        b = int(left + (k + 1) * step)
        crop = _crop(binary, a, b)
        if crop is None:
            continue
        crops.append(crop)
        text += recognizer.score_char(crop)[0]
    return text, crops
