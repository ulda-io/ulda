import UldaServerCRUD from './UldaServerCRUD.mjs';

/**
 * Minimal helper that wires an already constructed signer and db adapter
 * into UldaServerCRUD and starts the HTTP transport.
 *
 * Example inside your monorepo:
 *   import UldaSign from '../packages/ulda-sign/ulda-sign.js';
 *   import MemoryDbAdapter from './MemoryDbAdapter.mjs';
 *   import { startHttpCrudServer } from './bootstrap-http.mjs';
 *
 *   const signer = new UldaSign({ sign: { N: 5, mode: 'X', hash: 'SHA-256', originSize: 256 } });
 *   const db = new MemoryDbAdapter();
 *   await startHttpCrudServer({ signer, db, config: { codec: { bytes: 'base64' } } });
 */
export async function startHttpCrudServer({ signer, db, config = {} }) {
  const server = new UldaServerCRUD({
    ...config,
    signer,
    db,
  });

  await server.listen();
  return server;
}

export default startHttpCrudServer;
