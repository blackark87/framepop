import { randomUUID, createHash } from "node:crypto";
import { AppError, need, baseURL, json, request } from "./http.mjs";
export async function inventory(c, signal) {
  const base = baseURL(c.url),
    headers = c.token ? { Authorization: `Bearer ${c.token}` } : {};
  const nodes = await json(base + "/object_info", { headers, signal });
  const select = (node, key) => {
    const a = nodes[node]?.input?.required?.[key]?.[0];
    return Array.isArray(a) ? a : [];
  };
  let assets = [];
  try {
    assets =
      (
        await json(base + "/framepop/assets", {
          headers,
          signal,
          timeout: 180000,
        })
      ).assets || [];
  } catch (e) {
    if (e.code === "CONNECTION_UNAVAILABLE") throw e;
  }
  return {
    revision: createHash("sha256")
      .update(JSON.stringify({ nodes, assets }))
      .digest("hex"),
    nodes,
    models: [
      ...select("UNETLoader", "unet_name").map((name) => ({
        name,
        type: "diffusion_models",
      })),
      ...select("CheckpointLoaderSimple", "ckpt_name").map((name) => ({
        name,
        type: "checkpoints",
      })),
    ],
    loras: select("LoraLoaderModelOnly", "lora_name").length
      ? select("LoraLoaderModelOnly", "lora_name")
      : select("LoraLoader", "lora_name"),
    textEncoders: select("CLIPLoader", "clip_name"),
    vaes: select("VAELoader", "vae_name"),
    assets,
    hashSupport: assets.length > 0,
  };
}
// Comfy-Org workflow_templates/video_minimax_h3_i2v.json, non-Turbo path.
export function h3Selection(inv, selected) {
  need(
    /minimax[_-]h3.*fl2va/i.test(selected.model || "") &&
      inv.models.some(
        (m) => m.name === selected.model && m.type === "diffusion_models",
      ),
    "영상 모델은 MiniMax H3 FL2VA 파일을 선택하세요.",
    "UNSUPPORTED_MODEL",
  );
  const choose = (value, files, pattern, preferred, label) => {
    const candidates = files.filter((n) => pattern.test(n));
    const found =
      value ||
      candidates.find((n) => n.split("/").pop() === preferred) ||
      (candidates.length === 1 ? candidates[0] : null);
    need(
      found && candidates.includes(found),
      `${label} 파일을 확인하세요. 설정 → ComfyUI 자산에서 선택할 수 있습니다.`,
      "MISSING_MODEL",
    );
    return found;
  };
  return {
    ...selected,
    workflow: "minimax-h3-fl2va-v1",
    textEncoder: choose(
      selected.textEncoder,
      inv.textEncoders,
      /qwen3.*minimax[_-]h3/i,
      "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      "H3 텍스트 인코더",
    ),
    vae: choose(
      selected.vae,
      inv.vaes,
      /minimax[_-]h3[_-]video[_-]vae/i,
      "minimax_h3_video_vae_fp16.safetensors",
      "H3 영상 VAE",
    ),
    audioVae: choose(
      selected.audioVae,
      inv.vaes,
      /minimax[_-]h3[_-]audio[_-]vae/i,
      "minimax_h3_audio_vae_fp32.safetensors",
      "H3 오디오 VAE",
    ),
  };
}
export function buildGraph({
  kind,
  inventory: inv,
  selection,
  prompt,
  negative = "",
  seconds = 5,
  fps = 24,
  seed = 0,
  startImage,
  endImage,
  referenceImage,
}) {
  let g = {},
    index = 0;
  const add = (class_type, inputs) => {
    need(
      inv.nodes[class_type],
      `필수 ComfyUI 노드가 없습니다: ${class_type}`,
      "MISSING_NODE",
    );
    const key = String(++index);
    g[key] = { class_type, inputs };
    return [key, 0];
  };
  let model, clip, vae, latent;
  const file = selection.model;
  need(
    inv.models.some((m) => m.name === file),
    "선택한 모델 파일이 서버에 없습니다.",
    "MISSING_MODEL",
  );
  if (kind === "image") {
    need(
      inv.models.some((m) => m.name === file && m.type === "checkpoints"),
      "이미지 생성에는 지원 checkpoint 모델을 선택하세요.",
      "UNSUPPORTED_MODEL",
    );
    const ck = add("CheckpointLoaderSimple", { ckpt_name: file });
    model = ck;
    clip = [ck[0], 1];
    vae = [ck[0], 2];
    for (const l of selection.loras || []) {
      const n = add("LoraLoader", {
        model,
        clip,
        lora_name: l.name,
        strength_model: l.strength,
        strength_clip: l.textEncoderStrength ?? 0,
      });
      model = n;
      clip = [n[0], 1];
    }
    latent = add("EmptyLatentImage", {
      width: 1024,
      height: 1024,
      batch_size: 1,
    });
    if (referenceImage) {
      const image = add("LoadImage", { image: referenceImage });
      latent = add("VAEEncode", { pixels: image, vae });
    }
  } else {
    selection = h3Selection(inv, selection);
    need(
      fps === 24 && Number.isFinite(seconds) && seconds > 0 && seconds <= 15,
      "H3 영상은 24fps, 구간당 최대 15초로 생성합니다.",
      "INVALID_INPUT",
    );
    model = add("UNETLoader", { unet_name: file, weight_dtype: "default" });
    for (const l of selection.loras || []) {
      need(
        inv.loras.includes(l.name) && Number.isFinite(l.strength),
        "LoRA 파일과 확인된 권장 강도가 필요합니다.",
        "MISSING_MODEL",
      );
      model = add("LoraLoaderModelOnly", {
        model,
        lora_name: l.name,
        strength_model: l.strength,
      });
    }
    clip = add("CLIPLoader", {
      clip_name: selection.textEncoder,
      type: "minimax",
      device: "default",
    });
    vae = add("VAELoader", { vae_name: selection.vae });
    const audioVae = add("VAELoader", { vae_name: selection.audioVae });
    // H3 trained range starts near 5 seconds; shorter timeline clips are trimmed.
    const length = Math.ceil((Math.max(5, seconds) * fps - 5) / 17) * 17 + 5;
    const inputs = { clip, vae, prompt, width: 1344, height: 768, length };
    if (startImage)
      inputs.first_frame = add("LoadImage", { image: startImage });
    if (endImage) inputs.last_frame = add("LoadImage", { image: endImage });
    const conditioning = add("MiniMaxH3ImageToVideo", inputs);
    const noise = add("RandomNoise", { noise_seed: seed });
    const guider = add("BasicGuider", { model, conditioning });
    const sampler = add("KSamplerSelect", { sampler_name: "res_multistep" });
    const sigmas = add("BasicScheduler", {
      model,
      scheduler: "simple",
      steps: 20,
      denoise: 1,
    });
    const samples = add("SamplerCustomAdvanced", {
      noise,
      guider,
      sampler,
      sigmas,
      latent_image: [conditioning[0], 1],
    });
    const images = add("VAEDecode", { samples, vae });
    const audio = add("VAEDecodeAudio", { samples, vae: audioVae });
    const video = add("CreateVideo", { images, audio, fps });
    add("SaveVideo", {
      video,
      filename_prefix: "Framepop/" + randomUUID(),
      format: "mp4",
      codec: "h264",
    });
    return g;
  }
  const positive = add("CLIPTextEncode", { clip, text: prompt }),
    neg = add("CLIPTextEncode", { clip, text: negative });
  const sampled = add("KSampler", {
    model,
    positive,
    negative: neg,
    latent_image: latent,
    seed,
    steps: 25,
    cfg: 6,
    sampler_name: "euler",
    scheduler: "normal",
    denoise: referenceImage ? 0.75 : 1,
  });
  const images = add("VAEDecode", { samples: sampled, vae });
  add("SaveImage", { images, filename_prefix: "Framepop/" + randomUUID() });
  return g;
}
export async function upload(c, buffer, filename, signal) {
  const body = new FormData();
  body.append("image", new Blob([buffer]), filename);
  body.append("overwrite", "false");
  const result = await json(baseURL(c.url) + "/upload/image", {
    method: "POST",
    body,
    signal,
    headers: c.token ? { Authorization: `Bearer ${c.token}` } : {},
  });
  return result.subfolder ? result.subfolder + "/" + result.name : result.name;
}
export async function execute(c, graph, ctx, resumePrompt) {
  const base = baseURL(c.url),
    clientId = ctx.submission?.clientId || randomUUID(),
    headers = c.token ? { Authorization: `Bearer ${c.token}` } : {};
  let promptId = resumePrompt,
    ws;
  const event = (e) => ctx.event({ ...e, promptId });
  if (!c.token) {
    try {
      ws = new WebSocket(
        base.replace(/^http/, "ws") + "/ws?clientId=" + clientId,
      );
      ws.addEventListener("message", (m) => {
        if (typeof m.data !== "string") return;
        let e;
        try {
          e = JSON.parse(m.data);
        } catch {
          return;
        }
        const d = e.data || {};
        if (d.prompt_id && d.prompt_id !== promptId) return;
        if (
          [
            "progress",
            "executing",
            "execution_error",
            "execution_cached",
          ].includes(e.type)
        )
          event({ phase: e.type, node: d.node, value: d.value, max: d.max });
      });
    } catch {}
  }
  try {
    if (!promptId && ctx.submission) {
      const queue = await json(base + "/queue", {
        headers,
        signal: ctx.signal,
      });
      const history = await json(base + "/history?max_items=200", {
        headers,
        signal: ctx.signal,
      });
      const match = [
        ...(queue.queue_running || []),
        ...(queue.queue_pending || []),
        ...Object.values(history).map((x) => x.prompt),
      ].find((x) => x?.[3]?.client_id === clientId);
      need(
        match,
        "제출 결과를 확인할 수 없습니다. ComfyUI 대기열·기록에서 확인 후 새 작업으로 실행하세요.",
        "SUBMISSION_UNCERTAIN",
      );
      promptId = match[1];
      ctx.onSubmitted(promptId);
    }
    if (!promptId) {
      ctx.onSubmitting?.({ clientId });
      ctx.event({ phase: "submitting", clientId });
      const result = await json(base + "/prompt", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: graph,
          client_id: clientId,
          extra_data: { framepopJob: ctx.jobId },
        }),
        signal: ctx.signal,
        timeout: 60000,
      });
      need(
        result.prompt_id && !result.error,
        "ComfyUI가 실행 구성을 거절했습니다.",
        "GRAPH_INVALID",
      );
      promptId = result.prompt_id;
      ctx.onSubmitted(promptId);
      event({ phase: "queued" });
    }
    let failures = 0,
      queueCheckedAt = 0;
    while (true) {
      ctx.signal?.throwIfAborted();
      let result;
      try {
        result = await json(base + "/history/" + encodeURIComponent(promptId), {
          headers,
          signal: ctx.signal,
          timeout: 15000,
        });
        failures = 0;
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        if (++failures > 3)
          throw new AppError(
            "CONNECTION_UNAVAILABLE",
            "ComfyUI 연결이 끊겼습니다. 작업 ID를 보존했습니다.",
            503,
          );
        event({ phase: "connection_delayed" });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const history = result[promptId];
      if (history) {
        if (history.status?.status_str === "error")
          throw new AppError(
            "GENERATION_FAILED",
            "ComfyUI 실행 중 오류가 발생했습니다.",
          );
        if (
          history.status?.completed &&
          history.status?.status_str === "success"
        ) {
          event({ phase: "generation_completed" });
          return { promptId, outputs: history.outputs };
        }
      }
      if ((!ws || ws.readyState !== 1) && Date.now() - queueCheckedAt > 5000) {
        const queue = await json(base + "/queue", {
          headers,
          signal: ctx.signal,
          timeout: 10000,
        });
        queueCheckedAt = Date.now();
        if ((queue.queue_running || []).some((row) => row[1] === promptId))
          event({ phase: "executing" });
      }
      event({ heartbeatAt: Date.now() });
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    ws?.close();
    if (ctx.signal?.aborted && promptId) {
      try {
        const r = await json(
          base + "/api/jobs/" + encodeURIComponent(promptId) + "/cancel",
          { method: "POST", headers, timeout: 10000 },
        );
        ctx.event({ phase: "remote_cancel", remoteCancelled: r.cancelled });
      } catch {
        ctx.event({
          phase: "remote_cancel_unconfirmed",
          warning:
            "원격 중단을 확인하지 못했습니다. 다음 구간은 실행하지 않습니다.",
        });
      }
    }
  }
}
export async function output(c, file, signal) {
  need(file?.filename, "생성 파일이 없습니다.", "OUTPUT_INVALID");
  const q = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder || "",
    type: file.type || "output",
  });
  return request(baseURL(c.url) + "/view?" + q, {
    signal,
    timeout: 300000,
    headers: c.token ? { Authorization: `Bearer ${c.token}` } : {},
  });
}
