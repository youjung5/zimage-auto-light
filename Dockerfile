# zimage-auto-light — Z-Image-Turbo 자동 이미지 생성 REST API (gcube 워크로드용)
# 베이스: CUDA 12.8 base (runtime/cudnn 아님)
#   - torch cu128 휠이 cuDNN·cuBLAS·cuFFT 등 CUDA 라이브러리를 모두 자체 번들
#     → 시스템 CUDA 수학 라이브러리(약 3GB) 불필요 → base 로 최소화
#   - 지시받은 CUDA 12.8 기준 / RTX 5060·5090(Blackwell) 충족
FROM nvidia/cuda:12.8.0-base-ubuntu22.04

ARG MODEL_REPO=Disty0/Z-Image-Turbo-SDNQ-uint4-svd-r32

LABEL maintainer="data-alliance" \
      purpose="z-image-turbo auto image generation REST API for gcube" \
      model="${MODEL_REPO}"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_CACHE=/app/hf-cache \
    MODEL_REPO=${MODEL_REPO} \
    OUTPUT_DIR=/workspace/outputs \
    PORT=8000 \
    ZIMG_WIDTH=1024 \
    ZIMG_HEIGHT=1024 \
    ZIMG_STEPS=8 \
    ZIMG_GUIDANCE=0.0

# ── 시스템 패키지 (설치 + 정리 한 레이어) ──
#   build-essential + python3-dev: Triton JIT가 커널 런처를 컴파일할 때 C 컴파일러(+Python.h)가 필요.
#   없으면 SDNQ가 "Failed to find C compiler" → PyTorch eager 모드로 폴백(uint4 최적커널 미사용 → 느림).
#   (2026-06-11: 5060/5090/A100 측정이 전부 eager였던 원인. 정확한 속도엔 이게 있어야 함.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev git ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── ① torch(cu128)를 '먼저' 설치 ──
#   이렇게 해야 이후 requirements의 accelerate 등이 CPU torch를 추가로 끌어오지 않음
#   (기존엔 CPU torch 설치 후 재설치 → 두 벌이 이미지에 박혀 6.5GB 낭비)
#   torchaudio는 이미지 생성에 불필요 → 제외 (torch + torchvision 만)
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel && \
    python3 -m pip install --no-cache-dir torch torchvision \
      --index-url https://download.pytorch.org/whl/cu128 && \
    (python3 -m pip uninstall -y pytorch-triton triton nvidia-nccl-cu12 || true)
# ↑ 미사용 패키지 제거 (같은 레이어여야 실제 용량 감소):
#   - nvidia-nccl-cu12 : 다중 GPU 분산통신용. 우리는 레플리카당 단일 GPU → 미사용
#   - triton           : torch.compile/inductor용. SDNQ가 eager fallback("Triton not available")로
#                        동작 확인됨 → 미사용. (|| true: 없으면 무시, torch 설치 실패는 그대로 빌드 실패)

# ── ② 앱 의존성 + diffusers(소스) 설치, 캐시·pycache 정리(같은 레이어) ──
COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install --no-cache-dir -r /app/requirements.txt && \
    python3 -m pip install --no-cache-dir --no-deps git+https://github.com/huggingface/diffusers && \
    find / -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true && \
    rm -rf /root/.cache /tmp/*

# ── ③ 모델을 빌드 단계에서 굽기 (Tier3 런타임 다운로드 불가 대응) ──
#   콘솔 스크립트('hf'/'huggingface-cli')는 huggingface_hub 버전에 따라 PATH에 없을 수 있어
#   파이썬 snapshot_download 로 직접 받는다(버전·PATH 영향 없음). 캐시는 HF_HUB_CACHE 로.
RUN mkdir -p ${HF_HUB_CACHE} ${OUTPUT_DIR}/auto ${OUTPUT_DIR}/manual && \
    python3 -c "import os; from huggingface_hub import snapshot_download; snapshot_download(os.environ['MODEL_REPO'])" && \
    rm -rf /root/.cache /tmp/*

# ── 런타임은 캐시에서 오프라인 로드 ──
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

# ── 애플리케이션 파일 ──
COPY server.py /app/server.py
COPY benchmark.py /app/benchmark.py
COPY diag_vram.py /app/diag_vram.py
COPY index.html /app/index.html
COPY static/ /app/static/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]