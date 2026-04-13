import UldaServerCRUD from '../src/core/UldaServerCRUD.mjs';
import MemoryDbAdapter from '../src/adapters/MemoryDbAdapter.mjs';
import DemoSigner from '../src/DemoSigner.mjs';
import { expect } from './lib.mjs';

const core = new UldaServerCRUD({
  signer: new DemoSigner(),
  dbAdapter: new MemoryDbAdapter(),
  codec: { bytes: 'base64' },
});

const create = await core.api({
  action: 'create',
  body: { id: null, ulda: Buffer.from('sign-1'), load: Buffer.from('hello') },
});
expect(create.status === 201, `create status mismatch: ${create.status}`);
expect(create.response.id === '1', `create id mismatch: ${JSON.stringify(create.response)}`);

const read1 = await core.api({
  action: 'read',
  body: { id: '1', ulda: '', load: '' },
});
expect(read1.status === 200, `read1 status mismatch: ${read1.status}`);
expect(read1.response.ulda === Buffer.from('sign-1').toString('base64'), 'read1 ulda mismatch');
expect(read1.response.load === Buffer.from('hello').toString('base64'), 'read1 load mismatch');

const update = await core.api({
  action: 'update',
  body: { id: '1', ulda: Buffer.from('sign-2'), load: Buffer.from('world') },
});
expect(update.status === 200, `update status mismatch: ${update.status}`);

const read2 = await core.api({
  action: 'read',
  body: { id: '1', ulda: '', load: '' },
});
expect(read2.status === 200, `read2 status mismatch: ${read2.status}`);
expect(read2.response.ulda === Buffer.from('sign-2').toString('base64'), 'read2 ulda mismatch');
expect(read2.response.load === Buffer.from('world').toString('base64'), 'read2 load mismatch');

const badUpdate = await core.api({
  action: 'update',
  body: { id: '1', ulda: Buffer.from('sign-2'), load: Buffer.from('nope') },
});
expect(badUpdate.status === 403, `badUpdate status mismatch: ${badUpdate.status}`);
expect(badUpdate.response.error === 'verify_failed', 'badUpdate error mismatch');

const del = await core.api({
  action: 'delete',
  body: { id: '1', ulda: Buffer.from('sign-3'), load: Buffer.alloc(0) },
});
expect(del.status === 200, `delete status mismatch: ${del.status}`);

const readMissing = await core.api({
  action: 'read',
  body: { id: '1', ulda: '', load: '' },
});
expect(readMissing.status === 404, `readMissing status mismatch: ${readMissing.status}`);

console.log('smoke-core passed');
