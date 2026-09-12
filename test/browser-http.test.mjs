import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

test("HTTP browser without randomUUID can add a connection, submit work and add a segment", async () => {
  const elements = new Map(),
    requests = [];
  const element = (selector) => {
    if (!elements.has(selector))
      elements.set(selector, {
        innerHTML: "",
        value: "",
        textContent: "",
        addEventListener() {},
        classList: { add() {}, remove() {} },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return elements.get(selector);
  };
  const initial = {
    settings: { connections: [], roles: {}, comfy: { loras: [] } },
    projects: [
      {
        id: "p",
        title: "Test",
        revision: 1,
        plan: {
          segments: [{ id: "s", title: "Scene", prompt: "Text", duration: 6 }],
        },
      },
    ],
    references: [],
    jobs: [],
  };
  const sandbox = {
    crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    Uint8Array,
    console,
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { addEventListener() {} },
    localStorage: { getItem: () => "p", setItem() {} },
    location: { hash: "#settings" },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    EventSource: class {},
    fetch: async (url, options = {}) => {
      if (url === "/api/bootstrap")
        return { ok: true, json: async () => structuredClone(initial) };
      requests.push({ url, ...options });
      return {
        ok: true,
        json: async () => ({
          id: "job-" + requests.length,
          ...JSON.parse(options.body),
        }),
      };
    },
  };
  const context = vm.createContext(sandbox);
  const helper = (
    await readFile(new URL("../dist/id.js", import.meta.url), "utf8")
  ).replace("export function", "function");
  const client = (
    await readFile(new URL("../dist/live.js", import.meta.url), "utf8")
  ).replace(/^import .*from "\.\/id\.js";\s*/, "");
  vm.runInContext(helper + "\n" + client, context);
  await new Promise(setImmediate);
  assert.equal(sandbox.crypto.randomUUID, undefined);
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  await vm.runInContext('action("addConnection",{dataset:{}})', context);
  assert.equal(element("#modal").open, true);
  const connectionId = element("#modal").innerHTML.match(
    /id="connectionId"[^>]*value="([^"]+)"/,
  )[1];
  assert.match(connectionId, uuid);
  await vm.runInContext(
    'startJob("enhance",{target:"image",prompt:"Portrait"},null)',
    context,
  );
  await vm.runInContext('action("addSegment",{dataset:{}})', context);
  assert.equal(requests.length, 2);
  for (const request of requests)
    assert.match(request.headers["Idempotency-Key"], uuid);
  const segmentId = JSON.parse(requests[1].body).input.constraints[0].id;
  assert.match(segmentId, uuid);
  assert.equal(
    new Set([
      connectionId,
      segmentId,
      ...requests.map((r) => r.headers["Idempotency-Key"]),
    ]).size,
    4,
  );
});
