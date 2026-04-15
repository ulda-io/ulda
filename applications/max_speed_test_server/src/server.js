import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import UldaSign from "../../../packages/ulda-sign/ulda-sign.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const browserTestDir = path.join(rootDir, "browser-test");

function ensureWebCrypto() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== "function") {
    globalThis.crypto = webcrypto;
  }
  if (typeof globalThis.btoa !== "function") {
    globalThis.btoa = str => Buffer.from(str, "binary").toString("base64");
  }
  if (typeof globalThis.atob !== "function") {
    globalThis.atob = b64 => Buffer.from(b64, "base64").toString("binary");
  }
}

ensureWebCrypto();

const CONFIG = {
  port: Number(process.env.PORT ?? 8899),
  originSize: Number(process.env.ORIGIN_SIZE ?? 256),
  sign: {
    N: Number(process.env.SIGN_N ?? 5),
    mode: process.env.SIGN_MODE ?? "S",
    hash: process.env.SIGN_HASH ?? "SHA-256"
  },
  contentBytes: Number(process.env.CONTENT_BYTES ?? 32)
};

function normalizeOriginSize(value, fallback = 256) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n % 8 !== 0) {
    throw new Error("originSize must be a positive multiple of 8 (bits)");
  }
  return n;
}

function normalizeFormat(value, fallback = "hex") {
  if (value == null || value === "") return fallback;
  const fmt = String(value).toLowerCase();
  if (fmt === "hex" || fmt === "base64" || fmt === "bytes") return fmt;
  throw new Error("format must be hex, base64, or bytes");
}

function normalizeId(value) {
  const id = Number(value);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    throw new Error("id must be a positive integer");
  }
  return id;
}

function parseBytes(input, format, label) {
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (Array.isArray(input)) return Buffer.from(input);
  if (typeof input !== "string") {
    throw new Error(`${label} must be a string or byte array`);
  }
  const trimmed = input.trim();
  const fmt = normalizeFormat(format, "hex");
  if (fmt === "bytes") {
    throw new Error(`${label} with format=bytes must be an array`);
  }
  if (fmt === "hex") return Buffer.from(trimmed, "hex");
  if (fmt === "base64") return Buffer.from(trimmed, "base64");
  throw new Error(`Unsupported ${label} format`);
}

function encodeBytes(bytes, format) {
  const fmt = normalizeFormat(format, "base64");
  if (fmt === "hex") return Buffer.from(bytes).toString("hex");
  if (fmt === "base64") return Buffer.from(bytes).toString("base64");
  if (fmt === "bytes") return Array.from(Buffer.from(bytes));
  return Buffer.from(bytes).toString("base64");
}

function durationMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

const store = new Map();
let nextId = 1;

const uldaVerifier = new UldaSign({
  fmt: { export: "bytes" },
  sign: { originSize: normalizeOriginSize(CONFIG.originSize, 256) }
});

async function handleCreate(payload) {
  const key = parseBytes(payload.ulda_key ?? payload.uldaKey, payload.format, "ulda_key");
  const content = parseBytes(payload.content, payload.contentFormat ?? "base64", "content");
  const id = nextId++;
  store.set(id, {
    id,
    ulda_key: key,
    content,
    updatedAt: Date.now()
  });
  return { id };
}

async function handleRead(payload) {
  const id = normalizeId(payload.id);
  const row = store.get(id);
  if (!row) return { status: 404, error: "not found" };
  const format = payload.format ?? "base64";
  const contentFormat = payload.contentFormat ?? "base64";
  return {
    id: row.id,
    ulda_key: encodeBytes(row.ulda_key, format),
    content: encodeBytes(row.content, contentFormat),
    format: normalizeFormat(format, "base64"),
    contentFormat: normalizeFormat(contentFormat, "base64")
  };
}

async function handleUpdate(payload) {
  const id = normalizeId(payload.id);
  const row = store.get(id);
  if (!row) return { status: 404, error: "not found" };

  const newKey = parseBytes(payload.ulda_key ?? payload.uldaKey, payload.format, "ulda_key");
  const newContent = parseBytes(payload.content, payload.contentFormat ?? "base64", "content");

  const verified = await uldaVerifier.verify(row.ulda_key, newKey);
  if (!verified) return { status: 400, error: "signature verification failed" };

  row.ulda_key = newKey;
  row.content = newContent;
  row.updatedAt = Date.now();
  return { verified: true };
}

async function handleDelete(payload) {
  const id = normalizeId(payload.id);
  const row = store.get(id);
  if (!row) return { status: 404, error: "not found" };

  const key = parseBytes(payload.ulda_key ?? payload.uldaKey, payload.format, "ulda_key");
  const verified = await uldaVerifier.verify(row.ulda_key, key);
  if (!verified) return { status: 400, error: "signature verification failed" };

  store.delete(id);
  return { deleted: true };
}

function createServer({ port = CONFIG.port } = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (req, res) => {
    res.json({
      name: "max_speed_test_server",
      ok: true,
      endpoints: ["/config", "/records", "/records/:id", "/health", "/stats", "/browser-test"]
    });
  });

  app.get("/config", (req, res) => {
    res.json({
      originSize: normalizeOriginSize(CONFIG.originSize, 256),
      sign: {
        N: CONFIG.sign.N,
        mode: CONFIG.sign.mode,
        hash: CONFIG.sign.hash
      },
      contentBytes: CONFIG.contentBytes,
      format: "base64",
      contentFormat: "base64"
    });
  });

  app.get("/health", (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.get("/stats", (req, res) => {
    res.json({
      ok: true,
      recordsInMemory: store.size,
      nextId
    });
  });

  app.post("/records", async (req, res) => {
    const t0 = process.hrtime.bigint();
    try {
      const response = await handleCreate(req.body ?? {});
      return res.json({ ok: true, ...response, durationMs: durationMs(t0) });
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: err?.message ?? String(err),
        durationMs: durationMs(t0)
      });
    }
  });

  app.get("/records/:id", async (req, res) => {
    const t0 = process.hrtime.bigint();
    try {
      const response = await handleRead({
        id: req.params.id,
        format: req.query.format,
        contentFormat: req.query.contentFormat
      });
      if (response.status === 404) {
        return res.status(404).json({ ok: false, error: response.error, durationMs: durationMs(t0) });
      }
      return res.json({ ok: true, ...response, durationMs: durationMs(t0) });
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: err?.message ?? String(err),
        durationMs: durationMs(t0)
      });
    }
  });

  app.put("/records/:id", async (req, res) => {
    const t0 = process.hrtime.bigint();
    try {
      const response = await handleUpdate({
        id: req.params.id,
        ...req.body
      });
      if (response.status) {
        return res.status(response.status).json({
          ok: false,
          error: response.error,
          durationMs: durationMs(t0)
        });
      }
      return res.json({ ok: true, ...response, durationMs: durationMs(t0) });
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: err?.message ?? String(err),
        durationMs: durationMs(t0)
      });
    }
  });

  app.delete("/records/:id", async (req, res) => {
    const t0 = process.hrtime.bigint();
    try {
      const response = await handleDelete({
        id: req.params.id,
        ...req.body
      });
      if (response.status) {
        return res.status(response.status).json({
          ok: false,
          error: response.error,
          durationMs: durationMs(t0)
        });
      }
      return res.json({ ok: true, ...response, durationMs: durationMs(t0) });
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: err?.message ?? String(err),
        durationMs: durationMs(t0)
      });
    }
  });

  app.use("/browser-test", express.static(browserTestDir));

  const httpServer = http.createServer(app);
  const start = () =>
    new Promise(resolve => {
      httpServer.listen(port, () => resolve({ port }));
    });
  const stop = () =>
    new Promise((resolve, reject) => {
      httpServer.close(err => (err ? reject(err) : resolve()));
    });

  return { app, httpServer, start, stop };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { start } = createServer({ port: CONFIG.port });
  start().then(({ port }) => {
    console.log(`max_speed_test_server listening on http://localhost:${port}`);
    console.log("Browser test: http://localhost:8899/browser-test/");
    console.log(`source: ${path.resolve(__dirname)}`);
  });
}

export {
  createServer,
  handleCreate,
  handleRead,
  handleUpdate,
  handleDelete
};
