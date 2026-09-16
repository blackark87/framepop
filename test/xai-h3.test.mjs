import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Xai, trustedEndpoint } from "../server/xai.mjs";
import { buildGraph, h3Selection } from "../server/comfy.mjs";

const discovery = {
  issuer: "https://auth.x.ai",
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
  token_endpoint: "https://auth.x.ai/oauth2/token",
};
const device = {
  device_code: "private-device",
  user_code: "USER-CODE",
  verification_uri: "https://auth.x.ai/device",
  expires_in: 60,
  interval: 5,
};
const tokens = {
  access_token: "access-private",
  refresh_token: "refresh-private",
  expires_in: 3600,
};
async function oauthFixture(t, outcomes) {
  const requests = [],
    waits = [],
    records = new Map();
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    requests.push({
      path: req.url,
      body: Object.fromEntries(new URLSearchParams(body)),
      authorization: req.headers.authorization,
    });
    const next = outcomes.shift();
    res.writeHead(next?.error ? 400 : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(next || {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const store = {
    get: (k, id) => records.get(k + id),
    put: (k, id, v) => records.set(k + id, v),
  };
  const xai = new Xai(store, {
    fetch: (url, opts) =>
      fetch(
        "http://127.0.0.1:" + server.address().port + new URL(url).pathname,
        opts,
      ),
    sleep: async (ms) => {
      waits.push(ms);
      await new Promise(setImmediate);
    },
  });
  return { xai, store, requests, waits };
}
async function done(session) {
  for (let i = 0; i < 100 && session.status === "pending"; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(session.status, "pending");
}
test("standalone xAI HTTP flow handles pending/slow_down, owns tokens and discovers subscription models", async (t) => {
  const { xai, store, requests, waits } = await oauthFixture(t, [
    discovery,
    device,
    { error: "authorization_pending" },
    { error: "slow_down" },
    tokens,
    {
      data: [
        { id: "grok-build", api_backend: "responses" },
        { id: "grok-imagine-image", api_backend: "image" },
      ],
    },
  ]);
  const session = await xai.login();
  assert.equal(session.url, device.verification_uri);
  await done(session);
  assert.equal(session.status, "completed");
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.equal(store.get("secret", "xai").access, tokens.access_token);
  assert.equal(JSON.stringify(session).includes("private"), false);
  assert.deepEqual(await xai.models(), [
    { id: "grok-build", name: "grok-build" },
  ]);
  assert.equal(
    requests[1].body.client_id,
    "b1a00492-073a-47ea-816f-4c329264a828",
  );
  assert.equal(
    requests[2].body.grant_type,
    "urn:ietf:params:oauth:grant-type:device_code",
  );
  assert.equal(requests.at(-1).path, "/v1/models");
});
test("xAI denial preserves existing credential and never exposes provider payload", async (t) => {
  const { xai, store } = await oauthFixture(t, [
    discovery,
    device,
    { error: "access_denied", error_description: "private-provider-data" },
  ]);
  store.put("secret", "xai", { access: "existing" });
  const session = await xai.login();
  await done(session);
  assert.equal(session.status, "failed");
  assert.match(session.error, /거절/);
  assert.equal(session.error.includes("private-provider-data"), false);
  assert.equal(store.get("secret", "xai").access, "existing");
});
test("xAI concurrent refresh is exchanged once and rotates its own token", async (t) => {
  const { xai, store, requests } = await oauthFixture(t, [discovery, tokens]);
  store.put("secret", "xai", {
    access: "old",
    refresh: "old-refresh",
    expires: 1,
  });
  const [a, b] = await Promise.all([xai.credential(), xai.credential()]);
  assert.deepEqual(a, b);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.refresh_token, "old-refresh");
  assert.equal(store.get("secret", "xai").refresh, "refresh-private");
});
test("xAI rejects untrusted discovery before sending a device code or credential", async (t) => {
  const { xai, requests } = await oauthFixture(t, [
    { ...discovery, token_endpoint: "https://x.ai.attacker.test/token" },
  ]);
  await assert.rejects(xai.login(), { code: "AUTH_DISCOVERY_INVALID" });
  assert.equal(requests.length, 1);
  for (const u of [
    "http://auth.x.ai/token",
    "https://user@auth.x.ai/token",
    "https://auth.x.ai:123/token",
  ])
    assert.throws(() => trustedEndpoint(u));
});
const names = [
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "MiniMaxH3ImageToVideo",
  "LoadImage",
  "RandomNoise",
  "BasicGuider",
  "KSamplerSelect",
  "BasicScheduler",
  "SamplerCustomAdvanced",
  "VAEDecode",
  "VAEDecodeAudio",
  "CreateVideo",
  "SaveVideo",
];
const inv = {
  nodes: Object.fromEntries(names.map((n) => [n, {}])),
  models: [
    {
      name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      type: "diffusion_models",
    },
  ],
  textEncoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
  vaes: [
    "minimax_h3_video_vae_fp16.safetensors",
    "minimax_h3_audio_vae_fp32.safetensors",
  ],
  loras: [],
};
test("H3 official AV graph handles no/first/last/both keyframes without requiring references", () => {
  for (const [startImage, endImage] of [
    [undefined, undefined],
    ["first.png", undefined],
    [undefined, "last.png"],
    ["first.png", "last.png"],
  ]) {
    const g = buildGraph({
      kind: "video",
      inventory: inv,
      selection: { model: inv.models[0].name },
      prompt: "A person walks.",
      seconds: 15,
      startImage,
      endImage,
    });
    const find = (type) =>
      Object.entries(g).find(([id, n]) => n.class_type === type);
    const [conditionId, condition] = find("MiniMaxH3ImageToVideo");
    assert.equal(condition.inputs.length, 362);
    assert.equal(Boolean(condition.inputs.first_frame), Boolean(startImage));
    assert.equal(Boolean(condition.inputs.last_frame), Boolean(endImage));
    assert.equal(find("CLIPLoader")[1].inputs.type, "minimax");
    assert.deepEqual(find("SamplerCustomAdvanced")[1].inputs.latent_image, [
      conditionId,
      1,
    ]);
    assert.deepEqual(find("BasicGuider")[1].inputs.conditioning, [
      conditionId,
      0,
    ]);
    assert.equal(find("BasicScheduler")[1].inputs.steps, 20);
    assert.equal(
      find("KSamplerSelect")[1].inputs.sampler_name,
      "res_multistep",
    );
    assert.deepEqual(
      find("VAEDecode")[1].inputs.samples,
      find("VAEDecodeAudio")[1].inputs.samples,
    );
    assert.ok(find("CreateVideo")[1].inputs.audio);
    assert.equal(
      Object.values(g).some((n) =>
        /Wan|ModelSamplingSD3|Lora/.test(n.class_type),
      ),
      false,
    );
    for (const node of Object.values(g))
      for (const input of Object.values(node.inputs))
        if (Array.isArray(input)) assert.ok(g[input[0]]);
  }
});
test("H3 requires actual family-specific model/encoder/both VAEs; unsupported models cannot be relabelled", () => {
  const selected = { model: inv.models[0].name };
  assert.throws(
    () => h3Selection(inv, { model: "wan2.2_ti2v_5B.safetensors" }),
    { code: "UNSUPPORTED_MODEL" },
  );
  assert.throws(
    () => h3Selection({ ...inv, vaes: inv.vaes.slice(0, 1) }, selected),
    { code: "MISSING_MODEL" },
  );
  assert.throws(
    () => h3Selection(inv, { ...selected, textEncoder: "wrong.safetensors" }),
    { code: "MISSING_MODEL" },
  );
  const short = buildGraph({
    kind: "video",
    inventory: inv,
    selection: selected,
    prompt: "walk",
    seconds: 1,
  });
  assert.equal(
    Object.values(short).find((n) => n.class_type === "MiniMaxH3ImageToVideo")
      .inputs.length,
    124,
  );
});
test("xAI expired device response stops polling without storing credentials", async (t) => {
  const { xai, store, requests } = await oauthFixture(t, [
    discovery,
    device,
    { error: "expired_token" },
  ]);
  const session = await xai.login();
  await done(session);
  assert.equal(session.status, "failed");
  assert.match(session.error, /만료/);
  assert.equal(store.get("secret", "xai"), undefined);
  assert.equal(requests.length, 3);
});
test("xAI rejected refresh is not retried or converted to API-key auth", async (t) => {
  const { xai, store, requests } = await oauthFixture(t, [
    discovery,
    { error: "invalid_grant" },
  ]);
  store.put("secret", "xai", {
    access: "old",
    refresh: "old-refresh",
    expires: 1,
  });
  await assert.rejects(xai.credential(), { code: "AUTH_FAILED" });
  assert.equal(requests.length, 2);
  assert.equal(store.get("secret", "xai").access, "old");
});
