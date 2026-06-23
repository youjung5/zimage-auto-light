// ───────── API helpers ─────────
async function j(u) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(u, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  } finally {
    clearTimeout(t);
  }
}
async function post(u, b) {
  const r = await fetch(u, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b || {}),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}

// ───────── 상태 ─────────
let TAB = "gen",
  galFilter = "all",
  selRep = null,
  MODEL = { name: "Z-Image-Turbo", dtype: "uint4" };
let REPS = [],
  REPS_RAW = [],
  IMAGES = [],
  CONDS = [],
  selectedConfig = null;
let loaded = { gal: false, reps: false, cards: false, img: false }; // 첫 fetch 완료 여부 (로딩 스피너 표시용)
let repStore = {}; // 한 번 본 레플리카는 계속 보관(누적) → 자리 고정·안 사라짐
let curImg = null,
  mPromptVal = "",
  mSeedVal = "",
  mReplicaVal = "",
  rdReplica = null,
  rdRange = "live";
let cond = { status: "all", sort: "name" };
let recentIds = [],
  recentMode = false; // 결과 버튼: 방금 생성한 이미지 id + NEW 배지 모드
let genWatching = false,
  genBaseline = new Set(); // 생성 완료 감지(다량/job)용
let rdTimer = null; // 레플리카 모달 자동 갱신 타이머
let IMGTAB = [],
  imgCond = { type: "all", sort: "new" },
  imgScope = "run"; // 이미지 탭 상태 (scope: run=이번 실행 / all=전체)

// ───────── 탭 ─────────
function show(v) {
  TAB = v;
  document.getElementById("vGen").hidden = v !== "gen";
  document.getElementById("vDash").hidden = v !== "dash";
  document.getElementById("vImg").hidden = v !== "img";
  document.getElementById("vDocs").hidden = v !== "docs";
  document.getElementById("tGen").classList.toggle("on", v === "gen");
  document.getElementById("tDash").classList.toggle("on", v === "dash");
  document.getElementById("tImg").classList.toggle("on", v === "img");
  document.getElementById("tDocs").classList.toggle("on", v === "docs");
  if (v === "dash") reloadReplicas();
  if (v === "img") loadImgTab();
  if (v === "docs") {
    if (!document.querySelector("#docsBody .d-sec.on")) showDoc("intro");
  }
}
// 사용법: 왼쪽 목차(리모콘) 클릭 → 해당 섹션으로 스크롤 / 스크롤 시 현재 섹션 목차 강조
function showDoc(id, btn) {
  document
    .querySelectorAll("#docsBody .d-sec")
    .forEach((s) => s.classList.toggle("on", s.id === "docsec-" + id));
  const btns = [...document.querySelectorAll(".d-toc button")];
  btns.forEach((b) => b.classList.remove("on"));
  (btn || btns.find((b) => b.dataset.t === id) || btns[0]).classList.add("on");
  const sc = document.getElementById("docsBody");
  if (sc) sc.scrollTop = 0;
}

// ───────── MANUAL 접기 (접으면 REPLICAS가 flex로 늘어남) ─────────
function toggleManual() {
  const b = document.getElementById("manualBody"),
    t = document.getElementById("manualToggle");
  const open = b.style.display !== "none";
  b.style.display = open ? "none" : "block";
  t.classList.toggle("collapsed", open);
}

// ───────── CONFIG 토글 + 검색 ─────────
function toggleFile() {
  const on = document.getElementById("useFile").checked;
  document.getElementById("prompt").classList.toggle("disabled-soft", on);
  document.getElementById("condSearch").classList.toggle("disabled-soft", !on);
  if (!on) {
    document.getElementById("condDD").classList.remove("on");
  }
}
function filterConds() {
  const q = document.getElementById("condInput").value.toLowerCase();
  const dd = document.getElementById("condDD");
  const list = CONDS.filter((f) => f.toLowerCase().includes(q));
  dd.innerHTML = list.length
    ? list
        .map(
          (f) =>
            `<div class="cond-opt" onclick="pickConfig('${f}')">${f}</div>`,
        )
        .join("")
    : '<div class="cond-opt" style="color:var(--text-dim)">파일 없음</div>';
  dd.classList.add("on");
}
function pickConfig(f) {
  selectedConfig = f;
  document.getElementById("condInput").value = f;
  document.getElementById("condDD").classList.remove("on");
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#condSearch"))
    document.getElementById("condDD")?.classList.remove("on");
});

// ───────── 폼 검증 ─────────
function clearInvalid() {
  ["prompt", "w", "h", "steps", "count", "condInput"].forEach((id) =>
    document.getElementById(id)?.classList.remove("invalid"),
  );
}
function validate() {
  clearInvalid();
  const bad = [];
  const on = document.getElementById("useFile").checked;
  const w = +document.getElementById("w").value,
    h = +document.getElementById("h").value;
  const st = +document.getElementById("steps").value,
    ct = +document.getElementById("count").value;
  if (on) {
    if (!selectedConfig) {
      bad.push("condInput");
    }
  } else {
    if (!document.getElementById("prompt").value.trim()) bad.push("prompt");
  }
  if (!(w >= 256 && w <= 2048)) bad.push("w");
  if (!(h >= 256 && h <= 2048)) bad.push("h");
  if (!(st >= 1)) bad.push("steps");
  if (!(ct >= 1)) bad.push("count");
  bad.forEach((id) => document.getElementById(id).classList.add("invalid"));
  return bad;
}
function formMsg(cls, txt) {
  const m = document.getElementById("formMsg");
  m.className = "form-msg " + cls;
  m.textContent = txt;
}

// ───────── 생성 ─────────
let generating = false;
async function captureBaseline() {
  // 생성 직전의 MANUAL 이미지 id 집합 (방금 만든 것 추려내기용)
  try {
    const imgs = await j("/api/images?source=manual&limit=500");
    return new Set((imgs || []).map((m) => m.id));
  } catch (e) {
    return new Set();
  }
}
async function doGenerate() {
  if (generating) return; // 연타 방지
  const bad = validate();
  if (bad.length) {
    formMsg("err", "입력 내용을 확인해주세요.");
    return;
  }
  formMsg("", "");
  document.getElementById("formMsg").className = "form-msg"; // 검증 통과 → 이전 안내문구 제거
  const btn = document.getElementById("genBtn");
  const resBtn = document.getElementById("resultBtn");
  generating = true;
  btn.disabled = true;
  btn.textContent = "생성 중...";
  resBtn.disabled = true;
  resBtn.classList.remove("ready"); // 새 생성 시작 → 결과 버튼 잠금
  genBaseline = await captureBaseline();
  const on = document.getElementById("useFile").checked;
  const ct = +document.getElementById("count").value;
  try {
    let res;
    // 전체 레플리카 일괄 생성(브로드캐스트): 명령만 보내고 각 노드가 비동기로 각자 ct장 생성.
    if (document.getElementById("bcastAll").checked) {
      const seedv = document.getElementById("seed").value.trim();
      const body = on
        ? { count: ct, conditions_file: selectedConfig, random_pick: true }
        : {
            count: ct,
            prompt: document.getElementById("prompt").value.trim(),
            width: +document.getElementById("w").value,
            height: +document.getElementById("h").value,
            num_inference_steps: +document.getElementById("steps").value,
            guidance_scale: 0.0,
            seed: seedv === "" ? null : +seedv,
          };
      res = await post("/api/broadcast", body);
      if (!res.ok) {
        formMsg("err", (res.data && res.data.detail) || "전체 생성 요청 실패");
        endGenerate();
        return;
      }
      formMsg(
        "warn",
        "전체 레플리카에 생성 명령을 보냈습니다 — 각 노드가 곧 각자 " +
          ct +
          "장 생성합니다. (진행 중인 노드는 건너뜀)",
      );
      endGenerate();
      setTimeout(() => {
        formMsg("", "");
        document.getElementById("formMsg").className = "form-msg";
      }, 3000);
      poll();
      return;
    }
    if (on) {
      res = await post("/api/job/start", {
        count: ct,
        conditions_file: selectedConfig,
        random_pick: true,
      });
    } else {
      const seedv = document.getElementById("seed").value.trim();
      res = await post("/api/generate", {
        prompt: document.getElementById("prompt").value.trim(),
        width: +document.getElementById("w").value,
        height: +document.getElementById("h").value,
        num_inference_steps: +document.getElementById("steps").value,
        guidance_scale: 0.0,
        seed: seedv === "" ? null : +seedv,
        count: ct,
      });
    }
    if (!res.ok) {
      if (res.status === 409)
        formMsg(
          "warn",
          res.data.detail ||
            "진행 중인 작업이 있습니다. 일시중지 후 취소하신 다음 다시 진행해주세요.",
        );
      else formMsg("err", res.data.detail || "생성 요청 실패");
      endGenerate();
      return;
    }
    // 단일(single) = 응답 시점에 이미 완료 / 다량·CONFIG(job) = 백그라운드 → poll이 완료 감지
    if (!on && ct <= 1 && res.data && res.data.mode === "single") {
      await finishGenerate();
    } else {
      genWatching = true; // 생성 버튼은 계속 '생성 중...' 유지, renderJob이 완료 감지
    }
    poll();
  } catch (e) {
    formMsg("err", "생성 요청 실패");
    endGenerate();
  }
}
function endGenerate() {
  // 생성 버튼 원복 (완료/실패 공통)
  generating = false;
  genWatching = false;
  const btn = document.getElementById("genBtn");
  btn.disabled = false;
  btn.textContent = "생성";
}
async function finishGenerate() {
  // 완료 처리: 방금 만든 MANUAL id 계산 → 결과 버튼 활성
  let cur = [];
  try {
    cur = await j("/api/images?source=manual&limit=500");
  } catch (e) {
    cur = [];
  }
  recentIds = (cur || [])
    .filter((m) => !genBaseline.has(m.id))
    .map((m) => m.id);
  endGenerate();
  const resBtn = document.getElementById("resultBtn");
  if (recentIds.length) {
    resBtn.disabled = false;
    resBtn.classList.add("ready");
  }
  formMsg("warn", "생성이 완료되었습니다.");
  setTimeout(() => {
    formMsg("", "");
    document.getElementById("formMsg").className = "form-msg";
  }, 2500);
  poll();
}
// 결과 버튼: MANUAL 필터로 전환 + 방금 만든 것 NEW 배지
function showResult() {
  if (!recentIds.length) return;
  recentMode = true;
  selRep = null;
  galFilter = "manual";
  [...document.getElementById("galSeg").children].forEach((b) =>
    b.classList.toggle("on", b.dataset.f === "manual"),
  );
  updateGalFilter();
  poll();
}

// ───────── 잡 제어 ─────────
async function jobCtrl(a) {
  await post("/api/job/" + a, {});
  poll();
}

// ───────── 타겟 제어 모달 (pause/resume/cancel) ─────────
// 제어 버튼 → 대상 레플리카 목록 모달(체크박스·전체선택·검색) → 확인 시 /api/control 로 명령.
// 대상 상태: pause=running만 / resume=paused만 / cancel=running·paused.
let ctrlAction = null;
function openControlModal(action) {
  ctrlAction = action;
  const t = {
    pause: "일시중지할 레플리카 선택",
    resume: "재개할 레플리카 선택",
    cancel: "취소할 레플리카 선택",
  };
  document.getElementById("ctrlTitle").textContent =
    t[action] || "레플리카 선택";
  document.getElementById("ctrlSearch").value = "";
  document.getElementById("ctrlAll").checked = false;
  renderCtrlList();
  document.getElementById("ctrlModal").classList.add("on");
}
function closeCtrlModal() {
  document.getElementById("ctrlModal").classList.remove("on");
  ctrlAction = null;
}
function ctrlCandidates() {
  // 설계: 일시중지=동작 중(running) 대상 / 재개·취소=일시중지한 것(paused)만 대상
  const ok =
    { pause: ["running"], resume: ["paused"], cancel: ["paused"] }[
      ctrlAction
    ] || [];
  return repsList().filter((r) => !r._stale && ok.includes(r.job_state));
}
function renderCtrlList() {
  const q = (document.getElementById("ctrlSearch").value || "").toLowerCase();
  const list = ctrlCandidates().filter((r) =>
    (r.replica || "").toLowerCase().includes(q),
  );
  const el = document.getElementById("ctrlList");
  if (!list.length) {
    el.innerHTML = '<div class="ctrl-empty">대상 레플리카가 없습니다</div>';
    document.getElementById("ctrlAll").checked = false;
    return;
  }
  el.innerHTML = list
    .map(
      (r) =>
        `<label class="ctrl-item"><input type="checkbox" class="ctrl-cb" value="${r.replica}"><span class="switch"></span><span class="rid">${r.replica}</span><span class="ctrl-st ${r.job_state === "running" ? "c-running" : "c-paused"}">${(r.job_state || "").toUpperCase()}</span></label>`,
    )
    .join("");
}
function toggleCtrlAll() {
  const on = document.getElementById("ctrlAll").checked;
  document.querySelectorAll("#ctrlList .ctrl-cb").forEach((cb) => {
    cb.checked = on;
  });
}
async function confirmCtrl() {
  const targets = [
    ...document.querySelectorAll("#ctrlList .ctrl-cb:checked"),
  ].map((cb) => cb.value);
  if (!targets.length) {
    alert("대상 레플리카를 먼저 선택해주세요.");
    return;
  } // 조용히 닫지 않음 — 선택 여부를 명확히
  const action = ctrlAction;
  const r = await post("/api/control", { targets, action });
  if (!r || !r.ok) {
    alert("명령 전송에 실패했습니다.");
    return;
  }
  closeCtrlModal();
  const label =
    { pause: "일시중지", resume: "재개", cancel: "취소" }[action] || action;
  toast(
    `${targets.length}개 레플리카에 '${label}' 명령을 보냈어요. 적용까지 몇 초 걸릴 수 있어요`,
  );
  poll();
}
// 화면 하단 토스트 — 명령처럼 "보냈지만 반영에 시간이 걸리는" 동작의 안내용
let _toastTimer = null;
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}

// ───────── 폴링 ─────────
let polling = false;
async function poll() {
  if (polling) return; // 이전 poll이 아직 안 끝났으면 건너뜀 (요청 쌓임 방지)
  polling = true;
  try {
    if (!loaded.gal) renderGallery(); // 첫 로드 전(fetch 동안)엔 스피너 표시
    if (!loaded.reps) renderReplist();
    // 3개 요청을 동시에 쏜다(순차 대기 X) → 한 바퀴가 '제일 느린 1개' 시간으로 끝남
    const imgUrl =
      "/api/images?source=" +
      (galFilter === "all" ? "" : galFilter) +
      (selRep ? "&replica=" + encodeURIComponent(selRep) : "");
    const [s, imgs, reps] = await Promise.all([
      j("/api/status").catch(() => null),
      j(imgUrl).catch(() => null),
      j("/api/replicas_all").catch(() => null),
    ]);
    if (s) checkGenDone(s);
    if (imgs) {
      IMAGES = imgs;
      loaded.gal = true;
      renderGallery();
    }
    if (reps) {
      mergeReps(reps.replicas);
      loaded.reps = true;
      renderReplist();
      renderJob();
    }
    renderResources(); // reps 머지 후 호출 — /api/resources 폴링 제거(renderResources는 replicas_all 데이터만 사용)
  } finally {
    polling = false;
  }
}
// Job Status 표시: 레플리카 선택 시 그 레플리카, 선택 안 하면 전체 합계 (응답 1대 랜덤 표시 폐지)
function renderJob() {
  const map = {
    running: "RUNNING",
    paused: "PAUSED",
    done: "DONE",
    idle: "IDLE",
    cancelled: "CANCELLED",
    error: "ERROR",
    loading: "LOADING",
    dead: "DEAD",
  };
  const cls = {
    running: "s-running",
    paused: "s-paused",
    done: "s-done",
    idle: "s-idle",
    cancelled: "s-done",
    error: "s-error",
    loading: "s-loading",
    dead: "s-error",
  };
  const all = repsList(),
    alive = all.filter((r) => !r._stale);
  let state = "idle",
    completed = 0,
    total = 0;
  const scopeEl = document.getElementById("jobScope");
  if (selRep) {
    const r = all.find((x) => x.replica === selRep);
    // 죽은 레플리카는 heartbeat가 멈춰 job_state가 옛 'running'으로 굳어 있으므로 DEAD로 표시
    if (r) {
      state = r._stale ? "dead" : r.job_state || "idle";
      completed = r.job_completed || 0;
      total = r.job_total || 0;
    }
    if (scopeEl)
      scopeEl.innerHTML =
        "▸ " +
        selRep.slice(-5).toUpperCase() +
        ' <button class="gal-x" onclick="selReplica(null)">✕</button>';
  } else {
    completed = alive.reduce((a, r) => a + (r.job_completed || 0), 0);
    total = alive.reduce((a, r) => a + (r.job_total || 0), 0);
    if (alive.some((r) => r.job_state === "running")) state = "running";
    else if (alive.some((r) => r.job_state === "paused")) state = "paused";
    else if (alive.some((r) => r.job_state === "loading")) state = "loading";
    else if (total > 0 && completed >= total) state = "done";
    else state = "idle";
    if (scopeEl) scopeEl.textContent = "전체 레플리카 합계";
  }
  document.getElementById("jstate").textContent =
    map[state] || (state || "").toUpperCase();
  document.getElementById("jstate").className =
    "state-chip " + (cls[state] || "s-idle");
  document.getElementById("jc").textContent = total
    ? `${completed} / ${total}`
    : "–";
  document.getElementById("jbar").style.width =
    (total ? Math.round((completed / total) * 100) : 0) + "%";
  updateCtrlButtons(all);
}
// 버튼 활성화 규칙(설계): 일시중지=동작 중(running) 있을 때만 / 재개·취소=일시중지(paused) 있을 때만.
// → 처음엔 일시중지만 활성, 일시중지하면 재개·취소가 활성화된다.
function updateCtrlButtons(all) {
  const live = (all || repsList()).filter((r) => !r._stale);
  const hasRunning = live.some((r) => r.job_state === "running");
  const hasPaused = live.some((r) => r.job_state === "paused");
  const bp = document.getElementById("btnPause"),
    br = document.getElementById("btnResume"),
    bc = document.getElementById("btnCancel");
  if (bp) bp.disabled = !hasRunning;
  if (br) br.disabled = !hasPaused;
  if (bc) bc.disabled = !hasPaused;
}
// 수동 생성(생성 버튼) 완료 감지 → 결과 버튼 활성. 표시와 분리해 유지.
function checkGenDone(s) {
  if (
    genWatching &&
    s &&
    ["done", "idle", "cancelled", "error"].includes(s.state)
  ) {
    genWatching = false;
    finishGenerate();
  }
}
function renderResources() {
  const sc = document.getElementById("resScope");
  if (!selRep) {
    // 선택 안 했으면 아무 레플리카 자원도 보여주지 않는다(헷갈림 방지)
    if (sc) sc.textContent = "· 레플리카 선택 필요";
    setHTML(
      document.getElementById("resGrid"),
      '<div style="grid-column:1/-1;color:var(--text-dim);font-size:12px;padding:22px;text-align:center;line-height:1.5">REPLICAS에서 레플리카를 선택하면<br>그 레플리카의 자원이 표시됩니다</div>',
    );
    setHTML(document.getElementById("speedGrid"), "");
    return;
  }
  if (sc) sc.textContent = "· ▸ " + selRep.slice(-5).toUpperCase();
  const r = repsList().find((x) => x.replica === selRep);
  if (!r) return;
  const g = {
    vram_used_gb: r.vram_used_gb,
    vram_total_gb: r.vram_total_gb,
    ram_used_gb: r.ram_used_gb,
    ram_total_gb: r.ram_total_gb,
    util: r.util,
  };
  const peak = r.vram_peak_gb,
    lastGen = r.last_gen_s,
    avgS = r.avg_gen_s,
    minS = r.min_gen_s,
    maxS = r.max_gen_s;
  const lim = +document.getElementById("limitGen").value || null;
  const vover = lim && g.vram_used_gb != null && g.vram_used_gb > lim;
  const vp = g.vram_total_gb
    ? Math.min(100, (g.vram_used_gb / g.vram_total_gb) * 100)
    : 0;
  const rp = g.ram_total_gb
    ? Math.min(100, (g.ram_used_gb / g.ram_total_gb) * 100)
    : 0;
  setHTML(
    document.getElementById("resGrid"),
    `
    <div class="res ${vover ? "over" : ""}"><div class="rk">GPU VRAM</div><div class="rv">${g.vram_used_gb ?? "–"} <small>/ ${g.vram_total_gb ?? "–"} GB</small></div><div class="rbar"><i style="width:${vp}%"></i></div></div>
    <div class="res"><div class="rk">System RAM</div><div class="rv">${g.ram_used_gb ?? "–"} <small>/ ${g.ram_total_gb ?? "–"} GB</small></div><div class="rbar"><i style="width:${rp}%"></i></div></div>
    <div class="res"><div class="rk">GPU Util</div><div class="rv">${g.util ?? "–"} <small>%</small></div></div>
    <div class="res"><div class="rk">VRAM peak</div><div class="rv">${peak ?? "–"} <small>GB</small></div></div>`,
  );
  const f = (v) => (v == null ? "–" : v);
  setHTML(
    document.getElementById("speedGrid"),
    `
    <div class="sp"><div class="k">최근 생성</div><div class="v">${f(lastGen)}<small>s</small></div></div>
    <div class="sp"><div class="k">평균</div><div class="v">${f(avgS)}<small>s</small></div></div>
    <div class="sp"><div class="k">최단</div><div class="v">${f(minS)}<small>s</small></div></div>
    <div class="sp"><div class="k">최장</div><div class="v">${f(maxS)}<small>s</small></div></div>`,
  );
}
// 상태 → 점 색깔 (#4): 죽음 빨강 / 작업중 초록(기본) / 멈춤 노랑 / 끝남·기타 회색
function dotClass(r) {
  if (r._stale) return "dead";
  if (r._slow) return "slow";
  return (
    {
      running: "",
      paused: "paused",
      done: "done",
      idle: "done",
      cancelled: "done",
      error: "dead",
      loading: "loading",
    }[r.job_state] || ""
  );
}
// 키 기반 reconcile (#2): 통째로 다시 그리지 않고 있는 건 갱신·없어진 것만 제거 → 깜빡임 방지
function reconcile(container, items, keyOf, clsOf, htmlOf, onClickOf) {
  if (!items.length) {
    container.innerHTML =
      '<div class="recon-empty" style="color:var(--text-dim);font-size:12px;padding:14px;text-align:center;grid-column:1/-1">검색 결과 없음</div>';
    return;
  }
  const empty = container.querySelector(".recon-empty,.loading-box");
  if (empty) container.innerHTML = "";
  const esc = (s) => String(s).replace(/["\\]/g, (c) => "\\" + c);
  const keys = new Set();
  items.forEach((it) => {
    const k = keyOf(it);
    keys.add(k);
    let el = container.querySelector(':scope > [data-key="' + esc(k) + '"]');
    if (!el) {
      el = document.createElement("div");
      el.dataset.key = k;
      container.appendChild(el);
    }
    const cls = clsOf(it);
    if (el.className !== cls) el.className = cls;
    const html = htmlOf(it);
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
    el.onclick = onClickOf ? () => onClickOf(it) : null;
  });
  [...container.children].forEach((c) => {
    if (c.dataset.key !== undefined && !keys.has(c.dataset.key)) c.remove();
  });
}
// 폴링 패널용: 내용(html)이 실제로 바뀐 경우에만 갱신 → 매 사이클 통째 재생성/깜빡임 방지
function setHTML(el, html) {
  if (el && el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
}
// 로딩 스피너(천천히 도는 원 + 문구). 실제 내용이 오면 reconcile/reconcileThumbs가 알아서 걷어냄.
function loadingHTML(msg) {
  return (
    '<div class="loading-box"><div class="spinner"></div><span>' +
    msg +
    "</span></div>"
  );
}
// 레플리카 목록: 서버는 '살아있는 것만' 준다(죽은 건 집계에서 제외됨).
// 이번 응답에 없는 레플리카는 바로 지우지 않고 REP_GRACE_MS 동안 마지막 값을 유지한다.
// (서버가 status 파일을 쓰는 중이거나 2초 스냅샷 타이밍이 겹치면 한 사이클 잠깐 빠질 수 있는데,
//  그때마다 지우면 사라졌다 나타나는 깜빡임이 생기므로 유예를 둔다.)
// 진짜로 죽으면 서버가 계속 안 주므로 유예가 지나 자동 제거되고, 갱신 재개하면 다시 들어와 되살아난다.
const REP_GRACE_MS = 12000; // 폴링 3초 × 약 4사이클. 일시 누락은 무시, 오래 사라진 것만 제거
function mergeReps(list) {
  if (!Array.isArray(list)) return; // 응답이 이상하면 기존 유지(일시 깜빡임 방지)
  const t = Date.now();
  const seen = new Set();
  list.forEach((r) => {
    r._seen = t;
    repStore[r.replica] = r;
    seen.add(r.replica);
  });
  Object.keys(repStore).forEach((k) => {
    if (!seen.has(k) && t - (repStore[k]._seen || 0) > REP_GRACE_MS)
      delete repStore[k];
  });
}
// 화면용 목록: ID순 고정 정렬. 죽음 판정은 서버가 전담(여기서 재판정하지 않음).
// _slow(지연, 살아있음)만 서버 값을 그대로 쓴다.
function repsList() {
  return Object.values(repStore).sort((a, b) =>
    (a.replica || "").localeCompare(b.replica || ""),
  );
}
function renderReplist() {
  if (!loaded.reps) {
    setHTML(
      document.getElementById("replist"),
      loadingHTML("레플리카 불러오는 중"),
    );
    return;
  }
  const q = (document.getElementById("rq").value || "").toLowerCase();
  let list = repsList().filter((r) =>
    (r.replica || "").toLowerCase().includes(q),
  );
  reconcile(
    document.getElementById("replist"),
    list,
    (r) => r.replica,
    (r) => "repitem" + (selRep === r.replica ? " sel" : ""),
    (r) => `<span class="rid">${r.replica}</span>
      <span class="meta"><span class="dot ${dotClass(r)}"></span>${r.job_completed || 0}/${r.job_total || 0} · ${r.util ?? "–"}%</span>`,
    (r) => selReplica(r.replica),
  );
}
// 갤러리만 즉시 다시 받아온다 — 전체 poll의 겹침 방지 가드·순차 대기를 건너뛰어,
// 레플리카/필터 선택이 1~2분 밀리지 않고 바로 반영되게 한다(이미지 목록만 가볍게 fetch)
async function reloadGallery() {
  try {
    IMAGES = await j(
      "/api/images?source=" +
        (galFilter === "all" ? "" : galFilter) +
        (selRep ? "&replica=" + encodeURIComponent(selRep) : ""),
    );
    loaded.gal = true;
    renderGallery();
  } catch (e) {}
}
function selReplica(id) {
  selRep = id;
  recentMode = false;
  document.getElementById("repAll").classList.toggle("on", id === null);
  renderJob();
  renderResources(); // 선택 즉시 Job Status·Resources 반영(기존 repStore 데이터로)
  updateGalFilter();
  reloadGallery();
}
function setGalFilter(f, btn) {
  galFilter = f;
  recentMode = false;
  [...document.getElementById("galSeg").children].forEach((b) =>
    b.classList.remove("on"),
  );
  btn.classList.add("on");
  updateGalFilter();
  reloadGallery();
}
// 갤러리 상단 필터 라벨 + × (레플리카 선택 / 방금 생성)
function updateGalFilter() {
  const el = document.getElementById("galFilt");
  let label = "";
  if (recentMode) label = "방금 생성";
  else if (selRep) label = selRep.slice(-5).toUpperCase();
  if (!label) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    "▸ " +
    label +
    ' <button class="gal-x" onclick="clearGalFilter()">✕</button>';
}
function clearGalFilter() {
  selRep = null;
  recentMode = false;
  recentIds = []; // × → 레플리카/방금생성 해제 + NEW 배지 제거
  document.getElementById("repAll").classList.add("on");
  renderJob();
  renderResources();
  updateGalFilter();
  reloadGallery();
}
function renderGallery() {
  const el = document.getElementById("gallery");
  if (!loaded.gal) {
    setHTML(el, loadingHTML("이미지 불러오는 중"));
    return;
  }
  let list = IMAGES;
  if (recentMode) {
    // 방금 생성 모드: MANUAL을 최신순으로 (recentIds는 NEW 배지로 강조)
    list = [...IMAGES].sort((a, b) =>
      String(b.finished || b.created || "").localeCompare(
        String(a.finished || a.created || ""),
      ),
    );
  }
  if (!list.length) {
    el.innerHTML =
      '<div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:30px">이미지 없음</div>';
    return;
  }
  reconcileThumbs(el, list, (m) => recentMode && recentIds.includes(m.id));
}
// 썸네일 keyed reconcile: 이미 떠 있는 이미지는 그대로 두고(재로드 X), 새 것만 추가·사라진 것만 제거.
// 폴링마다 전체를 다시 그리지 않아 깜빡임 없음. 클릭은 메타 객체를 클로저로 잡아 재정렬에도 안전.
function reconcileThumbs(el, list, isNewFn) {
  [...el.children].forEach((n) => {
    if (!(n.dataset && n.dataset.id)) n.remove();
  }); // placeholder 등 제거
  const existing = {};
  [...el.children].forEach((n) => {
    existing[n.dataset.id] = n;
  });
  list.forEach((m, idx) => {
    let node = existing[m.id];
    if (node) {
      delete existing[m.id];
      const nb = node.querySelector(".new-badge");
      const want = !!(isNewFn && isNewFn(m));
      if (want && !nb) {
        const s = document.createElement("span");
        s.className = "new-badge";
        s.textContent = "NEW";
        node.insertBefore(s, node.firstChild);
      } else if (!want && nb) nb.remove();
    } else {
      node = document.createElement("div");
      node.className = "thumb";
      node.dataset.id = m.id;
      node.onclick = () => openImgObj(m);
      const isNew = !!(isNewFn && isNewFn(m));
      node.innerHTML = `${isNew ? '<span class="new-badge">NEW</span>' : ""}<div class="imgph" data-src="/api/images/${encodeURIComponent(m.id)}/thumb"></div><div class="cap"><span class="src">${(m.replica || "").slice(-5).toUpperCase()}</span><span class="mtag">${(m.png_sub || m.source || "").toUpperCase()}</span></div>`;
      loadImgBox(node.querySelector(".imgph")); // 새로 만든 박스만 로드
    }
    const cur = el.children[idx];
    if (cur !== node) el.insertBefore(node, cur || null); // 순서 맞추기 (이동은 재로드 아님)
  });
  Object.values(existing).forEach((n) => n.remove()); // 사라진 것 제거
}

// ───────── 이미지 로더 (불러오는 중 → 시간 더 걸림 → 다시 불러오기) ─────────
const LD_SLOW_MS = 8000; // 이 시간 넘게 로딩이면 "시간이 더 걸리고 있습니다"
const LD_FAIL_MS = 30000; // 이 시간 넘게 실패 반복이면 "다시 불러오기"
function loadImgBox(box, fit) {
  const src = box.dataset.src;
  if (!src) return;
  fit = fit || box.dataset.fit || "cover";
  box.innerHTML =
    '<div class="img-load"><span class="ld-msg">불러오는 중</span><span class="ld-dots"></span></div>';
  const t0 = Date.now();
  let slow = setTimeout(() => {
    const m = box.querySelector(".ld-msg");
    if (m) m.textContent = "시간이 더 걸리고 있습니다";
  }, LD_SLOW_MS);
  const img = new Image();
  img.onload = () => {
    clearTimeout(slow);
    box.innerHTML = "";
    img.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:" +
      fit +
      ";display:block";
    box.appendChild(img);
  };
  img.onerror = () => {
    // 아직 생성 안 된 이미지일 수 있어 재시도 — 재시도에만 캐시버스터(브라우저 캐시 무효화)를 붙인다
    if (Date.now() - t0 < LD_FAIL_MS) {
      setTimeout(() => {
        img.src = src + (src.includes("?") ? "&" : "?") + "_t=" + Date.now();
      }, 1500);
    } else {
      clearTimeout(slow);
      box.innerHTML =
        '<div class="img-fail" onclick="event.stopPropagation();loadImgBox(this.closest(\'.imgph,.imgph-big\'))">' +
        '<button class="img-reload" onclick="event.stopPropagation();loadImgBox(this.closest(\'.imgph,.imgph-big\'))"><svg class="ico"><use href="#i-reload"/></svg>다시 불러오기</button>' +
        '<div class="img-failsub">이미지를 불러오지 못했습니다. 잠시 후 다시 시도하거나, 네트워크·서비스 상태를 확인해주세요.</div></div>';
    }
  };
  // 썸네일(/thumb)은 immutable이라 캐시를 살려 두 번째부터 즉시 뜬다. 원본(/file)은 no-store라 어차피 매번 받음.
  img.src = src;
}
// 로딩 점 애니메이션 (.→..→...→ 반복) — 전역 1개 타이머
setInterval(() => {
  const d = [".", "..", "..."][Math.floor(Date.now() / 450) % 3];
  document.querySelectorAll(".ld-dots").forEach((e) => {
    e.textContent = d;
  });
}, 450);

// ───────── 이미지 모달 ─────────
function openImgObj(m) {
  if (!m) return;
  curImg = m;
  const box = document.getElementById("mImgBox");
  box.dataset.src = "/api/images/" + encodeURIComponent(m.id) + "/file";
  box.dataset.fit = "contain";
  loadImgBox(box, "contain");
  document.getElementById("mPrompt").textContent = m.prompt || "(없음)";
  mPromptVal = m.prompt || "";
  document.getElementById("mSeed").textContent = m.seed ?? "–";
  mSeedVal = String(m.seed ?? "");
  document.getElementById("mSize").textContent =
    `${m.width}×${m.height} · ${m.steps}`;
  document.getElementById("mModel").textContent =
    `${MODEL.name} ${MODEL.dtype}`;
  const type = (m.png_sub || m.source || "").toUpperCase();
  document.getElementById("mType").textContent = type;
  // CONFIG 줄: AUTO일 때만
  const cl = document.getElementById("mConfigLine");
  if (type === "AUTO" && m.config_file) {
    cl.style.display = "";
    document.getElementById("mConfig").textContent = m.config_file;
  } else cl.style.display = "none";
  // #8 RUN: 자동 생성된 이름(auto- 접두어)이면 표시
  const run = m.run_id || "–";
  document.getElementById("mRun").innerHTML =
    run +
    (String(run).startsWith("auto-")
      ? ' <span class="def">자동 생성</span>'
      : "");
  document.getElementById("mReplica").textContent = m.replica || "–";
  mReplicaVal = m.replica || "";
  // #10 시간: 시작 / 종료 / 걸린 시간 (구버전 메타는 created로 폴백)
  const fmt = (t) => (t ? String(t).replace("T", " ") : "–");
  document.getElementById("mStarted").textContent = fmt(m.started || m.created);
  document.getElementById("mFinished").textContent = fmt(
    m.finished || m.created,
  );
  document.getElementById("mElapsed").textContent =
    m.elapsed_s != null ? Math.round(m.elapsed_s * 1000) / 1000 + "s" : "–";
  document.getElementById("mFile").textContent = m.id + ".png";
  // #9 경로: 컨테이너 경로 + 저장소 안 위치(마운트는 /workspace 하나, 그 밑 outputs/)
  const cpath =
    m.png || "/workspace/outputs/" + (m.png_sub || "?") + "/" + m.id + ".png";
  const cloud = cpath.replace(/^\/workspace\//, ""); // 마운트된 /workspace 저장소 안에서의 경로(outputs/…)
  document.getElementById("mPathContainer").textContent = cpath;
  document.getElementById("mPathCloud").textContent = cloud;
  const sz = m.size_bytes
    ? (m.size_bytes / 1024 / 1024).toFixed(1) + "MB"
    : "–";
  document.getElementById("mSizeVal").textContent = sz;
  document.getElementById("imgModal").classList.add("on");
}
function closeImg() {
  document.getElementById("imgModal").classList.remove("on");
}
function copyText(t) {
  navigator.clipboard?.writeText(t);
}
function downloadImg() {
  if (!curImg) return;
  const a = document.createElement("a");
  a.href = "/api/images/" + encodeURIComponent(curImg.id) + "/file";
  a.download = curImg.id + ".png";
  a.click();
}
function viewReplica(id) {
  closeImg();
  show("dash");
  openReplicaModal(id);
}

// ───────── 이미지 탭 ─────────
async function loadImgTab() {
  if (!loaded.img) renderImgTab(); // 첫 로드 전(fetch 동안)엔 스피너 표시
  try {
    IMGTAB = (await j(`/api/images?scope=${imgScope}&limit=1000`)) || [];
    loaded.img = true;
  } catch (e) {
    IMGTAB = [];
  }
  bindSegment("iSegType", imgCond, "type", renderImgTab);
  bindSegment("iSegSort", imgCond, "sort", renderImgTab);
  renderImgTab();
}
// 보기 범위 토글: 이번 실행(run) / 전체(all) — scope가 바뀌면 서버에서 다시 받아옴
function setImgScope(scope, btn) {
  if (imgScope === scope) return;
  imgScope = scope;
  [...document.getElementById("imgScopeSeg").children].forEach((x) =>
    x.classList.toggle("on", x.dataset.s === scope),
  );
  loadImgTab();
}
// 세그먼트 토글 공용 바인더: 클릭한 버튼만 on, stateObj[key]에 값 저장 후 render() 호출.
function bindSegment(segId, stateObj, key, render) {
  [...document.getElementById(segId).children].forEach(
    (b) =>
      (b.onclick = () => {
        [...document.getElementById(segId).children].forEach((x) =>
          x.classList.remove("on"),
        );
        b.classList.add("on");
        stateObj[key] = b.dataset.v;
        render();
      }),
  );
}
function imgVal(id) {
  return (document.getElementById(id)?.value || "").trim();
}
function imgCondBadge() {
  let n = 0;
  if (imgCond.type !== "all") n++;
  if (imgCond.sort !== "new") n++;
  ["iqPrompt", "iqSeed", "iqReplica", "iqConfig"].forEach((id) => {
    if (imgVal(id)) n++;
  });
  return n;
}
function renderImgTab() {
  if (!loaded.img) {
    setHTML(
      document.getElementById("imgGrid"),
      loadingHTML("이미지 불러오는 중"),
    );
    return;
  }
  const q = imgVal("iq").toLowerCase();
  const fP = imgVal("iqPrompt").toLowerCase(),
    fS = imgVal("iqSeed"),
    fR = imgVal("iqReplica").toLowerCase(),
    fC = imgVal("iqConfig").toLowerCase();
  const f = (m) => ({
    prompt: (m.prompt || "").toLowerCase(),
    seed: String(m.seed ?? ""),
    replica: (m.replica || "").toLowerCase(),
    config: (m.config_file || "").toLowerCase(),
  });
  let list = IMGTAB.filter((m) => {
    if (imgCond.type !== "all" && (m.png_sub || m.source) !== imgCond.type)
      return false;
    const v = f(m);
    // 검색창: 빠른 자유 검색 (프롬프트·시드·레플리카·CONFIG 중 하나라도 포함)
    if (
      q &&
      !(
        v.prompt.includes(q) ||
        v.seed.includes(q) ||
        v.replica.includes(q) ||
        v.config.includes(q)
      )
    )
      return false;
    // 세부 조건: 입력한 것들 모두 만족(AND)
    if (fP && !v.prompt.includes(fP)) return false;
    if (fS && !v.seed.includes(fS)) return false;
    if (fR && !v.replica.includes(fR)) return false;
    if (fC && !v.config.includes(fC)) return false;
    return true;
  });
  const sorters = {
    new: (a, b) =>
      String(b.finished || b.created || "").localeCompare(
        String(a.finished || a.created || ""),
      ),
    old: (a, b) =>
      String(a.finished || a.created || "").localeCompare(
        String(b.finished || b.created || ""),
      ),
    seed: (a, b) => (a.seed || 0) - (b.seed || 0),
  };
  list.sort(sorters[imgCond.sort] || sorters.new);
  // 배지
  const n = imgCondBadge();
  const badge = document.getElementById("imgCondBadge");
  badge.textContent = n;
  badge.classList.toggle("hide", n === 0);
  document.getElementById("imgCount").textContent =
    `${list.length} / ${IMGTAB.length} 장`;
  const el = document.getElementById("imgGrid");
  if (!list.length) {
    el.innerHTML =
      '<div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:40px">이미지 없음</div>';
    return;
  }
  reconcileThumbs(el, list, null);
}
// 레플리카 모달 "더보기" → 이미지 탭으로 (그 레플리카로 세부 조건 필터)
function goImageTab(replica) {
  closeRd();
  show("img");
  ["iq", "iqPrompt", "iqSeed", "iqConfig"].forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.value = "";
  });
  const r = document.getElementById("iqReplica");
  if (r) r.value = replica ? replica.slice(-5) : ""; // 레플리카 세부 조건에 입력
  imgCond = { type: "all", sort: "new" };
  [...document.getElementById("iSegType").children].forEach((b) =>
    b.classList.toggle("on", b.dataset.v === "all"),
  );
  [...document.getElementById("iSegSort").children].forEach((b) =>
    b.classList.toggle("on", b.dataset.v === "new"),
  );
  setTimeout(renderImgTab, 50); // loadImgTab의 fetch 후 렌더 보장
}

// ───────── ⓘ 툴팁 ─────────
const TIPS = {
  type: "<b>AUTO</b> : 자동화 대량 생성\n<b>MANUAL</b> : UI 테스트 생성",
  run: "배포 시 RUN_ID로 지정한 실행 이름.\n같은 RUN_ID끼리 결과를 공유.\n지정 안 하면 자동 생성됨.",
  path: "<b>컨테이너</b> : 워크로드 안에서 보이는 전체 경로\n<b>저장소</b> : 마운트된 /workspace 저장소 안에서의 위치",
};
function tip(e, key) {
  e.stopPropagation();
  const t = document.getElementById("tip");
  if (t.classList.contains("on") && t.dataset.key === key) {
    t.classList.remove("on");
    return;
  }
  t.innerHTML = TIPS[key];
  t.dataset.key = key;
  t.classList.add("on");
  const r = e.target.getBoundingClientRect();
  t.style.left = Math.min(r.left, window.innerWidth - 260) + "px";
  t.style.top = r.bottom + 6 + "px";
}
document.addEventListener("click", (e) => {
  if (!e.target.classList.contains("info-i"))
    document.getElementById("tip")?.classList.remove("on");
});

// ───────── 다시 생성 ─────────
function askRegen() {
  const busy =
    document.getElementById("jstate").textContent === "RUNNING" ||
    document.getElementById("jstate").textContent === "PAUSED";
  document.getElementById("confirmText").innerHTML = busy
    ? "현재 진행 중인 작업이 있습니다. 지금 진행하면 <b>현재 작업을 취소</b>하고 이 설정으로 생성을 시작합니다."
    : "이 설정으로 생성을 시작합니다. 진행 버튼을 누르면 바로 시작됩니다.";
  document.getElementById("confirm").dataset.busy = busy ? "1" : "";
  document.getElementById("confirm").classList.add("on");
}
function closeConfirm() {
  document.getElementById("confirm").classList.remove("on");
}
async function doRegen() {
  const busy = document.getElementById("confirm").dataset.busy === "1";
  closeConfirm();
  if (!curImg) return;
  // 폼에 채우기 (CONFIG OFF, 직접 프롬프트)
  document.getElementById("useFile").checked = false;
  toggleFile();
  document.getElementById("prompt").value = curImg.prompt || "";
  document.getElementById("w").value = curImg.width;
  document.getElementById("h").value = curImg.height;
  document.getElementById("steps").value = curImg.steps;
  document.getElementById("seed").value = curImg.seed ?? "";
  document.getElementById("count").value = 1;
  closeImg();
  show("gen");
  if (busy) {
    await post("/api/job/cancel", {});
    await new Promise((r) => setTimeout(r, 1200));
  }
  doGenerate();
}

// ───────── 대시보드 ─────────
async function reloadReplicas() {
  try {
    if (!loaded.cards) renderCards(); // 첫 로드 전(fetch 동안)엔 스피너 표시
    const r = await j("/api/replicas_all");
    mergeReps(r.replicas);
    loaded.cards = true;
    renderSummary();
    renderCards();
  } catch (e) {}
}
function renderSummary() {
  const reps = repsList(); // 서버가 살아있는 레플리카만 준다(죽은 건 집계 제외)
  const st = { running: 0, paused: 0, done: 0, slow: 0 };
  reps.forEach((r) => {
    if (r._slow) {
      st.slow++;
      return;
    }
    if (r.job_state === "running") st.running++;
    else if (r.job_state === "paused") st.paused++;
    else st.done++;
  });
  const totGen = reps.reduce((a, r) => a + (r.generated || 0), 0);
  const totTp = Math.round(
    reps.reduce((a, r) => a + (r.throughput_hr || 0), 0),
  );
  const busyVals = reps.map((r) => r.busy_ratio).filter((v) => v != null);
  const avgBusy = busyVals.length
    ? Math.round(busyVals.reduce((a, b) => a + b, 0) / busyVals.length)
    : null;
  const utilVals = reps.map((r) => r.util).filter((v) => v != null);
  const avgUtil = utilVals.length
    ? Math.round(utilVals.reduce((a, b) => a + b, 0) / utilVals.length)
    : null;
  const ic = (id) => `<svg class="ico sum-ico"><use href="#${id}"/></svg>`;
  // 상태 분포 (running/paused/done/slow) — 아이콘+개수 칩
  const stateCell = (cls, icon, n) =>
    `<span class="st-pill ${cls}"><svg class="ico"><use href="#${icon}"/></svg>${n}</span>`;
  setHTML(
    document.getElementById("summary"),
    `
    <div class="sum"><div class="k">${ic("i-layers")}레플리카</div><div class="v">${reps.length}</div></div>
    <div class="sum"><div class="k">${ic("i-image")}총 생성 이미지</div><div class="v">${totGen}</div></div>
    <div class="sum sum-wide"><div class="k">${ic("i-activity")}상태</div>
      <div class="st-row">
        ${stateCell("run", "i-play", st.running)}
        ${stateCell("pau", "i-pause", st.paused)}
        ${stateCell("don", "i-check", st.done)}
        ${stateCell("slo", "i-activity", st.slow)}
      </div></div>
    <div class="sum"><div class="k">${ic("i-zap")}전체 시간당 생성</div><div class="v">${totTp} <small>장/h</small></div></div>
    <div class="sum"><div class="k">${ic("i-gauge")}평균 가동률</div><div class="v">${avgBusy ?? "–"} <small>%</small></div></div>
    <div class="sum"><div class="k">${ic("i-cpu")}평균 GPU Util</div><div class="v">${avgUtil ?? "–"} <small>%</small></div></div>`,
  );
}
function condBadgeCount() {
  let n = 0;
  if (cond.status !== "all") n++;
  if (cond.sort !== "name") n++;
  if (document.getElementById("cOver").checked) n++;
  return n;
}
function toggleCond() {
  document.getElementById("condPop").classList.toggle("on");
}
function renderCards() {
  if (!loaded.cards) {
    setHTML(
      document.getElementById("cards"),
      loadingHTML("레플리카 불러오는 중"),
    );
    return;
  }
  const q = (document.getElementById("dq").value || "").toLowerCase();
  const lim = +document.getElementById("limitDash").value || null;
  const overOnly = document.getElementById("cOver").checked;
  let list = repsList().filter((r) =>
    (r.replica || "").toLowerCase().includes(q),
  );
  if (cond.status !== "all")
    list = list.filter((r) => (r.job_state || "") === cond.status);
  if (overOnly && lim)
    list = list.filter((r) => r.vram_used_gb != null && r.vram_used_gb > lim);
  const sorters = {
    name: (a, b) => (a.replica || "").localeCompare(b.replica || ""),
    gen: (a, b) => (b.generated || 0) - (a.generated || 0),
    vram: (a, b) => (b.vram_used_gb || 0) - (a.vram_used_gb || 0),
    util: (a, b) => (b.util || 0) - (a.util || 0),
  };
  list.sort(sorters[cond.sort] || sorters.name);
  // 배지
  const n = condBadgeCount();
  const badge = document.getElementById("condBadge");
  badge.textContent = n;
  badge.classList.toggle("hide", n === 0);
  document.getElementById("dashCount").textContent =
    `${list.length} / ${repsList().length} 표시`;
  const cmap = {
    running: "c-running",
    done: "c-done",
    paused: "c-paused",
    idle: "c-done",
    cancelled: "c-done",
    error: "c-done",
    loading: "c-loading",
  };
  reconcile(
    document.getElementById("cards"),
    list,
    (r) => r.replica,
    (r) => {
      const over = lim && r.vram_used_gb != null && r.vram_used_gb > lim;
      return "rcard" + (over ? " over" : "");
    },
    (r) => {
      const over = lim && r.vram_used_gb != null && r.vram_used_gb > lim;
      const vt = r.vram_total_gb || 32;
      const vp = Math.min(100, ((r.vram_used_gb || 0) / vt) * 100);
      const slow = r._slow;
      return `<div class="top"><span class="rid">${r.replica}</span><span class="chip ${slow ? "c-slow" : cmap[r.job_state] || "c-done"}">${slow ? "SLOW" : (r.job_state || "").toUpperCase()}</span></div>
      <div class="rrow"><span class="lbl">GPU VRAM</span><span class="val ${over ? "over" : ""}">${r.vram_used_gb ?? "–"} <span style="color:var(--text-dim);font-size:11px">/ ${r.vram_total_gb ?? "–"} GB</span></span></div>
      <div class="rbar2"><i class="${over ? "over" : ""}" style="width:${vp}%"></i></div>
      <div class="rrow"><span class="lbl">GPU Util</span><span class="val">${r.util ?? "–"} %</span></div>
      <div class="rrow"><span class="lbl">생성</span><span class="val">${r.job_completed || 0} / ${r.job_total || 0}</span></div>
      <div class="rbar2"><i style="width:${r.job_total ? (r.job_completed / r.job_total) * 100 : 0}%"></i></div>`;
    },
    (r) => openReplicaModal(r.replica),
  );
  // 레플리카가 1개뿐이면 자동 선택해 상세 표시
  const _all = repsList();
  if (_all.length === 1 && !rdReplica) openReplicaModal(_all[0].replica);
}

// ───────── limit 적용 (생성탭) ─────────
function applyLimits() {
  renderResources();
}

// ───────── 레플리카 상세 모달 ─────────
// 갱신 상태 색. 원칙: "갱신이 멈춰도 정상인 건 죽은 레플리카·완료된 레플리카뿐."
//   그 외(running·paused·idle 등 살아있고 안 끝난 상태)는 하트비트가 계속 와야 정상 → age로 판단.
//   paused여도 컨테이너는 살아있으므로 갱신은 계속됨. 완료→작업 재개 시 다음 갱신에서 자동으로 초록 복귀.
// 우선순위: 죽음(빨강) > 완료(회색) > 갱신 지연 20~60s(노랑) > 정상(초록)
function ageInfo(r) {
  const age = r._age_s != null ? Math.round(r._age_s) : null;
  if (r._stale)
    return {
      cls: "dead",
      dot: "dead",
      txt: age != null ? `갱신 안 됨 · 마지막 ${age}초 전` : "갱신 안 됨",
    };
  if (r._slow)
    return {
      cls: "slow",
      dot: "slow",
      txt: age != null ? `응답 지연 · 마지막 ${age}초 전` : "응답 지연",
    };
  if (["done", "cancelled"].includes(r.job_state))
    return { cls: "done", dot: "done", txt: "갱신 종료" };
  // 여기부터는 살아있고 안 끝난 상태(paused 포함) → 갱신이 계속 와야 정상
  if (age != null && age >= 20)
    return { cls: "warn", dot: "paused", txt: `${age}초 전 갱신` };
  return { cls: "ok", dot: "", txt: age != null ? `${age}초 전 갱신` : "" };
}
function paintReplica(r) {
  const dead = r._stale;
  document.getElementById("rdId").textContent = r.replica;
  document.getElementById("rdChip").textContent = dead
    ? "DEAD"
    : (r.job_state || "").toUpperCase();
  document.getElementById("rdChip").className =
    "chip " +
    (dead
      ? "c-dead"
      : { running: "c-running", paused: "c-paused", loading: "c-loading" }[
          r.job_state
        ] || "c-done");
  const ai = ageInfo(r);
  document.getElementById("rdDot").className = "dot " + ai.dot;
  document.getElementById("rdAge").textContent = ai.txt;
  document.getElementById("rdLive").className = "live " + ai.cls;
  const vt = r.vram_total_gb || 32,
    rt = r.ram_total_gb || 64;
  setHTML(
    document.getElementById("gauges"),
    gauge(
      "GPU VRAM",
      r.vram_used_gb || 0,
      vt,
      "/ " + vt + " GB",
      limitDashVal() && r.vram_used_gb > limitDashVal(),
    ) +
      gauge("System RAM", r.ram_used_gb || 0, rt, "/ " + rt + " GB", false) +
      gauge("GPU Util", r.util || 0, 100, "%", false),
  );
  setHTML(
    document.getElementById("rdProgNum"),
    `${r.job_completed || 0} <span style="color:var(--text-dim);font-size:15px">/ ${r.job_total || 0}</span>`,
  );
  const pct = r.job_total
    ? Math.round((r.job_completed / r.job_total) * 100)
    : 0;
  document.getElementById("rdProgPct").textContent = pct + "%";
  document.getElementById("rdProgBar").style.width = pct + "%";
  // GPU 응답 배지 — dead면 status가 최신이 아니므로 숨김
  const gpuEl = document.getElementById("rdGpu");
  if (dead || r.gpu_ok == null) {
    gpuEl.textContent = "";
    gpuEl.className = "gpu-badge";
  } else if (r.gpu_ok) {
    gpuEl.textContent = "GPU 정상";
    gpuEl.className = "gpu-badge ok";
  } else {
    gpuEl.textContent = "GPU 이상";
    gpuEl.className = "gpu-badge bad";
  }
  // 취소/오류 사유
  const reasonEl = document.getElementById("rdReason");
  if (r.job_state === "cancelled") {
    reasonEl.textContent = `취소 — ${r.job_message || (r.job_completed || 0) + "장 후 취소"} (${r.job_completed || 0}/${r.job_total || 0})`;
    reasonEl.className = "rd-reason show cancelled";
  } else if (r.job_state === "error") {
    reasonEl.textContent = `오류 — ${r.job_message || "알 수 없음"}`;
    reasonEl.className = "rd-reason show err";
  } else {
    reasonEl.textContent = "";
    reasonEl.className = "rd-reason";
  }
  const f = (v) => (v == null ? "–" : v);
  const r1 = (v) => (v == null ? "–" : Math.round(v * 10) / 10); // 소수 첫째자리 반올림
  setHTML(
    document.getElementById("rdProgStats"),
    `
    <div class="ps"><div class="k">평균 생성</div><div class="v">${r1(r.avg_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">최단</div><div class="v">${r1(r.min_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">최장</div><div class="v">${r1(r.max_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">VRAM 평균</div><div class="v">${r1(r.vram_avg_gb)}<small>GB</small></div></div>
    <div class="ps"><div class="k">VRAM peak</div><div class="v">${r1(r.vram_peak_gb)}<small>GB</small></div></div>`,
  );
  // 작업 시간 — 시작 ●━[걸린시간]━● 종료 타임라인 하나
  const fdt = (t) => (t ? String(t).replace("T", " ") : null);
  const running = !r.job_finished;
  let durTxt = "–";
  if (r.job_elapsed_s != null) {
    durTxt = fmtDur(Math.max(0, Math.round(r.job_elapsed_s)));
  }
  setHTML(
    document.getElementById("rdJobTime"),
    !r.job_started
      ? '<div class="jt-empty">작업 기록 없음</div>'
      : `
    <div class="jt-rail">
      <span class="jt-dot start"></span>
      <span class="jt-line"><span class="jt-dur">${durTxt}</span></span>
      <span class="jt-dot end ${running ? "live" : ""}"></span>
    </div>
    <div class="jt-ends">
      <span class="jt-t">시작 ${fdt(r.job_started)}</span>
      <span class="jt-t">${running ? "진행 중" : "종료 " + fdt(r.job_finished)}</span>
    </div>`,
  );
  // 성능 분석 — 값 + 계산 근거 병기
  const upMin = r.uptime_s ? Math.round((r.uptime_s / 60) * 10) / 10 : null; // 가동시간(분)
  const genMin =
    r.gen_seconds_total != null
      ? Math.round((r.gen_seconds_total / 60) * 10) / 10
      : null; // 생성에 쓴 시간(분)
  // 시간당 생성은 이번 가동분(session_generated) 기준 — 총 생성량(generated)은 재시작 누적을 포함하므로 분리.
  const sgen = r.session_generated != null ? r.session_generated : r.generated;
  const perf = (
    k,
    val,
    unit,
    basis,
  ) => `<div class="pl-row"><div class="pl-k">${k}</div>
    <div class="pl-v">${val}<small>${unit}</small></div><div class="pl-basis">${basis}</div></div>`;
  setHTML(
    document.getElementById("rdPerf"),
    perf(
      "시간당 생성",
      f(r.throughput_hr),
      "장/h",
      sgen != null && upMin != null
        ? `${sgen}장 ÷ ${upMin}분 × 60 (이번 가동분)`
        : "데이터 부족",
    ) +
      perf("장당 평균", r1(r.avg_gen_s), "s", "최근 생성 표본 평균") +
      perf(
        "가동률",
        f(r.busy_ratio),
        "%",
        genMin != null && upMin != null
          ? `생성 ${genMin}분 ÷ 가동 ${upMin}분`
          : "데이터 부족",
      ) +
      perf(
        "이론 최대",
        f(r.throughput_max_hr),
        "장/h",
        r.avg_gen_s ? `3600초 ÷ 장당 ${r1(r.avg_gen_s)}s` : "데이터 부족",
      ) +
      perf("VRAM 효율", r1(r.vram_eff_gb), "GB/장", "장당 평균 VRAM peak"),
  );
  document.getElementById("rdMore").onclick = () => goImageTab(r.replica);
}
function fmtDur(s) {
  if (s < 60) return s + "초";
  const m = Math.floor(s / 60),
    ss = s % 60;
  if (m < 60) return m + "분 " + ss + "초";
  const h = Math.floor(m / 60);
  return h + "시간 " + (m % 60) + "분";
}
async function openReplicaModal(id) {
  rdReplica = id;
  rdRange = "live";
  let r = repsList().find((x) => x.replica === id);
  if (!r) {
    try {
      const d = await j("/api/replicas_all");
      r = (d.replicas || []).find((x) => x.replica === id);
    } catch (e) {}
  }
  if (!r) return;
  paintReplica(r);
  document.getElementById("rdPh").hidden = true;
  document.getElementById("rdBody").hidden = false;
  loadHistory();
  loadMini();
  if (rdTimer) clearInterval(rdTimer);
  rdTimer = setInterval(refreshReplicaModal, 3000); // 열려있는 동안 자동 갱신
}
async function refreshReplicaModal() {
  if (!rdReplica || document.getElementById("vDash").hidden) {
    clearInterval(rdTimer);
    rdTimer = null;
    return;
  }
  // 카드·요약과 동일한 출처(poll/reloadReplicas가 갱신하는 repStore)에서 읽어 값이 어긋나지 않게 한다
  const r = repsList().find((x) => x.replica === rdReplica);
  if (r) paintReplica(r);
  if (rdRange === "live") loadHistory(); // 실시간 범위면 시계열도 갱신
}
function limitDashVal() {
  return +document.getElementById("limitDash").value || null;
}
function closeRd() {
  rdReplica = null;
  var b = document.getElementById("rdBody");
  if (b) b.hidden = true;
  var p = document.getElementById("rdPh");
  if (p) p.hidden = false;
  if (rdTimer) {
    clearInterval(rdTimer);
    rdTimer = null;
  }
}
function setRange(r, btn) {
  rdRange = r;
  [...document.getElementById("tsToolbar").children].forEach((b) =>
    b.classList.remove("on"),
  );
  btn.classList.add("on");
  loadHistory();
}
async function loadHistory() {
  try {
    const d = await j(
      "/api/replica/" +
        encodeURIComponent(rdReplica) +
        "/history?range=" +
        rdRange,
    );
    setHTML(document.getElementById("tsChart"), sparkline(d.points || []));
  } catch (e) {
    setHTML(
      document.getElementById("tsChart"),
      '<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px">데이터 없음</div>',
    );
  }
}
async function loadMini() {
  try {
    const imgs = await j(
      "/api/images?replica=" + encodeURIComponent(rdReplica) + "&limit=6",
    );
    const mini = document.getElementById("rdMini");
    if (!imgs.length) {
      mini.innerHTML =
        '<div style="color:var(--text-dim);font-size:12px;padding:10px">이미지 없음</div>';
    } else {
      mini.innerHTML = imgs
        .map(
          (m) =>
            `<div class="imgph" data-src="/api/images/${encodeURIComponent(m.id)}/file"></div>`,
        )
        .join("");
      mini.querySelectorAll(".imgph").forEach((b) => loadImgBox(b));
    } // 모달 내 이미지는 클릭 안 됨(더보기로만)
  } catch (e) {}
}

// ───────── SVG 게이지 / 시계열 ─────────
function gauge(label, val, max, unit, danger) {
  const pct = max ? Math.min(100, (val / max) * 100) : 0,
    r = 34,
    c = 2 * Math.PI * r,
    off = c * (1 - pct / 100);
  const col = danger ? "#ff6b6b" : "url(#gg)";
  return `<div class="gauge"><div class="glabel">${label}</div>
    <svg width="86" height="86" viewBox="0 0 86 86">
      <defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9D4EFF"/><stop offset="1" stop-color="#B47AFF"/></linearGradient></defs>
      <circle cx="43" cy="43" r="${r}" stroke="rgba(255,255,255,.08)" stroke-width="7" fill="none"/>
      <circle cx="43" cy="43" r="${r}" stroke="${col}" stroke-width="7" fill="none" stroke-linecap="round"
        stroke-dasharray="${c}" transform="rotate(-90 43 43)"><animate attributeName="stroke-dashoffset" from="${c}" to="${off}" dur="0.9s" fill="freeze"/></circle>
      <text x="43" y="48" text-anchor="middle" font-family="Orbitron" font-size="16" fill="#fff">${Math.round(pct)}%</text>
    </svg><div class="gval" ${danger ? 'style="color:#ff6b6b"' : ""}>${val} <small>${unit}</small></div></div>`;
}
function sparkline(points) {
  if (!points || !points.length)
    return '<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px">데이터 없음</div>';
  const vals = points.map((p) => (p.vram == null ? 0 : p.vram));
  const W = 560,
    H = 120,
    max = Math.max(...vals, 1) * 1.15;
  const path = vals
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i / Math.max(1, vals.length - 1)) * W},${H - (v / max) * H}`,
    )
    .join(" ");
  const area = path + `L${W},${H}L0,${H}Z`;
  const lim = limitDashVal();
  let limLine = "";
  if (lim && lim < max) {
    const y = H - (lim / max) * H;
    limLine = `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#ff6b6b" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`;
  }
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:130px">
    <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(180,122,255,.35)"/><stop offset="1" stop-color="rgba(180,122,255,0)"/></linearGradient></defs>
    <path d="${area}" fill="url(#ag)"/><path d="${path}" fill="none" stroke="#B47AFF" stroke-width="2"/>${limLine}</svg>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-top:4px"><span>${points[0]?.t?.slice(-8) || ""}</span><span>GPU VRAM (GB)</span><span>now</span></div>`;
}

// ───────── 키보드 ─────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeImg();
    closeRd();
    closeConfirm();
  }
});

// ───────── 초기화 ─────────
async function init() {
  try {
    MODEL = await j("/api/model");
    document.getElementById("modelBadge").textContent = MODEL.dtype;
  } catch (e) {}
  try {
    const c = await j("/api/conditions");
    CONDS = c.files || [];
  } catch (e) {}
  bindSegment("segStatus", cond, "status", renderCards);
  bindSegment("segSort", cond, "sort", renderCards);
  poll();
  setInterval(() => {
    if (TAB === "gen") poll();
    else reloadReplicas();
  }, 3000);
}
init();

/* ===== 비교·활용 시나리오 JS — gcube-console(영업 셸)로 이관. 운영 페이지 미사용이라 주석 처리(2026-06-15). 복구하려면 이 블록주석 해제. =====
// ═══════════════════════════════════════════════════════════════════
// 비교 탭 (GPU 성능·비용 비교)
//  · 가격/정책: /api/gpu_profiles 에서 실제로 읽음 (gpu_profiles.json)
//  · 성능(STATS): 통계함 백엔드 구현 전이라 가데이터(placeholder). 통계함 완성 시 fetch로 교체.
// ═══════════════════════════════════════════════════════════════════
const CMP_MAX=4, CMP_MIN=2, CMP_DT=10000;
// ── 가데이터: 통계함(측정 성능). 키 = provider|model|mem_mode ──
// v10 실측 (batch1·1024×1024·8step·VRAM·Triton ON, 2026-06). spm=장당(초), vram=VRAM peak(GB).
// 같은 칩은 공급사 무관 동일 속도(gcube H100=RunPod H100로 검증) → spm은 공급사 공통.
// ⚠️ 4090은 gcube 측정값(throttle 의심)이라 잠정. 5060은 Tier3 공유라 변동(비혼잡 기준). 가격은 gpu_profiles.json.
const CMP_STATS = {
  "GCUBE|RTX 5060|VRAM":   {vram:8.46,err:3.0,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:24.0,n:40}},
  "GCUBE|RTX 5090|VRAM":   {vram:8.46,err:0.1,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:2.97,n:320}},
  "GCUBE|RTX 4090|VRAM":   {vram:8.46,err:0.5,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:4.56,n:40}},
  "GCUBE|A100 40GB|VRAM":  {vram:8.46,err:0.3,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:3.87,n:40}},
  "GCUBE|H100 80GB|VRAM":  {vram:8.48,err:0.3,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:1.68,n:40}},
  "RunPod|RTX 4090|VRAM":  {vram:8.46,err:0.5,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:4.56,n:40}},
  "RunPod|RTX 5090|VRAM":  {vram:8.46,err:0.1,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:2.97,n:40}},
  "RunPod|A100 80GB|VRAM": {vram:8.46,err:0.3,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:3.52,n:40}},
  "RunPod|H100 80GB|VRAM": {vram:8.48,err:0.3,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:1.67,n:40}},
  "Vast.ai|RTX 4090|VRAM": {vram:8.46,err:0.5,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:4.56,n:40}},
  "Vast.ai|RTX 5090|VRAM": {vram:8.46,err:0.1,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:2.97,n:40}},
  "Vast.ai|A100 80GB|VRAM":{vram:8.46,err:0.3,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:3.52,n:40}},
  "Vast.ai|H100 80GB|VRAM":{vram:8.48,err:0.3,dtype:'uint4',cond:{w:1024,h:1024,steps:8,gd:0.0,spm:1.67,n:40}}
};
let CMP_PROFILES=null, CMP_SRC={}, CMP_GPUS=[], CMP_loaded=false;
const CMP_sel=new Set(); let CMP_compareMode=false, CMP_cache=null;
let CMP_basis='actual', CMP_mode='count', CMP_condF={res:'ALL',step:'ALL',guid:'ALL'};
let CMP_pendRes='ALL', CMP_pendStep='ALL', CMP_pendGuid='ALL';
let CMP_mId=null, CMP_mBasis='actual', CMP_mMode='count', CMP_mTarget=CMP_DT, CMP_mCond={res:'ALL',step:'ALL',guid:'ALL'};
const cmpWon=n=>'₩'+Math.round(n).toLocaleString('ko-KR');
const cmpFnum=n=>Math.round(n).toLocaleString('ko-KR');
const cmpBill=b=>b==='minute'?'분 단위 과금':'시간 단위 과금';
function cmpSlug(s){return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'')||'p';}

async function cmpInit(){
  if(CMP_loaded){cmpRenderCatalog();return;}
  try{CMP_PROFILES=await j('/api/gpu_profiles');}catch(e){CMP_PROFILES={providers:[]};}
  CMP_build(); CMP_loaded=true; cmpShowSub('cat'); cmpRenderCatalog();
}
function CMP_build(){
  CMP_SRC={}; CMP_GPUS=[]; let i=0;
  ((CMP_PROFILES&&CMP_PROFILES.providers)||[]).forEach(p=>{
    const key=cmpSlug(p.provider);
    CMP_SRC[key]={label:(p.provider||'').toUpperCase(), cls:p.kind==='self'?'gcube':'ext'};
    (p.gpus||[]).forEach(gp=>{
      const sk=`${p.provider}|${gp.model}|${gp.mem_mode}`;
      const perf=CMP_STATS[sk]||{vram:0,err:0,dtype:'-',cond:{w:1024,h:1024,steps:8,gd:1.0,spm:2.0,n:0}};
      const bill=p.billing||{};
      CMP_GPUS.push({id:'gpu'+(i++),src:key,self:p.kind==='self',name:gp.model,mode:gp.mem_mode,
        price:gp.price_per_hour||0,base:bill.base_fee||0,storage:bill.storage_fee||0,
        billing:bill.unit||'hour',date:p.kind==='self'?null:(p.measured_at||null),
        vram:perf.vram,err:perf.err,dtype:perf.dtype,runs:perf.runs,cond:perf.cond});
    });
  });
}
function cmpCondStats(g){
  if(g.runs){const by={};g.runs.forEach(r=>{const gd=r.gd!=null?r.gd:1.0;const key=`${r.w}×${r.h}·${r.steps}·${gd}`;if(!by[key])by[key]={res:`${r.w}×${r.h}`,step:r.steps,guid:gd,n:0,t:0};by[key].n+=r.n;by[key].t+=r.spm*r.n;});
    Object.values(by).forEach(o=>{o.spm=o.t/o.n;o.iph=3600/o.spm;});
    const tot=Object.values(by).reduce((a,o)=>a+o.n,0);const aspm=Object.values(by).reduce((a,o)=>a+o.spm*o.n,0)/tot;
    return{by,all:{spm:aspm,iph:3600/aspm,n:tot}};}
  const c=g.cond||{w:0,h:0,steps:0,gd:1.0,spm:1,n:0};const gd=c.gd!=null?c.gd:1.0;const key=`${c.w}×${c.h}·${c.steps}·${gd}`;
  return{by:{[key]:{res:`${c.w}×${c.h}`,step:c.steps,guid:gd,spm:c.spm,iph:3600/c.spm,n:c.n}},all:{spm:c.spm,iph:3600/c.spm,n:c.n}};
}
function cmpEff(g,f){const cs=cmpCondStats(g);if(!f||f.res==='ALL')return cs.all;
  const ks=Object.values(cs.by).filter(o=>o.res===f.res&&(f.step==='ALL'||String(o.step)===String(f.step))&&(f.guid==='ALL'||String(o.guid)===String(f.guid)));
  if(!ks.length)return null;let n=0,t=0;ks.forEach(o=>{n+=o.n;t+=o.spm*o.n;});const spm=t/n;return{spm,iph:3600/spm,n};}
function cmpCompute(g,st,bss,m,t){let images,hours;
  if(bss==='actual'){images=st.n;hours=st.n*st.spm/3600;}
  else{if(m==='count'){images=t;hours=st.iph>0?images/st.iph:0;}else{hours=t;images=hours*st.iph;}}
  const bh=g.billing==='minute'?Math.ceil(hours*60)/60:Math.ceil(hours);const gpu=g.price*bh;const total=gpu+g.base+g.storage;
  return{images,hours,bh,gpu,total,cpp:images>0?total/images:0};}

function cmpRenderCatalog(){
  const card=g=>{const s=CMP_SRC[g.src];const st=cmpEff(g,{res:'ALL'});const c=cmpCompute(g,st,'pred','count',CMP_DT);
    const chip=g.mode==='VRAM'?'<span class="cmp-chip vram">VRAM</span>':'<span class="cmp-chip ram">RAM</span>';
    return `<div class="cmp-card ${s.cls} ${CMP_sel.has(g.id)?'sel':''}" onclick="cmpCardClick(event,'${g.id}')">
      <div class="cmp-ctop"><span class="cmp-cbx" onclick="event.stopPropagation();cmpSelect('${g.id}')">✓</span>
        <span class="cmp-badge ${s.cls}">${s.label}</span>${g.date?`<span class="cmp-cdate">${g.date} (KST)</span>`:''}</div>
      <div class="cmp-cname">${g.name} ${chip}</div>
      <div class="cmp-cpplab">원 / 장</div><div class="cmp-cppbig">${c.cpp.toFixed(1)}<small> 원</small></div>
      <div class="cmp-cppnote">1만 장 기준 예상 · ${cmpBill(g.billing)}</div>
      <div class="cmp-cfoot">장/시간 <b>${cmpFnum(st.iph)}</b> · 단가 <b>${cmpWon(g.price)}/h</b></div></div>`;};
  const grp=(label,self)=>{const items=CMP_GPUS.filter(g=>g.self===self);if(!items.length)return'';
    return `<div class="cmp-srcgroup"><div class="cmp-srclabel ${self?'gcube':'ext'}">${label}</div><div class="cmp-cards">${items.map(card).join('')}</div></div>`;};
  let html=grp('자사 (GCUBE)',true)+grp('경쟁사',false);
  if(!CMP_GPUS.length)html=`<div class="cmp-empty">등록된 GPU가 없습니다.<div class="e2">gpu_profiles.json 을 ⬆ 프로파일 불러오기로 업로드하거나 /workspace/ 에 넣고 ↻ 새로고침 하세요.</div></div>`;
  document.getElementById('cmpCatalog').innerHTML=html;
  document.getElementById('vCompare').classList.toggle('cmp-on',CMP_compareMode);
  const n=CMP_sel.size;
  document.getElementById('cmpModeBtn').classList.toggle('on',CMP_compareMode);
  document.getElementById('cmpSelCount').innerHTML=CMP_compareMode?`<b>${n}</b> / ${CMP_MAX} 선택`:'';
  document.getElementById('cmpAnaBtn').style.display=CMP_compareMode?'':'none';
  document.getElementById('cmpAnaBtn').disabled=n<CMP_MIN;
}
function cmpToggleCompare(){CMP_compareMode=!CMP_compareMode;if(!CMP_compareMode)CMP_sel.clear();cmpRenderCatalog();}
function cmpSelect(id){if(CMP_sel.has(id))CMP_sel.delete(id);else{if(CMP_sel.size>=CMP_MAX){cmpToast(`최대 ${CMP_MAX}개까지 비교할 수 있어요.`);return;}CMP_sel.add(id);}cmpRenderCatalog();}
function cmpCardClick(e,id){cmpOpenModal(id);}

async function cmpRefresh(){const b=document.getElementById('cmpRefreshBtn');b.style.opacity=.5;
  try{CMP_PROFILES=await j('/api/gpu_profiles');CMP_build();}catch(e){}
  b.style.opacity=1;cmpRenderCatalog();cmpToast('gpu_profiles.json · 통계를 다시 읽었어요.');}
function cmpImport(file){if(!file)return;const r=new FileReader();
  r.onload=async()=>{let obj;try{obj=JSON.parse(r.result);if(!obj||!Array.isArray(obj.providers))throw new Error('providers 배열이 없습니다');}
    catch(e){cmpToast('불러오기 실패: '+e.message);return;}
    const res=await post('/api/gpu_profiles',obj);
    if(res.ok){CMP_PROFILES=obj;CMP_build();CMP_sel.clear();cmpRenderCatalog();cmpToast('gpu_profiles.json 저장·반영 완료 (전체 레플리카 공유).');}
    else cmpToast('저장 실패: '+((res.data&&res.data.error)||res.status));};
  r.readAsText(file);document.getElementById('cmpFile').value='';}
function cmpExportProfiles(){const blob=JSON.stringify(CMP_PROFILES||{providers:[]},null,2);
  const b=new Blob([blob],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='gpu_profiles.json';a.click();
  cmpToast('gpu_profiles.json 내려받음 — 복구 시 /workspace/ 에 넣고 새로고침.');}

function cmpOpenModal(id){CMP_mId=id;CMP_mBasis='actual';CMP_mMode='count';CMP_mTarget=CMP_DT;CMP_mCond={res:'ALL',step:'ALL',guid:'ALL'};cmpRenderModal();document.getElementById('cmpOverlay').classList.add('show');}
function cmpCloseModal(){document.getElementById('cmpOverlay').classList.remove('show');}
function cmpMSet(k,v){if(k==='basis')CMP_mBasis=v;if(k==='mode')CMP_mMode=v;if(k==='res')CMP_mCond={res:v,step:'ALL',guid:'ALL'};if(k==='step'){CMP_mCond.step=v;CMP_mCond.guid='ALL';}if(k==='guid')CMP_mCond.guid=v;if(k==='target')CMP_mTarget=parseFloat((v||'').replace(/,/g,''))||0;cmpRenderModal();}
function cmpRenderModal(){
  const g=CMP_GPUS.find(x=>x.id===CMP_mId);const s=CMP_SRC[g.src];const cs=cmpCondStats(g);
  const st=cmpEff(g,CMP_mCond)||cs.all;const c=cmpCompute(g,st,CMP_mBasis,CMP_mMode,CMP_mTarget);
  const segs=[{l:'GPU 시간',v:c.gpu,col:'#B47AFF'},{l:'기본금',v:g.base,col:'#ffd580'},{l:'스토리지',v:g.storage,col:'#7fb3ff'}];
  const tot=segs.reduce((a,x)=>a+x.v,0)||1;const CC=2*Math.PI*52;let off=0;
  const arcs=segs.map(x=>{const len=x.v/tot*CC;const a=`<circle cx="70" cy="70" r="52" fill="none" stroke="${x.col}" stroke-width="20" stroke-dasharray="${len.toFixed(1)} ${(CC-len).toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}" transform="rotate(-90 70 70)"/>`;off+=len;return a;}).join('');
  const legend=segs.map(x=>`<div><span class="sw" style="background:${x.col}"></span>${x.l}<b>${(x.v/tot*100).toFixed(0)}%</b></div>`).join('');
  const resList=[...new Set(Object.values(cs.by).map(o=>o.res))];
  const stepList=[...new Set(Object.values(cs.by).filter(o=>CMP_mCond.res==='ALL'||o.res===CMP_mCond.res).map(o=>o.step))].sort((a,b)=>a-b);
  const guidList=[...new Set(Object.values(cs.by).filter(o=>(CMP_mCond.res==='ALL'||o.res===CMP_mCond.res)&&(CMP_mCond.step==='ALL'||String(o.step)===String(CMP_mCond.step))).map(o=>o.guid))].sort((a,b)=>a-b);
  const tip=CMP_mBasis==='actual'?`실측 누적 (${cmpFnum(c.images)}장)`:`${CMP_mMode==='count'?cmpFnum(CMP_mTarget)+'장':cmpFnum(CMP_mTarget)+'시간'} 가정`;
  const runs=g.runs?`<div class="cmp-mblock"><div class="cmp-h4">완료 실행 로그</div><div class="cmp-runlist">
    <div class="rr"><span>완료 시각</span><span>장수</span><span>초/장</span><span>조건</span></div>
    ${g.runs.map(r=>`<div class="rr"><b>${r.d}</b><b>${cmpFnum(r.n)}</b><b>${r.spm.toFixed(1)}s</b>${r.w}×${r.h} · ${r.steps}step</div>`).join('')}</div></div>`
    :`<div class="cmp-mblock"><div class="cmp-h4">측정 정보</div>
       <div class="cmp-kv"><span>측정 기준일</span><b>${g.date||'-'} (KST)</b></div>
       <div class="cmp-kv"><span>측정 표본</span><b>${cmpFnum((g.cond||{}).n||0)}장</b></div>
       <div class="cmp-kv"><span>가격 입력</span><b>달러가 → 원화 환산 입력</b></div></div>`;
  document.getElementById('cmpModal').innerHTML=`
    <div class="cmp-mhead"><span class="cmp-badge ${s.cls}">${s.label}</span><span class="cmp-mch">${g.name}</span>
      <span class="cmp-chip ${g.mode==='VRAM'?'vram':'ram'}">${g.mode}</span><button class="cmp-mclose" onclick="cmpCloseModal()">×</button></div>
    <div class="cmp-mctrl">
      <span class="cmp-lab">조건</span>
      <select onchange="cmpMSet('res',this.value)"><option value="ALL" ${CMP_mCond.res==='ALL'?'selected':''}>전체</option>${resList.map(r=>`<option value="${r}" ${CMP_mCond.res===r?'selected':''}>${r}</option>`).join('')}</select>
      <select onchange="cmpMSet('step',this.value)" ${CMP_mCond.res==='ALL'?'disabled':''}><option value="ALL">step 전체</option>${stepList.map(x=>`<option value="${x}" ${String(CMP_mCond.step)===String(x)?'selected':''}>${x} step</option>`).join('')}</select>
      <select onchange="cmpMSet('guid',this.value)" ${(CMP_mCond.res==='ALL'||CMP_mCond.step==='ALL')?'disabled':''}><option value="ALL">g 전체</option>${guidList.map(x=>`<option value="${x}" ${String(CMP_mCond.guid)===String(x)?'selected':''}>g ${x}</option>`).join('')}</select>
      <span class="cmp-vdiv"></span>
      <span class="cmp-lab">기준</span>
      <div class="cmp-seg"><button class="${CMP_mBasis==='actual'?'on':''}" onclick="cmpMSet('basis','actual')">실측</button><button class="${CMP_mBasis==='pred'?'on':''}" onclick="cmpMSet('basis','pred')">예측</button></div>
      <div class="cmp-seg"><button class="${CMP_mMode==='count'?'on':''}" ${CMP_mBasis!=='pred'?'disabled':''} onclick="cmpMSet('mode','count')">장 수</button><button class="${CMP_mMode==='time'?'on':''}" ${CMP_mBasis!=='pred'?'disabled':''} onclick="cmpMSet('mode','time')">시간</button></div>
      <input type="text" value="${CMP_mBasis==='pred'?(CMP_mMode==='count'?cmpFnum(CMP_mTarget):CMP_mTarget):''}" ${CMP_mBasis!=='pred'?'disabled':''} oninput="cmpMSet('target',this.value)" placeholder="${CMP_mMode==='count'?'장':'시간'}">
    </div>
    <div class="cmp-mgrid">
      <div class="cmp-donut"><div class="cmp-h4">비용 구성 · ${tip}</div>
        <svg width="140" height="140" viewBox="0 0 140 140"><circle cx="70" cy="70" r="52" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="20"/>${arcs}
          <text x="70" y="64" text-anchor="middle" fill="#fff" font-size="20" font-weight="700">${c.cpp.toFixed(1)}</text>
          <text x="70" y="82" text-anchor="middle" fill="#A0A0B0" font-size="10">원 / 장</text></svg>
        <div class="cmp-legend">${legend}<div style="border-top:1px solid var(--line);margin-top:6px;padding-top:6px">총비용<b>${cmpWon(c.total)}</b></div></div></div>
      <div><div class="cmp-h4">성능 · 신뢰도 <span style="opacity:.6;font-weight:400">(선택 조건 실측)</span></div>
        <div class="cmp-mstats">
          <div class="cmp-stat"><div class="l">초 / 장</div><div class="v">${st.spm.toFixed(1)}<small>s</small></div></div>
          <div class="cmp-stat"><div class="l">장 / 시간</div><div class="v">${cmpFnum(st.iph)}</div></div>
          <div class="cmp-stat"><div class="l">VRAM peak</div><div class="v">${(g.vram||0).toFixed(1)}<small>GB</small></div></div>
          <div class="cmp-stat"><div class="l">실패율</div><div class="v">${(g.err||0).toFixed(1)}<small>%</small></div></div>
          <div class="cmp-stat"><div class="l">표본</div><div class="v">${cmpFnum(st.n)}<small>장</small></div></div>
          <div class="cmp-stat"><div class="l">양자화</div><div class="v">${g.dtype||'-'}</div></div></div></div>
    </div>${runs}`;
}

function cmpShowSub(sub){document.getElementById('cmpSubCat').hidden=sub!=='cat';document.getElementById('cmpSubAna').hidden=sub!=='ana';document.getElementById('cmpSubScn').hidden=sub!=='scn';
  document.getElementById('cmpTcat').classList.toggle('on',sub==='cat');document.getElementById('cmpTana').classList.toggle('on',sub==='ana');document.getElementById('cmpTscn').classList.toggle('on',sub==='scn');
  if(sub==='ana')cmpRenderAnalysis();
  if(sub==='scn')uscInit();}
function cmpRunAnalysis(){CMP_cache={ids:[...CMP_sel]};CMP_basis='actual';CMP_mode='count';CMP_condF={res:'ALL',step:'ALL',guid:'ALL'};CMP_pendRes='ALL';CMP_pendStep='ALL';CMP_pendGuid='ALL';cmpShowSub('ana');}

// ===== 활용 시나리오 (usecase) — 비교 탭 서브탭. 숫자는 5.8 실측 기반 하드코딩(나중에 실통계 연동). =====
let USC_init=false;
function uscInit(){ if(USC_init)return; USC_init=true; concCalc(); bulkCalc(); flexCalc(); }
function showScn(id, btn){   // 활용 시나리오 내부 탭(동시/대량/구성) 전환
  document.querySelectorAll('#cmpSubScn .usc-body').forEach(function(e){e.style.display='none';});
  document.getElementById('scn-'+id).style.display='';
  document.querySelectorAll('#cmpSubScn .usc-tabs button').forEach(function(b){b.classList.remove('on');});
  btn.classList.add('on');
}
// --- 동시 사용자 ---
var concN = 5;
function concStep(d){ concN = Math.max(1, Math.min(12, concN+d)); concCalc(); }
function concCalc(){
  document.getElementById('conc-n').textContent = concN+'명';
  document.getElementById('conc-cnt').textContent = concN;
  document.getElementById('conc-slot').innerHTML = concN+'<small>명</small>';
  var us='';
  for(var i=1;i<=concN;i++) us += '<div class="usc-lane"><span class="usc-who">5090('+i+')</span><div class="usc-slot usc-go" style="width:31%"></div></div>';
  document.getElementById('conc-us').innerHTML = us;
  var seq='<div class="usc-lane"><span class="usc-who">H100</span><div class="usc-seq">';
  for(var j=1;j<=concN;j++) seq += '<i'+(j===1?' class="first"':'')+'>'+j+'</i>';
  seq += '</div></div>';
  document.getElementById('conc-them').innerHTML = seq;
  var done=(concN*1.67).toFixed(1), wait=((concN-1)*1.67).toFixed(1);
  document.getElementById('conc-done').innerHTML = '~'+done+'<small>초</small>';
  document.getElementById('conc-wait').innerHTML = '최대 '+wait+'<small>초</small>';
  document.getElementById('conc-them-axis').textContent = '순차 처리 · 마지막 사용자 약 '+done+'초';
  document.getElementById('conc-txt-done').textContent = '전원 ~3초 내 동시 처리';
}
// --- 대량 생성 ---
var bulkN = 10000;
function bulkStep(d){ bulkN = Math.max(1000, bulkN+d); bulkCalc(); }
function fmt(n){ return Math.round(n).toLocaleString(); }
function bulkCalc(){
  document.getElementById('bulk-n').textContent = bulkN.toLocaleString()+'장';
  document.getElementById('bulk-h3').textContent = '구성별 완료 시간 ('+bulkN.toLocaleString()+'장 기준)';
  var tH=bulkN/2158, t3=bulkN/3630, t5=bulkN/6050;
  var cH=bulkN*2.29, c3=bulkN*1.84, c5=bulkN*1.84;
  document.getElementById('b-h-bar').style.width='100%';  document.getElementById('b-h-bar').textContent=tH.toFixed(2)+'시간';
  document.getElementById('b-3-bar').style.width=(t3/tH*100).toFixed(0)+'%'; document.getElementById('b-3-bar').textContent=t3.toFixed(2)+'시간';
  document.getElementById('b-5-bar').style.width=(t5/tH*100).toFixed(0)+'%'; document.getElementById('b-5-bar').textContent=t5.toFixed(2)+'시간';
  document.getElementById('b-h-c').innerHTML=fmt(cH)+'원 · <small>2.29원/장</small>';
  document.getElementById('b-3-c').innerHTML=fmt(c3)+'원 · <small>1.84원/장</small>';
  document.getElementById('b-5-c').innerHTML=fmt(c5)+'원 · <small>1.84원/장</small>';
  document.getElementById('bulk-big').textContent = bulkN.toLocaleString()+'장 — 5090 ×5: 약 '+t5.toFixed(1)+'시간 / '+fmt(c5)+'원 (타사 H100 ×1: '+tH.toFixed(2)+'시간 / '+fmt(cH)+'원)';
}
// --- 구성 유연성 (목표 장수 기준 완료시간·총비용 비교) ---
var FX = {'5090':{tp:1210, price:2224}, 'A100':{tp:930, price:4273}};
var FXc = {'5090':2, 'A100':0};
var flexN = 10000;
var H100_TP = 2158, H100_CPP = 2.29;
function fxTime(h){ return h>=1 ? h.toFixed(2)+'<small>시간</small>' : Math.round(h*60)+'<small>분</small>'; }
function fxTimeStr(h){ return h>=1 ? h.toFixed(2)+'시간' : Math.round(h*60)+'분'; }
function flexNStep(d){ flexN = Math.max(1000, flexN+d); flexCalc(); }
function flexStep(g, d){ FXc[g]=Math.max(0, FXc[g]+d); document.getElementById('c-'+g).textContent=FXc[g]; flexCalc(); }
function flexCalc(){
  var tp=0, cost=0, parts=[];
  for(var g in FXc){ if(FXc[g]>0){ tp+=FXc[g]*FX[g].tp; cost+=FXc[g]*FX[g].price; parts.push(g+' ×'+FXc[g]); } }
  var cpp = tp>0 ? cost/tp : 0;
  document.getElementById('f-n').textContent = flexN.toLocaleString()+'장';
  document.getElementById('f-cfg').textContent = parts.join(' + ') || '없음';
  document.getElementById('f-tp').innerHTML = tp.toLocaleString()+'<small>장/h</small>';
  document.getElementById('f-cost').innerHTML = cost.toLocaleString()+'<small>원/h</small>';
  document.getElementById('f-cpp').innerHTML = (cpp? cpp.toFixed(2):'–')+'<small>원</small>';
  // 타사 H100 — 목표 장수 기준
  var hTime=flexN/H100_TP, hTotal=Math.round(flexN*H100_CPP);
  document.getElementById('h-time').innerHTML = fxTime(hTime);
  document.getElementById('h-total').innerHTML = hTotal.toLocaleString()+'<small>원</small>';
  var big = document.getElementById('f-big');
  if(tp===0){
    document.getElementById('f-time').innerHTML='–'; document.getElementById('f-total').innerHTML='–';
    big.textContent='GPU를 1대 이상 선택하세요'; return;
  }
  // GCUBE — 목표 장수 기준 (대수↑ → 완료 빨라짐, 총비용은 이미지당×장수)
  var gTime=flexN/tp, gTotal=Math.round(flexN*cpp);
  document.getElementById('f-time').innerHTML = fxTime(gTime);
  document.getElementById('f-total').innerHTML = gTotal.toLocaleString()+'<small>원</small>';
  var diff = Math.round((1 - cpp/H100_CPP)*100);
  var lead = '목표 '+flexN.toLocaleString()+'장 — '+parts.join(' + ')+': '+fxTimeStr(gTime)+' / '+gTotal.toLocaleString()+'원  vs  H100: '+fxTimeStr(hTime)+' / '+hTotal.toLocaleString()+'원';
  lead += diff>=0 ? ' → '+(gTime<hTime?'더 빠르고 ':'')+'약 '+diff+'% 저렴'
                  : ' → H100보다 '+(-diff)+'% 비쌈 (A100 비중↑)';
  big.textContent = lead;
}
function cmpUOpts(field,res,step){const set=new Set();CMP_cache.ids.forEach(id=>Object.values(cmpCondStats(CMP_GPUS.find(g=>g.id===id)).by).forEach(o=>{
  if(field==='res'){set.add(o.res);return;}
  if(field==='step'){if(res==='ALL'||o.res===res)set.add(o.step);return;}
  if(field==='guid'){if((res==='ALL'||o.res===res)&&(step==='ALL'||String(o.step)===String(step)))set.add(o.guid);}}));return[...set].sort((a,b)=>a-b);}
function cmpCondGroup(){const stepOpts=cmpUOpts('step',CMP_pendRes),guidOpts=cmpUOpts('guid',CMP_pendRes,CMP_pendStep);
  document.getElementById('cmpCondGroup').innerHTML=
    `<select id="cmpResSel" onchange="cmpOnRes(this.value)"><option value="ALL" ${CMP_pendRes==='ALL'?'selected':''}>해상도 전체</option>${cmpUOpts('res').map(r=>`<option value="${r}" ${CMP_pendRes===r?'selected':''}>${r}</option>`).join('')}</select>`
   +`<select id="cmpStepSel" onchange="cmpOnStep(this.value)" ${CMP_pendRes==='ALL'?'disabled':''}><option value="ALL">step 전체</option>${stepOpts.map(s=>`<option value="${s}" ${String(CMP_pendStep)===String(s)?'selected':''}>${s} step</option>`).join('')}</select>`
   +`<select id="cmpGuidSel" onchange="CMP_pendGuid=this.value" ${(CMP_pendRes==='ALL'||CMP_pendStep==='ALL')?'disabled':''}><option value="ALL">guidance 전체</option>${guidOpts.map(x=>`<option value="${x}" ${String(CMP_pendGuid)===String(x)?'selected':''}>g ${x}</option>`).join('')}</select>`
   +`<button class="cmp-mini go" onclick="cmpApplyCond()">조회</button>`;}
function cmpOnRes(v){CMP_pendRes=v;CMP_pendStep='ALL';CMP_pendGuid='ALL';cmpCondGroup();}
function cmpOnStep(v){CMP_pendStep=v;CMP_pendGuid='ALL';cmpCondGroup();}
function cmpCondLabel(c){return c.res==='ALL'?'전체':c.res+(c.step==='ALL'?'':' · '+c.step+'step')+(c.guid==='ALL'||c.step==='ALL'?'':' · g'+c.guid);}
function cmpApplyCond(){CMP_condF={res:CMP_pendRes,step:CMP_pendStep,guid:CMP_pendGuid};cmpRecalc();cmpToast('조건 적용: '+cmpCondLabel(CMP_condF));}
function cmpReset(){CMP_basis='actual';CMP_mode='count';CMP_condF={res:'ALL',step:'ALL',guid:'ALL'};CMP_pendRes='ALL';CMP_pendStep='ALL';CMP_pendGuid='ALL';cmpRenderAnalysis();cmpToast('초기화 — 전체 조건 · 실측 기준');}
function cmpSetBasis(b){CMP_basis=b;cmpRenderAnalysis();}
function cmpSetMode(m){CMP_mode=m;cmpRenderAnalysis();}
function cmpGetTarget(){const el=document.getElementById('cmpTarget');return el?(parseFloat((el.value||'').replace(/,/g,''))||0):CMP_DT;}
function cmpToggleSave(e){e.stopPropagation();document.getElementById('cmpSaveMenu').classList.toggle('show');}

function cmpRenderAnalysis(){
  const box=document.getElementById('cmpAna');
  if(!CMP_cache){box.innerHTML=`<div class="cmp-empty">비교 분석 내용 없음<div class="e2">카탈로그에서 비교 모드를 켜고 ${CMP_MIN}개 이상 골라 "분석"을 눌러주세요.</div></div>`;return;}
  box.innerHTML=`<div class="cmp-ctrlbar">
    <span class="cmp-lab">조건</span><span id="cmpCondGroup" style="display:flex;gap:9px;align-items:center"></span>
    <span class="cmp-vdiv"></span>
    <span class="cmp-lab">기준</span>
    <div class="cmp-seg"><button class="${CMP_basis==='actual'?'on':''}" onclick="cmpSetBasis('actual')">실측</button><button class="${CMP_basis==='pred'?'on':''}" onclick="cmpSetBasis('pred')">예측</button></div>
    <div class="cmp-seg"><button class="${CMP_mode==='count'?'on':''}" ${CMP_basis!=='pred'?'disabled':''} onclick="cmpSetMode('count')">장 수</button><button class="${CMP_mode==='time'?'on':''}" ${CMP_basis!=='pred'?'disabled':''} onclick="cmpSetMode('time')">시간</button></div>
    <input id="cmpTarget" type="text" value="${CMP_basis==='pred'?(CMP_mode==='count'?'10,000':'10'):''}" ${CMP_basis!=='pred'?'disabled':''} oninput="cmpRecalc()" placeholder="${CMP_mode==='count'?'장':'시간'}">
    <span class="cmp-vdiv"></span>
    <button class="cmp-mini" onclick="cmpReset()">초기화</button>
    <span style="flex:1"></span>
    <div class="cmp-savewrap"><button class="cmp-mini" onclick="cmpToggleSave(event)">결과 저장 ▾</button>
      <div class="cmp-savemenu" id="cmpSaveMenu"><button onclick="cmpExport('csv')">CSV (.csv)</button><button onclick="cmpExport('json')">JSON (.json)</button></div></div></div>
  <div class="cmp-cmp" id="cmpCols"></div>
  <div class="cmp-chart"><h3>원 / 장 — 낮을수록 비용 효율이 높음</h3><div id="cmpBars"></div></div>`;
  cmpCondGroup();cmpRecalc();
}
function cmpRecalc(){
  const sel=CMP_cache.ids.map(id=>CMP_GPUS.find(g=>g.id===id)).filter(Boolean);const t=cmpGetTarget();
  const res=sel.map(g=>{const st=cmpEff(g,CMP_condF);return{g,st,...(st?cmpCompute(g,st,CMP_basis,CMP_mode,t):{cpp:null})};});
  const valid=res.filter(r=>r.st);const cpps=valid.map(r=>r.cpp);const min=cpps.length?Math.min(...cpps):0;
  const predHead=CMP_basis==='actual'?'실측 누적':'예측';
  const cols=document.getElementById('cmpCols');cols.style.gridTemplateColumns=`repeat(${sel.length}, minmax(0,1fr))`;
  cols.innerHTML=res.map(r=>{const s=CMP_SRC[r.g.src];
    if(!r.st)return `<div class="cmp-col ${s.cls}"><span class="cmp-badge ${s.cls}">${s.label}</span><div class="cmp-ch">${r.g.name}</div><div class="cmp-cs">${r.g.mode} 모드</div><div class="cmp-nodata">선택한 조건의<br>측정 데이터 없음</div></div>`;
    const best=r.cpp===min&&valid.length>1;
    const subt=CMP_basis==='actual'?`실제 ${cmpWon(r.total)} · ${r.hours.toFixed(1)}h · ${cmpFnum(r.images)}장`:`총 ${cmpWon(r.total)} · ${r.hours.toFixed(1)}h(과금 ${r.bh.toFixed(1)}h)`;
    const smallt=CMP_basis==='actual'?'지금까지 측정된 그대로':(CMP_mode==='count'?cmpFnum(t)+'장':cmpFnum(t)+'시간')+' 돌린다고 가정';
    return `<div class="cmp-col ${s.cls}"><span class="cmp-badge ${s.cls}">${s.label}</span>
      <div class="cmp-ch">${r.g.name}</div><div class="cmp-cs">${r.g.mode} 모드 · ${r.g.date?r.g.date+' (KST)':'실시간'}</div>
      <div class="cmp-pred"><div class="cmp-zhead pred"><span class="dot"></span>${predHead}<span class="sm">${smallt}</span></div>
        <div class="cmp-cpplab">원 / 장</div><div class="cmp-cpp ${best?'g':'n'}">${r.cpp.toFixed(1)}<small>원</small></div>
        <div class="cmp-psub">${subt}</div></div>
      <div><div class="cmp-zhead fact"><span class="dot"></span>실측<span class="sm">측정된 속도</span></div>
        <div class="cmp-r"><span>초/장</span><b>${r.st.spm.toFixed(1)}s</b></div>
        <div class="cmp-r"><span>장/시간</span><b>${cmpFnum(r.st.iph)}</b></div>
        <div class="cmp-r"><span>VRAM peak</span><b>${(r.g.vram||0).toFixed(1)} GB</b></div>
        <div class="cmp-r"><span>표본</span><b>${cmpFnum(r.st.n)}장</b></div></div></div>`;}).join('');
  const bm=cpps.length?Math.max(...cpps)*1.12:1;
  document.getElementById('cmpBars').innerHTML=res.map(r=>{if(!r.st)return `<div class="cmp-barrow"><span class="cmp-barlab">${CMP_SRC[r.g.src].label} ${r.g.name}</span><span class="cmp-bartrack"></span><span class="cmp-barval" style="opacity:.5">없음</span></div>`;
    const best=r.cpp===min&&valid.length>1;const col=best?'var(--green)':'var(--purple)';
    return `<div class="cmp-barrow"><span class="cmp-barlab">${CMP_SRC[r.g.src].label} ${r.g.name} <span style="opacity:.6">${r.g.mode}</span></span>
      <span class="cmp-bartrack"><span class="cmp-barfill" data-w="${(r.cpp/bm*100).toFixed(1)}" style="background:${col}"></span></span>
      <span class="cmp-barval" style="color:${col}">${r.cpp.toFixed(1)}원</span></div>`;}).join('');
  requestAnimationFrame(()=>document.querySelectorAll('.cmp-barfill').forEach(b=>b.style.width=b.dataset.w+'%'));
}
function cmpExport(fmt){const sel=CMP_cache.ids.map(id=>CMP_GPUS.find(g=>g.id===id));const t=cmpGetTarget();
  const rows=sel.map(g=>{const st=cmpEff(g,CMP_condF);if(!st)return{출처:CMP_SRC[g.src].label,GPU:g.name,모드:g.mode,비고:'선택조건 데이터없음'};const c=cmpCompute(g,st,CMP_basis,CMP_mode,t);
    return{출처:CMP_SRC[g.src].label,GPU:g.name,모드:g.mode,측정기준일:g.date||'실시간',조건:cmpCondLabel(CMP_condF),기준:CMP_basis==='actual'?'실측':'예측',초당장:st.spm.toFixed(2),장당시간:Math.round(st.iph),과금단위:g.billing==='minute'?'분당':'시간당',시간당단가:g.price,기본금:g.base,스토리지:g.storage,장수:Math.round(c.images),사용시간_h:c.hours.toFixed(2),총비용:Math.round(c.total),원당장:c.cpp.toFixed(1)};});
  if(fmt==='json')cmpDownload('zimage_compare.json',JSON.stringify(rows,null,2));
  else{const h=Object.keys(rows[0]);cmpDownload('zimage_compare.csv','\ufeff'+[h.join(','),...rows.map(r=>h.map(k=>r[k]==null?'':r[k]).join(','))].join('\n'));}
  cmpToast(fmt.toUpperCase()+' 저장 완료.');}
function cmpDownload(n,c){const b=new Blob([c],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=n;a.click();}
let CMP_toT;function cmpToast(m){const e=document.getElementById('cmpToast');if(!e)return;e.textContent=m;e.classList.add('show');clearTimeout(CMP_toT);CMP_toT=setTimeout(()=>e.classList.remove('show'),3400);}
// ===== 비교·활용 시나리오 JS 끝 (위 블록주석) =====
*/
document.addEventListener("click", () => {
  const m = document.getElementById("cmpSaveMenu");
  if (m) m.classList.remove("show");
});
