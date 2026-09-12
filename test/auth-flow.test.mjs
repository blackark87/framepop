import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Codex } from "../server/codex.mjs";
import { createApp } from "../server/index.mjs";

test("Codex approval is tied to this login request, not an already signed-in account", async (t) => {
  const dir = await mkdtemp("/tmp/framepop-login-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codex = new Codex(dir);
  codex.start = async () => {};
  codex.rpc = async (method) =>
    method === "account/read"
      ? { account: { type: "chatgpt" } }
      : {
          loginId: "new-login",
          verificationUrl: "https://example.com/verify",
          userCode: "TEST",
          type: "chatgptDeviceCode",
        };
  assert.ok((await codex.status()).account);
  assert.equal((await codex.login()).status, "pending");
  codex.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "other-login", success: true },
  });
  assert.equal(codex.sessions.get("new-login").status, "pending");
  codex.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "new-login", success: true },
  });
  assert.equal(codex.sessions.get("new-login").status, "completed");
  codex.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "failed-login", success: false, error: "Denied" },
  });
  assert.equal(codex.sessions.get("failed-login").status, "failed");
});

test("subscription registration ignores server credentials and exposes per-request approval", async (t) => {
  const dir = await mkdtemp("/tmp/framepop-auth-api-test-");
  const codex = {
    sessions: new Map([["pending", { loginId: "pending", status: "pending" }]]),
    close() {},
    status: async () => ({ account: { type: "chatgpt" } }),
    start: async () => {},
    rpc: async () => ({
      data: [{ id: "test-model", displayName: "Test model" }],
    }),
  };
  const xai = {
    sessions: new Map([
      ["failed", { id: "failed", status: "failed", error: "Declined" }],
    ]),
  };
  const app = await createApp({ dataDir: dir, codex, xai });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.close();
    app.store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const root = "http://127.0.0.1:" + app.server.address().port;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(root + "/api" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const settings = (await call("/bootstrap")).data.settings;
  settings.connections = [
    {
      id: "c",
      kind: "codex",
      name: "OpenAI",
      url: "http://old-server",
      token: "old-token",
    },
  ];
  const saved = await call("/settings", "PUT", settings);
  assert.equal(saved.status, 200);
  assert.equal(
    app.store.get("settings", "main").connections[0].token,
    undefined,
  );
  assert.equal(saved.data.connections[0].url, undefined);
  assert.equal((await call("/auth/codex/pending")).data.status, "pending");
  assert.equal((await call("/auth/codex/missing")).data.status, "expired");
  assert.equal((await call("/auth/xai/failed")).data.error, "Declined");
  const models = await call("/connections/c/models", "POST");
  assert.equal(models.data.settings.connections[0].authStatus, "connected");
  assert.equal(models.data.models.length, 1);
});
