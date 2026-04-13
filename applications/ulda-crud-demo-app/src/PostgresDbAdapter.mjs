import { Pool } from 'pg';
import DbAdapterContract from './core/DbAdapterContract.mjs';

/**
 * PostgreSQL adapter for the minimal ULDA CRUD schema:
 *   id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
 *   sign BYTEA NOT NULL
 *   data BYTEA NOT NULL
 *   create_time TIMESTAMPTZ NOT NULL
 *   update_time TIMESTAMPTZ NOT NULL
 */
export default class PostgresDbAdapter extends DbAdapterContract {
  constructor({ connectionString, poolConfig = {} } = {}) {
    super();
    if (!connectionString) {
      throw new Error('PostgresDbAdapter requires connectionString');
    }

    this.pool = new Pool({
      connectionString,
      ...poolConfig,
    });
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close() {
    await this.pool.end();
  }

  async create(record) {
    const sql = `
      INSERT INTO ulda_records (sign, data, create_time, update_time)
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
      RETURNING id
    `;

    const result = await this.pool.query(sql, [
      Buffer.from(record.sign),
      Buffer.from(record.data),
      record.create_time,
      record.update_time,
    ]);

    return BigInt(result.rows[0].id);
  }

  async read(id) {
    const sql = `
      SELECT id, sign, data, create_time, update_time
      FROM ulda_records
      WHERE id = $1::bigint
    `;

    const result = await this.pool.query(sql, [id.toString()]);
    const row = result.rows[0];
    if (!row) return null;

    return {
      id: BigInt(row.id),
      sign: Buffer.from(row.sign),
      data: Buffer.from(row.data),
      create_time: row.create_time?.toISOString?.() ?? String(row.create_time),
      update_time: row.update_time?.toISOString?.() ?? String(row.update_time),
    };
  }

  async updateChecked(payload) {
    const sql = `
      UPDATE ulda_records
      SET sign = $3, data = $4, update_time = $5::timestamptz
      WHERE id = $1::bigint AND sign = $2
    `;

    const result = await this.pool.query(sql, [
      payload.id.toString(),
      Buffer.from(payload.expectedSign),
      Buffer.from(payload.nextSign),
      Buffer.from(payload.nextData),
      payload.update_time,
    ]);

    return result.rowCount === 1;
  }

  async deleteChecked(payload) {
    const sql = `
      DELETE FROM ulda_records
      WHERE id = $1::bigint AND sign = $2
    `;

    const result = await this.pool.query(sql, [
      payload.id.toString(),
      Buffer.from(payload.expectedSign),
    ]);

    return result.rowCount === 1;
  }
}
