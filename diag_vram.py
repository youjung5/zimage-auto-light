#!/usr/bin/env python3
"""
VRAM 단계별 프로파일러 — 8GB에서 1024가 '어느 단계'에서 넘치는지 숫자로 가른다.

질문: RTX 5060 8GB에서 1024 peak가 ~8.46GB로 카드(7.96GB)를 0.5GB 살짝 넘긴다.
      그 peak가
        (a) 8번 반복하는 디노이징 루프(transformer) 자체냐  → 루프가 안 들어옴 = 1024 고집 시 타협 필요
        (b) 1회성 단계(텍스트인코딩 / VAE 디코드)냐         → 루프는 들어옴 = '1024+8GB+빠름' 가능성!
      를 컴포넌트별 forward VRAM peak로 가린다. server.py / benchmark.py와 동일하게 로드.

실행 (컨테이너 안, GPU 한 대 · 서버 미기동 상태에서 단독으로):
  python3 diag_vram.py                          # RAM(오프로드) 모드 1024 ← 먼저 이것! 안전 + 실제속도 + 단계별 footprint
  python3 diag_vram.py --mem-mode VRAM          # 전부 VRAM(스필 날 수 있음 — peak '왜 넘치나' 확인용)
  python3 diag_vram.py --width 768 --height 768 # 768이 들어오는지/빠른지

해석:
  - 'transformer'(또는 호출수 최대 = 반복) peak가 8GB 안 → 루프는 OK, 1회성만 잡으면 됨.
  - 장당 시간이 이미 쓸만하면(RAM 모드) 추가 작업 없이 '셋 다' 거의 달성.
"""
import os, argparse, time
import torch
from sdnq import SDNQConfig  # noqa: F401  (server.py/benchmark.py와 동일 — from_pretrained 전 SDNQ 로더 등록)
from diffusers import ZImagePipeline


def gb(num_bytes):
    return round(num_bytes / 1024**3, 2)


def load_pipe(model_repo, mem_mode):
    """server.py와 동일한 로드(조건 동일 보장)."""
    print(f"[load] {model_repo} (MEM_MODE={mem_mode}) ...", flush=True)
    pipe = ZImagePipeline.from_pretrained(model_repo, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
    if mem_mode == "VRAM":
        pipe.to("cuda")
    else:  # RAM (오프로드) — server.py 기본
        for opt in ("enable_vae_slicing", "enable_vae_tiling", "enable_attention_slicing"):
            try:
                getattr(pipe, opt)()
            except Exception:
                pass
        pipe.enable_model_cpu_offload()
    print("[load] ready", flush=True)
    return pipe


def find_module_components(pipe):
    """파이프라인의 최상위 nn.Module 컴포넌트 목록 (text_encoder / transformer / vae 등)."""
    comps = []
    try:
        for name, mod in pipe.components.items():        # diffusers 표준 경로
            if isinstance(mod, torch.nn.Module):
                comps.append((name, mod))
    except Exception:
        pass
    if not comps:                                        # 폴백: 속성 스캔
        for name, mod in vars(pipe).items():
            if isinstance(mod, torch.nn.Module):
                comps.append((name, mod))
    return comps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.getenv("MODEL_REPO", "Disty0/Z-Image-Turbo-SDNQ-uint4-svd-r32"))
    ap.add_argument("--mem-mode", default=os.getenv("MEM_MODE", "RAM").strip().upper())
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--guidance", type=float, default=0.0)
    ap.add_argument("--prompt", default="a serene mountain lake at sunrise, ultra detailed, 8k")
    ap.add_argument("--warmup", type=int, default=1)
    ap.add_argument("--runs", type=int, default=2)
    a = ap.parse_args()

    if not torch.cuda.is_available():
        print("[err] CUDA 없음 — GPU에서 돌려야 의미 있음", flush=True)
        return

    props = torch.cuda.get_device_properties(0)
    card_gb = gb(props.total_memory)
    print(f"[gpu] {torch.cuda.get_device_name(0)}  VRAM {card_gb}GB", flush=True)

    pipe = load_pipe(a.model, a.mem_mode)

    torch.cuda.synchronize()
    resident0 = gb(torch.cuda.memory_allocated())  # 로드 직후 GPU 상주(VRAM 모드면 가중치 전체)

    # ── 컴포넌트별 forward VRAM peak 훅 ──
    # forward '직전' peak 리셋 → '직후' 기록. transformer는 step마다 호출 → 호출들 중 최댓값 = 루프 footprint.
    stats = {}  # name -> {"peak": bytes, "calls": int}
    handles = []
    comps = find_module_components(pipe)
    for name, module in comps:
        stats[name] = {"peak": 0, "calls": 0}

        def pre_hook(mod, inp):
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()

        def post_hook(mod, inp, out, _name=name):
            torch.cuda.synchronize()
            p = torch.cuda.max_memory_allocated()
            if p > stats[_name]["peak"]:
                stats[_name]["peak"] = p
            stats[_name]["calls"] += 1

        handles.append(module.register_forward_pre_hook(pre_hook))
        handles.append(module.register_forward_hook(post_hook))

    def one():
        gen = torch.Generator().manual_seed(1234)  # server.py와 동일(CPU generator)
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        t0 = time.perf_counter()
        pipe(prompt=a.prompt, width=a.width, height=a.height,
             num_inference_steps=a.steps, guidance_scale=a.guidance, generator=gen)
        torch.cuda.synchronize()
        return time.perf_counter() - t0, gb(torch.cuda.max_memory_allocated())

    for _ in range(a.warmup):       # 워밍업(첫 실행 CUDA 초기화 노이즈 → 버림)
        one()
    for s in stats.values():        # 워밍업 후 컴포넌트 통계 초기화
        s["peak"] = 0
        s["calls"] = 0

    times, peaks = [], []
    for _ in range(a.runs):
        dt_s, peak = one()
        times.append(dt_s)
        peaks.append(peak)

    for h in handles:
        h.remove()

    overall_peak = max(peaks)
    avg_t = sum(times) / len(times)
    measured = {n: s for n, s in stats.items() if s["calls"] > 0}

    # 반복 컴포넌트(호출수 최대) = 디노이징 루프 / 전체 peak를 만든 컴포넌트
    rep_name, rep = max(measured.items(), key=lambda kv: kv[1]["calls"])
    top_name, _ = max(measured.items(), key=lambda kv: kv[1]["peak"])

    print("\n===== VRAM 단계별 프로파일 =====", flush=True)
    print(f"GPU: {torch.cuda.get_device_name(0)} ({card_gb}GB)  mode={a.mem_mode}  "
          f"{a.width}x{a.height} {a.steps}step", flush=True)
    print(f"로드 직후 GPU 상주: {resident0}GB", flush=True)
    print("컴포넌트별 forward 중 VRAM peak:", flush=True)
    for name, s in sorted(measured.items(), key=lambda kv: -kv[1]["peak"]):
        tag = "  ← 반복(속도 핵심)" if name == rep_name and rep["calls"] > 1 else ""
        if name == top_name:
            tag += "  ← 전체 peak"
        print(f"  {name:<16}: {gb(s['peak'])}GB  ({s['calls']}회){tag}", flush=True)
    print(f"전체 peak: {overall_peak}GB / 카드 {card_gb}GB → 초과분 {round(overall_peak - card_gb, 2)}GB", flush=True)
    print(f"생성 시간: 장당 {round(avg_t, 2)}s", flush=True)

    # ── 판정 ──
    print("\n----- 판정 -----", flush=True)
    if rep["calls"] > 1:
        loop_peak = gb(rep["peak"])
        if loop_peak < card_gb * 0.97:
            print(f"✅ 반복 루프({rep_name}) = {loop_peak}GB → 8GB에 들어옴. 전체 peak는 1회성({top_name}).", flush=True)
            print("   → 1회성 단계만 잡으면(인코더/VAE 오프로드·타일) '1024+8GB+빠름' 가능성 높음.", flush=True)
            print("   → RAM 모드 장당 시간이 이미 쓸만하면 추가작업 거의 없이 달성.", flush=True)
        else:
            print(f"⚠️ 반복 루프({rep_name}) = {loop_peak}GB로 8GB({card_gb})를 넘김 → 루프 자체가 안 들어옴.", flush=True)
            print("   → 1024 고수 시 오프로드 느림 감수, 또는 768로 양보 필요.", flush=True)
    else:
        print("판정 보류: 반복 컴포넌트(호출 2회 이상) 식별 실패. 컴포넌트 이름/구조 확인 필요.", flush=True)


if __name__ == "__main__":
    main()
