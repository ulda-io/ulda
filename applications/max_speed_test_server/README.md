# max_speed_test_server

`max_speed_test_server` is an in-memory ULDA CRUD server for high-speed HTTP stress testing.

It does not use MySQL or any other database. All records are stored in a local Node.js `Map`, so the service is fast to start and has no disk/database overhead. Data is lost when the process stops.

## Features

- In-memory CRUD API over HTTP
- ULDA signature validation for update and delete operations
- Built-in browser UI for stress testing and on-page reporting
- JSON report output in the UI
- Optional Node CLI stress script for 100 clients

## API Endpoints

- `GET /` service info
- `GET /config` ULDA configuration returned to clients
- `GET /health` health endpoint
- `GET /stats` in-memory record stats
- `POST /records` create a record
- `GET /records/:id` read a record
- `PUT /records/:id` update a record (requires valid forward ULDA signature)
- `DELETE /records/:id` delete a record (requires valid forward ULDA signature)
- `GET /browser-test/` browser UI for stress tests

## ULDA Behavior

Each record stores its current `ulda_key`.

- `CREATE`: stores the provided `ulda_key` and `content`.
- `UPDATE`: verifies `verify(storedKey, newKey)` before replacing both key and content.
- `DELETE`: verifies `verify(storedKey, key)` before deletion.

A delete request must use a forward key (`stepUp` + `sign`). Sending the same current key will fail verification.

## Run Server

```bash
cd applications/max_speed_test_server
npm install
npm run dev
```

Default URL: `http://localhost:8899`

## Browser Stress UI (Workers)

Open:

```bash
http://localhost:8899/browser-test/
```

UI controls:

- Open the worker test page from the index: `throughput-workers.html`
- concurrency (workers/clients)
- duration in milliseconds
- content bytes
- signature format (`base64` or `hex`)
- `doRead` and `doDelete`

Worker model:

- `1 worker = 1 client = 1 record`
- each worker runs: `CREATE -> UPDATE loop (durationMs) -> optional READ -> optional DELETE`
- updates use `stepUp + sign` sequentially
- delete uses forward signature (`stepUp + sign`)

UI reporting includes:

- `config`, `settings`, `totals`
- per-operation summaries for `create`, `update`, `read`, `delete`
- for each operation: `count`, `failures`, `avgClientMs`, `avgServerMs`

## CLI Stress Script

Script path: `scripts/stress-http-100-clients.js`

Run:

```bash
cd applications/max_speed_test_server
npm run stress
```

Environment variables:

- `BASE_URL` (default `http://127.0.0.1:8899`)
- `CLIENTS` (default `100`)
- `UPDATES_PER_CLIENT` (default `5`)
- `CONTENT_BYTES` (default `32`)
