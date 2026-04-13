import { Buffer } from 'node:buffer';
import DbAdapterContract from './DbAdapterContract.mjs';

export default class MemoryDbAdapter extends DbAdapterContract {
  constructor() {
    super();
    this.rows = new Map();
    this.nextId = 1n;
  }

  clone(row) {
    if (!row) return null;
    return {
      id: BigInt(row.id),
      sign: Buffer.from(row.sign),
      data: Buffer.from(row.data),
      create_time: row.create_time,
      update_time: row.update_time,
    };
  }

  async create(record) {
    const id = this.nextId;
    this.nextId += 1n;
    this.rows.set(id.toString(), {
      id,
      sign: Buffer.from(record.sign),
      data: Buffer.from(record.data),
      create_time: record.create_time,
      update_time: record.update_time,
    });
    return id;
  }

  async read(id) {
    return this.clone(this.rows.get(BigInt(id).toString()) ?? null);
  }

  async updateChecked(payload) {
    const key = BigInt(payload.id).toString();
    const row = this.rows.get(key);
    if (!row) return false;
    if (!Buffer.from(row.sign).equals(Buffer.from(payload.expectedSign))) return false;
    row.sign = Buffer.from(payload.nextSign);
    row.data = Buffer.from(payload.nextData);
    row.update_time = payload.update_time;
    return true;
  }

  async deleteChecked(payload) {
    const key = BigInt(payload.id).toString();
    const row = this.rows.get(key);
    if (!row) return false;
    if (!Buffer.from(row.sign).equals(Buffer.from(payload.expectedSign))) return false;
    this.rows.delete(key);
    return true;
  }
}
