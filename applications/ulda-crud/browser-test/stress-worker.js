import UldaSign from "./ulda-sign.js";

let cancelled = false;

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

function makeBucket() {
  return { count: 0, failures: 0, clientMsTotal: 0, serverMsTotal: 0 };
}

function recordMetric(metrics, name, { ok, clientMs, durationMs }) {
  const b = metrics[name];
  b.count += 1;
  if (!ok) b.failures += 1;
  b.clientMsTotal += clientMs ?? 0;
  b.serverMsTotal += durationMs ?? 0;
}

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg?.type === "stop") {
    cancelled = true;
    return;
  }

  if (msg?.type !== "start") return;

  const { workerId, serverBase, config, durationMs, doRead, doDelete } = msg;

  const metrics = {
    create: makeBucket(),
    update: makeBucket(),
    read: makeBucket(),
    delete: makeBucket()
  };

  try {
    const ulda = new UldaSign({
      fmt: { export: "hex" },
      sign: {
        originSize: config.originSize,
        N: config.sign.N,
        mode: config.sign.mode,
        hash: config.sign.hash
      }
    });

    // 1) CREATE
    let originPkg = ulda.New(0n);
    let sig = await ulda.sign(originPkg);
    let content = bytesToBase64(randomBytes(config.contentBytes));

    const created = await fetchJsonWithTiming(`${serverBase}/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ulda_key: sig,
        content,
        format: "hex",
        contentFormat: "base64"
      })
    });

    recordMetric(metrics, "create", {
      ok: created.data.ok,
      clientMs: created.clientMs,
      durationMs: created.data.durationMs
    });

    if (!created.data.ok) {
      throw new Error(`create failed (worker ${workerId})`);
    }

    const id = created.data.id;

    // 2) HAMMER UPDATE(+READ)
    const endAt = performance.now() + durationMs;

    while (!cancelled && performance.now() < endAt) {
      // UPDATE: stepUp + sign + PUT
      originPkg = ulda.stepUp(originPkg);
      const sigB = await ulda.sign(originPkg);
      content = bytesToBase64(randomBytes(config.contentBytes));

      const upd = await fetchJsonWithTiming(`${serverBase}/records/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ulda_key: sigB,
          content,
          format: "hex",
          contentFormat: "base64"
        })
      });

      recordMetric(metrics, "update", {
        ok: upd.data.ok,
        clientMs: upd.clientMs,
        durationMs: upd.data.durationMs
      });

      if (!upd.data.ok) break;

      sig = sigB;

      if (doRead) {
        const rd = await fetchJsonWithTiming(
          `${serverBase}/records/${id}?format=hex&contentFormat=base64`
        );

        recordMetric(metrics, "read", {
          ok: rd.data.ok,
          clientMs: rd.clientMs,
          durationMs: rd.data.durationMs
        });
      }
    }

    // 3) DELETE (forward signature!)
    if (doDelete && !cancelled) {
      const nextOrigin = ulda.stepUp(originPkg);
      const sigDel = await ulda.sign(nextOrigin);

      const del = await fetchJsonWithTiming(`${serverBase}/records/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ulda_key: sigDel, format: "hex" })
      });

      recordMetric(metrics, "delete", {
        ok: del.data.ok,
        clientMs: del.clientMs,
        durationMs: del.data.durationMs
      });
    }

    self.postMessage({ type: "done", workerId, metrics });
  } catch (err) {
    self.postMessage({ type: "error", workerId, error: err?.message ?? String(err) });
  }
};
