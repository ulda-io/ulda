# example-password-keeper

Single-page ULDA demo app: encrypted password keeper with support for both REST and Socket.IO transports.

## What this app demonstrates

- `UldaFront` integration in a real browser UI.
- Cabinet lifecycle:
  - create
  - connect
  - update
  - reload
  - close
  - delete (per entry through UI)
- Per-entry content records + master index document.
- Same backend can be used via:
  - REST API
  - Socket.IO events

## Bigger CRUD server profile

This app ships its own CRUD server variant in `src/server.js` with larger payload settings than the default demo:

- `JSON_LIMIT=16mb` (default)
- `CONTENT_BYTES=8192` (default)
- `MAX_CONTENT_BYTES=8388608` (default, 8 MB)

So this example is better for larger encrypted payloads than the original small browser test profile.

## Run

```bash
cd applications/example-password-keeper
npm install
npm run dev
```

Open:

- UI: `http://localhost:8899/`
- API info: `http://localhost:8899/api`
- Healthcheck: `http://localhost:8899/health`
- Config: `http://localhost:8899/config`

## Environment

Use `.env.example` as a reference.

Important vars:

- `PORT`
- `JSON_LIMIT`
- `ORIGIN_SIZE`, `SIGN_N`, `SIGN_MODE`, `SIGN_HASH`
- `CONTENT_BYTES`
- `MAX_CONTENT_BYTES`
- DB vars (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_LIMIT`)
- Docker fallback vars (`DB_DOCKER_*`)

## Data model in UI

- Top-level key `__index` stores entry IDs.
- Each entry is stored in its own key:
  - `entry_<id>`
  - value: `{ title, username, password, note, updatedAt }`

All values are encrypted client-side by `ulda-front` before sending to server.

## Notes

- This is a demo stand, not production-ready password manager.
- It does not include user auth, MFA, audit logs, secure backup strategy, or conflict resolution policy.
