import { expect, b64, postJson } from './lib.mjs';

const baseUrl = process.env.BASE_URL ?? 'http://app:3010';

const create = await postJson(baseUrl, '/create', {
  id: null,
  ulda: b64('sign-1'),
  load: b64('hello'),
});
expect(create.status === 201, `create status mismatch: ${create.status}`);
const id = create.body.id;

const [a, b] = await Promise.all([
  postJson(baseUrl, '/update', { id, ulda: b64('sign-2a'), load: b64('world-a') }),
  postJson(baseUrl, '/update', { id, ulda: b64('sign-2b'), load: b64('world-b') }),
]);

const statuses = [a.status, b.status].sort((x, y) => x - y);
expect(statuses[0] === 200 && statuses[1] === 409, `race statuses mismatch: ${statuses.join(',')}`);

const read = await postJson(baseUrl, '/read', { id, ulda: '', load: '' });
expect(read.status === 200, `read status mismatch: ${read.status}`);
const survivors = new Set([b64('sign-2a'), b64('sign-2b')]);
expect(survivors.has(read.body.ulda), `unexpected survivor sign: ${read.body.ulda}`);

console.log('smoke-race passed');
