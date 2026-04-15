const serverEl = document.querySelector("#server");
const configEl = document.querySelector("#config");
const concurrencyEl = document.querySelector("#concurrency");
const durationMsEl = document.querySelector("#durationMs");
const contentBytesEl = document.querySelector("#contentBytes");
const signatureFormatEl = document.querySelector("#signatureFormat");
const doReadEl = document.querySelector("#doRead");
const doDeleteEl = document.querySelector("#doDelete");
const runBtn = document.querySelector("#runBtn");
const stopBtn = document.querySelector("#stopBtn");
const statusEl = document.querySelector("#status");
const progressEl = document.querySelector("#progress");
const totalOpsEl = document.querySelector("#totalOps");
const totalMsEl = document.querySelector("#totalMs");
const opsPerSecEl = document.querySelector("#opsPerSec");
const workerErrorsEl = document.querySelector("#workerErrors");
const outputEl = document.querySelector("#output");

const fallbackOrigin = location.origin === "null" ? "http://localhost:8899" : location.origin;
const serverBase = new URLSearchParams(location.search).get("server") ?? fallbackOrigin;
serverEl.textContent = serverBase;

const state = {
  config: null,
  running: false,
  cancelled: false,
  workers: []
};

function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(done, total) {
  progressEl.textContent = `${done} / ${total}`;
}

function showJson(value) {
  outputEl.textContent = JSON.stringify(value, null, 2);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return response.json();
}

async function loadConfig() {
  const data = await fetchJson(`${serverBase}/config`);
  if (!data?.originSize || !data?.sign) throw new Error("config unavailable");
  state.config = data;
  configEl.textContent =
    `originSize=${data.originSize}, N=${data.sign.N}, mode=${data.sign.mode}, hash=${data.sign.hash}`;
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
  const avgClientMs = bucket.count ? bucket.clientMsTotal / bucket.count : 0;
  const avgServerMs = bucket.count ? bucket.serverMsTotal / bucket.count : 0;
  return {
    count: bucket.count,
    failures: bucket.failures,
    avgClientMs: Number(avgClientMs.toFixed(2)),
    avgServerMs: Number(avgServerMs.toFixed(2))
  };
}

function stopAllWorkers() {
  for (const worker of state.workers) worker.terminate();
  state.workers = [];
}

function buildReport({ settings, metrics, totalOps, totalMs }) {
  const opsPerSec = totalMs > 0 ? totalOps / (totalMs / 1000) : 0;
  return {
    config: state.config,
    settings,
    totals: {
      totalOps,
      totalMs: Number(totalMs.toFixed(2)),
      opsPerSec: Number(opsPerSec.toFixed(2))
    },
    create: summarize(metrics.create),
    update: summarize(metrics.update),
    read: summarize(metrics.read),
    delete: summarize(metrics.delete)
  };
}

function updateLive({ totalOps, totalMs, workerErrors }) {
  const opsPerSec = totalMs > 0 ? totalOps / (totalMs / 1000) : 0;
  totalOpsEl.textContent = String(totalOps);
  totalMsEl.textContent = totalMs.toFixed(1);
  opsPerSecEl.textContent = opsPerSec.toFixed(2);
  workerErrorsEl.textContent = String(workerErrors);
}

async function runWorkersTest() {
  if (state.running) return;

  setStatus("running");
  runBtn.disabled = true;
  stopBtn.disabled = false;
  state.cancelled = false;
  state.running = true;

  let finished = 0;
  let workerErrors = 0;
  let totalRequests = 0;

  const metrics = makeMetrics();

  try {
    if (!state.config) await loadConfig();

    const concurrency = Math.max(1, Number(concurrencyEl.value || 1));
    const durationMs = Math.max(1, Number(durationMsEl.value || 10000));
    const contentBytes = Math.max(1, Number(contentBytesEl.value || state.config.contentBytes || 32));
    const doRead = doReadEl.checked;
    const doDelete = doDeleteEl.checked;
    const signatureFormat = signatureFormatEl.value === "hex" ? "hex" : "base64";

    const settings = {
      count: concurrency,
      concurrency,
      durationMs,
      doRead,
      doDelete,
      contentBytes,
      signatureFormat
    };

    const startAll = performance.now();
    setProgress(0, concurrency);

    const promises = Array.from({ length: concurrency }, (_, idx) => {
      const workerId = idx + 1;
      return new Promise((resolve, reject) => {
        const worker = new Worker("./stress-worker.js", { type: "module" });
        state.workers.push(worker);

        worker.onmessage = (event) => {
          const msg = event.data;
          if (msg?.type === "done") {
            resolve(msg);
            worker.terminate();
            return;
          }
          if (msg?.type === "error") {
            reject(msg);
            worker.terminate();
          }
        };

        worker.onerror = (event) => {
          reject({
            workerId,
            error: event?.message ?? "worker crashed"
          });
          worker.terminate();
        };

        worker.postMessage({
          type: "start",
          workerId,
          serverBase,
          config: state.config,
          durationMs,
          doRead,
          doDelete,
          contentBytes,
          signatureFormat
        });
      });
    });

    const settled = await Promise.allSettled(promises);

    for (const result of settled) {
      finished += 1;
      setProgress(finished, concurrency);

      if (result.status === "fulfilled") {
        totalRequests += result.value.requests ?? 0;
        mergeBucket(metrics.create, result.value.metrics.create);
        mergeBucket(metrics.update, result.value.metrics.update);
        mergeBucket(metrics.read, result.value.metrics.read);
        mergeBucket(metrics.delete, result.value.metrics.delete);
      } else {
        workerErrors += 1;
        const partial = result.reason?.metrics;
        if (partial) {
          totalRequests += result.reason.requests ?? 0;
          mergeBucket(metrics.create, partial.create ?? makeBucket());
          mergeBucket(metrics.update, partial.update ?? makeBucket());
          mergeBucket(metrics.read, partial.read ?? makeBucket());
          mergeBucket(metrics.delete, partial.delete ?? makeBucket());
        }
      }

      updateLive({
        totalOps: totalRequests,
        totalMs: performance.now() - startAll,
        workerErrors
      });
    }

    const totalMs = performance.now() - startAll;
    const report = buildReport({
      settings,
      metrics,
      totalOps: totalRequests,
      totalMs
    });

    showJson(report);
    setStatus(state.cancelled ? "stopped" : "done");
  } catch (err) {
    setStatus("error");
    showJson({ ok: false, error: err?.message ?? String(err) });
  } finally {
    stopAllWorkers();
    runBtn.disabled = false;
    stopBtn.disabled = true;
    state.running = false;
  }
}

runBtn.addEventListener("click", runWorkersTest);

stopBtn.addEventListener("click", () => {
  state.cancelled = true;
  stopAllWorkers();
  setStatus("stopped");
});

loadConfig().catch((err) => {
  setStatus("config error");
  showJson({ ok: false, error: err?.message ?? String(err) });
});
