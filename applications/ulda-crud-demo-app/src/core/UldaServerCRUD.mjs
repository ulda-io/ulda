import { Buffer } from 'node:buffer';

class UldaServerError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'UldaServerError';
    this.status = status;
    this.code = code;
  }
}

export default class UldaServerCRUD {
  constructor(cfg = {}) {
    const self = this;
    this.globalConfig = this.normalizeConfig(cfg);
    this.signer = this.globalConfig.signer;
    this.dbAdapter = this.globalConfig.dbAdapter;

    this.helper = {
      fail(status, code, message = code) {
        return new UldaServerError(status, code, message);
      },

      assert(condition, status, code, message = code) {
        if (!condition) throw self.helper.fail(status, code, message);
      },

      nowIso() {
        return new Date().toISOString();
      },

      encodeBytes(value) {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
        return self.globalConfig.codec.bytes === 'hex' ? buf.toString('hex') : buf.toString('base64');
      },

      decodeBytes(value) {
        if (value === null || value === undefined || value === '') return Buffer.alloc(0);
        if (Buffer.isBuffer(value)) return Buffer.from(value);
        if (value instanceof Uint8Array) return Buffer.from(value);
        if (Array.isArray(value)) return Buffer.from(value);
        self.helper.assert(typeof value === 'string', 400, 'bad_request', 'byte field must be encoded string or bytes');
        return self.globalConfig.codec.bytes === 'hex' ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
      },

      decodeId(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number') {
          self.helper.assert(Number.isInteger(value), 400, 'bad_request', 'id must be integer');
          return BigInt(value);
        }
        self.helper.assert(typeof value === 'string' && /^-?\d+$/.test(value), 400, 'bad_request', 'id must be decimal string');
        return BigInt(value);
      },

      encodeId(value) {
        return BigInt(value).toString();
      },

      normalizeAction(action) {
        const out = String(action ?? '').toLowerCase();
        self.helper.assert(['create', 'read', 'update', 'delete'].includes(out), 400, 'bad_request', 'unsupported action');
        return out;
      },
    };

    this.transport = {
      fromHttpPath(pathname, method = 'POST') {
        const routes = self.globalConfig.http.routes;
        const byPath = Object.entries(routes).find(([, path]) => path === pathname);
        self.helper.assert(method.toUpperCase() === 'POST' || pathname === '/health' || pathname === '/', 400, 'bad_request', 'only POST CRUD routes are allowed');
        self.helper.assert(byPath, 404, 'not_found', 'route not found');
        return byPath[0];
      },

      parsePacket(raw) {
        const body = raw?.body ?? raw ?? {};
        return {
          id: self.helper.decodeId(body.id),
          ulda: self.helper.decodeBytes(body.ulda),
          load: self.helper.decodeBytes(body.load),
        };
      },

      wsEnvelope(message) {
        const parsed = typeof message === 'string' ? JSON.parse(message) : JSON.parse(Buffer.from(message).toString('utf8'));
        const action = self.helper.normalizeAction(parsed?.op);
        return {
          action,
          body: parsed?.body ?? {},
        };
      },

      success(ctx) {
        if (ctx.action === 'create') {
          return { status: 201, response: { id: self.helper.encodeId(ctx.result.id) } };
        }
        if (ctx.action === 'read') {
          return {
            status: 200,
            response: {
              id: self.helper.encodeId(ctx.result.id),
              ulda: self.helper.encodeBytes(ctx.result.ulda),
              load: self.helper.encodeBytes(ctx.result.load),
            },
          };
        }
        return { status: 200, response: { id: self.helper.encodeId(ctx.result.id) } };
      },

      failure(error) {
        return {
          status: Number.isInteger(error?.status) ? error.status : 500,
          response: { error: typeof error?.code === 'string' ? error.code : 'internal' },
        };
      },
    };

    this.db = {
      create(record) {
        return self.dbAdapter.create(record);
      },
      read(id) {
        return self.dbAdapter.read(id);
      },
      updateChecked(payload) {
        return self.dbAdapter.updateChecked(payload);
      },
      deleteChecked(payload) {
        return self.dbAdapter.deleteChecked(payload);
      },
    };

    this.actions = {
      async dispatch(ctx) {
        if (ctx.action === 'create') return self.actions.create(ctx);
        if (ctx.action === 'read') return self.actions.read(ctx);
        if (ctx.action === 'update') return self.actions.update(ctx);
        return self.actions.delete(ctx);
      },

      async create(ctx) {
        const { id, ulda, load } = ctx.parsed;
        self.helper.assert(id === null, 400, 'bad_request', 'create does not accept id');
        self.helper.assert(ulda.length > 0, 400, 'bad_request', 'create requires non-empty ulda');
        const now = self.helper.nowIso();
        const record = {
          sign: ulda,
          data: load,
          create_time: now,
          update_time: now,
        };
        const createdId = await self.db.create(record);
        return { id: createdId };
      },

      async read(ctx) {
        const { id } = ctx.parsed;
        self.helper.assert(id !== null, 400, 'bad_request', 'read requires id');
        const row = await self.db.read(id);
        self.helper.assert(row, 404, 'not_found', 'record not found');
        return { id: row.id, ulda: row.sign, load: row.data };
      },

      async update(ctx) {
        const { id, ulda, load } = ctx.parsed;
        self.helper.assert(id !== null, 400, 'bad_request', 'update requires id');
        self.helper.assert(ulda.length > 0, 400, 'bad_request', 'update requires non-empty ulda');
        const row = await self.db.read(id);
        self.helper.assert(row, 404, 'not_found', 'record not found');
        const verified = await self.actions.verify(row.sign, ulda);
        self.helper.assert(verified, 403, 'verify_failed', 'verify failed');
        const updated = await self.db.updateChecked({
          id,
          expectedSign: row.sign,
          nextSign: ulda,
          nextData: load,
          update_time: self.helper.nowIso(),
        });
        self.helper.assert(updated, 409, 'conflict', 'compare-and-swap update failed');
        return { id };
      },

      async delete(ctx) {
        const { id, ulda } = ctx.parsed;
        self.helper.assert(id !== null, 400, 'bad_request', 'delete requires id');
        self.helper.assert(ulda.length > 0, 400, 'bad_request', 'delete requires non-empty ulda');
        const row = await self.db.read(id);
        self.helper.assert(row, 404, 'not_found', 'record not found');
        const verified = await self.actions.verify(row.sign, ulda);
        self.helper.assert(verified, 403, 'verify_failed', 'verify failed');
        const deleted = await self.db.deleteChecked({ id, expectedSign: row.sign });
        self.helper.assert(deleted, 409, 'conflict', 'compare-and-swap delete failed');
        return { id };
      },

      async verify(older, newer) {
        return !!(await self.signer.verify(older, newer));
      },
    };
  }

  normalizeConfig(cfg = {}) {
    if (!cfg.signer) throw new Error('UldaServerCRUD requires signer');
    if (!cfg.dbAdapter) throw new Error('UldaServerCRUD requires dbAdapter');

    return {
      signer: cfg.signer,
      dbAdapter: cfg.dbAdapter,
      codec: {
        bytes: cfg?.codec?.bytes ?? 'base64',
      },
      http: {
        host: cfg?.http?.host ?? '0.0.0.0',
        port: Number(cfg?.http?.port ?? 3010),
        routes: {
          create: cfg?.http?.routes?.create ?? '/create',
          read: cfg?.http?.routes?.read ?? '/read',
          update: cfg?.http?.routes?.update ?? '/update',
          delete: cfg?.http?.routes?.delete ?? '/delete',
        },
      },
      ws: {
        path: cfg?.ws?.path ?? '/ws',
      },
    };
  }

  makeContext(action, body) {
    return {
      action: this.helper.normalizeAction(action),
      parsed: this.transport.parsePacket({ body }),
      result: null,
    };
  }

  async pipeline(action, body) {
    const ctx = this.makeContext(action, body);
    try {
      ctx.result = await this.actions.dispatch(ctx);
      return this.transport.success(ctx);
    } catch (error) {
      return this.transport.failure(error);
    }
  }

  async api(request) {
    return this.pipeline(request.action, request.body);
  }
}

export { UldaServerError };
