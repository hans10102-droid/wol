#!/usr/bin/env python3
"""CLI: solve a CAPTCHA image.

Examples
--------
    python solve.py samples/synth_03_zscx.png
    python solve.py captcha.png --length 6
    python solve.py captcha.png --show cleaned.png   # save the de-lined image
"""

from __future__ import annotations

import argparse
import os
import sys

import cv2

from captcha.solver import Solver, DEFAULT_MODEL


def main() -> int:
    ap = argparse.ArgumentParser(description="Solve a lowercase-English CAPTCHA with a strike line.")
    ap.add_argument("image", help="path to the captcha image")
    ap.add_argument("--length", type=int, default=None, help="known number of characters (improves accuracy)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="trained KNN model (.npz)")
    ap.add_argument("--show", default=None, help="save the strike-line-removed image to this path")
    args = ap.parse_args()

    if os.path.exists(args.model):
        solver = Solver.from_model(args.model)
    else:
        print(f"[warn] model {args.model} not found; using Tesseract fallback if available", file=sys.stderr)
        solver = Solver()

    img = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if img is None:
        print(f"cannot read image: {args.image}", file=sys.stderr)
        return 1

    if args.show:
        cv2.imwrite(args.show, solver.clean(img))

    print(solver.solve(img, length=args.length))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
