# ulda-crud (ULDA CRUD server)

A small demonstration CRUD server (Express + Socket.IO) backed by MySQL that uses an **ULDA signature** as an application-level “state key” for each record.

Core idea: the server **does not store private keys** and **does not generate signatures**. It only:
1) stores the latest `ulda_key` for each record;
2) allows `UPDATE/DELETE` only if the client-provided `ulda_key` cryptographically **extends** the previous one (via `verify()`).

> This is a prototype intended for demos and benchmarking. It does **not** include authentication, TLS, rate-limiting, multi-tenant isolation, etc.

---

## Where this README belongs

Place this file at:

- `applications/ulda-crud/README.md`

---

## Requirements
- Node.js >= 18
- MySQL 8.0+ **or** Docker (the server can optionally start a MySQL container if DB is not reachable)

---

## Quick start
```bash
cd applications/ulda-crud
npm install

# optional configuration
cp .env.example .env

npm run dev
```

After startup:
- Browser UI: `http://localhost:8787/browser-test/`
- Config endpoint: `http://localhost:8787/config`
- Healthcheck: `http://localhost:8787/health`

---

## Configuration (.env)

### ULDA / demo settings
- `PORT` — HTTP port (default 8787)
- `ORIGIN_SIZE` — origin block size in **bits** (must be divisible by 8), e.g. 256
- `SIGN_N` — ULDA parameter N
- `SIGN_MODE` — ULDA mode: `S` or `X`
- `SIGN_HASH` — hash function name (e.g. `SHA-256`)
- `CONTENT_BYTES` — payload size used by the browser tests
- `LOG_REQUESTS` — enable verbose request tracing

### MySQL
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_LIMIT`

### Docker fallback (if MySQL is unavailable)
- `DB_DOCKER_ENABLE=true|false`
- `DB_DOCKER_IMAGE` (default `mysql:8.0`)
- `DB_DOCKER_CONTAINER`, `DB_DOCKER_VOLUME`
- `DB_DOCKER_ROOT_PASSWORD`

---

## Database schema

Table `main` (InnoDB):
- `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY
- `ulda_key` BLOB NOT NULL
- `content` LONGBLOB NOT NULL

The server stores only the **latest** `ulda_key` (current state) per record.

---

## ULDA semantics in the server

The server treats `ulda_key` as the **current authorization state** for a record.

### CREATE
- Accepts `ulda_key` and `content` and inserts a new row.
- In this prototype, the server does not validate the “origin” of the first `ulda_key`.

### UPDATE
- Loads `storedKey` from DB
- verifies `verify(storedKey, newKey)`
- if ok → updates `ulda_key` and `content`

### DELETE (important)
DELETE is also authorized using `verify()`.

Because ULDA verification is **strictly forward** (in the sense that `verify(A, A)` is false), the client cannot delete by sending the *current* signature. Instead, the client must send a **forward signature**:

- `nextPkg = stepUp(originPkg)`
- `sigDel = sign(nextPkg)`
- `DELETE` with `sigDel`

> Consequence: the client must keep its local state (origin package) to produce valid next signatures for update/delete. If the client loses that state, it cannot generate a valid forward signature.

---

## REST API

### GET /
Returns a list of endpoints.

### GET /config
Returns ULDA parameters and encoding formats used by browser tests.

### GET /health
Checks server/DB readiness.

### POST /records
Body:
```json
{
  "ulda_key": "<hex | base64 | bytes[]>",
  "content": "<base64 | hex | bytes[]>",
  "format": "hex",
  "contentFormat": "base64"
}
```

Response:
```json
{ "ok": true, "id": 123, "durationMs": 4.12 }
```

### GET /records/:id?format=hex&contentFormat=base64
Response:
```json
{
  "ok": true,
  "id": 123,
  "ulda_key": "<encoded>",
  "content": "<encoded>",
  "format": "hex",
  "contentFormat": "base64",
  "durationMs": 1.90
}
```

### PUT /records/:id
Same body as POST.
- `ulda_key` must pass `verify(storedKey, newKey)`.

### DELETE /records/:id
Body:
```json
{
  "ulda_key": "<hex | base64 | bytes[]>",
  "format": "hex"
}
```
- `ulda_key` must be a **forward** signature that passes `verify(storedKey, key)`.

---

## Socket.IO

Supported events:
- `create`
- `read`
- `update`
- `delete`

Payload format is equivalent to REST.

---

## Known limitations / notes (useful for papers & demos)
- No authentication / authorization model; record IDs are the only “identifier”.
- CORS is permissive (`*`).
- No explicit anti-rollback checks (monotonic index enforcement). In this prototype we assume rollback resistance is handled at the server/DB policy level. If needed, you can add monotonic index checks or optimistic concurrency control (`UPDATE ... WHERE ulda_key = <old>`).
- Concurrency/race handling is minimal; parallel updates may overwrite each other without locks/compare-and-swap.
