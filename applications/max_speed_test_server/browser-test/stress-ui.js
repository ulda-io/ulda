import UldaSign from "./ulda-sign.js";

const els = {
  serverBase: document.querySelector("#serverBase"),
  serverConfig: document.querySelector("#serverConfig"),
  clients: document.querySelector("#clients"),
  durationSeconds: document.querySelector("#durationSeconds"),
  contentBytes: document.querySelector("#contentBytes"),
  startIndex: document.querySelector("#startIndex"),
  runBtn: document.querySelector("#runBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  status: document.querySelector("#status"),
  progress: document.querySelector("#progress"),
  okClients: document.querySelector("#okClients"),
  failClients: document.querySelector("#failClients"),
  totalRequests: document.querySelector("#totalRequests"),
  durationMs: document.querySelector("#durationMs"),
  rps: document.querySelector("#rps"),
  opsBody: document.querySelector("#opsBody"),
  details: document.querySelector("#details"),
  jsonReport: document.querySelector("#jsonReport")
};

const state = {
  baseUrl: location.origin === "null" ? "http://127.0.0.1:8899" : location.origin,
  config: null,
  running: false,
  cancelled: false,
  finishedClients: 0,
  failedClients: 0
};

function setStatus(text) {
  els.status.textContent = text;
}

function setProgress(done, total) {
  els.progress.textContent = `${done} / ${total}`;
}

function randomBase64(byteLen) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

function createBucket() {
  return { ok: 0, fail: 0, clientMsSum: 0, serverMsSum: 0, clientMsList: [] };
}

function createMetrics() {
  return {
    create: createBucket(),
    update: createBucket(),
    read: createBucket(),
    delete: createBucket()
  };
}

function track(bucket, ok, clientMs, serverMs) {
  if (ok) bucket.ok += 1;
  else bucket.fail += 1;
  bucket.clientMsSum += clientMs ?? 0;
  bucket.serverMsSum += serverMs ?? 0;
  if (Number.isFinite(clientMs)) bucket.clientMsList.push(clientMs);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function fmt(v, digits = 2) {
  return Number(v || 0).toFixed(digits);
}

function summarizeBucket(bucket) {
  const count = bucket.ok + bucket.fail;
  return {
    count,
    failures: bucket.fail,
    avgClientMs: Number((count ? bucket.clientMsSum / count : 0).toFixed(2)),
    avgServerMs: Number((count ? bucket.serverMsSum / count : 0).toFixed(2))
  };
}

function updateOpsTable(metrics) {
  const rows = [
    ["create", metrics.create],
    ["update", metrics.update],
    ["read", metrics.read],
    ["delete", metrics.delete]
  ].map(([name, bucket]) => {
    const total = bucket.ok + bucket.fail;
    const avgClient = total ? bucket.clientMsSum / total : 0;
    const avgServer = total ? bucket.serverMsSum / total : 0;
    const p95 = percentile(bucket.clientMsList, 95);

    return `<tr>
      <td>${name}</td>
      <td>${bucket.ok}</td>
      <td>${bucket.fail}</td>
      <td>${fmt(avgClient)}</td>
      <td>${fmt(p95)}</td>
      <td>${fmt(avgServer)}</td>
    </tr>`;
  });

  els.opsBody.innerHTML = rows.join("");
}

function buildJsonReport(metrics, totals, settings) {
  const totalMs = performance.now() - totals.startedAt;
  const totalOps = totals.requests;
  const opsPerSec = totalMs > 0 ? totalOps / (totalMs / 1000) : 0;

  return {
    config: state.config ?? null,
    settings: {
      count: settings.clients,
      concurrency: settings.clients,
      durationMs: settings.durationMs,
      doRead: true,
      doDelete: true
    },
    totals: {
      totalOps,
      totalMs: Number(totalMs.toFixed(2)),
      opsPerSec: Number(opsPerSec.toFixed(2))
    },
    create: summarizeBucket(metrics.create),
    update: summarizeBucket(metrics.update),
    read: summarizeBucket(metrics.read),
    delete: summarizeBucket(metrics.delete)
  };
}

function updateJsonReport(metrics, totals, settings) {
  if (!els.jsonReport) return;
  const report = buildJsonReport(metrics, totals, settings);
  els.jsonReport.textContent = JSON.stringify(report, null, 2);
}

async function fetchJson(path, options = {}) {
  const started = performance.now();
  const response = await fetch(`${state.baseUrl}${path}`, options);
  const json = await response.json().catch(() => ({}));
  const clientMs = performance.now() - started;
  const ok = response.ok && json?.ok !== false;
  return { ok, json, clientMs };
}

async function loadConfig() {
  const response = await fetchJson("/config");
  if (!response.ok) throw new Error(response.json?.error ?? "Cannot load /config");
  state.config = response.json;

  els.serverConfig.textContent =
    `originSize=${state.config.originSize}, N=${state.config.sign.N}, ` +
    `mode=${state.config.sign.mode}, hash=${state.config.sign.hash}`;
}

async function clientRun(clientId, settings, metrics) {
  const signer = new UldaSign({
    fmt: { export: "base64" },
    sign: {
      N: state.config.sign.N,
      mode: state.config.sign.mode,
      hash: state.config.sign.hash,
      originSize: state.config.originSize
    }
  });

  const baseIndex = BigInt(settings.startIndex) + BigInt(clientId) * 1000000n;
  let statePkg = signer.New(baseIndex);
  let signature = await signer.sign(statePkg);
  let localRequestCount = 0;

  const createResponse = await fetchJson("/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ulda_key: signature,
      content: randomBase64(settings.contentBytes),
      format: "base64",
      contentFormat: "base64"
    })
  });

  localRequestCount += 1;
  track(metrics.create, createResponse.ok, createResponse.clientMs, createResponse.json?.durationMs);
  if (!createResponse.ok) throw new Error(createResponse.json?.error ?? "create failed");

  const id = createResponse.json.id;
  const endAt = performance.now() + settings.durationMs;

  while (!state.cancelled && performance.now() < endAt) {
    statePkg = signer.stepUp(statePkg);
    signature = await signer.sign(statePkg);

    const updateResponse = await fetchJson(`/records/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ulda_key: signature,
        content: randomBase64(settings.contentBytes),
        format: "base64",
        contentFormat: "base64"
      })
    });

    localRequestCount += 1;
    track(metrics.update, updateResponse.ok, updateResponse.clientMs, updateResponse.json?.durationMs);
    if (!updateResponse.ok) throw new Error(updateResponse.json?.error ?? "update failed");

    const readResponse = await fetchJson(`/records/${id}?format=base64&contentFormat=base64`);
    localRequestCount += 1;
    track(metrics.read, readResponse.ok, readResponse.clientMs, readResponse.json?.durationMs);
    if (!readResponse.ok) throw new Error(readResponse.json?.error ?? "read failed");
  }

  if (state.cancelled) throw new Error("cancelled");

  statePkg = signer.stepUp(statePkg);
  signature = await signer.sign(statePkg);

  const deleteResponse = await fetchJson(`/records/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ulda_key: signature, format: "base64" })
  });

  localRequestCount += 1;
  track(metrics.delete, deleteResponse.ok, deleteResponse.clientMs, deleteResponse.json?.durationMs);
  if (!deleteResponse.ok) throw new Error(deleteResponse.json?.error ?? "delete failed");

  return localRequestCount;
}

function updateSummary(metrics, totals) {
  const elapsedMs = performance.now() - totals.startedAt;
  const throughput = elapsedMs > 0 ? totals.requests / (elapsedMs / 1000) : 0;

  els.okClients.textContent = String(state.finishedClients - state.failedClients);
  els.failClients.textContent = String(state.failedClients);
  els.totalRequests.textContent = String(totals.requests);
  els.durationMs.textContent = fmt(elapsedMs, 1);
  els.rps.textContent = fmt(throughput, 2);

  updateOpsTable(metrics);
}

function setDetails(text) {
  els.details.textContent = text;
}

async function runTest() {
  if (state.running) return;

  state.running = true;
  state.cancelled = false;
  state.finishedClients = 0;
  state.failedClients = 0;

  els.runBtn.disabled = true;
  els.stopBtn.disabled = false;

  const settings = {
    clients: Math.max(1, Number(els.clients.value || 100)),
    durationMs: Math.max(1, Number(els.durationSeconds.value || 10)) * 1000,
    contentBytes: Math.max(1, Number(els.contentBytes.value || 32)),
    startIndex: Math.max(0, Number(els.startIndex.value || 1000000))
  };

  setStatus("running");
  setProgress(0, settings.clients);
  setDetails("Running test...");

  const metrics = createMetrics();
  const totals = { startedAt: performance.now(), requests: 0 };
  updateSummary(metrics, totals);
  updateJsonReport(metrics, totals, settings);

  try {
    if (!state.config) await loadConfig();

    const tasks = Array.from({ length: settings.clients }, (_, index) =>
      clientRun(index + 1, settings, metrics)
        .then(requests => {
          totals.requests += requests;
        })
        .catch(error => {
          if (String(error?.message ?? "") !== "cancelled") {
            state.failedClients += 1;
            setDetails(`Test error: ${error?.message ?? String(error)}\n\n${els.details.textContent}`);
          }
        })
        .finally(() => {
          state.finishedClients += 1;
          setProgress(state.finishedClients, settings.clients);
          updateSummary(metrics, totals);
          updateJsonReport(metrics, totals, settings);
        })
    );

    await Promise.all(tasks);

    const elapsedMs = performance.now() - totals.startedAt;
    const throughput = elapsedMs > 0 ? totals.requests / (elapsedMs / 1000) : 0;

    setDetails(
      [
        "Test completed.",
        `clients=${settings.clients}`,
        `durationSec=${fmt(settings.durationMs / 1000, 0)}`,
        `contentBytes=${settings.contentBytes}`,
        `requests=${totals.requests}`,
        `durationMs=${fmt(elapsedMs, 2)}`,
        `reqPerSec=${fmt(throughput, 2)}`
      ].join("\n")
    );

    setStatus(state.cancelled ? "stopped" : "done");
    updateJsonReport(metrics, totals, settings);
  } catch (error) {
    setStatus("error");
    setDetails(`Startup error: ${error?.message ?? String(error)}`);
  } finally {
    state.running = false;
    els.runBtn.disabled = false;
    els.stopBtn.disabled = true;
  }
}

function stopTest() {
  if (!state.running) return;
  state.cancelled = true;
  setStatus("stopping");
}

els.runBtn.addEventListener("click", runTest);
els.stopBtn.addEventListener("click", stopTest);
els.serverBase.textContent = state.baseUrl;

loadConfig().catch(error => {
  setStatus("config error");
  setDetails(`Config error: ${error?.message ?? String(error)}`);
});
