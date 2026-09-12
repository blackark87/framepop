export class AppError extends Error {
  constructor(code, message, status = 422, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export function need(ok, message, code = "INVALID_INPUT") {
  if (!ok)
    throw new AppError(
      code,
      message,
      ["VERSION_CONFLICT", "JOB_BUSY"].includes(code) ? 409 : 422,
    );
}
export function baseURL(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("INVALID_URL", "올바른 서버 주소가 필요합니다.");
  }
  need(
    ["http:", "https:"].includes(u.protocol) && !u.username && !u.password,
    "HTTP(S) 서버 주소를 입력하세요.",
  );
  u.hash = "";
  u.search = "";
  return u.href.replace(/\/$/, "");
}
export async function request(
  url,
  { signal, timeout = 60000, headers = {}, ...options } = {},
) {
  const s = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(timeout),
  ]);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      signal: s,
      redirect: "error",
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new AppError(
      "CONNECTION_UNAVAILABLE",
      "서버에 연결할 수 없습니다.",
      503,
    );
  }
  if (!response.ok)
    throw new AppError(
      response.status === 401 ? "AUTH_REQUIRED" : "UPSTREAM_ERROR",
      `연결 서버가 요청을 거절했습니다 (${response.status}).`,
      502,
    );
  return response;
}
export async function json(url, opts) {
  return (await request(url, opts)).json();
}
export async function lines(stream, fn) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    let p;
    while ((p = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, p);
      rest = rest.slice(p + 1);
      await fn(line.trim());
    }
  }
  if (rest.trim()) await fn(rest.trim());
}
export function parseJSON(text) {
  try {
    return JSON.parse(
      text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, ""),
    );
  } catch {
    throw new AppError(
      "OUTPUT_INVALID",
      "모델이 요구된 JSON 형식으로 응답하지 않았습니다.",
    );
  }
}
