"""Generate synthetic CAPTCHAs matching the target style.

The target CAPTCHAs are 4-6 distorted lowercase English letters with a single
thin, slightly slanted line struck through the middle.  Rendering a large,
labelled dataset in that style is what lets a small CNN reach near-perfect
accuracy: the font/effect space is narrow and fully reproducible.

Uses only Pillow + NumPy so it runs without any training framework.
"""

from __future__ import annotations

import random
import string

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ALPHABET = string.ascii_lowercase


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    # Serif fonts match the look of the samples; fall back to whatever is
    # available so generation never hard-fails.
    for name in (
        "DejaVuSerif.ttf",
        "DejaVuSerif-Bold.ttf",
        "LiberationSerif-Regular.ttf",
        "DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _char_image(ch: str, rng: random.Random, size: int = 48) -> Image.Image:
    font = _load_font(size)
    canvas = Image.new("L", (size + 20, size + 20), 255)
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 4), ch, font=font, fill=0)
    # Random shear + rotation to mimic the wobble of the real glyphs.
    angle = rng.uniform(-14, 14)
    canvas = canvas.rotate(angle, expand=True, fillcolor=255, resample=Image.BICUBIC)
    shear = rng.uniform(-0.20, 0.20)
    w, h = canvas.size
    canvas = canvas.transform(
        (w, h), Image.AFFINE, (1, shear, -shear * h / 2, 0, 1, 0),
        fillcolor=255, resample=Image.BICUBIC,
    )
    return _crop_ink(canvas)


def _crop_ink(img: Image.Image) -> Image.Image:
    arr = np.asarray(img)
    ys, xs = np.where(arr < 128)
    if xs.size == 0:
        return img
    return img.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


def make_captcha(
    text: str | None = None,
    length: int | None = None,
    seed: int | None = None,
    height: int = 64,
) -> tuple[np.ndarray, str]:
    """Return (image, text). ``image`` is grayscale uint8, text on white."""
    rng = random.Random(seed)
    if text is None:
        n = length or rng.randint(4, 6)
        text = "".join(rng.choice(ALPHABET) for _ in range(n))

    glyphs = [_char_image(ch, rng) for ch in text]
    scale = (height - 16) / max(g.height for g in glyphs)
    glyphs = [g.resize((max(1, int(g.width * scale)), max(1, int(g.height * scale)))) for g in glyphs]

    # Real samples space the letters out; the strike line is what visually
    # joins them.  Occasional near-touching keeps segmentation honest.
    gap = rng.choice([1, 2, 2, 3, 4, 5, 0])
    total_w = sum(g.width for g in glyphs) + gap * (len(glyphs) - 1) + 20
    canvas = Image.new("L", (total_w, height), 255)

    x = 10
    for g in glyphs:
        y = (height - g.height) // 2 + rng.randint(-4, 4)
        canvas.paste(g, (x, y))
        x += g.width + gap

    _draw_strike_line(canvas, rng)
    return np.asarray(canvas), text


def _draw_strike_line(canvas: Image.Image, rng: random.Random) -> None:
    w, h = canvas.size
    draw = ImageDraw.Draw(canvas)
    y_mid = h // 2 + rng.randint(-4, 4)
    slant = rng.randint(-8, 8)
    thickness = rng.randint(1, 3)
    draw.line((0, y_mid - slant, w, y_mid + slant), fill=0, width=thickness)


def dataset(count: int, seed: int = 0, **kwargs):
    """Yield ``count`` (image, text) pairs with reproducible seeds."""
    for i in range(count):
        yield make_captcha(seed=seed * 100003 + i, **kwargs)


if __name__ == "__main__":
    import os

    out = os.path.join(os.path.dirname(__file__), "..", "samples")
    os.makedirs(out, exist_ok=True)
    for idx, (img, text) in enumerate(dataset(8, seed=7)):
        Image.fromarray(img).save(os.path.join(out, f"synth_{idx:02d}_{text}.png"))
    print(f"wrote 8 synthetic samples to {os.path.normpath(out)}")
