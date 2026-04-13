import { expect, b64, postJson } from './lib.mjs';

const baseUrl = process.env.BASE_URL ?? 'http://app:3010';

const create = await postJson(baseUrl, '/create', {
  id: null,
  ulda: b64('sign-1'),
  load: b64('hello'),
});
expect(create.status === 201, `create status mismatch: ${create.status}`);
expect(create.body.id === '1', `create id mismatch: ${JSON.stringify(create.body)}`);

const read1 = await postJson(baseUrl, '/read', { id: '1', ulda: '', load: '' });
expect(read1.status === 200, `read1 status mismatch: ${read1.status}`);
expect(read1.body.ulda === b64('sign-1'), 'read1 ulda mismatch');
expect(read1.body.load === b64('hello'), 'read1 load mismatch');

const update = await postJson(baseUrl, '/update', {
  id: '1',
  ulda: b64('sign-2'),
  load: b64('world'),
});
expect(update.status === 200, `update status mismatch: ${update.status}`);

const read2 = await postJson(baseUrl, '/read', { id: '1', ulda: '', load: '' });
expect(read2.status === 200, `read2 status mismatch: ${read2.status}`);
expect(read2.body.ulda === b64('sign-2'), 'read2 ulda mismatch');
expect(read2.body.load === b64('world'), 'read2 load mismatch');

const badUpdate = await postJson(baseUrl, '/update', {
  id: '1',
  ulda: b64('sign-2'),
  load: b64('nope'),
});
expect(badUpdate.status === 403, `badUpdate status mismatch: ${badUpdate.status}`);
expect(badUpdate.body.error === 'verify_failed', 'badUpdate error mismatch');

const del = await postJson(baseUrl, '/delete', {
  id: '1',
  ulda: b64('sign-3'),
  load: '',
});
expect(del.status === 200, `delete status mismatch: ${del.status}`);

const readMissing = await postJson(baseUrl, '/read', { id: '1', ulda: '', load: '' });
expect(readMissing.status === 404, `readMissing status mismatch: ${readMissing.status}`);

console.log('smoke-rest passed');
