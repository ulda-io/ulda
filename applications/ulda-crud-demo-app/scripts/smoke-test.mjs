const baseUrl = process.env.BASE_URL ?? 'http://app:3010';

const json = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  return { status: res.status, body: payload };
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const create = await json('/create', {
  id: null,
  ulda: Buffer.from('sign-1').toString('base64'),
  load: Buffer.from('hello').toString('base64'),
});
expect(create.status === 201, `create status mismatch: ${create.status}`);
expect(create.body.id === '1', `create id mismatch: ${JSON.stringify(create.body)}`);

const read1 = await json('/read', {
  id: '1',
  ulda: '',
  load: '',
});
expect(read1.status === 200, `read status mismatch: ${read1.status}`);
expect(read1.body.load === Buffer.from('hello').toString('base64'), `read load mismatch: ${JSON.stringify(read1.body)}`);

const update = await json('/update', {
  id: '1',
  ulda: Buffer.from('sign-2').toString('base64'),
  load: Buffer.from('world').toString('base64'),
});
expect(update.status === 200, `update status mismatch: ${update.status}`);

const read2 = await json('/read', {
  id: '1',
  ulda: '',
  load: '',
});
expect(read2.status === 200, `read2 status mismatch: ${read2.status}`);
expect(read2.body.ulda === Buffer.from('sign-2').toString('base64'), `read2 ulda mismatch: ${JSON.stringify(read2.body)}`);
expect(read2.body.load === Buffer.from('world').toString('base64'), `read2 load mismatch: ${JSON.stringify(read2.body)}`);

const badUpdate = await json('/update', {
  id: '1',
  ulda: Buffer.from('sign-2').toString('base64'),
  load: Buffer.from('nope').toString('base64'),
});
expect(badUpdate.status === 403, `badUpdate status mismatch: ${badUpdate.status}`);
expect(badUpdate.body.error === 'verify_failed', `badUpdate error mismatch: ${JSON.stringify(badUpdate.body)}`);

const del = await json('/delete', {
  id: '1',
  ulda: Buffer.from('sign-3').toString('base64'),
  load: '',
});
expect(del.status === 200, `delete status mismatch: ${del.status}`);

const readMissing = await json('/read', {
  id: '1',
  ulda: '',
  load: '',
});
expect(readMissing.status === 404, `readMissing status mismatch: ${readMissing.status}`);

console.log('smoke test passed');
