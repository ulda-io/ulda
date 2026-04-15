const recordCountEl = document.querySelector("#recordCount");
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
  cancelled: false,
  running: false,
  workers: []
};

function setStatus(text, tone = "idle") {
  statusEl.textContent = text;
  statusEl.style.background = tone === "error" ? "#ffe5e5" : "#e9efff";
  statusEl.style.color = tone === "error" ? "#b91c1c" : "#2f6bff";
}

function show(result) {
  outputEl.textContent = JSON.stringify(result, null, 2);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  return res.json();
}

async function loadConfig() {
  const data = await fetchJson(`${serverBase}/config`);
  if (!data?.originSize) throw new Error("config unavailable");
  state.config = data;
  configEl.textContent = `originSize=${data.originSize}, N=${data.sign.N}, mode=${data.sign.mode}, hash=${data.sign.hash}`;
}

function makeBucket() {
  return { count: 0, failures: 0, clientMsTotal: 0, serverMsTotal: 0 };
}

function makeMetrics() {
  return {
    create: makeBucket(),
    update: makeBucket(),
    read: makeBucket(),
    delete: makeBucket()
  };
}

function mergeBucket(dst, src) {
  dst.count += src.count;
  dst.failures += src.failures;
  dst.clientMsTotal += src.clientMsTotal;
  dst.serverMsTotal += src.serverMsTotal;
}

function summarize(bucket) {
  const avgClient = bucket.count ? bucket.clientMsTotal / bucket.count : 0;
  const avgServer = bucket.count ? bucket.serverMsTotal / bucket.count : 0;
  return {
    count: bucket.count,
    failures: bucket.failures,
    avgClientMs: Number(avgClient.toFixed(2)),
    avgServerMs: Number(avgServer.toFixed(2))
  };
}

function stopAllWorkers() {
  for (const w of state.workers) w.terminate();
  state.workers = [];
}

async function runStressWorkers() {
  setStatus("stress (workers)...");
  runBtn.disabled = true;
  stressBtn.disabled = true;
  stopBtn.disabled = false;
  state.cancelled = false;
  state.running = true;

  try {
    if (!state.config) await loadConfig();

    const concurrency = Math.max(1, Number(concurrencyEl.value || 1));
    const durationMs = Math.max(1, Number(stressSecondsEl.value || 10)) * 1000;
    const doRead = doReadEl.checked;
    const doDelete = doDeleteEl.checked;

    // В worker-режимі: 1 worker = 1 client = 1 record.
    // Тому "count" для settings логічно дорівнює concurrency.
    const count = concurrency;

    const metrics = makeMetrics();
    const startAll = performance.now();

    const donePromises = Array.from({ length: concurrency }, (_, workerId) => {
      return new Promise((resolve, reject) => {
        const w = new Worker("./stress-worker.js", { type: "module" });
        state.workers.push(w);

        w.onmessage = (ev) => {
          const msg = ev.data;
          if (msg?.type === "done") {
            resolve(msg);
            w.terminate();
          } else if (msg?.type === "error") {
            reject(new Error(`worker ${msg.workerId}: ${msg.error}`));
            w.terminate();
          }
        };

        w.onerror = (e) => {
          reject(new Error(`worker ${workerId} crashed: ${e.message ?? "unknown error"}`));
          w.terminate();
        };

        w.postMessage({
          type: "start",
          workerId,
          serverBase,
          config: state.config,
          durationMs,
          doRead,
          doDelete
        });
      });
    });

    const results = await Promise.allSettled(donePromises);

    for (const r of results) {
      if (r.status === "fulfilled") {
        const m = r.value.metrics;
        mergeBucket(metrics.create, m.create);
        mergeBucket(metrics.update, m.update);
        mergeBucket(metrics.read, m.read);
        mergeBucket(metrics.delete, m.delete);
      } else {
        // якщо частина воркерів впала — покажемо це як error у виводі
        // але метрики по тим, хто встиг, лишимо
        console.error(r.reason);
      }
    }

    const totalMs = performance.now() - startAll;
    const totalOps =
      metrics.create.count + metrics.update.count + metrics.read.count + metrics.delete.count;
    const opsPerSec = totalMs ? totalOps / (totalMs / 1000) : 0;

    setStatus("stress (workers) done");
    show({
      config: state.config,
      settings: { count, concurrency, durationMs, doRead, doDelete, impl: "web-workers" },
      totals: {
        totalOps,
        totalMs: Number(totalMs.toFixed(2)),
        opsPerSec: Number(opsPerSec.toFixed(2))
      },
      create: summarize(metrics.create),
      update: summarize(metrics.update),
      read: summarize(metrics.read),
      delete: summarize(metrics.delete)
    });
  } catch (err) {
    setStatus("error", "error");
    show({ ok: false, error: err?.message ?? String(err) });
  } finally {
    stopAllWorkers();
    runBtn.disabled = false;
    stressBtn.disabled = false;
    stopBtn.disabled = true;
    state.running = false;
  }
}

runBtn.addEventListener("click", () => {
  if (state.running) return;
  runStressWorkers();
});

stressBtn.addEventListener("click", () => {
  if (state.running) return;
  runStressWorkers();
});

stopBtn.addEventListener("click", () => {
  state.cancelled = true;
  stopAllWorkers();
  setStatus("stopped", "error");
});

loadConfig().catch(err => {
  setStatus("config error", "error");
  show({ ok: false, error: err?.message ?? String(err) });
});
