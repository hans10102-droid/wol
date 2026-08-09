"""Train the KNN glyph recognizer from synthetic (or real) samples.

Synthetic training renders single-character captchas — one glyph plus a strike
line — runs them through the exact inference preprocessing, and stores the
resulting normalised bitmaps as labelled templates.  Keeping train and
inference preprocessing identical is what makes the recognizer accurate.

To adapt to the *real* captchas, drop labelled PNGs into a folder named
``<text>.png`` (or ``<text>_xx.png``) and pass ``--real-dir``; those crops are
added to the template set.
"""

from __future__ import annotations

import argparse
import glob
import os
import string

import cv2

from captcha.preprocess import preprocess
from captcha.segment import segment_characters
from captcha.recognizer import KNNRecognizer
from train.generate import make_captcha

ALPHABET = string.ascii_lowercase


def synthetic_char_crops(per_char: int, seed: int = 0):
    crops, labels = [], []
    counter = 0
    for ch in ALPHABET:
        made = 0
        while made < per_char:
            img, _ = make_captcha(text=ch, seed=seed * 1_000_003 + counter)
            counter += 1
            cleaned = preprocess(img)
            parts = segment_characters(cleaned, expected=1)
            if len(parts) == 1:
                crops.append(parts[0])
                labels.append(ch)
                made += 1
    return crops, labels


def real_char_crops(directory: str):
    crops, labels = [], []
    for path in sorted(glob.glob(os.path.join(directory, "*.png"))):
        name = os.path.splitext(os.path.basename(path))[0]
        text = name.split("_")[0]
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            continue
        cleaned = preprocess(img)
        parts = segment_characters(cleaned, expected=len(text))
        if len(parts) == len(text):
            crops.extend(parts)
            labels.extend(list(text))
    return crops, labels


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-char", type=int, default=40, help="synthetic samples per letter")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--real-dir", default=None, help="folder of labelled real captchas")
    ap.add_argument("--out", default=os.path.join("models", "knn.npz"))
    args = ap.parse_args()

    crops, labels = synthetic_char_crops(args.per_char, seed=args.seed)
    print(f"synthetic templates: {len(crops)}")

    if args.real_dir:
        rc, rl = real_char_crops(args.real_dir)
        crops += rc
        labels += rl
        print(f"real templates added: {len(rc)}")

    model = KNNRecognizer(k=args.k).fit(crops, labels)
    model.save(args.out)
    print(f"saved model with {len(labels)} templates -> {args.out}")


if __name__ == "__main__":
    main()
