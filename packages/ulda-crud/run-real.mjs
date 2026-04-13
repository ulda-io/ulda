import UldaSign from '../packages/ulda-sign/ulda-sign.js';
import MemoryDbAdapter from './src/MemoryDbAdapter.mjs';
import { startHttpCrudServer } from './src/bootstrap-http.mjs';

const signer = new UldaSign({
  sign: {
    N: 5,
    mode: 'X',
    hash: 'SHA-256',
    originSize: 256,
  },
});

const db = new MemoryDbAdapter();

await startHttpCrudServer({
  signer,
  db,
  config: {
    codec: { bytes: 'base64' },
    http: {
      host: '127.0.0.1',
      port: 3000,
    },
  },
});

console.log('Server started on http://127.0.0.1:3000');