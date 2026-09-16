import { setTimeout as delay } from "node:timers/promises";
import { id } from "./store.mjs";
import { AppError, need, request, lines } from "./http.mjs";

// Public client/protocol reference: OpenClaw extensions/xai/xai-oauth.ts.
// Framepop owns the HTTP exchange and credentials; no OpenClaw code or account is loaded.
const ISSUER = "https://auth.x.ai";
const CLIENT = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_API = "https://cli-chat-proxy.grok.com/v1";
export function trustedEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {}
  need(
    url &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai")),
    "xAI 인증 서버 주소를 확인하지 못했습니다.",
    "AUTH_DISCOVERY_INVALID",
  );
  return url.href;
}
function credentialFrom(data, previous = {}) {
  need(
    typeof data.access_token === "string" && data.access_token,
    "xAI 인증 응답에 토큰이 없습니다.",
    "AUTH_RESPONSE_INVALID",
  );
  let expires =
    Number(data.expires_in) > 0
      ? Date.now() + Number(data.expires_in) * 1000
      : undefined;
  if (!expires) {
    try {
      expires =
        JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url"))
          .exp * 1000;
    } catch {}
  }
  need(
    Number.isFinite(expires) && expires > Date.now(),
    "xAI 토큰 유효기간을 확인하지 못했습니다.",
    "AUTH_RESPONSE_INVALID",
  );
  const refresh = data.refresh_token || previous.refresh;
  need(
    typeof refresh === "string" && refresh,
    "xAI 갱신 토큰이 없습니다. 다시 로그인하세요.",
    "AUTH_RESPONSE_INVALID",
  );
  return { access: data.access_token, refresh, expires };
}
const authError = (code) =>
  new AppError(
    "AUTH_FAILED",
    {
      access_denied: "xAI 로그인이 거절되었습니다.",
      authorization_denied: "xAI 로그인이 거절되었습니다.",
      expired_token: "xAI 로그인 코드가 만료되었습니다. 다시 로그인하세요.",
      invalid_grant: "xAI 인증이 만료되었습니다. 다시 로그인하세요.",
      invalid_scope: "xAI가 요청한 인증 범위를 허용하지 않았습니다.",
    }[code] ||
      "xAI 인증 요청에 실패했습니다. 계정 자격과 네트워크를 확인하세요.",
  );

export class Xai {
  constructor(
    store,
    { fetch: fetcher = globalThis.fetch, sleep = delay } = {},
  ) {
    this.store = store;
    this.fetch = fetcher;
    this.sleep = sleep;
    this.sessions = new Map();
  }
  async oauth(url, body) {
    const response = await this.fetch(trustedEndpoint(url), {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json",
        "User-Agent": "Framepop/1.0",
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      ...(body ? { body: new URLSearchParams(body) } : {}),
    });
    const data = await response.json().catch(() => null);
    need(
      data && typeof data === "object",
      "xAI 인증 응답을 읽지 못했습니다.",
      "AUTH_RESPONSE_INVALID",
    );
    return { ok: response.ok, data };
  }
  async discovery() {
    const { ok, data } = await this.oauth(
      ISSUER + "/.well-known/openid-configuration",
    );
    need(
      ok && data.issuer === ISSUER,
      "xAI 인증 정보를 확인하지 못했습니다.",
      "AUTH_DISCOVERY_INVALID",
    );
    return {
      device: trustedEndpoint(data.device_authorization_endpoint),
      token: trustedEndpoint(data.token_endpoint),
    };
  }
  async login() {
    const endpoints = await this.discovery();
    const { ok, data } = await this.oauth(endpoints.device, {
      client_id: CLIENT,
      scope: SCOPE,
    });
    if (!ok) throw authError(data.error);
    need(
      data.device_code && data.user_code && Number(data.expires_in) > 0,
      "xAI 로그인 코드 응답이 올바르지 않습니다.",
      "AUTH_RESPONSE_INVALID",
    );
    const session = {
      id: id(),
      status: "pending",
      createdAt: Date.now(),
      url: trustedEndpoint(
        data.verification_uri_complete || data.verification_uri,
      ),
      code: data.user_code,
      expiresAt: Date.now() + Number(data.expires_in) * 1000,
    };
    // Only the latest pending request may replace this provider's credential.
    for (const s of this.sessions.values())
      if (s.status === "pending") s.status = "cancelled";
    this.sessions.set(session.id, session);
    void this.poll(
      session,
      endpoints.token,
      data.device_code,
      Math.max(1000, (Number(data.interval) || 5) * 1000),
    ).catch((error) => {
      if (session.status !== "pending") return;
      session.status = "failed";
      session.error =
        error instanceof AppError
          ? error.message
          : "xAI 인증 서버에 연결할 수 없습니다. 다시 로그인하세요.";
    });
    return session;
  }
  async poll(session, endpoint, deviceCode, interval) {
    while (session.status === "pending" && Date.now() < session.expiresAt) {
      await this.sleep(Math.min(interval, session.expiresAt - Date.now()));
      if (session.status !== "pending" || Date.now() >= session.expiresAt)
        break;
      const { ok, data } = await this.oauth(endpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT,
        device_code: deviceCode,
      });
      if (session.status !== "pending") return;
      if (ok) {
        this.store.put("secret", "xai", credentialFrom(data));
        session.status = "completed";
        return;
      }
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") {
        interval += 5000;
        continue;
      }
      throw authError(data.error);
    }
    if (session.status === "pending") {
      session.status = "expired";
      session.error = "xAI 로그인 코드가 만료되었습니다. 다시 로그인하세요.";
    }
  }
  async credential() {
    const credential = this.store.get("secret", "xai");
    need(credential?.access, "xAI 구독 로그인이 필요합니다.", "AUTH_REQUIRED");
    if (credential.expires > Date.now() + 60000) return credential;
    if (!this.refreshing)
      this.refreshing = (async () => {
        need(
          credential.refresh,
          "xAI 구독 로그인이 필요합니다.",
          "AUTH_REQUIRED",
        );
        const { token } = await this.discovery();
        // Refresh tokens rotate: never retry an uncertain exchange automatically.
        const { ok, data } = await this.oauth(token, {
          grant_type: "refresh_token",
          client_id: CLIENT,
          refresh_token: credential.refresh,
        });
        if (!ok) throw authError(data.error);
        const next = credentialFrom(data, credential);
        this.store.put("secret", "xai", next);
        return next;
      })().finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
  async models() {
    const cr = await this.credential();
    const response = await this.fetch(XAI_API + "/models", {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${cr.access}` },
    });
    need(
      response.ok,
      "xAI 구독 모델을 조회하지 못했습니다.",
      "MODEL_DISCOVERY_FAILED",
    );
    const data = await response.json();
    const rows = data.data || data.models;
    need(
      Array.isArray(rows),
      "xAI 모델 목록 형식이 올바르지 않습니다.",
      "MODEL_DISCOVERY_FAILED",
    );
    return rows
      .filter((m) => {
        const backend = m.api_backend || m.apiBackend || m.backend;
        return (
          typeof (m.id || m.model) === "string" &&
          (backend
            ? ["responses", "chat", "language"].includes(backend.toLowerCase())
            : !/imagine|image|video|audio|tts/i.test(m.id || m.model))
        );
      })
      .map((m) => ({ id: m.id || m.model, name: m.name || m.id || m.model }));
  }
  async complete(model, messages, { signal, onProgress }) {
    const cr = await this.credential();
    const models = await this.models();
    need(
      models.some((m) => m.id === model),
      "구독에서 사용할 수 없는 xAI 모델입니다.",
      "MODEL_REQUIRED",
    );
    const response = await request(XAI_API + "/responses", {
      method: "POST",
      signal,
      timeout: 900000,
      headers: {
        Authorization: `Bearer ${cr.access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        store: false,
        input: messages.map((m) => ({
          role: m.role,
          content: [{ type: "input_text", text: m.content }],
        })),
        tools: [],
      }),
    });
    let out = "";
    await lines(response.body, (line) => {
      if (!line.startsWith("data:")) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") return;
      const data = JSON.parse(raw);
      if (data.type === "response.output_text.delta") {
        out += data.delta;
        onProgress?.({ receivedAt: Date.now() });
      }
      if (["response.failed", "error"].includes(data.type))
        throw new AppError("MODEL_ERROR", "xAI 작업 실행에 실패했습니다.");
    });
    need(out, "xAI 응답이 비어 있습니다.");
    return out;
  }
}
