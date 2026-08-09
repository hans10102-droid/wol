"""Image preprocessing for lowercase-English CAPTCHAs with a strike line.

The CAPTCHAs handled here are short strings of distorted lowercase English
letters with a single thin, (near-)straight line drawn across the middle of
the whole image.  That strike line is the main reason OCR fails: it merges
neighbouring glyphs and adds spurious horizontal strokes.

The key routine is :func:`remove_strike_line`, which detects the dominant line
and erases only the pixels that belong to the line, keeping the letter strokes
that the line happens to cross.  Everything downstream (segmentation,
recognition) gets a clean binary image of just the letters.
"""

from __future__ import annotations

import cv2
import numpy as np


def to_binary(image: np.ndarray) -> np.ndarray:
    """Return a binary image where text is white (255) on black (0).

    Accepts colour, grayscale, or already-binary input.
    """
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()

    # Otsu handles the varying contrast of the sample captchas well.
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # If the threshold picked the wrong polarity (background became text),
    # correct it: text should be the minority of pixels.
    if np.count_nonzero(binary) > binary.size * 0.5:
        binary = cv2.bitwise_not(binary)
    return binary


def _detect_line(binary: np.ndarray, max_thickness: int) -> tuple[np.ndarray, bool]:
    """Return (band_mask, found) locating the strike line.

    ``band_mask`` is a filled band a few pixels tall following the detected
    line across the full width.  ``found`` is False when no dominant line is
    present (then the caller should skip removal).
    """
    h, w = binary.shape
    band = np.zeros_like(binary)

    # A strike line is long and nearly horizontal.  Probabilistic Hough finds
    # it robustly even when slanted or slightly wavy (it returns segments we
    # merge into one band).
    min_len = int(w * 0.45)
    lines = cv2.HoughLinesP(
        binary,
        rho=1,
        theta=np.pi / 180,
        threshold=int(w * 0.30),
        minLineLength=min_len,
        maxLineGap=int(w * 0.15),
    )

    drew = False
    thickness = max(3, max_thickness + 2)
    if lines is not None:
        for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4):
            angle = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
            # Keep only near-horizontal long segments (the strike line),
            # rejecting vertical letter strokes Hough might also report.
            if angle <= 25 or angle >= 155:
                cv2.line(band, (x1, y1), (x2, y2), 255, thickness)
                drew = True

    if drew:
        return band, True

    # Fallback: no clear Hough line.  Use the row with the most text as the
    # centre of a horizontal band (works for perfectly horizontal lines).
    row_sums = binary.sum(axis=1)
    peak = int(np.argmax(row_sums))
    if row_sums[peak] > w * 0.5 * 255:
        y0 = max(0, peak - thickness // 2)
        y1 = min(h, peak + thickness // 2 + 1)
        band[y0:y1, :] = 255
        return band, True

    return band, False


def _column_line_y(band: np.ndarray) -> np.ndarray:
    """Per-column centre row of the detected line, interpolated across gaps."""
    w = band.shape[1]
    ys = np.full(w, -1.0)
    for x in range(w):
        rows = np.where(band[:, x] > 0)[0]
        if rows.size:
            ys[x] = rows.mean()
    known = np.where(ys >= 0)[0]
    if known.size == 0:
        return ys
    ys = np.interp(np.arange(w), known, ys[known])
    return ys


def _vertical_run(column: np.ndarray, y: int) -> tuple[int, int]:
    """Return (top, bottom) of the maximal black run in ``column`` covering y."""
    if y < 0 or y >= column.size or column[y] == 0:
        return (y, y - 1)  # empty run
    top = y
    while top > 0 and column[top - 1] > 0:
        top -= 1
    bottom = y
    while bottom < column.size - 1 and column[bottom + 1] > 0:
        bottom += 1
    return (top, bottom)


def _estimate_thickness(binary: np.ndarray, line_y: np.ndarray, max_thickness: int) -> int:
    heights = []
    for x in range(0, binary.shape[1], 2):
        y = int(round(line_y[x]))
        top, bottom = _vertical_run(binary[:, x], y)
        if bottom >= top:
            heights.append(bottom - top + 1)
    if not heights:
        return max_thickness
    thin = [h for h in heights if h <= max_thickness + 1]
    est = int(np.median(thin)) if thin else int(np.median(heights))
    return int(np.clip(est, 1, max_thickness))


def remove_strike_line(binary: np.ndarray, max_thickness: int = 4) -> np.ndarray:
    """Erase the strike line from a binary (text=white) image.

    For every column the line passes through, we look at the vertical black run
    sitting on the line.  A *thin* run (no taller than the measured line
    thickness plus a small margin) is line-only and gets removed; a *tall* run
    is a letter stroke the line overlaps, and is kept whole.  This preserves the
    letter bodies that lowercase glyphs place right on the strike line.
    """
    band, found = _detect_line(binary, max_thickness)
    if not found:
        return binary.copy()

    h, w = binary.shape
    result = binary.copy()
    line_y = _column_line_y(band)
    thickness = _estimate_thickness(binary, line_y, max_thickness)
    keep_above = thickness + 2  # runs taller than this are letter strokes

    for x in range(w):
        y = int(round(line_y[x]))
        top, bottom = _vertical_run(binary[:, x], y)
        if bottom < top:
            continue
        run_h = bottom - top + 1
        if run_h <= keep_above:
            result[top : bottom + 1, x] = 0  # pure line segment

    # Bridge the small vertical nicks removal may have opened in letter strokes.
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, thickness + 3))
    result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, close_kernel)

    # Drop tiny specks left from the line ends.
    result = _remove_specks(result, min_area=max(6, (h * w) // 3000))
    return result


def _remove_specks(binary: np.ndarray, min_area: int) -> np.ndarray:
    num, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    out = np.zeros_like(binary)
    for i in range(1, num):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            out[labels == i] = 255
    return out


def preprocess(image: np.ndarray, max_thickness: int = 4) -> np.ndarray:
    """Full cleanup: binarize, remove the strike line, denoise.

    Returns a binary image (text=white on black) ready for segmentation or OCR.
    """
    binary = to_binary(image)
    cleaned = remove_strike_line(binary, max_thickness=max_thickness)
    return cleaned


def for_ocr(image: np.ndarray, max_thickness: int = 4, pad: int = 8) -> np.ndarray:
    """Preprocess and return a black-text-on-white image padded for Tesseract."""
    cleaned = preprocess(image, max_thickness=max_thickness)
    inverted = cv2.bitwise_not(cleaned)  # black text on white
    return cv2.copyMakeBorder(inverted, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)
