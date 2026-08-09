"""Segment a cleaned CAPTCHA into individual character images.

Segmentation is the accuracy bottleneck for connected/overlapping glyphs, so
this uses a count-aware strategy when the string length is known:

1. group text into connected components (left→right);
2. merge fragments (e.g. an 'i' dot, or a piece left by line removal) into the
   nearest neighbour until no more than ``expected`` groups remain;
3. split any group that still spans several letters at the lowest-density
   interior columns (projection valleys), never at arbitrary midpoints.
"""

from __future__ import annotations

import cv2
import numpy as np


def segment_characters(
    binary: np.ndarray,
    expected: int | None = None,
    min_width: int = 4,
) -> list[np.ndarray]:
    """Split a binary (text=white) image into per-character crops, left→right."""
    spans = _component_spans(binary, min_width)
    if not spans:
        return []

    if expected is not None:
        spans = _merge_to(spans, binary, expected)
        spans = _split_to(spans, binary, expected, min_width)

    crops = []
    for x0, x1 in spans:
        col = binary[:, x0:x1]
        rows = np.where(col.sum(axis=1) > 0)[0]
        if rows.size == 0:
            continue
        crops.append(binary[rows[0] : rows[-1] + 1, x0:x1])
    return crops


def _component_spans(binary: np.ndarray, min_width: int) -> list[tuple[int, int]]:
    """x-spans of connected components, merged where they horizontally overlap."""
    num, _, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    boxes = []
    for i in range(1, num):
        x = stats[i, cv2.CC_STAT_LEFT]
        w = stats[i, cv2.CC_STAT_WIDTH]
        area = stats[i, cv2.CC_STAT_AREA]
        if area < 3:
            continue
        boxes.append((x, x + w))
    if not boxes:
        return []
    boxes.sort()

    merged = [list(boxes[0])]
    for x0, x1 in boxes[1:]:
        # Overlapping x-ranges belong to the same glyph (e.g. 'j' body + dot).
        if x0 <= merged[-1][1] - 1:
            merged[-1][1] = max(merged[-1][1], x1)
        else:
            merged.append([x0, x1])
    return [(a, b) for a, b in merged if b - a >= 1]


def _profile(binary: np.ndarray, x0: int, x1: int) -> np.ndarray:
    return (binary[:, x0:x1] > 0).sum(axis=0)


def _merge_to(spans, binary, expected):
    spans = [list(s) for s in spans]
    while len(spans) > expected:
        # Merge the narrowest span into its closer neighbour.
        widths = [b - a for a, b in spans]
        i = int(np.argmin(widths))
        if i == 0:
            j = 1
        elif i == len(spans) - 1:
            j = i - 1
        else:
            left_gap = spans[i][0] - spans[i - 1][1]
            right_gap = spans[i + 1][0] - spans[i][1]
            j = i - 1 if left_gap <= right_gap else i + 1
        lo, hi = sorted((i, j))
        spans[lo] = [spans[lo][0], spans[hi][1]]
        del spans[hi]
    return [tuple(s) for s in spans]


def _split_to(spans, binary, expected, min_width):
    spans = [tuple(s) for s in spans]
    guard = 0
    while len(spans) < expected and guard < 100:
        guard += 1
        # Split the widest span at its best interior valley.
        i = int(np.argmax([b - a for a, b in spans]))
        a, b = spans[i]
        cut = _best_valley(binary, a, b, min_width)
        if cut is None:
            break
        spans = spans[:i] + [(a, cut), (cut, b)] + spans[i + 1 :]
    return spans


def _best_valley(binary, a, b, min_width):
    """Column (absolute x) of minimum ink density in the interior of [a, b)."""
    if b - a < 2 * min_width:
        return None
    prof = _profile(binary, a, b).astype(float)
    interior = slice(min_width, len(prof) - min_width)
    idx = np.arange(len(prof))
    # Prefer valleys near the centre so even splits win ties on flat regions.
    centre_bias = np.abs(idx - len(prof) / 2) * 0.01 * (prof.max() + 1)
    score = prof + centre_bias
    region = score[interior]
    if region.size == 0:
        return None
    local = int(np.argmin(region)) + min_width
    return a + local
