import http from 'node:http';
import UldaServerCRUD from './core/UldaServerCRUD.mjs';

export async function startPublicServer({ signer, db, config = {} }) {
  const core = new UldaServerCRUD({
    ...config,
    signer,
    db,
  });

  const host = core.globalConfig.http.host;
  const port = core.globalConfig.http.port;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const body = JSON.stringify({
        ok: true,
        service: 'ulda-crud-demo-app',
        routes: {
          create: core.globalConfig.http.routes.create,
          read: core.globalConfig.http.routes.read,
          update: core.globalConfig.http.routes.update,
          delete: core.globalConfig.http.routes.delete,
          health: '/health',
        },
        body: { id: 'string|null', ulda: 'base64', load: 'base64' },
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body).toString(),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      Promise.resolve()
        .then(() => (typeof db.ping === 'function' ? db.ping() : true))
        .then(() => {
          const body = JSON.stringify({ ok: true });
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body).toString(),
            'cache-control': 'no-store',
          });
          res.end(body);
        })
        .catch(error => {
          const body = JSON.stringify({ ok: false, error: error?.message ?? 'health_failed' });
          res.writeHead(503, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body).toString(),
            'cache-control': 'no-store',
          });
          res.end(body);
        });
      return;
    }

    core.handleNode(req, res).catch(error => {
      const out = core.stageError(error, null);
      core.helper.writeNodeResponse(res, out);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    core,
    close: async () => {
      await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
      if (typeof db.close === 'function') await db.close();
    },
  };
}

export default startPublicServer;
