import { newId } from "./id.js";

const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const titles = {
  projects: "프로젝트",
  references: "레퍼런스",
  settings: "설정",
  story: "기획",
  timeline: "타임라인",
  video: "영상·QC",
  palette: "디자인 시안",
};
const labels = {
  analyze: "시놉시스 분석",
  story: "플롯·스토리",
  timeline: "타임라인 구성",
  enhance_image: "이미지 프롬프트 강화",
  enhance_video: "비디오 프롬프트 강화",
  lora_review: "LoRA 권장값 확인",
  consistency: "정합성 검토",
};
let data = {
    settings: { connections: [], roles: {}, comfy: { loras: [] } },
    projects: [],
    references: [],
    jobs: [],
  },
  selected = localStorage.getItem("framepop-live-project"),
  tab = "connections",
  segmentIndex = 0,
  inventory = null,
  error = "",
  loginRequired = false,
  referenceDraft = { name: "", profile: "", prompt: "" },
  streams = new Map();
const page = () =>
    titles[location.hash.slice(1)] ? location.hash.slice(1) : "projects",
  project = () => data.projects.find((p) => p.id === selected),
  time = (n) =>
    Math.floor((n || 0) / 60)
      .toString()
      .padStart(2, "0") +
    ":" +
    Math.floor((n || 0) % 60)
      .toString()
      .padStart(2, "0");
const busy = (p) =>
  data.jobs.find(
    (j) => j.projectId === p && ["queued", "running"].includes(j.status),
  );
async function api(path, method = "GET", body) {
  const r = await fetch("/api" + path, {
    method,
    headers: body
      ? {
          "Content-Type": "application/json",
          ...(path === "/jobs" ? { "Idempotency-Key": newId() } : {}),
        }
      : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const v = await r.json();
  if (!r.ok) {
    if (r.status === 401) loginRequired = true;
    throw Error(v.error?.message || "요청에 실패했습니다.");
  }
  return v;
}
function notify(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 3500);
}
function head(title, description = "", buttons = "") {
  return `<div class="heading"><div><h1>${title}</h1>${description ? `<p>${description}</p>` : ""}</div>${buttons}</div>`;
}
function field(label, name, value = "", type = "input", options = "") {
  return `<div class="field"><label for="${name}">${label}</label>${type === "textarea" ? `<textarea id="${name}" rows="4">${esc(value)}</textarea>` : type === "select" ? `<select id="${name}">${options}</select>` : `<input id="${name}" type="${type === "input" ? "text" : type}" value="${esc(value)}">`}</div>`;
}
function opts(values, current, empty = "선택") {
  return (
    `<option value="">${empty}</option>` +
    values
      .map((v) => {
        const id = typeof v === "string" ? v : v.id,
          name = typeof v === "string" ? v : v.name;
        return `<option value="${esc(id)}" ${id === current ? "selected" : ""}>${esc(name)}</option>`;
      })
      .join("")
  );
}
const modelChoices = (local) =>
  data.settings.connections
    .filter(
      (c) =>
        ["ollama", "lmstudio", "codex", "xai", "openclaw"].includes(c.kind) &&
        (!local || ["ollama", "lmstudio"].includes(c.kind)),
    )
    .flatMap((c) =>
      (c.models || []).map((m) => ({
        id: c.id + "|" + m.id,
        name: c.name + " · " + m.name,
      })),
    );
const assignmentValue = (a) => (a ? a.connectionId + "|" + a.model : ""),
  assignment = (v) => {
    if (!v) return null;
    const i = v.indexOf("|");
    return { connectionId: v.slice(0, i), model: v.slice(i + 1) };
  };
function globalProgress() {
  const p = project();
  const relevant = data.jobs.filter(
    (j) =>
      ["queued", "running"].includes(j.status) &&
      (j.projectId === p?.id ||
        (!j.projectId && ["references", "settings"].includes(page()))),
  );
  return relevant
    .map((j) => {
      const g = j.progress || {};
      const age = Math.floor((Date.now() - j.updatedAt) / 1000),
        elapsed = time((Date.now() - j.createdAt) / 1000);
      const phases = {
        queued: "실행 대기",
        assigning: "담당 배정",
        llm: labels[g.role] || "모델 응답 대기",
        source_lookup: "배포 출처 확인",
        submitting: "ComfyUI 제출",
        executing: "ComfyUI 실행",
        progress: "ComfyUI 샘플링",
        face_qc: "얼굴 검수",
        segment_passed: "구간 검수 완료",
        connection_delayed: "상태 수신 지연",
        started: "작업 시작",
      };
      return `<section class="card live-progress"><div class="row between"><div><span class="pill ${age > 30 ? "orange" : "blue"}">${age > 30 ? "최근 상태 확인 중" : "실행 중"}</span><h3>${esc(phases[g.phase] || g.phase)}</h3><small>${esc(g.model || "")}${g.segmentIndex !== undefined ? " · 구간 " + (g.segmentIndex + 1) + " / " + g.totalSegments : ""}</small></div><button data-action="cancel" data-id="${j.id}">중단</button></div><div class="row between progress-meta"><small>경과 ${elapsed}</small><small>마지막 수신 ${age}초 전</small></div>${g.phase === "progress" && g.max ? `<div class="row between"><small>현재 노드 ${esc(g.node)}</small><strong>${g.value} / ${g.max} steps</strong></div><div class="progress" role="progressbar" aria-label="샘플링 진행률" aria-valuenow="${g.value}" aria-valuemax="${g.max}"><div style="width:${(100 * g.value) / g.max}%"></div></div>` : `<small>${g.tokens ? "수신 응답 " + g.tokens + "회 · " : ""}${g.framesChecked ? "검사 프레임 " + g.framesChecked : "완료 응답 대기"}</small>`}</section>`;
    })
    .join("");
}
function jobErrors() {
  const kinds =
    {
      story: ["plan", "revise"],
      timeline: ["plan", "revise"],
      video: ["video"],
      references: ["image", "enhance"],
      settings: ["recommend"],
    }[page()] || [];
  const j = data.jobs.find(
    (j) =>
      kinds.includes(j.kind) &&
      (j.projectId === project()?.id ||
        (!j.projectId && ["references", "settings"].includes(page()))),
  );
  if (
    !j ||
    !["failed", "review_required", "interrupted", "cancelled"].includes(
      j.status,
    )
  )
    return "";
  return `<div class="field-error" role="alert"><strong>${["interrupted", "cancelled"].includes(j.status) ? "중단된 작업" : "작업 확인 필요"}</strong><p>${esc(j.progress?.warning || j.error)}</p><button data-action="retry" data-id="${j.id}">이 작업 재시도</button></div>`;
}

function projectList() {
  return (
    head(
      "프로젝트",
      "",
      `<button class="primary" data-action="newProject">＋ 새 프로젝트</button>`,
    ) +
    `<div class="grid3">${data.projects.map((p) => `<article class="card"><h2>${esc(p.title)}</h2><p class="muted">${time(p.duration)} · ${p.plan?.segments.length || 0}구간</p><span class="pill">${p.approved ? "확정됨" : "작업 중"}</span><div class="actions"><button data-action="openProject" data-id="${p.id}">프로젝트 열기 →</button></div></article>`).join("")}</div>`
  );
}
function story() {
  const p = project();
  if (!p) return projectList();
  return (
    head(
      "이야기 만들기",
      "",
      `<button class="primary" data-action="plan" ${busy(p.id) ? "disabled" : ""}>이야기 만들기</button>`,
    ) +
    `<div class="columns"><section class="card">${field("프로젝트 이름 · 필수", "title", p.title)}${field("시놉시스 · 필수", "synopsis", p.synopsis, "textarea")}${field("모델 프로파일 (선택)", "profile", p.modelProfile, "textarea")}<div class="fields">${field("재생 시간 (초)", "duration", p.duration, "number")}${field(
      "실행 경로",
      "mode",
      p.mode,
      "select",
      opts(
        [
          { id: "local", name: "로컬 전용" },
          { id: "mixed", name: "혼합" },
        ],
        p.mode,
      ),
    )}</div>${field(
      "레퍼런스 (선택)",
      "reference",
      p.referenceId || "",
      "select",
      opts(
        data.references.map((r) => ({ id: r.id, name: r.name })),
        p.referenceId,
        "사용 안 함",
      ),
    )}<button data-action="saveProject">입력 저장</button></section><section class="card"><h2>플롯·스토리</h2>${p.story ? `${p.story.plot.map((b) => `<div class="story-beat"><div><h3>${esc(b.title)}</h3><p>${esc(b.text)}</p></div></div>`).join("")}<p style="white-space:pre-wrap">${esc(p.story.story)}</p><div class="actions"><small>버전 ${p.revision}</small><button data-page="timeline">타임라인 검토 →</button></div>` : '<span class="pill">미생성</span>'}</section></div>`
  );
}
function timeline() {
  const p = project();
  if (!p?.plan)
    return (
      head("타임라인") +
      '<div class="card"><button class="primary" data-page="story">이야기 만들기</button></div>'
    );
  const list = p.plan.segments;
  segmentIndex = Math.min(segmentIndex, list.length - 1);
  const s = list[segmentIndex],
    start = list.slice(0, segmentIndex).reduce((n, s) => n + s.duration, 0);
  return (
    head(
      "타임라인",
      "",
      `<button class="primary" data-action="approve" ${busy(p.id) || p.pendingRevision ? "disabled" : ""}>${p.approved ? "확정됨" : "이야기·타임라인 확정"}</button>`,
    ) +
    `<section class="card"><div class="card-head"><h2>${esc(s.title)}</h2><span class="pill">${time(start)} — ${time(start + s.duration)}</span></div><p style="white-space:pre-wrap">${esc(s.prompt)}</p><div class="row" style="margin-top:20px"><button data-action="revise" ${busy(p.id) ? "disabled" : ""}>수정 요청</button><button data-action="moveLeft" ${segmentIndex === 0 || busy(p.id) ? "disabled" : ""}>← 앞 순서로</button><button data-action="moveRight" ${segmentIndex === list.length - 1 || busy(p.id) ? "disabled" : ""}>뒤 순서로 →</button><button data-action="addSegment" ${busy(p.id) ? "disabled" : ""}>＋ 구간 추가</button><button data-action="deleteSegment" ${list.length < 2 || busy(p.id) ? "disabled" : ""}>구간 삭제</button></div><div class="timeline">${list.map((s, i) => `<button class="clip ${i === segmentIndex ? "selected" : ""}" aria-pressed="${i === segmentIndex}" data-segment="${i}"><span class="clip-number">${i + 1}</span><strong>${s.duration}초</strong><small>${esc(s.title)}</small></button>`).join("")}</div></section>`
  );
}
function video() {
  const p = project();
  if (!p) return projectList();
  const job = data.jobs.find(
      (j) =>
        j.projectId === p.id &&
        j.kind === "video" &&
        j.projectRevision === p.revision,
    ),
    s = p.plan?.segments || [],
    completed = Object.values(job?.segments || {}).filter((s) =>
      ["pass", "no_face"].includes(s.qc?.status),
    ).length;
  return (
    head(
      "영상·검수",
      "",
      job?.status === "review_required"
        ? `<button class="primary" data-action="retry" data-id="${job.id}">실패 구간 재생성</button>`
        : `<button class="primary" data-action="video" ${!p.approved || busy(p.id) ? "disabled" : ""}>${job?.status === "completed" ? "영상 다시 생성" : "영상 생성"}</button>`,
    ) +
    `<section class="card"><div class="row between"><h2>${completed} / ${s.length} 구간 검수 완료</h2><span class="pill">${job?.status === "review_required" ? "검수 확인 필요" : job?.status === "completed" ? "완료" : busy(p.id) ? "작업 중" : p.approved ? "생성 준비됨" : "기획·타임라인 확정 필요"}</span></div><div class="progress"><div style="width:${s.length ? (completed / s.length) * 100 : 0}%"></div></div><div class="segments">${s
      .map((segment, i) => {
        const q = job?.segments[segment.id]?.qc;
        return `<button class="seg ${i === segmentIndex ? "selected" : ""} ${q?.status === "pass" ? "pass" : q ? "fail" : ""}" aria-pressed="${i === segmentIndex}" data-segment="${i}">${i + 1} ${q?.status === "pass" ? "✓" : ""}</button>`;
      })
      .join(
        "",
      )}</div></section>${s[segmentIndex] ? `<section class="card"><h2>${esc(s[segmentIndex].title)}</h2>${job?.segments[s[segmentIndex].id]?.file ? `<video class="scene-img" controls playsinline src="/media/${job.segments[s[segmentIndex].id].file.key}"></video>` : '<div class="media-empty">미생성</div>'}${job?.segments[s[segmentIndex].id]?.qc ? `<div class="checks"><div class="check"><span>Face QC</span><b>${esc({ pass: "통과", fail: "확인 필요", no_face: "얼굴 없음" }[job.segments[s[segmentIndex].id].qc.status] || job.segments[s[segmentIndex].id].qc.status)}</b></div><div class="check"><span>검사 프레임</span><b>${job.segments[s[segmentIndex].id].qc.framesChecked}</b></div><div class="check"><span>문제 프레임</span><b>${job.segments[s[segmentIndex].id].qc.badFrames ?? "—"}</b></div><div class="check"><span>연결부 얼굴</span><b>${job.segments[s[segmentIndex].id].qc.boundaryPassed ? "통과" : "확인 필요"}</b></div></div>` : ""}</section>` : ""}${job?.snapshot ? `<section class="card"><h2>적용 모델·LoRA</h2><p>${esc(job.snapshot.model)}</p>${job.snapshot.loras.map((l) => `<p>${esc(l.name)} · 강도 ${l.strength}<a target="_blank" rel="noopener" href="${esc(l.source.url)}">권장값 출처 ↗</a></p>`).join("")}</section>` : ""}${job?.result?.videoKey ? `<section class="card"><h2>완성 영상</h2><video class="scene-img" controls src="/media/${job.result.videoKey}"></video><a href="/media/${job.result.videoKey}" download>영상 다운로드</a></section>` : ""}`
  );
}
function references() {
  return (
    head("레퍼런스 보관함") +
    `<div class="columns"><section class="card">${field("이름 (선택)", "refName", referenceDraft.name)}${field("모델 프로파일 (선택)", "refProfile", referenceDraft.profile, "textarea")}${field("이미지 프롬프트 · 생성 시 필수", "refPrompt", referenceDraft.prompt, "textarea")}<div class="row"><button data-action="enhanceReference">프롬프트 강화</button><button class="primary" data-action="image">이미지 생성</button></div></section><section class="card"><h2>보관함 <span class="pill">${data.references.length}</span></h2><div class="candidate-grid">${data.references.map((r) => `<article><img class="scene-img" src="/media/${r.imageKey}" alt="${esc(r.name)}"><h3>${esc(r.name)}</h3><p class="help">${esc(r.profile)}</p></article>`).join("")}</div></section></div>`
  );
}
function settings() {
  const s = data.settings;
  return (
    head("설정") +
    `<div class="tabs">${[
      ["connections", "계정·서버"],
      ["roles", "역할 배정"],
      ["comfy", "ComfyUI 자산"],
      ["enhancement", "프롬프트 강화"],
    ]
      .map(
        ([key, name]) =>
          `<button data-tab="${key}" class="${tab === key ? "active" : ""}" aria-pressed="${tab === key}">${name}</button>`,
      )
      .join("")}</div>` +
    (tab === "connections"
      ? `<section class="card"><div class="card-head"><h2>연결 관리</h2><button data-action="addConnection">＋ 연결 추가</button></div><div class="setting-grid">${s.connections.map((c) => `<article class="connection"><h3>${esc(c.name)}</h3><small>${esc(isSubscription(c.kind) ? subscriptionName(c.kind) + " 구독" : c.kind)}${c.url ? " · " + esc(c.url) : ""}</small><p class="help">${isSubscription(c.kind) ? (c.authStatus === "connected" ? "구독 연결됨 · " : "로그인 필요 · ") : ""}조회 모델 ${c.models?.length || 0}개</p><div class="row">${["codex", "xai"].includes(c.kind) ? `<button data-auth="${c.kind}" data-auth-connection="${c.id}">${c.authStatus === "connected" ? "다시 로그인" : "구독 로그인"}</button>` : ""}<button data-scan="${c.id}">모델 조회</button><button data-edit-connection="${c.id}">수정</button></div></article>`).join("")}</div></section>`
      : tab === "roles"
        ? `<section class="card">${field(
            "배정 방식",
            "assignmentMode",
            s.assignmentMode,
            "select",
            opts(
              [
                { id: "auto", name: "Primary 자동 배정" },
                { id: "manual", name: "수동 배정" },
              ],
              s.assignmentMode,
            ),
          )}${field("Primary 모델", "primary", assignmentValue(s.primary), "select", opts(modelChoices(false), assignmentValue(s.primary)))}<div class="roles">${Object.entries(
            labels,
          )
            .map(
              ([role, name]) =>
                `<label for="role-${role}">${name}</label><select id="role-${role}" ${s.assignmentMode === "auto" ? "disabled" : ""}>${opts(modelChoices(role.startsWith("enhance_")), assignmentValue(s.roles[role]))}</select>`,
            )
            .join(
              "",
            )}</div><button class="primary" data-action="saveRoles" style="margin-top:20px">역할 배정 저장</button></section>`
        : tab === "enhancement"
          ? `<section class="card">${field("공통 강화 지시", "enhancementInstruction", s.enhancementInstruction, "textarea")}<button class="primary" data-action="saveEnhancement">저장</button></section>`
          : comfySettings())
  );
}
function comfySettings() {
  const c = data.settings.comfy,
    connections = data.settings.connections.filter((c) => c.kind === "comfy");
  return `<section class="card">${field("ComfyUI 서버", "comfyConnection", c.connectionId, "select", opts(connections, c.connectionId))}<button data-action="scanComfy">설치 모델·LoRA 조회</button>${
    inventory
      ? `<div style="margin-top:20px">${field(
          "영상 모델 · H3 FL2VA",
          "videoModel",
          c.model,
          "select",
          opts(
            inventory.models
              .filter(
                (m) =>
                  m.type === "diffusion_models" &&
                  /minimax[_-]h3.*fl2va/i.test(m.name),
              )
              .map((m) => m.name),
            c.model,
          ),
        )}<details><summary>H3 인코더·VAE</summary>${[
          [
            "textEncoder",
            "텍스트 인코더",
            inventory.textEncoders.filter((n) =>
              /qwen3.*minimax[_-]h3/i.test(n),
            ),
          ],
          [
            "vae",
            "영상 VAE",
            inventory.vaes.filter((n) =>
              /minimax[_-]h3[_-]video[_-]vae/i.test(n),
            ),
          ],
          [
            "audioVae",
            "오디오 VAE",
            inventory.vaes.filter((n) =>
              /minimax[_-]h3[_-]audio[_-]vae/i.test(n),
            ),
          ],
        ]
          .map(([key, label, files]) =>
            field(
              label,
              key,
              c[key],
              "select",
              `<option value="">자동 선택</option>${files.map((name) => `<option value="${esc(name)}" ${c[key] === name ? "selected" : ""}>${esc(name)}</option>`).join("")}`,
            ),
          )
          .join("")}</details>${field(
          "이미지 모델",
          "imageModel",
          c.imageModel,
          "select",
          opts(
            inventory.models
              .filter((m) => m.type === "checkpoints")
              .map((m) => m.name),
            c.imageModel,
          ),
        )}<h3>영상용 LoRA (복수 선택)</h3><div class="lora-list">${inventory.loras.map((name) => `<label class="lora-choice"><input type="checkbox" data-lora="${esc(name)}" ${c.loras.includes(name) ? "checked" : ""}><span>${esc(name)}</span></label>`).join("") || '<span class="pill">0개</span>'}</div><h3>이미지용 LoRA (복수 선택)</h3><div class="lora-list">${inventory.loras.map((name) => `<label class="lora-choice"><input type="checkbox" data-image-lora="${esc(name)}" ${(c.imageLoras || []).includes(name) ? "checked" : ""}><span>${esc(name)}</span></label>`).join("") || '<span class="pill">0개</span>'}</div>${!inventory.hashSupport && ((c.loras || []).length || (c.imageLoras || []).length) ? '<p class="field-error">LoRA의 정확한 배포 버전을 찾으려면 서버에 framepop_assets 확장을 설치해 주세요.</p>' : ""}<div class="button-row"><button class="primary" data-action="saveComfy">사용 자산 저장</button><button data-action="recommend">영상 권장 강도 확인</button><button data-action="recommendImage">이미지 권장 강도 확인</button></div></div>`
      : ""
  }</section>`;
}
function render() {
  const p = page(),
    inProject = ["story", "timeline", "video"].includes(p);
  $("#nav").innerHTML = ["projects", "references", "settings"]
    .map(
      (k) =>
        `<button data-page="${k}" class="${p === k || (inProject && k === "projects") ? "active" : ""}" aria-current="${p === k || (inProject && k === "projects") ? "page" : "false"}">${titles[k]}</button>`,
    )
    .join("");
  $("#breadcrumb").innerHTML =
    inProject && project()
      ? `<a href="#projects">프로젝트 목록</a> / <select id="switchProject" aria-label="프로젝트 전환">${opts(
          data.projects.map((p) => ({ id: p.id, name: p.title })),
          selected,
        )}</select> / ${titles[p]}`
      : titles[p];
  if (loginRequired) {
    $("#main").innerHTML =
      head("작업실 접속") +
      `<div class="card">${field("접속 코드", "accessCode", "", "password")}<button data-action="login">접속</button></div>`;
    return;
  }
  $("#main").innerHTML =
    `${inProject ? `<nav class="project-tabs">${["story", "timeline", "video"].map((k, i) => `<button data-page="${k}" class="${p === k ? "active" : ""}">${i + 1}. ${titles[k]}</button>`).join("")}</nav>` : ""}<div id="liveProgress">${globalProgress()}</div>${error ? `<div class="field-error" role="alert">${esc(error)}</div>` : ""}${jobErrors()}${{ projects: projectList, story, timeline, video, references, settings, palette: () => head("디자인 시안") + '<img style="width:100%" src="palette.svg" alt="컬러 차트">' }[p]()}`;
}
async function refresh() {
  data = await api("/bootstrap");
  if (!project() && data.projects.length) selected = data.projects[0].id;
  for (const j of data.jobs.filter((j) =>
    ["queued", "running"].includes(j.status),
  ))
    watch(j);
  render();
}
function watch(job) {
  if (streams.has(job.id)) return;
  const stream = new EventSource("/api/jobs/" + job.id + "/events");
  streams.set(job.id, stream);
  stream.onmessage = async (e) => {
    const event = JSON.parse(e.data),
      j = data.jobs.find((j) => j.id === job.id);
    if (j) {
      if (event.segmentId && event.segmentId !== j.progress?.segmentId)
        j.progress = {};
      if (event.role && event.role !== j.progress?.role)
        delete j.progress.tokens;
      j.progress = { ...j.progress, ...event };
      j.updatedAt = Date.parse(event.at);
    }
    $("#liveProgress") && ($("#liveProgress").innerHTML = globalProgress());
    if (
      ["completed", "failed", "review_required", "cancelled"].includes(
        event.phase,
      )
    ) {
      stream.close();
      streams.delete(job.id);
      try {
        const latest = await api("/jobs/" + job.id);
        if (latest.kind === "enhance" && latest.status === "completed") {
          referenceDraft.prompt = latest.result.prompt;
          notify("프롬프트 강화 완료");
        }
        if (latest.kind === "recommend" && latest.status === "completed")
          dialog(
            `<h2>권장 강도</h2>${latest.result.loras.map((l) => `<p>${esc(l.name)} · ${l.strength}</p><a href="${esc(l.source.url)}" target="_blank" rel="noopener">출처 확인 ↗</a>`).join("") || '<span class="pill">선택 0개</span>'}`,
          );
        await refresh();
      } catch (e) {
        error = e.message;
        render();
      }
    }
  };
  stream.onerror = () => {
    const j = data.jobs.find((j) => j.id === job.id);
    if (j) j.progress.phase = "connection_delayed";
  };
}
async function startJob(kind, input = {}, projectId = project()?.id) {
  const j = await api("/jobs", "POST", { kind, projectId, input });
  data.jobs.unshift(j);
  watch(j);
  render();
  return j;
}
function dialogActions(primary = "") {
  return `<div class="dialog-actions"><button data-action="close">닫기</button>${primary}</div>`;
}
function dialog(html, actions = "") {
  stopAuthWatch();
  $("#modal").innerHTML =
    html.replace("<h2>", '<h2 id="dialog-title">') +
    (actions === false ? "" : dialogActions(actions));
  $("#modal").showModal();
}
const subscriptionName = (kind) => (kind === "codex" ? "OpenAI" : "xAI");
const isSubscription = (kind) => ["codex", "xai"].includes(kind);
let authFlow = null;
function stopAuthWatch() {
  if (authFlow) clearTimeout(authFlow.timer);
  authFlow = null;
}
function connectionDetails(kind, c = {}) {
  const button = `<button class="primary" data-action="saveConnection">${isSubscription(kind) ? subscriptionName(kind) + " 구독으로 연결" : "연결 저장"}</button>`;
  return (
    (isSubscription(kind)
      ? ""
      : `${field("서버 주소 · 필수", "connectionUrl", c.url)}${field("서버 인증 토큰 (선택)", "connectionToken", "", "password")}`) +
    dialogActions(button)
  );
}
function authMarkup(flow, state = {}) {
  const url = state.verificationUrl || state.authUrl || state.url;
  const code = state.userCode || state.code;
  const retry = `<button data-auth="${flow.provider}" data-auth-connection="${flow.connectionId}">다시 로그인</button>`;
  if (state.status === "completed")
    return `<h2>${flow.name} 구독 연결 완료</h2><div class="dialog-status"><span class="pill">모델 ${state.modelCount}개</span></div>${dialogActions('<button class="primary" data-action="openRoles">역할 배정으로</button>')}`;
  if (["failed", "expired"].includes(state.status))
    return `<h2>${flow.name} 연결 확인 필요</h2><p class="field-error" role="alert">${esc(state.error || "로그인 확인 시간이 지났습니다. 다시 시작해 주세요.")}</p>${dialogActions(retry)}`;
  return `<h2>${flow.name} 구독 로그인</h2>${url ? `<a class="auth-link primary" target="_blank" rel="noopener noreferrer" href="${esc(url)}">${flow.name} 로그인 페이지 열기 ↗</a>${code ? `<div class="auth-code"><span>기기 코드</span><strong>${esc(code)}</strong></div>` : ""}` : ""}<p id="authStatus" role="status">${url ? "승인 대기" : "로그인 준비 중…"}</p>${dialogActions('<button data-action="checkAuth">상태 다시 확인</button>')}`;
}
function showAuth(flow, state) {
  if (authFlow !== flow || !$("#modal").open) return;
  $("#modal").innerHTML = authMarkup(flow, state).replace(
    "<h2>",
    '<h2 id="dialog-title">',
  );
}
async function checkAuth(flow) {
  if (!flow || authFlow !== flow || flow.checking || !$("#modal").open) return;
  clearTimeout(flow.timer);
  flow.checking = true;
  try {
    const state = await api(
      "/auth/" + flow.provider + "/" + encodeURIComponent(flow.id),
    );
    if (authFlow !== flow || !$("#modal").open) return;
    if (state.status === "completed") {
      $("#authStatus").textContent = "승인 완료 · 모델 조회 중";
      const result = await api(
        "/connections/" + flow.connectionId + "/models",
        "POST",
      );
      data.settings = result.settings;
      if (authFlow !== flow || !$("#modal").open) return;
      showAuth(flow, { status: "completed", modelCount: result.models.length });
      render();
      return;
    }
    if (["failed", "expired"].includes(state.status)) {
      showAuth(flow, state);
      return;
    }
    if (Date.now() - flow.startedAt > 15 * 60 * 1000) {
      showAuth(flow, { status: "expired" });
      return;
    }
    const signature = JSON.stringify([
      state.verificationUrl || state.url,
      state.userCode || state.code,
    ]);
    if (signature !== flow.signature) {
      flow.signature = signature;
      showAuth(flow, state);
    } else if ($("#authStatus"))
      $("#authStatus").textContent = "승인 대기 중 · 방금 상태를 확인했습니다.";
    flow.timer = setTimeout(() => checkAuth(flow), 1500);
  } catch (e) {
    if (authFlow === flow)
      showAuth(flow, { status: "failed", error: e.message });
  } finally {
    flow.checking = false;
  }
}
async function beginAuth(provider, connectionId) {
  dialog(
    `<h2>${subscriptionName(provider)} 구독 로그인</h2><p role="status">로그인 준비 중…</p>`,
  );
  const flow = {
    provider,
    connectionId,
    name: subscriptionName(provider),
    startedAt: Date.now(),
  };
  authFlow = flow;
  try {
    const state = await api("/auth/" + provider, "POST");
    if (authFlow !== flow || !$("#modal").open) return;
    flow.id = state.loginId || state.id;
    if (!flow.id)
      throw Error("로그인 요청을 확인할 수 없습니다. 다시 시작해 주세요.");
    flow.signature = JSON.stringify([
      state.verificationUrl || state.url,
      state.userCode || state.code,
    ]);
    showAuth(flow, state);
    flow.timer = setTimeout(() => checkAuth(flow), 1500);
  } catch (e) {
    if (authFlow === flow)
      showAuth(flow, { status: "failed", error: e.message });
  }
}

async function saveSettings() {
  data.settings = await api("/settings", "PUT", data.settings);
}
function markInvalid(q) {
  $(q)?.setAttribute("aria-invalid", "true");
}
async function saveProject() {
  const p = project();
  if (!$("#synopsis").value.trim()) {
    markInvalid("#synopsis");
    throw Error("시놉시스를 입력해 주세요.");
  }
  const updates = {
    revision: p.revision,
    title: $("#title").value,
    synopsis: $("#synopsis").value,
    modelProfile: $("#profile").value,
    duration: Number($("#duration").value),
    mode: $("#mode").value,
    referenceId: $("#reference").value || null,
  };
  const result = await api("/projects/" + p.id, "PATCH", updates);
  data.projects = data.projects.map((p) => (p.id === result.id ? result : p));
  return result;
}
function captureReference() {
  for (const [k, q] of Object.entries({
    name: "#refName",
    profile: "#refProfile",
    prompt: "#refPrompt",
  }))
    referenceDraft[k] = $(q)?.value ?? referenceDraft[k];
}
async function action(a, b) {
  error = "";
  if (a === "login") {
    await api("/session", "POST", { code: $("#accessCode").value });
    loginRequired = false;
    return refresh();
  }
  if (a === "close") {
    stopAuthWatch();
    return $("#modal").close();
  }
  if (a === "newProject")
    return dialog(
      `<h2>새 프로젝트</h2>${field("프로젝트 이름 · 필수", "newTitle")}`,
      '<button class="primary" data-action="createProject">만들기</button>',
    );
  if (a === "createProject") {
    const title = $("#newTitle").value.trim();
    if (!title) {
      markInvalid("#newTitle");
      throw Error("프로젝트 이름이 필요합니다.");
    }
    const p = await api("/projects", "POST", { title });
    data.projects.unshift(p);
    selected = p.id;
    localStorage.setItem("framepop-live-project", selected);
    $("#modal").close();
    location.hash = "story";
  }
  if (a === "openProject") {
    selected = b.dataset.id;
    localStorage.setItem("framepop-live-project", selected);
    segmentIndex = 0;
    location.hash = "story";
  }
  if (a === "saveProject") {
    await saveProject();
    notify("저장했습니다.");
  }
  if (a === "plan") {
    await saveProject();
    return startJob("plan");
  }
  if (a === "approve") {
    const p = await api("/projects/" + selected + "/approve", "POST", {
      revision: project().revision,
    });
    data.projects = data.projects.map((x) => (x.id === p.id ? p : x));
    location.hash = "video";
  }
  if (a === "video") return startJob("video");
  if (a === "cancel") {
    await api("/jobs/" + b.dataset.id + "/cancel", "POST");
    return refresh();
  }
  if (a === "retry") {
    const j = await api("/jobs/" + b.dataset.id + "/retry", "POST");
    watch(j);
    return refresh();
  }
  if (
    ["moveLeft", "moveRight", "addSegment", "deleteSegment", "revise"].includes(
      a,
    )
  ) {
    const s = project().plan.segments[segmentIndex];
    if (a === "revise")
      return dialog(
        `<h2>구간 수정 요청</h2>${field("수정할 구간 내용", "segmentPrompt", s.prompt, "textarea")}${field("길이 (초)", "segmentDuration", s.duration, "number")}`,
        '<button class="primary" data-action="submitRevision">수정 반영</button>',
      );
    const constraints =
      a === "deleteSegment"
        ? [{ id: s.id, deleted: true }]
        : a === "addSegment"
          ? [{ id: newId(), index: segmentIndex + 1 }]
          : [{ id: s.id, index: segmentIndex + (a === "moveLeft" ? -1 : 1) }];
    return startJob("revise", { constraints });
  }
  if (a === "submitRevision") {
    const s = project().plan.segments[segmentIndex];
    const duration = Number($("#segmentDuration").value);
    if (!Number.isInteger(duration) || duration < 1 || duration > 15)
      throw Error("구간 길이는 1~15초 정수로 입력하세요.");
    const prompt = $("#segmentPrompt").value.trim();
    if (!prompt) throw Error("수정 내용을 입력하세요.");
    $("#modal").close();
    return startJob("revise", {
      constraints: [{ id: s.id, prompt, duration }],
    });
  }
  if (a === "enhanceReference") {
    captureReference();
    if (!referenceDraft.prompt.trim() && !referenceDraft.profile.trim()) {
      markInvalid("#refPrompt");
      markInvalid("#refProfile");
      throw Error("프롬프트 또는 모델 프로파일을 입력해 주세요.");
    }
    return startJob(
      "enhance",
      {
        target: "image",
        prompt: referenceDraft.prompt,
        profile: referenceDraft.profile,
      },
      null,
    );
  }
  if (a === "image") {
    captureReference();
    if (!referenceDraft.prompt.trim()) {
      markInvalid("#refPrompt");
      throw Error("이미지 프롬프트를 입력하거나 강화로 생성해 주세요.");
    }
    return startJob("image", referenceDraft, null);
  }
  if (a === "addConnection" || b.dataset.editConnection) {
    const c = data.settings.connections.find(
      (c) => c.id === b.dataset.editConnection,
    ) || { id: newId(), kind: "ollama" };
    return dialog(
      `<h2>계정·서버 연결</h2><input id="connectionId" type="hidden" value="${c.id}">${field("연결 이름 (선택)", "connectionName", c.name)}${field(
        "연결 종류",
        "connectionKind",
        c.kind,
        "select",
        opts(
          [
            { id: "ollama", name: "Ollama" },
            { id: "lmstudio", name: "LM Studio" },
            { id: "comfy", name: "ComfyUI" },
            { id: "codex", name: "OpenAI 구독 (Codex)" },
            { id: "xai", name: "xAI 구독" },
            { id: "openclaw", name: "OpenClaw 서버" },
          ],
          c.kind,
        ),
      )}<div id="connectionDetails">${connectionDetails(c.kind, c)}</div>`,
      false,
    );
  }
  if (a === "saveConnection") {
    const kind = $("#connectionKind").value;
    if (!kind) throw Error("연결 종류를 선택해 주세요.");
    const c = {
      id: $("#connectionId").value,
      kind,
      name:
        $("#connectionName").value.trim() ||
        (isSubscription(kind) ? subscriptionName(kind) + " 구독" : kind),
    };
    if (!isSubscription(kind)) {
      c.url = $("#connectionUrl").value.trim();
      if (!c.url) {
        markInvalid("#connectionUrl");
        throw Error("서버 주소를 입력해 주세요.");
      }
      if ($("#connectionToken").value) c.token = $("#connectionToken").value;
    }
    b.disabled = true;
    try {
      const connections = data.settings.connections.map((x) =>
        x.id === c.id ? { ...(x.kind === kind ? x : {}), ...c } : x,
      );
      if (!connections.some((x) => x.id === c.id)) connections.push(c);
      data.settings = await api("/settings", "PUT", {
        ...data.settings,
        connections,
      });
      if (isSubscription(kind)) {
        render();
        return beginAuth(kind, c.id);
      }
      $("#modal").close();
    } finally {
      b.disabled = false;
    }
  }
  if (a === "checkAuth") return checkAuth(authFlow);
  if (a === "openRoles") {
    stopAuthWatch();
    $("#modal").close();
    tab = "roles";
    location.hash = "settings";
    render();
    return;
  }
  if (a === "saveRoles") {
    const auto = $("#assignmentMode").value === "auto";
    const required = auto
      ? ["#primary"]
      : Object.keys(labels).map((r) => "#role-" + r);
    const missing = required.filter((q) => !$(q).value);
    if (missing.length) {
      missing.forEach(markInvalid);
      throw Error("담당 모델을 선택해 주세요.");
    }
    data.settings.assignmentMode = $("#assignmentMode").value;
    data.settings.primary = assignment($("#primary").value);
    if (data.settings.assignmentMode === "manual")
      for (const role of Object.keys(labels))
        data.settings.roles[role] = assignment($("#role-" + role).value);
    await saveSettings();
    notify("역할 배정을 저장했습니다.");
  }
  if (a === "saveEnhancement") {
    data.settings.enhancementInstruction = $("#enhancementInstruction").value;
    await saveSettings();
    notify("저장했습니다.");
  }
  if (a === "scanComfy") {
    const id = $("#comfyConnection").value;
    if (!id) throw Error("ComfyUI 서버를 선택하세요.");
    data.settings.comfy.connectionId = id;
    await saveSettings();
    inventory = await api("/connections/" + id + "/models", "POST");
  }
  if (["saveComfy", "recommend", "recommendImage"].includes(a)) {
    data.settings.comfy = {
      ...data.settings.comfy,
      connectionId: $("#comfyConnection").value,
      model: $("#videoModel").value,
      imageModel: $("#imageModel").value,
      textEncoder: $("#textEncoder").value || null,
      vae: $("#vae").value || null,
      audioVae: $("#audioVae").value || null,
      loras: [...document.querySelectorAll("[data-lora]:checked")].map(
        (e) => e.dataset.lora,
      ),
      imageLoras: [
        ...document.querySelectorAll("[data-image-lora]:checked"),
      ].map((e) => e.dataset.imageLora),
    };
    await saveSettings();
    if (a === "recommend" || a === "recommendImage")
      return startJob(
        "recommend",
        { target: a === "recommendImage" ? "image" : "video" },
        null,
      );
    notify("사용 자산을 저장했습니다.");
  }
  render();
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  try {
    if (b.dataset.page) {
      location.hash = b.dataset.page;
      return;
    }
    if (b.dataset.tab) {
      tab = b.dataset.tab;
      error = "";
      render();
      return;
    }
    if (b.dataset.segment !== undefined) {
      const x = $(".timeline")?.scrollLeft || 0,
        y = scrollY;
      segmentIndex = Number(b.dataset.segment);
      render();
      if ($(".timeline")) $(".timeline").scrollLeft = x;
      document
        .querySelector(`[data-segment="${segmentIndex}"]`)
        ?.focus({ preventScroll: true });
      scrollTo(0, y);
      return;
    }
    if (b.dataset.scan) {
      const result = await api(
        "/connections/" + b.dataset.scan + "/models",
        "POST",
      );
      if (result.settings) data.settings = result.settings;
      else inventory = result;
      notify("모델 목록을 확인했습니다.");
      render();
      return;
    }
    if (b.dataset.auth) {
      const connectionId =
        b.dataset.authConnection ||
        data.settings.connections.find((c) => c.kind === b.dataset.auth)?.id;
      if (!connectionId) throw Error("계정 연결을 먼저 등록해 주세요.");
      return beginAuth(b.dataset.auth, connectionId);
    }
    await action(b.dataset.action, b);
  } catch (e) {
    error = e.message;
    const modal = $("#modal");
    if (modal.open) {
      modal.querySelector(".field-error")?.remove();
      const p = document.createElement("p");
      p.className = "field-error";
      p.setAttribute("role", "alert");
      p.textContent = e.message;
      modal.prepend(p);
    } else {
      document.querySelector("#main > .field-error")?.remove();
      const p = document.createElement("p");
      p.className = "field-error";
      p.setAttribute("role", "alert");
      p.textContent = e.message;
      $("#main").prepend(p);
    }
  }
});
document.addEventListener("input", (e) => {
  e.target.removeAttribute("aria-invalid");
  if (["refName", "refProfile", "refPrompt"].includes(e.target.id))
    captureReference();
});
document.addEventListener("change", (e) => {
  if (e.target.id === "connectionKind")
    $("#connectionDetails").innerHTML = connectionDetails(e.target.value);
  if (e.target.id === "switchProject") {
    selected = e.target.value;
    localStorage.setItem("framepop-live-project", selected);
    segmentIndex = 0;
    render();
  }
  if (e.target.id === "assignmentMode") {
    const manual = e.target.value === "manual";
    document
      .querySelectorAll('[id^="role-"]')
      .forEach((e) => (e.disabled = !manual));
  }
});
$("#modal").addEventListener("close", stopAuthWatch);
window.addEventListener("hashchange", () => {
  error = "";
  render();
});
setInterval(() => {
  if ($("#liveProgress")) $("#liveProgress").innerHTML = globalProgress();
}, 1000);
refresh().catch((e) => {
  error = e.message;
  render();
});
