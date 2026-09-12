import { realpathSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { id } from "./store.mjs";
import { AppError, need, request, lines } from "./http.mjs";
export class Xai {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
  }
  async runtime() {
    if (this.modules) return this.modules;
    let root = process.env.FRAMEPOP_OPENCLAW_XAI_DIR;
    for (const binary of [
      "/opt/homebrew/bin/openclaw",
      "/usr/local/bin/openclaw",
    ]) {
      if (root || !existsSync(binary)) continue;
      const real = realpathSync(binary);
      for (const candidate of [
        resolve(
          dirname(real),
          "../libexec/lib/node_modules/openclaw/dist/extensions/xai",
        ),
        resolve(dirname(real), "dist/extensions/xai"),
      ])
        if (existsSync(resolve(candidate, "xai-oauth.js"))) root = candidate;
    }
    need(
      root,
      "OpenClaw xAI OAuth 런타임 경로를 확인하세요.",
      "AUTH_RUNTIME_REQUIRED",
    );
    const oauth = await import(pathToFileURL(resolve(root, "xai-oauth.js")));
    const catalog = await import(
      pathToFileURL(resolve(root, "provider-catalog.js"))
    );
    return (this.modules = { ...oauth, ...catalog });
  }
  async login() {
    const rt = await this.runtime();
    const session = { id: id(), status: "pending", createdAt: Date.now() };
    this.sessions.set(session.id, session);
    rt.loginXaiDeviceCode({
      isRemote: true,
      config: {},
      runtime: { log() {} },
      openUrl: async () => {},
      prompter: {
        progress: () => ({ update() {}, stop() {} }),
        note: async (text) => {
          const url = text.match(/URL: (\S+)/)?.[1],
            code = text.match(/Code: (\S+)/)?.[1];
          if (url) session.url = url;
          if (code) session.code = code;
        },
      },
    })
      .then((result) => {
        if (session.status !== "pending") return;
        const credential = result.profiles?.[0]?.credential;
        need(credential?.access, "OAuth 인증 정보가 없습니다.");
        this.store.put("secret", "xai", credential);
        session.status = "completed";
      })
      .catch(() => {
        session.status = "failed";
        session.error =
          "xAI 로그인에 실패했습니다. 계정 자격과 네트워크를 확인하세요.";
      });
    return session;
  }
  async credential() {
    let credential = this.store.get("secret", "xai");
    need(credential?.access, "xAI 구독 로그인이 필요합니다.", "AUTH_REQUIRED");
    if (credential.expires && credential.expires < Date.now() + 60000) {
      credential = await (
        await this.runtime()
      ).refreshXaiOAuthCredential(credential);
      this.store.put("secret", "xai", credential);
    }
    return credential;
  }
  async models() {
    const cr = await this.credential();
    const provider = await (
      await this.runtime()
    ).buildLiveXaiOAuthProvider({ discoveryApiKey: cr.access });
    return provider.models.map((m) => ({ id: m.id, name: m.name || m.id }));
  }
  async complete(model, messages, { signal, onProgress }) {
    const cr = await this.credential();
    const provider = await (
      await this.runtime()
    ).buildLiveXaiOAuthProvider({ discoveryApiKey: cr.access });
    need(
      provider.models.some((m) => m.id === model),
      "구독에서 사용할 수 없는 xAI 모델입니다.",
      "MODEL_REQUIRED",
    );
    const response = await request(
      provider.baseUrl.replace(/\/$/, "") + "/responses",
      {
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
      },
    );
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
