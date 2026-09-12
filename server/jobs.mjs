import { EventEmitter } from "node:events";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { id } from "./store.mjs";
import { AppError, need } from "./http.mjs";
import { task, connection } from "./llm.mjs";
import { inventory, buildGraph, execute, output, upload } from "./comfy.mjs";
import { recommend } from "./recommend.mjs";
import { trimVideo, lastFrame, qc, command } from "./media.mjs";
export function validatePlan(plan, duration, constraints = []) {
  need(
    Array.isArray(plan.segments) &&
      plan.segments.length > 0 &&
      plan.segments.length <= 600,
    "구간 목록이 올바르지 않습니다.",
    "OUTPUT_INVALID",
  );
  const seen = new Set();
  for (const s of plan.segments) {
    need(
      typeof s.id === "string" &&
        !seen.has(s.id) &&
        typeof s.title === "string" &&
        typeof s.prompt === "string" &&
        s.prompt.trim() &&
        Number.isInteger(s.duration) &&
        s.duration >= 1 &&
        s.duration <= 15,
      "구간 형식이나 길이가 올바르지 않습니다.",
      "OUTPUT_INVALID",
    );
    seen.add(s.id);
  }
  need(
    plan.segments.reduce((n, s) => n + s.duration, 0) === duration,
    "구간 합계가 목표 재생 시간과 다릅니다.",
    "OUTPUT_INVALID",
  );
  for (const c of constraints) {
    const s = plan.segments.find((s) => s.id === c.id);
    if (c.deleted) {
      need(!s, "삭제 요청 구간이 다시 생성되었습니다.", "CONSTRAINT_VIOLATION");
      continue;
    }
    need(s, "수정한 구간을 잃었습니다.", "CONSTRAINT_VIOLATION");
    for (const k of ["title", "prompt", "duration"])
      if (c[k] !== undefined)
        need(
          s[k] === c[k],
          "사용자 수정 내용이 보존되지 않았습니다.",
          "CONSTRAINT_VIOLATION",
        );
    if (c.index !== undefined)
      need(
        plan.segments[c.index]?.id === c.id,
        "지정 순서가 보존되지 않았습니다.",
        "CONSTRAINT_VIOLATION",
      );
  }
  return plan;
}
export class Jobs extends EventEmitter {
  constructor(
    store,
    {
      codex,
      xai,
      taskFn = task,
      comfy = { inventory, execute, output, upload },
      qcFn = qc,
    } = {},
  ) {
    super();
    this.store = store;
    this.codex = codex;
    this.xai = xai;
    this.task = taskFn;
    this.comfy = comfy;
    this.qc = qcFn;
    this.active = new Map();
    for (const j of store
      .list("job")
      .filter((j) => ["running", "queued"].includes(j.status))) {
      j.status = "interrupted";
      j.error =
        "실행 서버가 재시작되었습니다. 저장된 작업을 확인한 뒤 재개하세요.";
      store.put("job", j.id, j);
    }
  }
  event(j, data) {
    if (data.segmentId && data.segmentId !== j.progress?.segmentId)
      j.progress = {};
    if (data.role && data.role !== j.progress?.role) {
      delete j.progress.tokens;
    }
    j.progress = { ...j.progress, ...data, receivedAt: Date.now() };
    j.updatedAt = Date.now();
    this.store.put("job", j.id, j);
    const e = this.store.event(j.id, data);
    this.emit(j.id, e);
  }
  create(kind, projectId, input = {}, key) {
    if (key) {
      const existing = this.store.list("job").find((j) => j.key === key);
      if (existing) {
        need(
          existing.kind === kind &&
            existing.projectId === projectId &&
            JSON.stringify(existing.input) === JSON.stringify(input),
          "중복 제출 키가 다른 요청에 사용되었습니다.",
          "VERSION_CONFLICT",
        );
        return existing;
      }
    }
    const project = projectId ? this.store.get("project", projectId) : null;
    if (projectId) need(project, "프로젝트가 없습니다.");
    if (["plan", "revise", "video"].includes(kind))
      need(project, "프로젝트가 필요합니다.");
    if (kind === "revise") need(project?.plan, "수정할 타임라인이 없습니다.");
    if (projectId)
      need(
        !this.store
          .list("job")
          .some(
            (j) =>
              j.projectId === projectId &&
              ["running", "queued"].includes(j.status),
          ),
        "프로젝트 작업이 이미 진행 중입니다.",
        "JOB_BUSY",
      );
    const settings = this.store.get("settings", "main");
    need(settings, "연결을 먼저 설정하세요.");
    const j = {
      id: id(),
      key,
      kind,
      projectId,
      projectRevision: project?.revision,
      input,
      project: structuredClone(project),
      settings: structuredClone(settings),
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: { phase: "queued" },
      artifacts: [],
      segments: {},
    };
    if (["plan", "revise"].includes(kind)) {
      project.approved = false;
      project.pendingRevision = true;
      this.store.put("project", project.id, project);
    }
    this.store.put("job", j.id, j);
    queueMicrotask(() => this.run(j));
    return j;
  }
  async run(j) {
    const controller = new AbortController();
    this.active.set(j.id, controller);
    j.status = "running";
    const ctx = {
      jobId: j.id,
      signal: controller.signal,
      codex: this.codex,
      xai: this.xai,
      localOnly: j.project?.mode === "local",
      event: (data) => this.event(j, data),
    };
    this.event(j, { phase: "started" });
    try {
      if (["plan", "revise"].includes(j.kind)) await this.plan(j, ctx);
      else if (j.kind === "enhance") await this.enhance(j, ctx);
      else if (j.kind === "recommend") await this.recommend(j, ctx);
      else if (j.kind === "image") await this.image(j, ctx);
      else if (j.kind === "video") await this.video(j, ctx);
      else throw new AppError("INVALID_INPUT", "지원하지 않는 작업입니다.");
      ctx.signal.throwIfAborted();
      j.status = "completed";
      this.event(j, { phase: "completed" });
    } catch (e) {
      j.status = controller.signal.aborted
        ? "cancelled"
        : [
              "OUTPUT_INVALID",
              "CONSTRAINT_VIOLATION",
              "QC_FAILED",
              "QC_UNVERIFIABLE",
              "SOURCE_NOT_FOUND",
              "RECOMMENDATION_UNVERIFIED",
              "ASSET_IDENTITY_REQUIRED",
              "UNSUPPORTED_MODEL",
              "MISSING_NODE",
              "MISSING_MODEL",
              "SUBMISSION_UNCERTAIN",
            ].includes(e.code)
          ? "review_required"
          : "failed";
      j.error = e.message;
      j.code = e.code || "EXECUTION_FAILED";
      this.event(j, { phase: j.status, error: j.error, code: j.code });
    } finally {
      this.active.delete(j.id);
    }
  }
  cancel(jobId) {
    const j = this.store.get("job", jobId);
    need(j, "작업이 없습니다.");
    this.active.get(jobId)?.abort();
    if (!this.active.has(jobId)) {
      j.status = "cancelled";
      this.event(j, { phase: "cancelled" });
    }
    return j;
  }
  retry(jobId) {
    const j = this.store.get("job", jobId);
    need(j && !this.active.has(jobId), "재시도할 수 없는 작업입니다.");
    need(
      ["failed", "review_required", "interrupted", "cancelled"].includes(
        j.status,
      ),
      "재시도할 수 없는 작업입니다.",
    );
    if (j.projectId) {
      need(
        !this.store
          .list("job")
          .some(
            (x) =>
              x.id !== j.id &&
              x.projectId === j.projectId &&
              ["queued", "running"].includes(x.status),
          ),
        "프로젝트 작업이 진행 중입니다.",
        "JOB_BUSY",
      );
      need(
        this.store.get("project", j.projectId)?.revision === j.project.revision,
        "프로젝트가 변경되었습니다. 새 작업으로 실행하세요.",
        "VERSION_CONFLICT",
      );
    }
    if (
      j.kind === "image" &&
      (j.code === "GENERATION_FAILED" || j.progress.remoteCancelled === true)
    ) {
      delete j.promptId;
      delete j.submission;
    }
    if (
      j.code === "QC_FAILED" ||
      j.code === "QC_UNVERIFIABLE" ||
      j.code === "GENERATION_FAILED" ||
      j.progress.remoteCancelled === true
    ) {
      const s = j.segments[j.progress.segmentId];
      if (s) {
        s.previous = { ...s };
        delete s.promptId;
        delete s.submission;
        delete s.file;
        delete s.qc;
        s.seed = (s.seed || 0) + 1;
        delete s.graph;
      }
    }
    j.status = "queued";
    delete j.error;
    this.store.put("job", j.id, j);
    queueMicrotask(() => this.run(j));
    return j;
  }
  async call(j, role, input, contract, ctx) {
    return this.task(j.settings, role, input, contract, ctx);
  }
  async plan(j, ctx) {
    const p = j.project;
    need(p.synopsis?.trim(), "시놉시스를 입력해 주세요.");
    const constraints = j.input.constraints || [];
    const input = {
      synopsis: p.synopsis,
      modelProfile: p.modelProfile,
      duration: p.duration,
      previous: p.plan,
      constraints,
    };
    const analysis = await this.call(
      j,
      "analyze",
      input,
      '{"characters":[],"themes":[],"conflicts":[]}',
      ctx,
    );
    const story = await this.call(
      j,
      "story",
      { ...input, analysis },
      '{"plot":[{"title":"...","text":"..."}],"story":"..."}',
      ctx,
    );
    need(
      typeof story.story === "string" &&
        story.story.trim() &&
        Array.isArray(story.plot) &&
        story.plot.every(
          (b) => b && typeof b.title === "string" && typeof b.text === "string",
        ),
      "스토리 출력이 올바르지 않습니다.",
      "OUTPUT_INVALID",
    );
    const plan = validatePlan(
      await this.call(
        j,
        "timeline",
        { ...input, analysis, story },
        '{"segments":[{"id":"unique-id","title":"...","prompt":"영상 생성 지시","duration":15,"expectsFaces":true,"continuous":false}]}. 합계 duration 일치. 각 구간은 1~15초. 사용자 constraints의 id/내용/길이/순서는 정확히 유지.',
        ctx,
      ),
      p.duration,
      constraints,
    );
    const check = await this.call(
      j,
      "consistency",
      { ...input, story, plan },
      '{"valid":true,"issues":[]}. 이야기와 타임라인 및 수정 제약의 의미 일관성을 검토한다.',
      ctx,
    );
    need(
      check.valid === true,
      "이야기 정합성 검토에 문제가 있습니다.",
      "OUTPUT_INVALID",
    );
    const current = this.store.get("project", p.id);
    need(
      current.revision === p.revision,
      "작업 중 프로젝트가 변경되었습니다.",
      "VERSION_CONFLICT",
    );
    current.history ??= [];
    if (current.plan)
      current.history.push({
        revision: current.revision,
        plan: current.plan,
        story: current.story,
      });
    current.revision++;
    current.story = story;
    current.plan = plan;
    current.approved = false;
    current.pendingRevision = false;
    this.store.put("project", p.id, current);
    j.result = { project: current };
  }
  async enhance(j, ctx) {
    const { target, prompt, profile } = j.input;
    need(
      ["image", "video"].includes(target) &&
        ((prompt || "").trim() || (profile || "").trim()),
      "프롬프트 또는 모델 프로파일을 입력하세요.",
    );
    const result = await this.call(
      j,
      "enhance_" + target,
      {
        prompt: prompt || "",
        profile: profile || "",
        instruction: j.settings.enhancementInstruction,
      },
      '{"prompt":"강화된 생성 프롬프트"}. 고정 외형과 사용자의 의도를 유지한다.',
      ctx,
    );
    need(result.prompt?.trim(), "강화 결과가 비어 있습니다.", "OUTPUT_INVALID");
    j.result = { ...result, original: prompt || profile };
  }
  async selection(j, ctx) {
    const c = connection(j.settings, j.settings.comfy.connectionId);
    need(c.kind === "comfy", "ComfyUI 연결이 필요합니다.");
    const inv = await this.comfy.inventory(c, ctx.signal);
    const selected = structuredClone(j.input.selection || j.settings.comfy);
    if (j.kind === "image" || j.input.target === "image") {
      selected.model = selected.imageModel || null;
      selected.loras = selected.imageLoras || [];
    }
    selected.textEncoder ||= inv.textEncoders.find(
      (n) => n === "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    );
    selected.vae ||= inv.vaes.find((n) => n === "wan2.2_vae.safetensors");
    need(selected.model, "사용할 ComfyUI 모델을 선택하세요.", "MISSING_MODEL");
    const resolved =
      j.snapshot || (await recommend(j.settings, inv, selected, ctx));
    if (j.snapshot)
      need(
        j.snapshot.inventoryRevision === inv.revision,
        "서버 자산이 변경되어 저장된 실행 구성을 재사용할 수 없습니다.",
        "VERSION_CONFLICT",
      );
    return { c, inv, resolved };
  }
  async recommend(j, ctx) {
    j.result = (await this.selection(j, ctx)).resolved;
  }
  async saveOutput(j, c, outputs, ctx, suffix) {
    const files = Object.values(outputs).flatMap((o) => [
      ...(o.images || []),
      ...(o.videos || []),
      ...(o.gifs || []),
    ]);
    const file = files.find((f) =>
      suffix === "png"
        ? /\.(png|jpg|webp)$/i.test(f.filename)
        : /\.(mp4|webm|mov)$/i.test(f.filename),
    );
    need(file, "생성 결과 파일을 찾지 못했습니다.", "OUTPUT_INVALID");
    const response = await this.comfy.output(c, file, ctx.signal);
    const key = id() + "." + suffix;
    const path = resolve(this.store.dir, "media", key);
    await mkdir(resolve(this.store.dir, "media"), { recursive: true });
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    j.artifacts.push(key);
    return { key, path };
  }
  async image(j, ctx) {
    need(j.input.prompt?.trim(), "이미지 프롬프트가 필요합니다.");
    const { c, inv, resolved } = await this.selection(j, ctx);
    j.snapshot = resolved;
    const graph =
      j.graph ||
      buildGraph({
        kind: "image",
        inventory: inv,
        selection: resolved,
        prompt: j.input.prompt,
        seed: j.input.seed || 1,
      });
    j.graph = graph;
    this.event(j, { phase: "graph_validated" });
    const out = await this.comfy.execute(
      c,
      graph,
      {
        ...ctx,
        submission: j.submission,
        onSubmitting: (value) => {
          j.submission = value;
          this.event(j, { phase: "submitting" });
        },
        onSubmitted: (promptId) => {
          j.promptId = promptId;
          this.event(j, { phase: "queued", promptId });
        },
      },
      j.promptId,
    );
    j.result = await this.saveOutput(j, c, out.outputs, ctx, "png");
    const ref = {
      id: id(),
      name: j.input.name || "레퍼런스",
      profile: j.input.profile || "",
      prompt: j.input.prompt,
      imageKey: j.result.key,
      createdAt: Date.now(),
    };
    this.store.put("reference", ref.id, ref);
    j.result.reference = ref;
  }
  async video(j, ctx) {
    const p = j.project;
    need(
      p.approved && p.plan && !p.pendingRevision,
      "이야기·타임라인을 확정해 주세요.",
      "VERSION_CONFLICT",
    );
    const { c, inv, resolved } = await this.selection(j, ctx);
    if (j.snapshot) {
      need(
        j.snapshot.inventoryRevision === resolved.inventoryRevision,
        "서버 모델·노드가 변경되었습니다. 기존 작업을 자동 재실행하지 않습니다.",
        "VERSION_CONFLICT",
      );
    } else {
      j.snapshot = resolved;
      this.event(j, { phase: "graph_preparing" });
    }
    let anchors = [],
      previousFaces = [],
      previousFile;
    const reference = p.referenceId
      ? this.store.get("reference", p.referenceId)
      : null;
    for (let i = 0; i < p.plan.segments.length; i++) {
      ctx.signal.throwIfAborted();
      const segment = p.plan.segments[i];
      let s = (j.segments[segment.id] ??= {
        seed: Math.floor(Math.random() * 2147483647),
      });
      this.event(j, {
        segmentId: segment.id,
        segmentIndex: i,
        totalSegments: p.plan.segments.length,
        phase: "segment_start",
      });
      if (s.qc && ["pass", "no_face"].includes(s.qc.status)) {
        anchors = s.qc.anchors;
        previousFaces = s.qc.lastFaces;
        previousFile = s.file;
        continue;
      }
      if (!s.prompt) {
        const result = await this.call(
          j,
          "enhance_video",
          {
            prompt: segment.prompt,
            profile: p.modelProfile,
            instruction: j.settings.enhancementInstruction,
          },
          '{"prompt":"강화된 영상 프롬프트"}',
          ctx,
        );
        need(
          result.prompt?.trim(),
          "영상 프롬프트가 비어 있습니다.",
          "OUTPUT_INVALID",
        );
        s.prompt = result.prompt;
      }
      let startImage;
      if (previousFile && segment.continuous) {
        const path = resolve(this.store.dir, "media", id() + ".png");
        await lastFrame(previousFile.path, path, ctx.signal);
        startImage = await this.comfy.upload(
          c,
          await readFile(path),
          "boundary.png",
          ctx.signal,
        );
      } else if (reference) {
        startImage = await this.comfy.upload(
          c,
          await readFile(resolve(this.store.dir, "media", reference.imageKey)),
          "reference.png",
          ctx.signal,
        );
      }
      if (!s.file) {
        const graph =
          s.graph ||
          buildGraph({
            kind: "video",
            inventory: inv,
            selection: j.snapshot,
            prompt:
              s.prompt +
              " " +
              j.snapshot.loras.flatMap((l) => l.triggers).join(" "),
            seconds: segment.duration,
            seed: s.seed,
            startImage,
          });
        s.graph = graph;
        const out = await this.comfy.execute(
          c,
          graph,
          {
            ...ctx,
            submission: s.submission,
            onSubmitting: (value) => {
              s.submission = value;
              this.event(j, { phase: "submitting" });
            },
            onSubmitted: (promptId) => {
              s.promptId = promptId;
              this.event(j, { phase: "queued", promptId });
            },
          },
          s.promptId,
        );
        const original = await this.saveOutput(j, c, out.outputs, ctx, "mp4");
        const key = id() + ".mp4",
          path = resolve(this.store.dir, "media", key);
        await trimVideo(original.path, path, segment.duration, ctx.signal);
        s.file = { key, path };
        j.artifacts.push(key);
        this.event(j, { phase: "face_qc" });
      }
      s.qc = await this.qc(
        s.file.path,
        j.settings.qc,
        {
          anchors,
          previousFaces,
          expectsFaces: segment.expectsFaces !== false,
          continuous: !!segment.continuous,
          referenceImage: reference
            ? resolve(this.store.dir, "media", reference.imageKey)
            : null,
          models: resolve(this.store.dir, "qc-models"),
        },
        ctx,
      );
      this.event(j, {
        phase: "qc_result",
        qc: { ...s.qc, anchors: undefined, lastFaces: undefined },
      });
      if (!["pass", "no_face"].includes(s.qc.status))
        throw new AppError(
          s.qc.status === "fail" ? "QC_FAILED" : "QC_UNVERIFIABLE",
          "구간 얼굴·연결부 검수가 통과하지 못했습니다. 다음 구간은 대기합니다.",
        );
      anchors = s.qc.anchors;
      previousFaces = s.qc.lastFaces;
      previousFile = s.file;
      this.event(j, { phase: "segment_passed", completedSegments: i + 1 });
    }
    const manifest = resolve(this.store.dir, id() + ".txt");
    await writeFile(
      manifest,
      p.plan.segments
        .map((s) => `file '${j.segments[s.id].file.path}'`)
        .join("\n"),
    );
    const key = id() + ".mp4";
    await command(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        manifest,
        "-c",
        "copy",
        resolve(this.store.dir, "media", key),
      ],
      { signal: ctx.signal },
    );
    j.artifacts.push(key);
    j.result = { videoKey: key };
  }
}
