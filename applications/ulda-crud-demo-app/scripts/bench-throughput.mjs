import { WebSocket } from 'ws';
import { b64, postJson } from './lib.mjs';

const transport = String(process.env.BENCH_TRANSPORT ?? 'rest').toLowerCase();
const mode = String(process.env.BENCH_MODE ?? 'update').toLowerCase();
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 10000);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 20);
const payloadBytes = Number(process.env.BENCH_PAYLOAD_BYTES ?? 64);
const baseUrl = process.env.BASE_URL ?? 'http://app:3010';
const baseWsUrl = process.env.BASE_WS_URL ?? 'ws://app:3010/ws';

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const makePayloadBase64 = (workerId, seq, size) => {
  const text = `${workerId}:${seq}:`;
  const source = Buffer.from(text.repeat(Math.ceil(size / Math.max(1, text.length))).slice(0, size), 'utf8');
  return source.toString('base64');
};

class WsClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.queue = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.once('open', resolve);
      ws.once('error', reject);
      ws.on('message', message => {
        const resolveNext = this.queue.shift();
        if (!resolveNext) return;
        try {
          resolveNext(JSON.parse(Buffer.from(message).toString('utf8')));
        } catch (error) {
          resolveNext({ ok: false, status: 500, response: { error: error.message } });
        }
      });
      ws.on('close', () => {
        while (this.queue.length > 0) {
          const resolveNext = this.queue.shift();
          resolveNext({ ok: false, status: 500, response: { error: 'ws_closed' } });
        }
      });
    });
  }

  async send(action, body) {
    const responsePromise = new Promise(resolve => this.queue.push(resolve));
    this.ws.send(JSON.stringify({ op: action, body }));
    const out = await responsePromise;
    return { status: out.status, body: out.response };
  }

  async close() {
    if (!this.ws) return;
    await new Promise(resolve => {
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }
}

async function makeRestClient() {
  return {
    send: (action, body) => postJson(baseUrl, `/${action}`, body),
    close: async () => {},
  };
}

async function makeWsClient() {
  const client = new WsClient(baseWsUrl);
  await client.open();
  return client;
}

async function makeClient() {
  if (transport === 'ws') return makeWsClient();
  if (transport === 'rest') return makeRestClient();
  throw new Error(`unsupported BENCH_TRANSPORT=${transport}`);
}

const summary = {
  transport,
  mode,
  durationMs,
  concurrency,
  payloadBytes,
  startedAt: new Date().toISOString(),
  totalOps: 0,
  okOps: 0,
  failedOps: 0,
  statusCounts: {},
  totalLatencyMs: 0,
  minLatencyMs: Number.POSITIVE_INFINITY,
  maxLatencyMs: 0,
};

const countStatus = status => {
  const key = String(status);
  summary.statusCounts[key] = (summary.statusCounts[key] ?? 0) + 1;
};

const clients = [];
const records = [];
for (let workerId = 0; workerId < concurrency; workerId += 1) {
  clients.push(await makeClient());
  records.push({ id: null, seq: 0 });
}

async function createSeed(workerId) {
  const client = clients[workerId];
  const create = await client.send('create', {
    id: null,
    ulda: b64(`bench-${workerId}-sign-0`),
    load: makePayloadBase64(workerId, 0, payloadBytes),
  });
  expect(create.status === 201, `seed create failed for worker ${workerId}: ${JSON.stringify(create)}`);
  records[workerId] = { id: create.body.id, seq: 0 };
}

if (mode === 'update' || mode === 'read') {
  for (let workerId = 0; workerId < concurrency; workerId += 1) {
    await createSeed(workerId);
  }
}

const endAt = Date.now() + durationMs;

async function runWorker(workerId) {
  const client = clients[workerId];
  while (Date.now() < endAt) {
    let action;
    let body;

    if (mode === 'create') {
      const nextSeq = records[workerId].seq + 1;
      records[workerId].seq = nextSeq;
      action = 'create';
      body = {
        id: null,
        ulda: b64(`bench-${workerId}-sign-${nextSeq}`),
        load: makePayloadBase64(workerId, nextSeq, payloadBytes),
      };
    } else if (mode === 'read') {
      action = 'read';
      body = { id: records[workerId].id, ulda: '', load: '' };
    } else if (mode === 'update') {
      const nextSeq = records[workerId].seq + 1;
      action = 'update';
      body = {
        id: records[workerId].id,
        ulda: b64(`bench-${workerId}-sign-${nextSeq}`),
        load: makePayloadBase64(workerId, nextSeq, payloadBytes),
      };
      records[workerId].seq = nextSeq;
    } else {
      throw new Error(`unsupported BENCH_MODE=${mode}`);
    }

    const started = performance.now();
    let out;
    try {
      out = await client.send(action, body);
    } catch (error) {
      out = { status: 500, body: { error: error.message } };
    }
    const latency = performance.now() - started;

    summary.totalOps += 1;
    summary.totalLatencyMs += latency;
    summary.minLatencyMs = Math.min(summary.minLatencyMs, latency);
    summary.maxLatencyMs = Math.max(summary.maxLatencyMs, latency);
    countStatus(out.status);

    if (out.status >= 200 && out.status < 300) {
      summary.okOps += 1;
      if (mode === 'create') {
        // nothing else needed
      }
    } else {
      summary.failedOps += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, index) => runWorker(index)));

if (mode === 'update' || mode === 'read') {
  await Promise.all(records.map(async (record, workerId) => {
    const client = clients[workerId];
    const del = await client.send('delete', {
      id: record.id,
      ulda: b64(`bench-${workerId}-cleanup-${record.seq + 1}`),
      load: '',
    });
    if (del.status !== 200) {
      // cleanup is best-effort, but we still expose it in output if something went wrong
      summary.cleanupError = summary.cleanupError ?? [];
      summary.cleanupError.push({ workerId, status: del.status, body: del.body });
    }
  }));
}

await Promise.all(clients.map(client => client.close()));

const elapsedMs = durationMs;
const opsPerSec = summary.totalOps / (elapsedMs / 1000);
const avgLatencyMs = summary.totalOps > 0 ? summary.totalLatencyMs / summary.totalOps : 0;

const report = {
  ...summary,
  elapsedMs,
  opsPerSec: Number(opsPerSec.toFixed(2)),
  avgLatencyMs: Number(avgLatencyMs.toFixed(2)),
  minLatencyMs: Number((Number.isFinite(summary.minLatencyMs) ? summary.minLatencyMs : 0).toFixed(2)),
  maxLatencyMs: Number(summary.maxLatencyMs.toFixed(2)),
  finishedAt: new Date().toISOString(),
};

console.log(JSON.stringify(report, null, 2));
console.log(`throughput: ${report.opsPerSec} ops/sec, ok=${report.okOps}, failed=${report.failedOps}`);
