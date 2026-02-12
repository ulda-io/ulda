import { webcrypto } from "node:crypto";
import UldaSign from "../../../packages/ulda-sign/ulda-sign.js";

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

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8899";
const CLIENTS = Number(process.env.CLIENTS ?? 100);
const UPDATES_PER_CLIENT = Number(process.env.UPDATES_PER_CLIENT ?? 5);
const CONTENT_BYTES = Number(process.env.CONTENT_BYTES ?? 32);

function randomBase64(byteLen) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

async function jsonRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    const message = json?.error ?? `HTTP ${response.status}`;
    throw new Error(`${method} ${path} failed: ${message}`);
  }
  return json;
}

async function runClient(clientId, signCfg) {
  const signer = new UldaSign({
    fmt: { export: "base64" },
    sign: {
      N: signCfg.N,
      mode: signCfg.mode,
      hash: signCfg.hash,
      originSize: signCfg.originSize
    }
  });

  const baseIndex = BigInt(clientId) * 1000000n;
  let state = signer.New(baseIndex);
  let signature = await signer.sign(state);

  const created = await jsonRequest("/records", {
    method: "POST",
    body: {
      ulda_key: signature,
      content: randomBase64(CONTENT_BYTES),
      format: "base64",
      contentFormat: "base64"
    }
  });
  const id = created.id;

  for (let i = 0; i < UPDATES_PER_CLIENT; i++) {
    state = signer.stepUp(state);
    signature = await signer.sign(state);
    await jsonRequest(`/records/${id}`, {
      method: "PUT",
      body: {
        ulda_key: signature,
        content: randomBase64(CONTENT_BYTES),
        format: "base64",
        contentFormat: "base64"
      }
    });
    if (i === 0 || i === UPDATES_PER_CLIENT - 1) {
      await jsonRequest(`/records/${id}?format=base64&contentFormat=base64`);
    }
  }

  state = signer.stepUp(state);
  signature = await signer.sign(state);
  await jsonRequest(`/records/${id}`, {
    method: "DELETE",
    body: { ulda_key: signature, format: "base64" }
  });
}

async function main() {
  const t0 = process.hrtime.bigint();
  const serverCfg = await jsonRequest("/config");
  const signCfg = {
    ...serverCfg.sign,
    originSize: serverCfg.originSize
  };

  const results = await Promise.allSettled(
    Array.from({ length: CLIENTS }, (_, i) => runClient(i + 1, signCfg))
  );

  const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const failures = results.filter(r => r.status === "rejected");
  const success = CLIENTS - failures.length;

  const requestsPerClient = 1 + UPDATES_PER_CLIENT + 2 + 1;
  const totalRequests = CLIENTS * requestsPerClient;
  const rps = totalRequests / (durationMs / 1000);

  console.log("Stress test completed");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Clients: ${CLIENTS}`);
  console.log(`Updates per client: ${UPDATES_PER_CLIENT}`);
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Success clients: ${success}`);
  console.log(`Failed clients: ${failures.length}`);
  console.log(`Duration: ${durationMs.toFixed(2)} ms`);
  console.log(`Approx throughput: ${rps.toFixed(2)} req/s`);

  if (failures.length > 0) {
    console.log("Sample errors:");
    failures.slice(0, 10).forEach((f, i) => {
      console.log(`${i + 1}. ${f.reason?.message ?? String(f.reason)}`);
    });
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error("Stress test failed:", err?.message ?? String(err));
  process.exit(1);
});
