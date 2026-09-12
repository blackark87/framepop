import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { AppError } from "./http.mjs";
// Uses the user's installed Codex app-server; tokens stay in its auth store.
export class Codex extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = resolve(dir, "codex-work");
    mkdirSync(this.dir, { recursive: true });
    this.seq = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.on("notification", (message) => {
      if (
        message.method !== "account/login/completed" ||
        !message.params?.loginId
      )
        return;
      const { loginId, success, error } = message.params;
      this.sessions.set(loginId, {
        ...this.sessions.get(loginId),
        loginId,
        status: success ? "completed" : "failed",
        ...(error ? { error } : {}),
      });
    });
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.process = spawn(
        "codex",
        [
          "app-server",
          "--stdio",
          "--disable",
          "shell_tool",
          "--disable",
          "code_mode_host",
          "--disable",
          "apps",
          "--disable",
          "plugins",
          "--disable",
          "browser_use",
          "--disable",
          "computer_use",
          "--disable",
          "multi_agent",
        ],
        { stdio: ["pipe", "pipe", "pipe"], cwd: this.dir },
      );
      let buffer = "";
      this.process.stderr.on("data", () => {});
      this.process.stdout.on("data", (b) => {
        buffer += b;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          let m;
          try {
            m = JSON.parse(buffer.slice(0, i));
          } catch {
            buffer = buffer.slice(i + 1);
            continue;
          }
          buffer = buffer.slice(i + 1);
          if (m.id !== undefined && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            m.error
              ? p.reject(new AppError("CODEX_ERROR", m.error.message, 502))
              : p.resolve(m.result);
          } else if (m.id !== undefined) {
            this.send({
              id: m.id,
              error: {
                code: -32601,
                message: "Tools and approvals are not available in Framepop.",
              },
            });
          } else this.emit("notification", m);
        }
      });
      this.process.on("error", (e) => this.fail(e));
      this.process.on("exit", () =>
        this.fail(
          new AppError("CODEX_UNAVAILABLE", "Codex 연결이 종료됐습니다.", 503),
        ),
      );
      await this.rpc("initialize", {
        clientInfo: { name: "framepop", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      this.send({ method: "initialized", params: {} });
    })();
    return this.ready;
  }
  fail(e) {
    this.ready = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
  send(m) {
    this.process.stdin.write(JSON.stringify(m) + "\n");
  }
  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError("CODEX_TIMEOUT", "Codex 응답이 지연됩니다.", 504));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async login() {
    await this.start();
    const result = await this.rpc("account/login/start", {
      type: "chatgptDeviceCode",
    });
    const session = {
      ...result,
      createdAt: Date.now(),
      status: "pending",
      ...this.sessions.get(result.loginId),
    };
    this.sessions.set(result.loginId, session);
    return session;
  }
  async status() {
    await this.start();
    return this.rpc("account/read", { refreshToken: false });
  }
  async complete(model, messages, { signal, onProgress }) {
    await this.start();
    const thread = await this.rpc("thread/start", {
      ...(model !== "default" ? { model } : {}),
      cwd: this.dir,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions:
        "Respond only with the requested JSON. Do not run any commands, access files, use tools or browse.",
      config: { web_search: "disabled", mcp_servers: {} },
    });
    const threadId = thread.thread.id;
    return new Promise((resolve, reject) => {
      let text = "",
        turnId,
        timer;
      const clean = () => {
        clearTimeout(timer);
        this.off("notification", listener);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        if (turnId)
          this.rpc("turn/interrupt", { threadId, turnId }).catch(() => {});
        clean();
        reject(new AppError("CANCELLED", "작업을 중단했습니다."));
      };
      const listener = (m) => {
        if (m.params?.threadId !== threadId) return;
        if (m.method === "item/agentMessage/delta") {
          text += m.params.delta || "";
          onProgress?.({ receivedAt: Date.now() });
        }
        if (m.method === "turn/completed") {
          clean();
          m.params.turn?.status === "completed"
            ? resolve(text)
            : reject(
                new AppError(
                  "MODEL_ERROR",
                  (
                    m.params.turn?.error?.message ||
                    "Codex 작업이 완료되지 않았습니다."
                  ).slice(0, 600),
                ),
              );
        }
      };
      this.on("notification", listener);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, 900000);
      this.rpc("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: messages.map((m) => m.role + ": " + m.content).join("\n"),
          },
        ],
      })
        .then((r) => (turnId = r.turn.id))
        .catch((e) => {
          clean();
          reject(e);
        });
    });
  }
  close() {
    this.process?.kill();
  }
}
