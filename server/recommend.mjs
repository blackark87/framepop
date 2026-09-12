import { AppError, need, json, request } from "./http.mjs";
import { task } from "./llm.mjs";
export async function findSource(asset, signal) {
  need(
    /^[a-f0-9]{64}$/i.test(asset?.sha256 || ""),
    "정확한 파일 식별을 위해 ComfyUI에 framepop_assets 확장이 필요합니다.",
    "ASSET_IDENTITY_REQUIRED",
  );
  let sources = [];
  try {
    const v = await json(
      "https://civitai.com/api/v1/model-versions/by-hash/" + asset.sha256,
      { signal, timeout: 30000 },
    );
    const match = v.files?.find(
      (f) => f.hashes?.SHA256?.toLowerCase() === asset.sha256.toLowerCase(),
    );
    if (match) {
      const model = await json(
        "https://civitai.com/api/v1/models/" + v.modelId,
        { signal, timeout: 30000 },
      );
      sources.push({
        url: `https://civitai.com/models/${v.modelId}?modelVersionId=${v.id}`,
        version: String(v.id),
        sha256: asset.sha256,
        text: JSON.stringify({
          baseModel: v.baseModel,
          versionDescription: v.description,
          modelDescription: model.description,
          trainedWords: v.trainedWords,
        }),
      });
    }
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  if (!sources.length) {
    const filename = asset.name.split("/").pop();
    const candidates = await json(
      "https://huggingface.co/api/models?search=" +
        encodeURIComponent(filename.replace(/\.safetensors$/, "")) +
        "&limit=6",
      { signal },
    ).catch(() => []);
    const hint = asset.metadata?.hf_repo_id;
    if (hint && /^[\w.-]+\/[\w.-]+$/.test(hint))
      candidates.unshift({ id: hint });
    for (const c of candidates.slice(0, 6)) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(c.id || "")) continue;
      const m = await json(
        "https://huggingface.co/api/models/" + c.id + "?blobs=true",
        { signal },
      ).catch(() => null);
      if (!m?.siblings?.some((f) => f.lfs?.sha256 === asset.sha256)) continue;
      const revision = m.sha;
      need(/^[a-f0-9]{40}$/.test(revision), "배포 버전을 확인하지 못했습니다.");
      const url = `https://huggingface.co/${c.id}/raw/${revision}/README.md`;
      const text = await (await request(url, { signal })).text();
      sources.push({
        url: `https://huggingface.co/${c.id}/blob/${revision}/README.md`,
        version: revision,
        sha256: asset.sha256,
        text: text.slice(0, 60000),
      });
      break;
    }
  }
  need(
    sources.length,
    "일치하는 LoRA 배포 버전을 찾지 못했습니다.",
    "SOURCE_NOT_FOUND",
  );
  return sources.map((s) => ({ ...s, checkedAt: new Date().toISOString() }));
}
export async function recommend(settings, inv, selection, ctx) {
  const loras = [];
  for (const name of selection.loras || []) {
    need(
      inv.loras.includes(name),
      "선택 LoRA가 서버에 없습니다.",
      "MISSING_MODEL",
    );
    ctx.event({ phase: "source_lookup", asset: name });
    const asset = inv.assets.find((a) => a.type === "loras" && a.name === name);
    const sources = await findSource(asset, ctx.signal);
    const data = await task(
      settings,
      "lora_review",
      {
        model: selection.model,
        selectedLoras: selection.loras,
        asset: name,
        sources,
      },
      "JSON {compatible:boolean, strength:number|null, min:number|null,max:number|null, quote:string, compatibilityQuote:string, sourceIndex:integer, reason:string, triggers:string[]}. 원문에 명시된 모델 강도 범위만 사용한다. 숫자를 추정하지 않는다. 근거가 없거나 기본 모델 호환성을 확인하지 못하면 compatible=false,strength=null. quote는 권장 강도를 포함한 원문 그대로여야 한다. compatibilityQuote는 해당 LoRA의 기반 모델을 명시한 원문 그대로여야 한다. 선택 모델과 기반 모델의 일치가 불명확하면 compatible=false. 텍스트 인코더 강도를 추정하지 않는다.",
      ctx,
    );
    const source = verifyRecommendation(data, sources);
    loras.push({
      name,
      strength: data.strength,
      textEncoderStrength: 0,
      sha256: asset.sha256,
      triggers: data.triggers || [],
      reason: data.reason,
      source: { ...source, text: undefined },
      quote: data.quote,
      compatibilityQuote: data.compatibilityQuote,
    });
  }
  return { ...selection, loras, inventoryRevision: inv.revision };
}

export function verifyRecommendation(data, sources) {
  const source = sources[data.sourceIndex];
  need(
    data.compatible === true &&
      source &&
      typeof data.quote === "string" &&
      data.quote.length >= 3 &&
      source.text.includes(data.quote),
    "권장 강도와 호환성의 근거를 확인하지 못했습니다.",
    "RECOMMENDATION_UNVERIFIED",
  );
  need(
    [data.strength, data.min, data.max].every(Number.isFinite) &&
      data.min <= data.strength &&
      data.strength <= data.max &&
      Math.abs(data.strength) <= 10,
    "권장 강도 범위를 확인하지 못했습니다.",
    "RECOMMENDATION_UNVERIFIED",
  );
  const numbers = (data.quote.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  need(
    numbers.includes(data.min) && numbers.includes(data.max),
    "원문에 없는 범위를 사용할 수 없습니다.",
    "RECOMMENDATION_UNVERIFIED",
  );
  need(
    typeof data.compatibilityQuote === "string" &&
      data.compatibilityQuote.length >= 3 &&
      source.text.includes(data.compatibilityQuote),
    "기본 모델 호환성의 원문 근거가 없습니다.",
    "RECOMMENDATION_UNVERIFIED",
  );
  need(
    Array.isArray(data.triggers) &&
      data.triggers.every((t) => typeof t === "string"),
    "LoRA 트리거 형식이 올바르지 않습니다.",
    "RECOMMENDATION_UNVERIFIED",
  );
  return source;
}
