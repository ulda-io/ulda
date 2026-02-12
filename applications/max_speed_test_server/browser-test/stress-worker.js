import UldaSign from "./ulda-sign.js";

let cancelled = false;

function randomBytes(size) {
  const arr = new Uint8Array(size);
  crypto.getRandomValues(arr);
  return arr;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchJsonWithTiming(url, options) {
  const start = performance.now();
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  const clientMs = Number((performance.now() - start).toFixed(2));
  return { ok: response.ok && data?.ok !== false, data, clientMs };
}

function createBucket() {
  return { count: 0, failures: 0, clientMsTotal: 0, serverMsTotal: 0 };
}

function addMetric(metrics, op, result) {
  const b = metrics[op];
  b.count += 1;
  if (!result.ok) b.failures += 1;
  b.clientMsTotal += result.clientMs ?? 0;
  b.serverMsTotal += result.data?.durationMs ?? 0;
}

function exportContent(bytes) {
  return bytesToBase64(bytes);
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message?.type === "stop") {
    cancelled = true;
    return;
  }

  if (message?.type !== "start") return;

  cancelled = false;

  const {
    workerId,
    serverBase,
    config,
    durationMs,
    doRead,
    doDelete,
    contentBytes,
    signatureFormat
  } = message;

  const metrics = {
    create: createBucket(),
    update: createBucket(),
    read: createBucket(),
    delete: createBucket()
  };

  let requests = 0;

  try {
    const ulda = new UldaSign({
      fmt: { export: signatureFormat },
      sign: {
        originSize: config.originSize,
        N: config.sign.N,
        mode: config.sign.mode,
        hash: config.sign.hash
      }
    });

    let originPkg = ulda.New(BigInt(workerId));
    let sig = await ulda.sign(originPkg);

    const createResult = await fetchJsonWithTiming(`${serverBase}/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ulda_key: sig,
        content: exportContent(randomBytes(contentBytes)),
        format: signatureFormat,
        contentFormat: "base64"
      })
    });
    requests += 1;
    addMetric(metrics, "create", createResult);

    if (!createResult.ok) {
      throw new Error(createResult.data?.error ?? `create failed in worker ${workerId}`);
    }

    const id = createResult.data.id;
    const endAt = performance.now() + durationMs;

    while (!cancelled && performance.now() < endAt) {
      originPkg = ulda.stepUp(originPkg);
      sig = await ulda.sign(originPkg);

      const updateResult = await fetchJsonWithTiming(`${serverBase}/records/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ulda_key: sig,
          content: exportContent(randomBytes(contentBytes)),
          format: signatureFormat,
          contentFormat: "base64"
        })
      });
      requests += 1;
      addMetric(metrics, "update", updateResult);

      if (!updateResult.ok) {
        throw new Error(updateResult.data?.error ?? `update failed in worker ${workerId}`);
      }

      if (doRead) {
        const readResult = await fetchJsonWithTiming(
          `${serverBase}/records/${id}?format=${encodeURIComponent(signatureFormat)}&contentFormat=base64`
        );
        requests += 1;
        addMetric(metrics, "read", readResult);

        if (!readResult.ok) {
          throw new Error(readResult.data?.error ?? `read failed in worker ${workerId}`);
        }
      }
    }

    if (!cancelled && doDelete) {
      const nextOrigin = ulda.stepUp(originPkg);
      const deleteSig = await ulda.sign(nextOrigin);

      const deleteResult = await fetchJsonWithTiming(`${serverBase}/records/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ulda_key: deleteSig,
          format: signatureFormat
        })
      });
      requests += 1;
      addMetric(metrics, "delete", deleteResult);

      if (!deleteResult.ok) {
        throw new Error(deleteResult.data?.error ?? `delete failed in worker ${workerId}`);
      }
    }

    self.postMessage({ type: "done", workerId, metrics, requests, cancelled });
  } catch (err) {
    self.postMessage({
      type: "error",
      workerId,
      error: err?.message ?? String(err),
      metrics,
      requests
    });
  }
};
