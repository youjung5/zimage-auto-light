#!/usr/bin/env python3
"""
GPU 성능 벤치마크 — 같은 모델·조건으로 여러 GPU를 '공정' 비교하고 결과를 JSON으로 저장.

목적:
  - H100 / A100 / RTX 5060Ti 등 GPU를 바꿔가며 같은 스크립트를 돌려, 비교 가능한 성능 데이터를 모은다.
  - server.py와 '똑같이' 모델을 로드(sdnq 등록 + ZImagePipeline + bfloat16 + MEM_MODE) → 조건 동일.

실행 (컨테이너 안에서):
  python3 benchmark.py                 # 배치 1, 15회 측정
  python3 benchmark.py --sweep         # 배치 1,2,4,8.. OOM 직전까지 → 최대 throughput
  python3 benchmark.py --batch 4 --runs 20 --note "RunPod H100 80GB"

결과: bench_<gpu>_<시각>.json + 화면 요약. 이 파일을 GPU마다 모으면 비교 데이터가 된다.
"""
import os, sys, json, time, argparse, threading, datetime as dt

import torch
from sdnq import SDNQConfig  # noqa: F401  (SDNQ 로더 등록 — server.py와 동일, from_pretrained 전에 필요)
from diffusers import ZImagePipeline


def gpu_static_info():
    if not torch.cuda.is_available():
        return {"gpu_name": "CPU (no CUDA)", "vram_total_gb": None}
    p = torch.cuda.get_device_properties(0)
    return {"gpu_name": torch.cuda.get_device_name(0),
            "vram_total_gb": round(p.total_memory / 1024**3, 2)}


class UtilSampler(threading.Thread):
    """생성 도는 동안 GPU util(%)을 백그라운드로 샘플링(nvml). 없으면 조용히 패스."""
    def __init__(self, interval=0.05):
        super().__init__(daemon=True)
        self.interval = interval; self.samples = []; self._stop = threading.Event(); self._h = None
        try:
            import pynvml
            pynvml.nvmlInit(); self._pynvml = pynvml
            self._h = pynvml.nvmlDeviceGetHandleByIndex(0)
        except Exception:
            self._pynvml = None
    def run(self):
        if not self._h: return
        while not self._stop.is_set():
            try: self.samples.append(self._pynvml.nvmlDeviceGetUtilizationRates(self._h).gpu)
            except Exception: pass
            time.sleep(self.interval)
    def stop(self):
        self._stop.set()
        try: self.join(timeout=1)
        except Exception: pass
        if not self.samples: return {"avg": None, "max": None, "n": 0}
        return {"avg": round(sum(self.samples)/len(self.samples), 1),
                "max": max(self.samples), "n": len(self.samples)}


def load_pipe(model_repo, mem_mode):
    """server.py와 '완전히 동일하게' 로드 — 모든 카드를 같은 조건으로 비교하기 위함.
    ※ VAE 슬라이싱/타일링/어텐션 슬라이싱은 server.py처럼 '모드 무관 항상 ON'.
      (예전엔 VRAM 모드에서 이걸 꺼서 8GB는 스필, 그리고 서버와 조건이 달라 비교가 부정확했음.)"""
    print(f"[load] {model_repo} (MEM_MODE={mem_mode}) ...", flush=True)
    pipe = ZImagePipeline.from_pretrained(model_repo, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
    # 추론 메모리 절감(모드 무관 항상 — server.py와 동일 조건)
    for opt in ("enable_vae_slicing", "enable_vae_tiling", "enable_attention_slicing"):
        try: getattr(pipe, opt)()
        except Exception: pass
    if mem_mode == "VRAM":
        pipe.to("cuda")                  # 모델 VRAM 상주 (여유 노드)
    else:  # RAM
        pipe.enable_model_cpu_offload()  # 컴포넌트씩만 VRAM (빠듯 노드)
    print("[load] ready", flush=True)
    return pipe


def measure(pipe, a, batch):
    """warmup 후 runs회 측정. 반환: 장당 시간 통계 + VRAM peak + util."""
    def one():
        gen = torch.Generator().manual_seed(1234)  # server.py와 동일(CPU generator)
        if torch.cuda.is_available(): torch.cuda.reset_peak_memory_stats(); torch.cuda.synchronize()
        t0 = time.perf_counter()
        out = pipe(prompt=a.prompt, width=a.width, height=a.height,
                   num_inference_steps=a.steps, guidance_scale=a.guidance,
                   num_images_per_prompt=batch, generator=gen)
        if torch.cuda.is_available(): torch.cuda.synchronize()
        dt_s = time.perf_counter() - t0
        n = len(out.images)
        peak = round(torch.cuda.max_memory_allocated()/1024**3, 2) if torch.cuda.is_available() else None
        return dt_s, n, peak

    for _ in range(a.warmup):  # 워밍업(첫 실행은 CUDA 초기화로 느림 → 버림)
        one()
    sampler = UtilSampler(); sampler.start()
    per_call, peaks = [], []
    for _ in range(a.runs):
        dt_s, n, peak = one()
        per_call.append(dt_s);
        if peak is not None: peaks.append(peak)
    util = sampler.stop()
    per_img = [c / batch for c in per_call]
    avg_img = sum(per_img)/len(per_img)
    return {
        "batch": batch, "runs": a.runs,
        "per_image_s": {"avg": round(avg_img, 3), "min": round(min(per_img), 3), "max": round(max(per_img), 3)},
        "per_call_s_avg": round(sum(per_call)/len(per_call), 3),
        "throughput_img_per_h": round(3600.0/avg_img, 1) if avg_img > 0 else None,
        "vram_peak_gb": max(peaks) if peaks else None,
        "util_pct": util,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.getenv("MODEL_REPO", "Disty0/Z-Image-Turbo-SDNQ-uint4-svd-r32"))
    ap.add_argument("--mem-mode", default=os.getenv("MEM_MODE", "VRAM").strip().upper())
    ap.add_argument("--width", type=int, default=int(os.getenv("ZIMG_WIDTH", "1024")))
    ap.add_argument("--height", type=int, default=int(os.getenv("ZIMG_HEIGHT", "1024")))
    ap.add_argument("--steps", type=int, default=int(os.getenv("ZIMG_STEPS", "8")))
    ap.add_argument("--guidance", type=float, default=float(os.getenv("ZIMG_GUIDANCE", "0.0")))
    ap.add_argument("--prompt", default="a serene mountain lake at sunrise, ultra detailed, 8k")
    ap.add_argument("--runs", type=int, default=15)
    ap.add_argument("--warmup", type=int, default=2)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--sweep", action="store_true", help="배치 1,2,4,8.. OOM 직전까지 측정")
    ap.add_argument("--note", default="", help="플랫폼/메모 (예: 'RunPod H100 80GB')")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    if not torch.cuda.is_available():
        print("[warn] CUDA 없음 — GPU 벤치마크 의미 없음", flush=True)

    info = gpu_static_info()
    pipe = load_pipe(a.model, a.mem_mode)

    batches = [1, 2, 4, 8, 16, 32] if a.sweep else [a.batch]
    results = []
    for b in batches:
        try:
            print(f"[run] batch={b} (warmup {a.warmup} + {a.runs}회) ...", flush=True)
            r = measure(pipe, a, b)
            results.append(r)
            pi = r["per_image_s"]["avg"]
            print(f"   → 장당 {pi}s · {r['throughput_img_per_h']}장/h · VRAM peak {r['vram_peak_gb']}GB · util≈{r['util_pct']['avg']}%", flush=True)
        except torch.cuda.OutOfMemoryError:
            print(f"   → batch={b} OOM. 여기까지가 한계.", flush=True)
            torch.cuda.empty_cache(); break
        except Exception as e:
            print(f"   → batch={b} 실패: {e}", flush=True)
            torch.cuda.empty_cache(); break

    record = {
        "measured_at": dt.datetime.now().isoformat(timespec="seconds"),
        "note": a.note,
        "gpu_name": info["gpu_name"], "vram_total_gb": info["vram_total_gb"],
        "torch": torch.__version__, "cuda": torch.version.cuda,
        "model": a.model, "dtype": "bfloat16", "mem_mode": a.mem_mode,
        "conditions": {"width": a.width, "height": a.height, "steps": a.steps, "guidance": a.guidance},
        "prompt": a.prompt,
        "results": results,
    }

    slug = "".join(c if c.isalnum() else "_" for c in info["gpu_name"])[:40]
    out = a.out or f"bench_{slug}_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    print("\n===== 요약 =====", flush=True)
    print(f"GPU       : {info['gpu_name']}  (VRAM {info['vram_total_gb']}GB)", flush=True)
    print(f"모델/모드 : {a.model} / {a.mem_mode} / {a.width}x{a.height} {a.steps}step", flush=True)
    for r in results:
        u = r["util_pct"]["avg"]
        print(f"  batch {r['batch']:>2} : 장당 {r['per_image_s']['avg']}s · {r['throughput_img_per_h']}장/h · VRAM peak {r['vram_peak_gb']}GB · util≈{u}%", flush=True)
    print(f"\n저장: {out}", flush=True)


if __name__ == "__main__":
    main()
