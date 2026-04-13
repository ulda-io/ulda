import http from 'node:http';

/**
 * Minimal binary CRUD server with ULDA verify-gate.
 *
 * Public request shape at the transport body level:
 *   { id, ulda, load }
 *
 * Action is transport-defined and stays outside the body.
 * Internally the server always works with:
 *   { id: bigint | null, ulda: Buffer, load: Buffer }
 */
export default class UldaServerCRUD {
  constructor(cfg = {}) {
    const g = (this.globalConfig = {
      codec: {
        bytes: cfg?.codec?.bytes ?? 'base64',
      },
      http: {
        host: cfg?.http?.host ?? '127.0.0.1',
        port: cfg?.http?.port ?? 3000,
        maxBodySize: cfg?.http?.maxBodySize ?? 1024 * 1024,
        routes: {
          create: cfg?.http?.routes?.create ?? '/create',
          read: cfg?.http?.routes?.read ?? '/read',
          update: cfg?.http?.routes?.update ?? '/update',
          delete: cfg?.http?.routes?.delete ?? '/delete',
        },
      },
      signer: cfg?.signer ?? null,
      db: cfg?.db ?? null,
    });

    const self = this;

    this.arguments = Object.freeze({
      config: g,
      signer: g.signer,
      db: g.db,
    });

    this.helper = {
      now: () => new Date().toISOString(),

      fail: (status, code, message = code, details = null) => {
        const err = new Error(message);
        err.status = status;
        err.code = code;
        err.details = details;
        return err;
      },

      assert: (condition, status, code, message = code, details = null) => {
        if (!condition) throw self.helper.fail(status, code, message, details);
      },

      isPlainObject: value =>
        value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,

      cloneBytes: value => Buffer.from(value ?? []),

      bytesEqual: (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0,

      bytesEmpty: value => !value || value.length === 0,

      normalizeId: raw => {
        if (raw === null || raw === undefined || raw === '') return null;
        if (typeof raw === 'bigint') return raw;
        if (typeof raw === 'number') {
          self.helper.assert(Number.isInteger(raw) && raw >= 0, 400, 'bad_request', 'id must be a non-negative integer');
          return BigInt(raw);
        }
        if (typeof raw === 'string') {
          self.helper.assert(/^\d+$/.test(raw), 400, 'bad_request', 'id must contain digits only');
          return BigInt(raw);
        }
        throw self.helper.fail(400, 'bad_request', 'id has unsupported type');
      },

      decodeBase64: raw => {
        if (raw === '') return Buffer.alloc(0);
        self.helper.assert(typeof raw === 'string', 400, 'bad_request', 'bytes must be a base64 string');
        const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
        self.helper.assert(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized),
          400,
          'bad_request',
          'invalid base64 payload'
        );
        return Buffer.from(normalized, 'base64');
      },

      decodeHex: raw => {
        if (raw === '') return Buffer.alloc(0);
        self.helper.assert(typeof raw === 'string', 400, 'bad_request', 'bytes must be a hex string');
        self.helper.assert(/^[0-9a-fA-F]*$/.test(raw) && raw.length % 2 === 0, 400, 'bad_request', 'invalid hex payload');
        return Buffer.from(raw, 'hex');
      },

      decodeBytes: (raw, mode = g.codec.bytes) => {
        if (raw === null || raw === undefined) return Buffer.alloc(0);
        if (Buffer.isBuffer(raw)) return Buffer.from(raw);
        if (raw instanceof Uint8Array) return Buffer.from(raw);
        if (raw instanceof ArrayBuffer) return Buffer.from(raw);
        if (Array.isArray(raw)) {
          self.helper.assert(raw.every(v => Number.isInteger(v) && v >= 0 && v <= 255), 400, 'bad_request', 'byte array must contain integers 0..255');
          return Buffer.from(raw);
        }
        if (typeof raw === 'string') {
          if (mode === 'base64') return self.helper.decodeBase64(raw);
          if (mode === 'hex') return self.helper.decodeHex(raw);
          if (mode === 'utf8') return Buffer.from(raw, 'utf8');
          if (mode === 'raw') throw self.helper.fail(400, 'bad_request', 'raw mode does not accept string bytes');
        }
        throw self.helper.fail(400, 'bad_request', 'unsupported byte payload');
      },

      encodeBytes: (value, mode = g.codec.bytes) => {
        const buf = Buffer.from(value ?? []);
        if (mode === 'base64') return buf.toString('base64');
        if (mode === 'hex') return buf.toString('hex');
        if (mode === 'utf8') return buf.toString('utf8');
        if (mode === 'raw') return buf;
        throw self.helper.fail(500, 'internal', `unsupported codec: ${mode}`);
      },

      normalizeBody: body => {
        if (body === null || body === undefined) return {};
        if (self.helper.isPlainObject(body)) return body;
        throw self.helper.fail(400, 'bad_request', 'body must be a plain object');
      },

      actionFromPath: pathname => {
        const routes = g.http.routes;
        if (pathname === routes.create) return 'create';
        if (pathname === routes.read) return 'read';
        if (pathname === routes.update) return 'update';
        if (pathname === routes.delete) return 'delete';
        return null;
      },

      writeNodeResponse: (res, out) => {
        const body = JSON.stringify(out.response);
        const headers = {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body).toString(),
          ...(out.headers ?? {}),
        };
        res.writeHead(out.status, headers);
        res.end(body);
      },
    };

    this.transport = {
      readNodeBody: req =>
        new Promise((resolve, reject) => {
          let size = 0;
          const chunks = [];

          req.on('data', chunk => {
            size += chunk.length;
            if (size > g.http.maxBodySize) {
              reject(self.helper.fail(400, 'bad_request', 'request body too large'));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });

          req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) {
              resolve({});
              return;
            }

            try {
              resolve(JSON.parse(raw));
            } catch (error) {
              reject(self.helper.fail(400, 'bad_request', 'body must be valid JSON', error.message));
            }
          });

          req.on('error', reject);
        }),

      fromNode: async req => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const action = self.helper.actionFromPath(url.pathname);

        self.helper.assert(req.method === 'POST', 400, 'bad_request', 'HTTP transport expects POST routes only');
        self.helper.assert(action !== null, 404, 'not_found', 'route not found');

        const body = await self.transport.readNodeBody(req);

        return {
          source: 'node:http',
          action,
          method: req.method,
          path: url.pathname,
          body,
        };
      },

      fromEnvelope: async request => {
        self.helper.assert(self.helper.isPlainObject(request), 400, 'bad_request', 'request envelope must be a plain object');
        self.helper.assert(typeof request.action === 'string', 400, 'bad_request', 'request envelope must contain action');

        return {
          source: 'envelope',
          action: request.action,
          method: request.method ?? null,
          path: request.path ?? null,
          body: request.body ?? request.payload ?? request,
        };
      },

      input: async request => {
        if (request?.req && typeof request.req.on === 'function') return self.transport.fromNode(request.req);
        if (request && typeof request === 'object') return self.transport.fromEnvelope(request);
        throw self.helper.fail(400, 'bad_request', 'unsupported request source');
      },

      parse: input => {
        const action = input.action;
        self.helper.assert(['create', 'read', 'update', 'delete'].includes(action), 400, 'bad_request', 'unsupported action');

        const body = self.helper.normalizeBody(input.body);
        const parsed = {
          action,
          id: self.helper.normalizeId(body.id ?? null),
          ulda: self.helper.decodeBytes(body.ulda, g.codec.bytes),
          load: self.helper.decodeBytes(body.load, g.codec.bytes),
        };

        if (action === 'create') {
          self.helper.assert(parsed.id === null, 400, 'bad_request', 'create expects empty id');
          self.helper.assert(parsed.ulda.length > 0, 400, 'bad_request', 'create expects non-empty ulda');
          return parsed;
        }

        if (action === 'read') {
          self.helper.assert(parsed.id !== null, 400, 'bad_request', 'read expects id');
          self.helper.assert(self.helper.bytesEmpty(parsed.ulda), 400, 'bad_request', 'read expects empty ulda');
          self.helper.assert(self.helper.bytesEmpty(parsed.load), 400, 'bad_request', 'read expects empty load');
          return parsed;
        }

        if (action === 'update') {
          self.helper.assert(parsed.id !== null, 400, 'bad_request', 'update expects id');
          self.helper.assert(parsed.ulda.length > 0, 400, 'bad_request', 'update expects non-empty ulda');
          return parsed;
        }

        if (action === 'delete') {
          self.helper.assert(parsed.id !== null, 400, 'bad_request', 'delete expects id');
          self.helper.assert(parsed.ulda.length > 0, 400, 'bad_request', 'delete expects non-empty ulda');
          self.helper.assert(self.helper.bytesEmpty(parsed.load), 400, 'bad_request', 'delete expects empty load');
          return parsed;
        }

        throw self.helper.fail(400, 'bad_request', 'unsupported action');
      },

      output: ctx => {
        const result = ctx.result;
        const headers = { 'cache-control': 'no-store' };

        if (result.kind === 'create') {
          return { status: 201, headers, response: { id: result.id.toString() } };
        }

        if (result.kind === 'read') {
          return {
            status: 200,
            headers,
            response: {
              id: result.id.toString(),
              ulda: self.helper.encodeBytes(result.ulda),
              load: self.helper.encodeBytes(result.load),
            },
          };
        }

        if (result.kind === 'update' || result.kind === 'delete') {
          return { status: 200, headers, response: { id: result.id.toString() } };
        }

        throw self.helper.fail(500, 'internal', 'unknown pipeline result');
      },

      error: error => {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        const code = typeof error?.code === 'string' ? error.code : 'internal';
        return {
          status,
          headers: { 'cache-control': 'no-store' },
          response: { error: code },
        };
      },
    };

    this.db = {
      create: async ({ sign, data, createTime, updateTime }) => {
        const db = g.db;
        self.helper.assert(db && typeof db.create === 'function', 500, 'internal', 'db adapter must implement create(record)');
        const id = await db.create({
          sign: self.helper.cloneBytes(sign),
          data: self.helper.cloneBytes(data),
          create_time: createTime,
          update_time: updateTime,
        });
        return self.helper.normalizeId(id);
      },

      read: async id => {
        const db = g.db;
        self.helper.assert(db && typeof db.read === 'function', 500, 'internal', 'db adapter must implement read(id)');
        const row = await db.read(id);
        if (!row) return null;

        return {
          id: self.helper.normalizeId(row.id),
          sign: self.helper.decodeBytes(row.sign, 'raw'),
          data: self.helper.decodeBytes(row.data, 'raw'),
          create_time: row.create_time ?? null,
          update_time: row.update_time ?? null,
        };
      },

      updateChecked: async ({ id, expectedSign, nextSign, nextData, updateTime }) => {
        const db = g.db;
        self.helper.assert(db && typeof db.updateChecked === 'function', 500, 'internal', 'db adapter must implement updateChecked(payload)');
        return Boolean(
          await db.updateChecked({
            id,
            expectedSign: self.helper.cloneBytes(expectedSign),
            nextSign: self.helper.cloneBytes(nextSign),
            nextData: self.helper.cloneBytes(nextData),
            update_time: updateTime,
          })
        );
      },

      deleteChecked: async ({ id, expectedSign }) => {
        const db = g.db;
        self.helper.assert(db && typeof db.deleteChecked === 'function', 500, 'internal', 'db adapter must implement deleteChecked(payload)');
        return Boolean(
          await db.deleteChecked({
            id,
            expectedSign: self.helper.cloneBytes(expectedSign),
          })
        );
      },
    };

    this.actions = {
      Verify: async (older, newer) => {
        const signer = g.signer;
        self.helper.assert(signer && typeof signer.verify === 'function', 500, 'internal', 'signer must implement verify(a, b)');
        const res = await signer.verify(Buffer.from(older), Buffer.from(newer));
        return Boolean(res);
      },

      Create: async ctx => {
        const { ulda, load } = ctx.parsed;
        const now = self.helper.now();
        const id = await self.db.create({
          sign: ulda,
          data: load,
          createTime: now,
          updateTime: now,
        });
        return { kind: 'create', id };
      },

      Read: async ctx => {
        const row = await self.db.read(ctx.parsed.id);
        if (!row) throw self.helper.fail(404, 'not_found', 'record not found');
        return {
          kind: 'read',
          id: row.id,
          ulda: row.sign,
          load: row.data,
        };
      },

      Update: async ctx => {
        const { id, ulda, load } = ctx.parsed;
        const row = await self.db.read(id);
        if (!row) throw self.helper.fail(404, 'not_found', 'record not found');

        const ok = await self.actions.Verify(row.sign, ulda);
        if (!ok) throw self.helper.fail(403, 'verify_failed', 'verify() rejected the signature transition');

        const updated = await self.db.updateChecked({
          id,
          expectedSign: row.sign,
          nextSign: ulda,
          nextData: load,
          updateTime: self.helper.now(),
        });

        if (!updated) throw self.helper.fail(409, 'conflict', 'compare-and-swap update failed');
        return { kind: 'update', id };
      },

      Delete: async ctx => {
        const { id, ulda } = ctx.parsed;
        const row = await self.db.read(id);
        if (!row) throw self.helper.fail(404, 'not_found', 'record not found');

        const ok = await self.actions.Verify(row.sign, ulda);
        if (!ok) throw self.helper.fail(403, 'verify_failed', 'verify() rejected the signature transition');

        const deleted = await self.db.deleteChecked({
          id,
          expectedSign: row.sign,
        });

        if (!deleted) throw self.helper.fail(409, 'conflict', 'compare-and-swap delete failed');
        return { kind: 'delete', id };
      },

      Dispatch: async ctx => {
        if (ctx.parsed.action === 'create') return self.actions.Create(ctx);
        if (ctx.parsed.action === 'read') return self.actions.Read(ctx);
        if (ctx.parsed.action === 'update') return self.actions.Update(ctx);
        if (ctx.parsed.action === 'delete') return self.actions.Delete(ctx);
        throw self.helper.fail(400, 'bad_request', 'unsupported action');
      },
    };

    this.httpServer = null;
  }

  makeContext(request, args = this.arguments) {
    return {
      args,
      raw: request,
      input: null,
      parsed: null,
      result: null,
    };
  }

  async stageTransportInput(ctx) {
    ctx.input = await this.transport.input(ctx.raw);
    return ctx;
  }

  stageParse(ctx) {
    ctx.parsed = this.transport.parse(ctx.input);
    return ctx;
  }

  async stageCrud(ctx) {
    ctx.result = await this.actions.Dispatch(ctx);
    return ctx;
  }

  stageTransportOutput(ctx) {
    return this.transport.output(ctx);
  }

  stageError(error, _ctx) {
    return this.transport.error(error);
  }

  async pipelineConstructor(request, args = this.arguments) {
    const ctx = this.makeContext(request, args);

    try {
      await this.stageTransportInput(ctx);
      this.stageParse(ctx);
      await this.stageCrud(ctx);
      return this.stageTransportOutput(ctx);
    } catch (error) {
      return this.stageError(error, ctx);
    }
  }

  api(request) {
    return this.pipelineConstructor(request, this.arguments);
  }

  create(body = {}) {
    return this.api({ action: 'create', body });
  }

  read(body = {}) {
    return this.api({ action: 'read', body });
  }

  update(body = {}) {
    return this.api({ action: 'update', body });
  }

  delete(body = {}) {
    return this.api({ action: 'delete', body });
  }

  async handleNode(req, res) {
    const out = await this.api({ req, res });
    this.helper.writeNodeResponse(res, out);
  }

  listen(port = this.globalConfig.http.port, host = this.globalConfig.http.host) {
    if (this.httpServer) return Promise.resolve(this.httpServer);

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleNode(req, res).catch(error => {
          const out = this.stageError(error, null);
          this.helper.writeNodeResponse(res, out);
        });
      });

      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.httpServer = server;
        resolve(server);
      });
    });
  }

  close() {
    if (!this.httpServer) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const server = this.httpServer;
      this.httpServer = null;
      server.close(error => (error ? reject(error) : resolve()));
    });
  }
}
