import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import UldaSign from "../../ulda-sign/ulda-sign.js";
import UldaFront, {
  createRestAdapter,
  createSocketIOAdapter,
  UldaSecurityError
} from "../ulda-front.js";

if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== "function") {
  globalThis.crypto = webcrypto;
}
if (typeof globalThis.btoa !== "function") {
  globalThis.btoa = str => Buffer.from(str, "binary").toString("base64");
}
if (typeof globalThis.atob !== "function") {
  globalThis.atob = b64 => Buffer.from(b64, "base64").toString("binary");
}

const hasWebCrypto =
  globalThis.crypto &&
  globalThis.crypto.subtle &&
  typeof globalThis.crypto.getRandomValues === "function";

const signConfig = Object.freeze({
  originSize: 256,
  N: 5,
  mode: "S",
  hash: "SHA-256"
});

class InMemoryUldaBackend {
  constructor(config = signConfig) {
    this.config = config;
    this.records = new Map();
    this.nextId = 1;
    this.transitions = [];
    this.verifier = new UldaSign({
      fmt: { export: "hex" },
      sign: {
        originSize: config.originSize,
        N: config.N,
        mode: config.mode,
        hash: config.hash
      }
    });
  }

  makeConfigResponse() {
    return {
      originSize: this.config.originSize,
      sign: {
        N: this.config.N,
        mode: this.config.mode,
        hash: this.config.hash
      },
      contentBytes: 32,
      format: "hex",
      contentFormat: "base64"
    };
  }

  async create({ ulda_key, content }) {
    const id = this.nextId++;
    this.records.set(id, {
      id,
      ulda_key: String(ulda_key),
      content: String(content)
    });
    return { id };
  }

  async read({ id }) {
    const numericId = Number(id);
    const row = this.records.get(numericId);
    if (!row) return { status: 404, error: "not found" };
    return {
      id: row.id,
      ulda_key: row.ulda_key,
      content: row.content,
      format: "hex",
      contentFormat: "base64"
    };
  }

  async update({ id, ulda_key, content }) {
    const numericId = Number(id);
    const row = this.records.get(numericId);
    if (!row) return { status: 404, error: "not found" };
    const oldKey = row.ulda_key;
    const newKey = String(ulda_key);
    const verified = await this.verifier.verify(oldKey, newKey);
    if (!verified) return { status: 400, error: "signature verification failed" };
    this.transitions.push({ op: "update", id: numericId, oldKey, newKey });
    row.ulda_key = newKey;
    row.content = String(content);
    return { verified: true };
  }

  async remove({ id, ulda_key }) {
    const numericId = Number(id);
    const row = this.records.get(numericId);
    if (!row) return { status: 404, error: "not found" };
    const oldKey = row.ulda_key;
    const newKey = String(ulda_key);
    const verified = await this.verifier.verify(oldKey, newKey);
    if (!verified) return { status: 400, error: "signature verification failed" };
    this.transitions.push({ op: "delete", id: numericId, oldKey, newKey });
    this.records.delete(numericId);
    return { deleted: true };
  }
}

function makeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

function createFetchForBackend(backend) {
  return async (input, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const url = new URL(String(input));
    const path = url.pathname;
    let payload = {};
    if (init.body != null) payload = JSON.parse(String(init.body));

    if (method === "GET" && path === "/config") {
      return makeResponse(200, backend.makeConfigResponse());
    }

    if (method === "POST" && path === "/records") {
      const created = await backend.create(payload);
      return makeResponse(200, { ok: true, id: created.id });
    }

    if (method === "GET" && /^\/records\/\d+$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      const row = await backend.read({ id });
      if (row.status) return makeResponse(row.status, { ok: false, error: row.error });
      return makeResponse(200, { ok: true, ...row });
    }

    if (method === "PUT" && /^\/records\/\d+$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      const result = await backend.update({ id, ...payload });
      if (result.status) return makeResponse(result.status, { ok: false, error: result.error });
      return makeResponse(200, { ok: true, ...result });
    }

    if (method === "DELETE" && /^\/records\/\d+$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      const result = await backend.remove({ id, ...payload });
      if (result.status) return makeResponse(result.status, { ok: false, error: result.error });
      return makeResponse(200, { ok: true, ...result });
    }

    return makeResponse(404, { ok: false, error: "not found" });
  };
}

function createSocketForBackend(backend) {
  return {
    emit(event, payload, cb) {
      Promise.resolve()
        .then(async () => {
          if (event === "create") {
            const created = await backend.create(payload ?? {});
            return { ok: true, id: created.id };
          }
          if (event === "read") {
            const row = await backend.read(payload ?? {});
            if (row.status) return { ok: false, error: row.error };
            return { ok: true, ...row };
          }
          if (event === "update") {
            const result = await backend.update(payload ?? {});
            if (result.status) return { ok: false, error: result.error };
            return { ok: true, ...result };
          }
          if (event === "delete") {
            const result = await backend.remove(payload ?? {});
            if (result.status) return { ok: false, error: result.error };
            return { ok: true, ...result };
          }
          return { ok: false, error: `unsupported event: ${event}` };
        })
        .then(data => cb(data))
        .catch(err => cb({ ok: false, error: err?.message ?? String(err) }));
    }
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(stepMs);
  }
  return false;
}

test("REST: create/update/reload/delete follows ULDA forward verification", { skip: !hasWebCrypto }, async () => {
  const backend = new InMemoryUldaBackend(signConfig);
  const fetchImpl = createFetchForBackend(backend);
  const adapter = createRestAdapter({ fetchImpl, signConfig });

  const client = new UldaFront(null, null, "http://localhost:8787", {
    adapter,
    options: {
      allowInsecureLocalhost: true,
      autosave: false
    }
  });

  const created = await client.create({ password: "master-pass" });
  assert.equal(typeof created.id, "number");
  assert.equal(backend.records.has(created.id), true);

  client.data.name = "Alice";
  client.data.profile = { city: "Paris" };
  const firstUpdate = await client.update();
  assert.deepEqual(firstUpdate, { ok: true, created: 2, updated: 0, deleted: 0 });

  client.data.name = "Bob";
  client.data.profile.city = "Berlin";
  const secondUpdate = await client.update();
  assert.deepEqual(secondUpdate, { ok: true, created: 0, updated: 2, deleted: 0 });

  delete client.data.name;
  const deleteOne = await client.update();
  assert.deepEqual(deleteOne, { ok: true, created: 0, updated: 0, deleted: 1 });

  const reader = new UldaFront(created.id, "master-pass", "http://localhost:8787", {
    adapter,
    options: {
      allowInsecureLocalhost: true,
      autosave: false
    }
  });
  const reloaded = await reader.connect();
  assert.equal(reloaded.id, created.id);
  assert.equal(reader.data.name, undefined);
  assert.equal(reader.data.profile.city, "Berlin");

  await reader.close();
  await client.close();

  assert.ok(backend.transitions.length >= 4);
  for (const t of backend.transitions) {
    assert.notEqual(t.oldKey, t.newKey);
    assert.equal(await backend.verifier.verify(t.oldKey, t.newKey), true);
  }
});

test("Socket.IO adapter: create/connect/update works against same ULDA verification rules", { skip: !hasWebCrypto }, async () => {
  const backend = new InMemoryUldaBackend(signConfig);
  const socket = createSocketForBackend(backend);
  const fetchImpl = createFetchForBackend(backend);
  const adapter = createSocketIOAdapter({
    socket,
    fetchImpl,
    signConfig,
    configBaseUrl: "http://localhost:8787"
  });

  const creator = new UldaFront(null, null, "ws://localhost:8787", {
    adapter,
    options: {
      allowInsecureLocalhost: true,
      autosave: false
    }
  });

  const created = await creator.create({ password: "socket-pass" });
  creator.data.settings = { theme: "light" };
  creator.data.name = "Socket User";
  await creator.update();

  const joiner = new UldaFront(created.id, "socket-pass", "ws://localhost:8787", {
    adapter,
    options: {
      allowInsecureLocalhost: true,
      autosave: false
    }
  });
  await joiner.connect();
  assert.equal(joiner.data.name, "Socket User");
  assert.equal(joiner.data.settings.theme, "light");

  joiner.data.settings.theme = "dark";
  await joiner.update();
  await joiner.reload();
  assert.equal(joiner.data.settings.theme, "dark");

  await joiner.close();
  await creator.close();

  assert.ok(backend.transitions.length >= 2);
  for (const t of backend.transitions) {
    assert.equal(await backend.verifier.verify(t.oldKey, t.newKey), true);
  }
});

test("Autosave mode flushes proxy mutation without explicit update()", { skip: !hasWebCrypto }, async () => {
  const backend = new InMemoryUldaBackend(signConfig);
  const fetchImpl = createFetchForBackend(backend);
  const adapter = createRestAdapter({ fetchImpl, signConfig });

  const client = new UldaFront(null, null, "http://localhost:8787", {
    adapter,
    options: {
      allowInsecureLocalhost: true,
      autosave: true,
      autosaveDebounceMs: 5
    }
  });

  const created = await client.create({ password: "autosave-pass" });
  client.data.note = "saved by autosave";
  const autosaveDone = await waitFor(() => backend.records.size >= 2 && backend.transitions.length >= 1);
  assert.equal(autosaveDone, true);

  const reader = new UldaFront(created.id, "autosave-pass", "http://localhost:8787", {
    adapter,
    options: {
      allowInsecureLocalhost: true,
      autosave: false
    }
  });
  await reader.connect();
  assert.equal(reader.data.note, "saved by autosave");

  await reader.close();
  await client.close();
});

test("Security: insecure non-localhost transport is blocked by default", { skip: !hasWebCrypto }, async () => {
  const backend = new InMemoryUldaBackend(signConfig);
  const fetchImpl = createFetchForBackend(backend);
  const adapter = createRestAdapter({ fetchImpl, signConfig });

  assert.throws(
    () => {
      new UldaFront(null, null, "http://example.com", { adapter });
    },
    err => err instanceof UldaSecurityError
  );
});

test("ULDA strict-forward property: stale signature update is rejected (verify(A, A) = false)", { skip: !hasWebCrypto }, async () => {
  const backend = new InMemoryUldaBackend(signConfig);
  const fetchImpl = createFetchForBackend(backend);
  const adapter = createRestAdapter({ fetchImpl, signConfig });

  const client = new UldaFront(null, null, "http://localhost:8787", {
    adapter,
    options: {
      allowInsecureLocalhost: true,
      autosave: false
    }
  });

  const created = await client.create({ password: "strict-pass" });
  const row = backend.records.get(created.id);
  assert.ok(row);

  const stale = await backend.update({
    id: created.id,
    ulda_key: row.ulda_key,
    content: row.content
  });
  assert.equal(stale.status, 400);
  assert.equal(stale.error, "signature verification failed");

  client.data.value = "fresh";
  const ok = await client.update();
  assert.equal(ok.ok, true);

  await client.close();
});
