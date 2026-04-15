import { WebSocket } from 'ws';
import { expect, b64 } from './lib.mjs';

const baseWsUrl = process.env.BASE_WS_URL ?? 'ws://app:3010/ws';

function wsCall(ws, op, body) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      try {
        const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onError = error => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.send(JSON.stringify({ op, body }));
  });
}

const ws = new WebSocket(baseWsUrl);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

const create = await wsCall(ws, 'create', { id: null, ulda: b64('sign-1'), load: b64('hello') });
expect(create.status === 201, `create status mismatch: ${create.status}`);
expect(create.response.id === '1', `create id mismatch: ${JSON.stringify(create.response)}`);

const read1 = await wsCall(ws, 'read', { id: '1', ulda: '', load: '' });
expect(read1.status === 200, `read1 status mismatch: ${read1.status}`);
expect(read1.response.ulda === b64('sign-1'), 'read1 ulda mismatch');
expect(read1.response.load === b64('hello'), 'read1 load mismatch');

const update = await wsCall(ws, 'update', { id: '1', ulda: b64('sign-2'), load: b64('world') });
expect(update.status === 200, `update status mismatch: ${update.status}`);

const badUpdate = await wsCall(ws, 'update', { id: '1', ulda: b64('sign-2'), load: b64('nope') });
expect(badUpdate.status === 403, `badUpdate status mismatch: ${badUpdate.status}`);
expect(badUpdate.response.error === 'verify_failed', 'badUpdate error mismatch');

const del = await wsCall(ws, 'delete', { id: '1', ulda: b64('sign-3'), load: '' });
expect(del.status === 200, `delete status mismatch: ${del.status}`);

const readMissing = await wsCall(ws, 'read', { id: '1', ulda: '', load: '' });
expect(readMissing.status === 404, `readMissing status mismatch: ${readMissing.status}`);

ws.close();
await new Promise(resolve => ws.once('close', resolve));
console.log('smoke-ws passed');
