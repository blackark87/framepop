import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store, defaults } from "../server/store.mjs";
import { Jobs, validatePlan } from "../server/jobs.mjs";
import { complete, task, assertRoute } from "../server/llm.mjs";
import { buildGraph, execute } from "../server/comfy.mjs";
import { verifyRecommendation } from "../server/recommend.mjs";
import { createApp } from "../server/index.mjs";
import { command, qc } from "../server/media.mjs";
const temp = () => mkdtemp(join(tmpdir(), "framepop-test-"));
const settings = () => ({
  ...defaults(),
  assignmentMode: "manual",
  connections: [
    {
      id: "local",
      kind: "ollama",
      name: "local",
      url: "http://localhost:11434",
      models: [{ id: "test" }],
    },
    { id: "gpu", name: "GPU", kind: "comfy", url: "http://localhost:8188" },
  ],
  comfy: {
    connectionId: "gpu",
    model: "wan2.2_ti2v_5B_fp16.safetensors",
    loras: [],
  },
});
const segment = (id = "s1", duration = 1) => ({
  id,
  title: id,
  prompt: "A person walks.",
  duration,
  expectsFaces: true,
});
const p = () => ({
  id: "p",
  title: "Test",
  synopsis: "A person walks.",
  modelProfile: "",
  duration: 2,
  mode: "local",
  revision: 1,
  approved: true,
  plan: { segments: [segment(), segment("s2")] },
});
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return "http://127.0.0.1:" + server.address().port;
}
async function storeFor(t) {
  const dir = await temp();
  const s = new Store(dir);
  s.put("settings", "main", settings());
  t.after(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return s;
}
async function settled(store, id) {
  for (let i = 0; i < 500; i++) {
    const j = store.get("job", id);
    if (!["running", "queued"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("job timeout");
}
const nodes = Object.fromEntries(
  [
    "UNETLoader",
    "LoraLoaderModelOnly",
    "ModelSamplingSD3",
    "CLIPLoader",
    "VAELoader",
    "Wan22ImageToVideoLatent",
    "LoadImage",
    "CLIPTextEncode",
    "KSampler",
    "VAEDecode",
    "CreateVideo",
    "SaveVideo",
    "CheckpointLoaderSimple",
    "LoraLoader",
    "EmptyLatentImage",
    "SaveImage",
  ].map((n) => [n, {}]),
);
const inventory = {
  revision: "r1",
  nodes,
  models: [
    { name: "wan2.2_ti2v_5B_fp16.safetensors", type: "diffusion_models" },
  ],
  loras: ["a", "b"],
  textEncoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
  vaes: ["wan2.2_vae.safetensors"],
  assets: [],
};
test("timeline rejects duration mismatch, duplicate IDs and lost exact edits", () => {
  assert.throws(() => validatePlan({ segments: [segment()] }, 2));
  assert.throws(() => validatePlan({ segments: [segment(), segment()] }, 2));
  assert.throws(() =>
    validatePlan({ segments: [segment()] }, 1, [
      { id: "s1", prompt: "Changed" },
    ]),
  );
  assert.throws(() =>
    validatePlan({ segments: [segment()] }, 1, [{ id: "s1", deleted: true }]),
  );
  assert.equal(
    validatePlan({ segments: [segment()] }, 1, [{ id: "s1", index: 0 }])
      .segments.length,
    1,
  );
});
test("Ollama stream is consumed through actual HTTP adapter", async (t) => {
  let received;
  const url = await fixture(t, async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    received = JSON.parse(b);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { content: '{"prompt":' } }) + "\n");
    res.end(
      JSON.stringify({ message: { content: '"ok"}' }, done: true }) + "\n",
    );
  });
  const events = [];
  const result = await complete(
    { kind: "ollama", url },
    "qwen",
    [{ role: "user", content: "test" }],
    { onProgress: (e) => events.push(e) },
  );
  assert.equal(JSON.parse(result).prompt, "ok");
  assert.equal(received.stream, true);
  assert.equal(received.format, "json");
  assert.equal(events.length, 2);
});
test("local routing and enhancement never fall back to cloud", () => {
  const s = { connections: [{ id: "cloud", kind: "xai" }] };
  assert.throws(
    () =>
      assertRoute(s, { connectionId: "cloud", model: "grok" }, true, "story"),
    { code: "POLICY_BLOCKED" },
  );
  assert.throws(
    () =>
      assertRoute(
        s,
        { connectionId: "cloud", model: "grok" },
        false,
        "enhance_video",
      ),
    { code: "POLICY_BLOCKED" },
  );
});
test("plan pipeline, idempotency, busy guard and persistence", async (t) => {
  const store = await storeFor(t);
  store.put("project", "p", p());
  const called = [];
  const jobs = new Jobs(store, {
    taskFn: async (s, role, input) => {
      called.push(role);
      if (role === "story")
        return {
          story: "A walk",
          plot: [{ title: "Walk", text: "The person walks." }],
        };
      if (role === "timeline") return { segments: [segment(), segment("s2")] };
      if (role === "consistency") return { valid: true };
      return {};
    },
  });
  const j = jobs.create("plan", "p", {}, "key");
  assert.equal(jobs.create("plan", "p", {}, "key").id, j.id);
  assert.throws(() => jobs.create("revise", "p", {}), { code: "JOB_BUSY" });
  assert.equal(store.get("project", "p").approved, false);
  const done = await settled(store, j.id);
  assert.equal(done.status, "completed");
  assert.deepEqual(called, ["analyze", "story", "timeline", "consistency"]);
  assert.equal(store.get("project", "p").revision, 2);
  assert.ok(store.events(j.id).length >= 2);
  assert.throws(() => jobs.retry(j.id));
});
test("failed revision retains old story and blocks approval", async (t) => {
  const store = await storeFor(t);
  store.put("project", "p", p());
  const jobs = new Jobs(store, {
    taskFn: async (s, r) =>
      r === "story"
        ? { story: "draft", plot: [] }
        : r === "timeline"
          ? { segments: [segment(), segment("s2")] }
          : {},
  });
  const done = await settled(
    store,
    jobs.create("revise", "p", {
      constraints: [{ id: "s1", prompt: "exact new text" }],
    }).id,
  );
  assert.equal(done.code, "CONSTRAINT_VIOLATION");
  assert.equal(
    store.get("project", "p").plan.segments[0].prompt,
    "A person walks.",
  );
  assert.equal(store.get("project", "p").pendingRevision, true);
});
test("server restart preserves interrupted job and prompt ID", async (t) => {
  const store = await storeFor(t);
  store.put("job", "j", {
    id: "j",
    status: "running",
    segments: { s1: { promptId: "gpu-id" } },
  });
  new Jobs(store);
  assert.equal(store.get("job", "j").status, "interrupted");
  assert.equal(store.get("job", "j").segments.s1.promptId, "gpu-id");
});
test("workflow applies multiple LoRAs in order with resolved strengths", () => {
  const selection = {
    ...settings().comfy,
    textEncoder: inventory.textEncoders[0],
    vae: inventory.vaes[0],
    loras: [
      { name: "a", strength: 0.6 },
      { name: "b", strength: 0.8 },
    ],
  };
  const graph = buildGraph({
    kind: "video",
    inventory,
    selection,
    prompt: "walk",
    seconds: 15,
  });
  const loras = Object.values(graph).filter(
    (n) => n.class_type === "LoraLoaderModelOnly",
  );
  assert.deepEqual(
    loras.map((l) => [l.inputs.lora_name, l.inputs.strength_model]),
    [
      ["a", 0.6],
      ["b", 0.8],
    ],
  );
  assert.deepEqual(loras[1].inputs.model, ["2", 0]);
  assert.equal(
    Object.values(graph).find((n) => n.class_type === "Wan22ImageToVideoLatent")
      .inputs.length,
    361,
  );
  assert.throws(
    () =>
      buildGraph({
        kind: "video",
        inventory: { ...inventory, nodes: {} },
        selection,
        prompt: "x",
      }),
    { code: "MISSING_NODE" },
  );
});
test("Comfy history resumes without duplicate submission; partial output is not completion", async (t) => {
  let posts = 0,
    hits = 0;
  const url = await fixture(t, (req, res) => {
    if (req.method === "POST") posts++;
    res.setHeader("content-type", "application/json");
    if(req.url==="/queue")return res.end(JSON.stringify({queue_running:[[0,"existing"]],queue_pending:[]}));
    hits++;
    res.end(
      JSON.stringify({
        existing: {
          status: {
            completed: hits > 1,
            status_str: hits > 1 ? "success" : "running",
          },
          outputs: { save: { images: [{ filename: "frame.png" }] } },
        },
      }),
    );
  });
  const c = new AbortController();
  const out = await execute(
    { url, token: "fixture" },
    {},
    { signal: c.signal, event: () => {} },
    "existing",
  );
  assert.equal(out.promptId, "existing");
  assert.equal(posts, 0);
  assert.equal(hits, 2);
});
test("API validation, conflict guard, optional profile and byte range for iPhone", async (t) => {
  const dir = await temp();
  const app = await createApp({ dataDir: dir });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.close();
    app.store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const root = "http://127.0.0.1:" + app.server.address().port;
  const call = (path, method = "GET", body) =>
    fetch(root + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await call("/api/bootstrap")).status, 200);
  let res = await call("/api/projects", "POST", { title: "hello" });
  const project = await res.json();
  assert.equal(project.modelProfile, "");
  assert.equal(project.referenceId, null);
  res = await call("/api/projects/" + project.id, "PATCH", {
    revision: 0,
    duration: 2,
  });
  assert.equal(res.status, 409);
  await writeFile(join(dir, "media", "clip.mp4"), "0123456789");
  res = await fetch(root + "/media/clip.mp4", {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), "2345");
  res = await fetch(root + "/media/clip.mp4", {
    headers: { Range: "bytes=99-" },
  });
  assert.equal(res.status, 416);
  const b = await (await call("/api/bootstrap")).json();
  b.settings.qc.maxBadFraction = 2;
  assert.equal((await call("/api/settings", "PUT", b.settings)).status, 422);
});
test("sequential QC gates next segment; retry only regenerates failed segment", async (t) => {
  const store = await storeFor(t);
  store.put("project", "p", {
    ...p(),
    duration: 3,
    plan: { segments: [segment(), segment("s2"), segment("s3")] },
  });
  const clip = join(store.dir, "fixture.mp4");
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:r=24:d=1",
    "-c:v",
    "libx264",
    clip,
  ]);
  const generated = [],
    checked = [];
  let fail = true;
  const jobs = new Jobs(store, {
    taskFn: async () => ({ prompt: "enhanced" }),
    comfy: {
      inventory: async () => inventory,
      execute: async (c, g, ctx) => {
        generated.push(g);
        ctx.onSubmitted("id" + generated.length);
        return { outputs: { save: { videos: [{ filename: "clip.mp4" }] } } };
      },
      output: async () => new Response(await readFile(clip)),
      upload: async () => "",
    },
    qcFn: async () => {
      checked.push(1);
      return {
        status: fail && checked.length === 2 ? "fail" : "pass",
        anchors: [],
        lastFaces: [],
        framesChecked: 24,
      };
    },
  });
  const initial = await settled(store, jobs.create("video", "p").id);
  assert.equal(initial.code, "QC_FAILED");
  assert.equal(generated.length, 2);
  assert.equal(Object.keys(initial.segments).length, 2);
  const firstKey = initial.segments.s1.file.key;
  fail = false;
  jobs.retry(initial.id);
  const done = await settled(store, initial.id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(generated.length, 4);
  assert.equal(done.segments.s1.file.key, firstKey);
  assert.ok(done.result.videoKey);
  assert.equal(checked.length, 4);
});
test("real QC decodes all frames and never passes missing expected face", async (t) => {
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clip = join(dir, "blank.mp4");
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=24:d=1",
    "-c:v",
    "libx264",
    clip,
  ]);
  const context = { models: resolve("data/qc-models"), expectsFaces: true };
  const result = await qc(clip, defaults().qc, context, { event: () => {} });
  assert.equal(result.framesChecked, 24);
  assert.equal(result.status, "unverifiable");
  const noFace = await qc(
    clip,
    defaults().qc,
    { ...context, expectsFaces: false },
    { event: () => {} },
  );
  assert.equal(noFace.status, "no_face");
});

test("LoRA requires exact source quotes, compatibility and a supported numeric range", () => {
  const sources = [{ text: "Wan 2.2. Recommended strength 0.6 to 0.8." }],
    good = {
      compatible: true,
      sourceIndex: 0,
      strength: 0.7,
      min: 0.6,
      max: 0.8,
      quote: "Recommended strength 0.6 to 0.8.",
      compatibilityQuote: "Wan 2.2",
      triggers: [],
    };
  assert.equal(verifyRecommendation(good, sources), sources[0]);
  for (const patch of [
    { strength: 1 },
    { quote: "Recommended strength 0.5 to 1.0." },
    { compatibilityQuote: "SDXL" },
    { min: 0.5 },
    { compatible: false },
    { sourceIndex: 9 },
  ])
    assert.throws(() => verifyRecommendation({ ...good, ...patch }, sources), {
      code: "RECOMMENDATION_UNVERIFIED",
    });
});
