import UldaSign from "./ulda-sign.js";

const recordCountEl = document.querySelector("#recordCount");
const updatesPerEl = document.querySelector("#updatesPer");
const concurrencyEl = document.querySelector("#concurrency");
const stressSecondsEl = document.querySelector("#stressSeconds");
const doReadEl = document.querySelector("#doRead");
const doDeleteEl = document.querySelector("#doDelete");
const outputEl = document.querySelector("#output");
const statusEl = document.querySelector("#status");
const serverEl = document.querySelector("#server");
const configEl = document.querySelector("#config");
const runBtn = document.querySelector("#runBtn");
const stressBtn = document.querySelector("#stressBtn");
const stopBtn = document.querySelector("#stopBtn");

const fallbackOrigin = location.origin === "null" ? "http://localhost:8787" : location.origin;
const serverBase = new URLSearchParams(location.search).get("server") ?? fallbackOrigin;
serverEl.textContent = serverBase;

const state = {
  config: null,
  ulda: null,
  cancelled: false,
  running: false
};

function setStatus(text, tone = "idle") {
  statusEl.textContent = text;
  statusEl.style.background = tone === "error" ? "#ffe5e5" : "#e9efff";
  statusEl.style.color = tone === "error" ? "#b91c1c" : "#2f6bff";
}

function show(result) {
  outputEl.textContent = JSON.stringify(result, null, 2);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

function randomBytes(size) {
  const arr = new Uint8Array(size);
  crypto.getRandomValues(arr);
  return arr;
}

async function fetchJsonWithTiming(url, options) {
  const start = performance.now();
  const res = await fetch(url, options);
  const data = await res.json();
  const clientMs = Number((performance.now() - start).toFixed(2));
  return { data, clientMs };
}

async function loadConfig() {
  const { data } = await fetchJsonWithTiming(`${serverBase}/config`);
  if (!data?.originSize) throw new Error("config unavailable");
  state.config = data;
  configEl.textContent = `originSize=${data.originSize}, N=${data.sign.N}, mode=${data.sign.mode}, hash=${data.sign.hash}`;
}

function ensureSigner() {
  if (!state.config) throw new Error("Config not loaded");
  if (state.ulda) return;
  state.ulda = new UldaSign({
    fmt: { export: "hex" },
    sign: {
      originSize: state.config.originSize,
      N: state.config.sign.N,
      mode: state.config.sign.mode,
      hash: state.config.sign.hash
    }
  });
}

function makeMetrics() {
  const base = () => ({ count: 0, failures: 0, clientMsTotal: 0, serverMsTotal: 0 });
  return {
    create: base(),
    update: base(),
    read: base(),
    delete: base()
  };
}

function recordMetric(metrics, name, result) {
  const bucket = metrics[name];
  bucket.count += 1;
  if (!result.ok) bucket.failures += 1;
  bucket.clientMsTotal += result.clientMs ?? 0;
  bucket.serverMsTotal += result.durationMs ?? 0;
}

function summarizeMetric(metric) {
  const avgClient = metric.count ? metric.clientMsTotal / metric.count : 0;
  const avgServer = metric.count ? metric.serverMsTotal / metric.count : 0;
  return {
    count: metric.count,
    failures: metric.failures,
    avgClientMs: Number(avgClient.toFixed(2)),
    avgServerMs: Number(avgServer.toFixed(2))
  };
}

function mapWithConcurrency(items, limit, worker) {
  let index = 0;
  const results = new Array(items.length);
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  });
  return Promise.all(runners).then(() => results);
}

function checkCancelled() {
  if (state.cancelled) {
    throw new Error("Cancelled");
  }
}

async function createRecord() {
  const originPkg = state.ulda.New(0n);
  const sigA = await state.ulda.sign(originPkg);
  const content = bytesToBase64(randomBytes(state.config.contentBytes));
  const { data, clientMs } = await fetchJsonWithTiming(`${serverBase}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ulda_key: sigA,
      content,
      format: "hex",
      contentFormat: "base64"
    })
  });
  return { data, clientMs, originPkg, sigA, content };
}

async function updateRecord(record) {
  record.originPkg = state.ulda.stepUp(record.originPkg);
  const sigB = await state.ulda.sign(record.originPkg);
  const content = bytesToBase64(randomBytes(state.config.contentBytes));
  const { data, clientMs } = await fetchJsonWithTiming(`${serverBase}/records/${record.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ulda_key: sigB,
      content,
      format: "hex",
      contentFormat: "base64"
    })
  });
  if (data.ok) {
    record.sigA = sigB;
    record.content = content;
  }
  return { data, clientMs };
}

async function readRecord(record) {
  const { data, clientMs } = await fetchJsonWithTiming(
    `${serverBase}/records/${record.id}?format=hex&contentFormat=base64`
  );
  return { data, clientMs };
}

async function deleteRecord(record) {
  // For DELETE the server expects a "forward" signature (the next state), otherwise verify() will fail.
  const nextOrigin = state.ulda.stepUp(record.originPkg);
  const sigDel = await state.ulda.sign(nextOrigin);

  const { data, clientMs } = await fetchJsonWithTiming(`${serverBase}/records/${record.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ulda_key: sigDel, format: "hex" })
  });

  // if delete succeeds — record that we've "consumed" the step
  if (data.ok) {
    record.originPkg = nextOrigin;
    record.sigA = sigDel;
  }

  return { data, clientMs };
}


async function runTest() {
  setStatus("running...");
  runBtn.disabled = true;
  stressBtn.disabled = true;
  stopBtn.disabled = false;
  state.cancelled = false;
  state.running = true;

  const count = Math.max(1, Number(recordCountEl.value || 1));
  const updatesPer = Math.max(0, Number(updatesPerEl.value || 0));
  const concurrency = Math.max(1, Number(concurrencyEl.value || 1));
  const doRead = doReadEl.checked;
  const doDelete = doDeleteEl.checked;

  const metrics = makeMetrics();
  const records = [];
  const startAll = performance.now();

  try {
    if (!state.config) await loadConfig();
    ensureSigner();

    setStatus("creating...");
    const createResults = await mapWithConcurrency(
      Array.from({ length: count }),
      concurrency,
      async () => {
        checkCancelled();
        const result = await createRecord();
        recordMetric(metrics, "create", {
          ok: result.data.ok,
          clientMs: result.clientMs,
          durationMs: result.data.durationMs
        });
        if (result.data.ok) {
          records.push({
            id: result.data.id,
            originPkg: result.originPkg,
            sigA: result.sigA,
            content: result.content
          });
        }
        return result.data.ok;
      }
    );

    if (!createResults.every(Boolean)) {
      setStatus("create errors", "error");
    }

    if (updatesPer > 0 && records.length) {
      setStatus("updating...");
      await mapWithConcurrency(records, concurrency, async record => {
        for (let i = 0; i < updatesPer; i++) {
          checkCancelled();
          const result = await updateRecord(record);
          recordMetric(metrics, "update", {
            ok: result.data.ok,
            clientMs: result.clientMs,
            durationMs: result.data.durationMs
          });
          if (!result.data.ok) break;
        }
      });
    }

    if (doRead && records.length) {
      setStatus("reading...");
      await mapWithConcurrency(records, concurrency, async record => {
        checkCancelled();
        const result = await readRecord(record);
        recordMetric(metrics, "read", {
          ok: result.data.ok,
          clientMs: result.clientMs,
          durationMs: result.data.durationMs
        });
      });
    }

    if (doDelete && records.length) {
      setStatus("deleting...");
      await mapWithConcurrency(records, concurrency, async record => {
        checkCancelled();
        const result = await deleteRecord(record);
        recordMetric(metrics, "delete", {
          ok: result.data.ok,
          clientMs: result.clientMs,
          durationMs: result.data.durationMs
        });
      });
    }

    const totalMs = performance.now() - startAll;
    const totalOps =
      metrics.create.count + metrics.update.count + metrics.read.count + metrics.delete.count;
    const opsPerSec = totalMs ? totalOps / (totalMs / 1000) : 0;

    setStatus("done");
    show({
      config: state.config,
      settings: { count, updatesPer, concurrency, doRead, doDelete },
      totals: {
        totalOps,
        totalMs: Number(totalMs.toFixed(2)),
        opsPerSec: Number(opsPerSec.toFixed(2))
      },
      create: summarizeMetric(metrics.create),
      update: summarizeMetric(metrics.update),
      read: summarizeMetric(metrics.read),
      delete: summarizeMetric(metrics.delete)
    });
  } catch (err) {
    if (err?.message === "Cancelled") {
      setStatus("cancelled", "error");
    } else {
      setStatus("error", "error");
    }
    show({ ok: false, error: err?.message ?? String(err) });
  } finally {
    runBtn.disabled = false;
    stressBtn.disabled = false;
    stopBtn.disabled = true;
    state.running = false;
  }
}

runBtn.addEventListener("click", () => {
  if (state.running) return;
  runTest();
});

async function runStress() {
  setStatus("stress...");
  runBtn.disabled = true;
  stressBtn.disabled = true;
  stopBtn.disabled = false;
  state.cancelled = false;
  state.running = true;

  const concurrency = Math.max(1, Number(concurrencyEl.value || 1));
  const count = Math.max(concurrency, Number(recordCountEl.value || 1));
  const durationMs = Math.max(1, Number(stressSecondsEl.value || 10)) * 1000;
  const doRead = doReadEl.checked;
  const doDelete = doDeleteEl.checked;

  const metrics = makeMetrics();
  const records = [];
  const startAll = performance.now();

  try {
    if (!state.config) await loadConfig();
    ensureSigner();

    setStatus("stress: creating records...");
    await mapWithConcurrency(
      Array.from({ length: count }),
      Math.min(concurrency, count),
      async () => {
        checkCancelled();
        const result = await createRecord();
        recordMetric(metrics, "create", {
          ok: result.data.ok,
          clientMs: result.clientMs,
          durationMs: result.data.durationMs
        });
        if (result.data.ok) {
          records.push({
            id: result.data.id,
            originPkg: result.originPkg,
            sigA: result.sigA,
            content: result.content
          });
        }
      }
    );

    if (!records.length) throw new Error("No records created for stress test");

    setStatus("stress: hammering updates...");
    const endAt = performance.now() + durationMs;

    await mapWithConcurrency(
    Array.from({ length: concurrency }),
    concurrency,
    async (_, workerId) => {
      const record = records[workerId];

      while (performance.now() < endAt) {
        checkCancelled();

        const update = await updateRecord(record);
        recordMetric(metrics, "update", {
          ok: update.data.ok,
          clientMs: update.clientMs,
          durationMs: update.data.durationMs
        });

        if (doRead) {
          const read = await readRecord(record);
          recordMetric(metrics, "read", {
            ok: read.data.ok,
            clientMs: read.clientMs,
            durationMs: read.data.durationMs
          });
        }
      }
    }
  );

    if (doDelete) {
      setStatus("stress: deleting...");
      await mapWithConcurrency(records, Math.min(concurrency, records.length), async record => {
        checkCancelled();
        const del = await deleteRecord(record);
        recordMetric(metrics, "delete", {
          ok: del.data.ok,
          clientMs: del.clientMs,
          durationMs: del.data.durationMs
        });
      });
    }

    const totalMs = performance.now() - startAll;
    const totalOps =
      metrics.create.count + metrics.update.count + metrics.read.count + metrics.delete.count;
    const opsPerSec = totalMs ? totalOps / (totalMs / 1000) : 0;

    setStatus("stress done");
    show({
      config: state.config,
      settings: { count, concurrency, durationMs, doRead, doDelete },
      totals: {
        totalOps,
        totalMs: Number(totalMs.toFixed(2)),
        opsPerSec: Number(opsPerSec.toFixed(2))
      },
      create: summarizeMetric(metrics.create),
      update: summarizeMetric(metrics.update),
      read: summarizeMetric(metrics.read),
      delete: summarizeMetric(metrics.delete)
    });
  } catch (err) {
    if (err?.message === "Cancelled") {
      setStatus("cancelled", "error");
    } else {
      setStatus("error", "error");
    }
    show({ ok: false, error: err?.message ?? String(err) });
  } finally {
    runBtn.disabled = false;
    stressBtn.disabled = false;
    stopBtn.disabled = true;
    state.running = false;
  }
}

stressBtn.addEventListener("click", () => {
  if (state.running) return;
  runStress();
});

stopBtn.addEventListener("click", () => {
  state.cancelled = true;
});

loadConfig().catch(err => {
  setStatus("config error", "error");
  show({ ok: false, error: err?.message ?? String(err) });
});
