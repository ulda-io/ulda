import test from 'node:test';
import assert from 'node:assert/strict';

import UldaServerCRUD from '../src/UldaServerCRUD.mjs';
import MemoryDbAdapter from '../src/MemoryDbAdapter.mjs';

class FakeSigner {
  constructor(pairs = []) {
    this.allowed = new Set();
    for (const [a, b] of pairs) this.allow(a, b);
  }

  key(a, b) {
    return `${Buffer.from(a).toString('hex')}|${Buffer.from(b).toString('hex')}`;
  }

  allow(a, b) {
    this.allowed.add(this.key(a, b));
  }

  async verify(a, b) {
    return this.allowed.has(this.key(a, b));
  }
}

class ConflictUpdateAdapter extends MemoryDbAdapter {
  async updateChecked(_payload) {
    return false;
  }
}

class ConflictDeleteAdapter extends MemoryDbAdapter {
  async deleteChecked(_payload) {
    return false;
  }
}

const b = text => Buffer.from(text, 'utf8');
const h = value => Buffer.from(value, 'utf8').toString('hex');

function makeServer({ db = new MemoryDbAdapter(), signer = new FakeSigner() } = {}) {
  return new UldaServerCRUD({
    db,
    signer,
    codec: { bytes: 'hex' },
  });
}

test('create stores sign, data, create_time and update_time', async () => {
  const db = new MemoryDbAdapter();
  const server = makeServer({ db });

  const out = await server.create({
    ulda: b('sig0'),
    load: b('data0'),
  });

  assert.equal(out.status, 201);
  assert.deepEqual(out.response, { id: '1' });

  const row = await db.read(1n);
  assert.equal(row.id, 1n);
  assert.deepEqual(row.sign, b('sig0'));
  assert.deepEqual(row.data, b('data0'));
  assert.ok(typeof row.create_time === 'string');
  assert.ok(typeof row.update_time === 'string');
});

test('read returns the same minimal shape: { id, ulda, load }', async () => {
  const server = makeServer();
  await server.create({ ulda: b('sig0'), load: b('data0') });

  const out = await server.read({ id: '1' });

  assert.equal(out.status, 200);
  assert.deepEqual(out.response, {
    id: '1',
    ulda: h('sig0'),
    load: h('data0'),
  });
});

test('update verifies transition and writes next sign + next data', async () => {
  const db = new MemoryDbAdapter();
  const signer = new FakeSigner([[b('sig0'), b('sig1')]]);
  const server = makeServer({ db, signer });

  await server.create({ ulda: b('sig0'), load: b('data0') });
  const out = await server.update({
    id: '1',
    ulda: b('sig1'),
    load: b('data1'),
  });

  assert.equal(out.status, 200);
  assert.deepEqual(out.response, { id: '1' });

  const row = await db.read(1n);
  assert.deepEqual(row.sign, b('sig1'));
  assert.deepEqual(row.data, b('data1'));
});

test('update rejects invalid verify transition', async () => {
  const db = new MemoryDbAdapter();
  const signer = new FakeSigner();
  const server = makeServer({ db, signer });

  await server.create({ ulda: b('sig0'), load: b('data0') });
  const out = await server.update({
    id: '1',
    ulda: b('sigX'),
    load: b('data1'),
  });

  assert.equal(out.status, 403);
  assert.deepEqual(out.response, { error: 'verify_failed' });

  const row = await db.read(1n);
  assert.deepEqual(row.sign, b('sig0'));
  assert.deepEqual(row.data, b('data0'));
});

test('delete verifies transition and removes the row', async () => {
  const db = new MemoryDbAdapter();
  const signer = new FakeSigner([[b('sig0'), b('sig1')]]);
  const server = makeServer({ db, signer });

  await server.create({ ulda: b('sig0'), load: b('data0') });
  const out = await server.delete({
    id: '1',
    ulda: b('sig1'),
  });

  assert.equal(out.status, 200);
  assert.deepEqual(out.response, { id: '1' });
  assert.equal(await db.read(1n), null);
});

test('update returns conflict when compare-and-swap fails after verify', async () => {
  const db = new ConflictUpdateAdapter();
  const signer = new FakeSigner([[b('sig0'), b('sig1')]]);
  const server = makeServer({ db, signer });

  await server.create({ ulda: b('sig0'), load: b('data0') });
  const out = await server.update({
    id: '1',
    ulda: b('sig1'),
    load: b('data1'),
  });

  assert.equal(out.status, 409);
  assert.deepEqual(out.response, { error: 'conflict' });
});

test('delete returns conflict when compare-and-swap fails after verify', async () => {
  const db = new ConflictDeleteAdapter();
  const signer = new FakeSigner([[b('sig0'), b('sig1')]]);
  const server = makeServer({ db, signer });

  await server.create({ ulda: b('sig0'), load: b('data0') });
  const out = await server.delete({
    id: '1',
    ulda: b('sig1'),
  });

  assert.equal(out.status, 409);
  assert.deepEqual(out.response, { error: 'conflict' });
});

test('read returns not_found for missing row', async () => {
  const server = makeServer();
  const out = await server.read({ id: '999' });

  assert.equal(out.status, 404);
  assert.deepEqual(out.response, { error: 'not_found' });
});

test('delete expects empty load', async () => {
  const server = makeServer();
  const out = await server.delete({
    id: '1',
    ulda: b('sig1'),
    load: b('non-empty'),
  });

  assert.equal(out.status, 400);
  assert.deepEqual(out.response, { error: 'bad_request' });
});
