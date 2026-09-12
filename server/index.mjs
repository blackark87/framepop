import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store, id, defaults } from "./store.mjs";
import { AppError, need, baseURL } from "./http.mjs";
import { models, roles, connection } from "./llm.mjs";
import { inventory } from "./comfy.mjs";
import { Jobs } from "./jobs.mjs";
import { Codex } from "./codex.mjs";
import { Xai } from "./xai.mjs";
export async function createApp({
  dataDir = resolve("data"),
  store = new Store(dataDir),
  jobs,
  codex = new Codex(dataDir),
  xai = new Xai(store),
} = {}) {
  if (!store.get("settings", "main")) store.put("settings", "main", defaults());
  jobs ??= new Jobs(store, { codex, xai });
  await mkdir(resolve(dataDir, "media"), { recursive: true });
  let token = process.env.FRAMEPOP_TOKEN;
  try {
    token ||= (await readFile(resolve(dataDir, "access-code"), "utf8")).trim();
  } catch {}
  if (!token) {
    token = randomBytes(24).toString("base64url");
    await writeFile(resolve(dataDir, "access-code"), token, { mode: 0o600 });
  }
  const local = (req) =>
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  const equal = (a, b) =>
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const auth = (req) =>
    (local(req) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(
        new URL("http://" + req.headers.host).hostname,
      )) ||
    equal(req.headers.authorization?.replace(/^Bearer /, "") || "", token) ||
    equal(
      (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("framepop="))
        ?.slice(9) || "",
      token,
    );
  const send = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const body = async (req) => {
    let text = "";
    for await (const b of req) {
      text += b;
      if (text.length > 2e6)
        throw new AppError("TOO_LARGE", "요청이 너무 큽니다.", 413);
    }
    try {
      return JSON.parse(text || "{}");
    } catch {
      throw new AppError("INVALID_JSON", "JSON 형식이 올바르지 않습니다.");
    }
  };
  const safeSettings = () => {
    const s = structuredClone(store.get("settings", "main"));
    s.connections = s.connections.map((c) => {
      const { token, ...safe } = c;
      return { ...safe, hasToken: !!token };
    });
    return s;
  };
  const publicJob = (j) => {
    if (!j) return null;
    const { settings, project, ...safe } = j;
    return safe;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`
      )
        throw new AppError(
          "ORIGIN_DENIED",
          "다른 사이트에서의 요청은 허용하지 않습니다.",
          403,
        );
      if (path === "/api/session" && req.method === "POST") {
        const b = await body(req);
        if (!equal(String(b.code || ""), token))
          throw new AppError(
            "AUTH_REQUIRED",
            "접속 코드가 올바르지 않습니다.",
            401,
          );
        res.setHeader(
          "Set-Cookie",
          `framepop=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
        return send(res, 200, { ok: true });
      }
      if (
        (path.startsWith("/api/") || path.startsWith("/media/")) &&
        !auth(req)
      )
        throw new AppError("AUTH_REQUIRED", "접속 코드를 입력해 주세요.", 401);
      if (path === "/api/bootstrap" && req.method === "GET")
        return send(res, 200, {
          settings: safeSettings(),
          projects: store.list("project"),
          references: store.list("reference"),
          jobs: store.list("job").map(publicJob),
          roles,
        });
      if (path === "/api/settings" && req.method === "PUT") {
        const b = await body(req),
          old = store.get("settings", "main");
        need(
          b.revision === old.revision,
          "설정이 다른 화면에서 변경되었습니다.",
          "VERSION_CONFLICT",
        );
        need(
          ["auto", "manual"].includes(b.assignmentMode),
          "배정 방식이 올바르지 않습니다.",
        );
        need(Array.isArray(b.connections), "연결 목록이 필요합니다.");
        for (const c of b.connections) {
          need(
            [
              "ollama",
              "lmstudio",
              "codex",
              "xai",
              "comfy",
              "openclaw",
            ].includes(c.kind),
            "연결 종류가 올바르지 않습니다.",
          );
          need(c.id && c.name, "연결 이름이 필요합니다.");
          if (!["codex", "xai"].includes(c.kind)) c.url = baseURL(c.url);
          const previous = old.connections.find((x) => x.id === c.id);
          if (
            c.token === undefined &&
            previous?.token &&
            previous.kind === c.kind &&
            !["codex", "xai"].includes(c.kind)
          )
            c.token = previous.token;
          if (["codex", "xai"].includes(c.kind)) {
            delete c.url;
            delete c.token;
          }
          delete c.hasToken;
        }
        need(
          new Set(b.connections.map((c) => c.id)).size === b.connections.length,
          "연결 ID가 중복되었습니다.",
        );
        need(
          b.comfy &&
            Array.isArray(b.comfy.loras) &&
            b.comfy.loras.every((x) => typeof x === "string") &&
            new Set(b.comfy.loras).size === b.comfy.loras.length,
          "LoRA 선택이 올바르지 않습니다.",
        );
        need(
          !b.comfy.imageLoras ||
            (Array.isArray(b.comfy.imageLoras) &&
              b.comfy.imageLoras.every((x) => typeof x === "string")),
          "이미지 LoRA 선택이 올바르지 않습니다.",
        );
        need(
          b.qc &&
            Number.isFinite(b.qc.minSimilarity) &&
            b.qc.minSimilarity >= 0 &&
            b.qc.minSimilarity <= 1 &&
            Number.isFinite(b.qc.minSharpness) &&
            b.qc.minSharpness > 0 &&
            Number.isFinite(b.qc.maxBadFraction) &&
            b.qc.maxBadFraction >= 0 &&
            b.qc.maxBadFraction < 1,
          "검수 기준이 올바르지 않습니다.",
        );
        for (const a of [b.primary, ...Object.values(b.roles || {})].filter(
          Boolean,
        ))
          need(
            b.connections.some((c) => c.id === a.connectionId) &&
              typeof a.model === "string" &&
              a.model,
            "모델 배정이 올바르지 않습니다.",
          );
        need(
          typeof b.enhancementInstruction === "string",
          "강화 지시가 올바르지 않습니다.",
        );
        const s = { ...old, ...b, revision: old.revision + 1 };
        store.put("settings", "main", s);
        return send(res, 200, safeSettings());
      }
      let match;
      if (
        (match = path.match(/^\/api\/connections\/([^/]+)\/models$/)) &&
        req.method === "POST"
      ) {
        const settings = store.get("settings", "main"),
          c = connection(settings, match[1]);
        if (c.kind === "comfy") {
          const inv = await inventory(c);
          store.put("inventory", c.id, inv);
          return send(res, 200, inv);
        }
        if (c.kind === "codex")
          need(
            (await codex.status()).account?.type === "chatgpt",
            "OpenAI 구독 로그인을 완료해 주세요.",
            "AUTH_REQUIRED",
          );
        const found =
          c.kind === "xai"
            ? await xai.models()
            : c.kind === "codex"
              ? (await codex.start(),
                (await codex.rpc("model/list", {})).data.map((m) => ({
                  id: m.id || m.model,
                  name: m.displayName || m.model,
                })))
              : await models(c);
        c.models = found;
        if (["codex", "xai"].includes(c.kind)) {
          c.authStatus = "connected";
          c.authCheckedAt = Date.now();
        }
        settings.revision++;
        store.put("settings", "main", settings);
        return send(res, 200, { models: found, settings: safeSettings() });
      }
      if (path === "/api/projects" && req.method === "POST") {
        const b = await body(req);
        need(b.title?.trim(), "프로젝트 이름이 필요합니다.");
        const p = {
          id: id(),
          title: b.title.trim(),
          synopsis: "",
          modelProfile: "",
          duration: 300,
          mode: "local",
          referenceId: null,
          revision: 1,
          approved: false,
          createdAt: Date.now(),
        };
        store.put("project", p.id, p);
        return send(res, 201, p);
      }
      if (
        (match = path.match(/^\/api\/projects\/([^/]+)$/)) &&
        req.method === "PATCH"
      ) {
        const p = store.get("project", match[1]);
        need(p, "프로젝트가 없습니다.");
        const b = await body(req);
        need(
          b.revision === p.revision,
          "프로젝트 버전이 변경되었습니다.",
          "VERSION_CONFLICT",
        );
        need(
          !store
            .list("job")
            .some(
              (j) =>
                j.projectId === p.id &&
                ["running", "queued"].includes(j.status),
            ),
          "작업 중에는 입력을 변경할 수 없습니다.",
          "JOB_BUSY",
        );
        for (const k of [
          "title",
          "synopsis",
          "modelProfile",
          "duration",
          "mode",
          "referenceId",
        ])
          if (b[k] !== undefined) p[k] = b[k];
        need(
          Number.isInteger(p.duration) && p.duration >= 1 && p.duration <= 3600,
          "재생 시간은 1~3600초로 입력하세요.",
        );
        need(
          ["local", "mixed"].includes(p.mode),
          "실행 경로가 올바르지 않습니다.",
        );
        if (p.referenceId)
          need(
            store.get("reference", p.referenceId),
            "레퍼런스를 찾을 수 없습니다.",
          );
        need(
          typeof p.title === "string" &&
            p.title.trim() &&
            typeof p.synopsis === "string" &&
            typeof p.modelProfile === "string",
          "입력 형식이 올바르지 않습니다.",
        );
        p.revision++;
        p.approved = false;
        p.pendingRevision = !!p.plan;
        store.put("project", p.id, p);
        return send(res, 200, p);
      }
      if (
        (match = path.match(/^\/api\/projects\/([^/]+)\/approve$/)) &&
        req.method === "POST"
      ) {
        const p = store.get("project", match[1]),
          b = await body(req);
        need(
          !store
            .list("job")
            .some(
              (j) =>
                j.projectId === p?.id &&
                ["running", "queued"].includes(j.status),
            ),
          "작업 중에는 확정할 수 없습니다.",
          "JOB_BUSY",
        );
        need(
          p?.plan && p.revision === b.revision && !p.pendingRevision,
          "확정할 수 있는 최신 결과가 없습니다.",
        );
        p.approved = true;
        store.put("project", p.id, p);
        return send(res, 200, p);
      }
      if (path === "/api/jobs" && req.method === "POST") {
        const b = await body(req);
        need(
          ["plan", "revise", "enhance", "image", "video", "recommend"].includes(
            b.kind,
          ),
          "지원하지 않는 작업입니다.",
        );
        const job = jobs.create(
          b.kind,
          b.projectId || null,
          b.input || {},
          req.headers["idempotency-key"],
        );
        return send(res, 202, publicJob(job));
      }
      if (
        (match = path.match(
          /^\/api\/jobs\/([^/]+)(?:\/(cancel|retry|events))?$/,
        ))
      ) {
        const job = store.get("job", match[1]);
        need(job, "작업이 없습니다.");
        if (match[2] === "events" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const push = (e) =>
            res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          let cursor = Number(
            req.headers["last-event-id"] || url.searchParams.get("after") || 0,
          );
          let batch;
          do {
            batch = store.events(job.id, cursor);
            for (const e of batch) {
              push(e);
              cursor = e.seq;
            }
          } while (batch.length === 1000);
          const listener = (e) => {
            if (e.seq > cursor) {
              push(e);
              cursor = e.seq;
            }
          };
          jobs.on(job.id, listener);
          const heartbeat = setInterval(
            () => res.write(": heartbeat\n\n"),
            15000,
          );
          req.on("close", () => {
            clearInterval(heartbeat);
            jobs.off(job.id, listener);
          });
          return;
        }
        if (req.method === "POST" && match[2])
          return send(
            res,
            200,
            publicJob(
              match[2] === "cancel" ? jobs.cancel(job.id) : jobs.retry(job.id),
            ),
          );
        return send(res, 200, publicJob(job));
      }
      if (path === "/api/auth/codex" && req.method === "POST")
        return send(res, 200, await codex.login());
      if (path === "/api/auth/codex" && req.method === "GET")
        return send(res, 200, await codex.status());
      if (path === "/api/auth/xai" && req.method === "POST")
        return send(res, 200, await xai.login());
      if (
        (match = path.match(/^\/api\/auth\/(codex|xai)\/([^/]+)$/)) &&
        req.method === "GET"
      )
        return send(
          res,
          200,
          (match[1] === "codex" ? codex : xai).sessions.get(match[2]) || {
            status: "expired",
          },
        );
      if (path.startsWith("/api/"))
        throw new AppError("NOT_FOUND", "요청 경로가 없습니다.", 404);
      const media = path.startsWith("/media/");
      let file;
      if (media) {
        need(
          /^[\w-]+\.(mp4|png|webm)$/.test(path.slice(7)),
          "파일 경로가 올바르지 않습니다.",
        );
        file = resolve(dataDir, "media", path.slice(7));
      } else {
        const clean = decodeURIComponent(path === "/" ? "/index.html" : path);
        need(
          !clean.includes("..") && !clean.includes("\\"),
          "파일 경로가 올바르지 않습니다.",
        );
        file = resolve("dist", "." + clean);
      }
      let data;
      try {
        if (media) {
          const info = await stat(file);
          const range = req.headers.range;
          const type =
            extname(file) === ".png"
              ? "image/png"
              : extname(file) === ".webm"
                ? "video/webm"
                : "video/mp4";
          let start = 0,
            end = info.size - 1,
            status = 200;
          if (range) {
            const m = range.match(/^bytes=(\d*)-(\d*)$/);
            if (!m || (!m[1] && !m[2])) {
              res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
              return res.end();
            }
            start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]));
            end =
              m[1] && m[2]
                ? Math.min(Number(m[2]), info.size - 1)
                : info.size - 1;
            if (start > end || start >= info.size) {
              res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
              return res.end();
            }
            status = 206;
          }
          res.writeHead(status, {
            "Content-Type": type,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
            "Cache-Control": "private, no-cache",
            ...(status === 206
              ? { "Content-Range": `bytes ${start}-${end}/${info.size}` }
              : {}),
          });
          if (req.method === "HEAD") return res.end();
          const stream = createReadStream(file, { start, end });
          stream.on("error", () => res.destroy());
          stream.pipe(res);
          return;
        }
        data = await readFile(file);
      } catch {
        throw new AppError("NOT_FOUND", "파일이 없습니다.", 404);
      }
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".mp4": "video/mp4",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch (e) {
      if (!res.headersSent)
        send(res, e.status || 500, {
          error: {
            code: e.code || "SERVER_ERROR",
            message: e.status ? e.message : "서버 처리 중 오류가 발생했습니다.",
          },
        });
      else res.end();
    }
  });
  return {
    server,
    store,
    jobs,
    close: () => {
      codex.close();
      for (const c of jobs.active.values()) c.abort();
      server.close();
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const host = process.env.HOST || "0.0.0.0",
    port = Number(process.env.PORT || 5173);
  app.server.listen(port, host, () =>
    console.log(
      `Framepop: http://127.0.0.1:${port} (bind ${host})\nRemote access code: data/access-code`,
    ),
  );
  for (const s of ["SIGINT", "SIGTERM"])
    process.on(s, () => {
      app.close();
      process.exit();
    });
}
