import DbAdapterContract from './DbAdapterContract.mjs';

/**
 * In-memory adapter for local development and tests.
 * Stores the internal schema:
 *   id, sign, data, create_time, update_time
 */
export default class MemoryDbAdapter extends DbAdapterContract {
  constructor() {
    super();
    this.nextId = 1n;
    this.rows = new Map();
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
    const row = this.rows.get(id.toString());
    if (!row) return null;

    return {
      id: row.id,
      sign: Buffer.from(row.sign),
      data: Buffer.from(row.data),
      create_time: row.create_time,
      update_time: row.update_time,
    };
  }

  async updateChecked(payload) {
    const row = this.rows.get(payload.id.toString());
    if (!row) return false;
    if (Buffer.compare(row.sign, Buffer.from(payload.expectedSign)) !== 0) return false;

    row.sign = Buffer.from(payload.nextSign);
    row.data = Buffer.from(payload.nextData);
    row.update_time = payload.update_time;
    return true;
  }

  async deleteChecked(payload) {
    const row = this.rows.get(payload.id.toString());
    if (!row) return false;
    if (Buffer.compare(row.sign, Buffer.from(payload.expectedSign)) !== 0) return false;

    this.rows.delete(payload.id.toString());
    return true;
  }
}
