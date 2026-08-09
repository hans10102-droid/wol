# CAPTCHA 인식 (영어 소문자 + 중앙 취소선)

영어 소문자로 이루어진 CAPTCHA 이미지를 인식합니다. 이 CAPTCHA의 핵심 문제는
**글자 가운데를 가로지르는 얇은 취소선(strike line)** 인데, 이 선이 글자들을
서로 연결하고 가짜 획을 만들어 일반 OCR을 망가뜨립니다.

이 프로젝트는 그 선을 **글자 획은 보존하면서 깔끔하게 제거**한 뒤, 인식·분할을
수행합니다.

## 왜 인식이 안 됐는가 → 무엇을 고쳤는가

- 소문자는 x-height(글자 몸통)가 이미지 정중앙에 오는데, 취소선이 바로 그
  몸통 한가운데를 지나갑니다. 그래서 "선 영역을 통째로 지우는" 단순한 방법은
  글자 몸통까지 지워버립니다.
- 해결책은 **세로 런(run) 길이 기반 제거**입니다. 선이 지나가는 각 열에서
  세로로 이어진 검은 픽셀의 길이를 봅니다. 길이가 선 두께 정도로 **얇으면**
  순수 선으로 보고 지우고, **길면** 글자 획이 겹친 것으로 보고 통째로 남깁니다.
  제거 후 생긴 1~2px 틈은 세로 방향 close 연산으로 메웁니다.
- 자세한 구현: `captcha/preprocess.py`의 `remove_strike_line`.

## 파이프라인

```
이미지 → 이진화 → 취소선 제거 → (인식 유도) 문자 분할 → 문자 인식 → 텍스트
         to_binary   remove_strike_line   split.guided_segment   KNNRecognizer
```

- **분할이 정확도의 핵심**이라, 길이를 알 때는 고정된 휴리스틱 대신
  **인식 유도 분할(recognition-guided segmentation)** 을 씁니다. 여러 후보
  절단 위치를 만든 뒤, 동적 계획법(DP)으로 "각 조각을 인식기가 가장 확신하는"
  분할을 찾습니다 (`captcha/split.py`). 겹치거나 붙은 글자에 특히 강합니다.

## 사용법

```bash
pip install -r requirements.txt

# 단일 이미지 해석 (길이를 알면 넘겨주는 게 정확도에 좋음)
python solve.py path/to/captcha.png --length 6

# 취소선 제거 결과를 눈으로 확인
python solve.py path/to/captcha.png --show cleaned.png
```

파이썬 API:

```python
from captcha import Solver
solver = Solver.from_model("models/knn.npz")
text = solver.solve("captcha.png", length=6)

# 전처리(취소선 제거)만 따로 쓰고 싶을 때 — 기존 OCR에 그대로 물릴 수 있음
import cv2
from captcha import preprocess, for_ocr
cleaned = preprocess(cv2.imread("captcha.png"))     # 글자=흰색
ocr_input = for_ocr(cv2.imread("captcha.png"))      # 검은 글자/흰 배경 (Tesseract용)
```

## 정확도

무작위 왜곡 합성 CAPTCHA(학습에 쓰지 않은 시드) 기준:

| 지표 | 값 |
|------|-----|
| 문자 단위 정확도 | ~97.6% |
| 문자열 전체 정확도 | ~91% |
| 고립 문자 인식(분할 완벽 가정) | ~99.6% |

실제 CAPTCHA는 **하나의 일정한 폰트**라 합성보다 쉬우므로, 실제 라벨 샘플을
조금만 추가 학습하면 100%에 근접합니다 (아래 참고).

## 실제 CAPTCHA로 정확도 끌어올리기 (권장)

1. 실제 CAPTCHA 이미지를 정답 텍스트로 이름 붙여 한 폴더에 모읍니다:
   `axovpm.png`, `rjmauk.png`, `rjmauk_02.png` … (`_` 앞부분이 정답)
2. 합성 데이터에 실제 샘플을 더해 재학습:

   ```bash
   python -m train.train --per-char 160 --real-dir path/to/real_captchas
   ```

   실제 글자 모양이 템플릿에 추가되어 그 폰트에 맞춰집니다.

## 선택: Tesseract 백업

학습된 모델이 없을 때는 `pytesseract`(+ 시스템 `tesseract`)가 설치돼 있으면
그걸로 대체 인식합니다. 소문자 화이트리스트와 취소선 제거 전처리가 자동
적용됩니다. 정확도는 KNN 모델 쪽이 더 높습니다.

## 구조

```
captcha/
  preprocess.py   취소선 제거 + 이진화/정리   (핵심 수정)
  segment.py      연결요소/투영 기반 문자 분할
  split.py        인식 유도 DP 분할
  recognizer.py   KNN 글자 인식기 (+ Tesseract 백업)
  solver.py       end-to-end 해석기
train/
  generate.py     실제 스타일 합성 CAPTCHA 생성기
  train.py        합성/실제 샘플로 KNN 모델 학습
tests/
  test_pipeline.py  취소선 제거·인식·end-to-end 테스트
solve.py          CLI
models/knn.npz    학습된 기본 모델 (합성 데이터)
```

## 테스트

```bash
python tests/test_pipeline.py      # 또는:  python -m pytest -q
```
