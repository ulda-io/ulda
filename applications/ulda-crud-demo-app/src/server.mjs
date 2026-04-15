import http from 'node:http';
import { WebSocketServer } from 'ws';

import UldaServerCRUD from './core/UldaServerCRUD.mjs';
import DemoSigner from './DemoSigner.mjs';
import PostgresDbAdapter from './adapters/PostgresDbAdapter.mjs';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3010);
const codec = process.env.BYTES_CODEC ?? 'base64';
const wsPath = process.env.WS_PATH ?? '/ws';
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@db:5432/ulda_demo';

const signer = new DemoSigner();
const dbAdapter = new PostgresDbAdapter({ connectionString: databaseUrl });
const core = new UldaServerCRUD({
  signer,
  dbAdapter,
  codec: { bytes: codec },
  http: {
    host,
    port,
    routes: {
      create: '/create',
      read: '/read',
      update: '/update',
      delete: '/delete',
    },
  },
  ws: { path: wsPath },
});

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString(),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  return raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);

  if (req.method === 'GET' && url.pathname === '/') {
    writeJson(res, 200, {
      ok: true,
      service: 'ulda-crud-demo-app',
      codec,
      routes: {
        create: '/create',
        read: '/read',
        update: '/update',
        delete: '/delete',
        health: '/health',
        ws: wsPath,
      },
      body: { id: 'string|null', ulda: codec, load: codec },
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    try {
      await dbAdapter.ping();
      writeJson(res, 200, { ok: true });
    } catch (error) {
      writeJson(res, 503, { ok: false, error: error?.message ?? 'health_failed' });
    }
    return;
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  try {
    const action = core.transport.fromHttpPath(url.pathname, req.method);
    const body = await readJsonBody(req);
    const out = await core.api({ action, body });
    writeJson(res, out.status, out.response);
  } catch (error) {
    const out = core.transport.failure(error);
    writeJson(res, out.status, out.response);
  }
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', ws => {
  ws.on('message', async message => {
    try {
      const envelope = core.transport.wsEnvelope(message);
      const out = await core.api({ action: envelope.action, body: envelope.body });
      ws.send(JSON.stringify({ ok: out.status < 400, status: out.status, response: out.response }));
    } catch (error) {
      const out = core.transport.failure(error);
      ws.send(JSON.stringify({ ok: false, status: out.status, response: out.response }));
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  if (url.pathname !== wsPath) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, resolve);
});

console.log(`ulda-crud-demo-app listening on http://${host}:${port}`);
console.log(`ulda-crud-demo-app ws on ws://${host}:${port}${wsPath}`);

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await dbAdapter.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
