# ulda-front

Security-first frontend API for ULDA cabinet storage, with built-in support for:

- REST transport
- Socket.IO transport

This package is designed for the architecture you described:

- one master record (cabinet root)
- many content records (logical fields)
- identical storage shape for master/content in backend
- encrypted payloads with per-file ULDA forward state (`originPkg`)

---

## What is implemented now

`packages/ulda-front/ulda-front.js` includes:

1. `UldaFront` class:
- `connect`
- `create`
- `update`
- `reload`
- `delete`
- `close`
- proxy-based `ulda.data` API with autosave queue

2. Built-in adapter factories:
- `createRestAdapter(...)`
- `createSocketIOAdapter(...)`

3. Security-focused envelope crypto defaults:
- AES-256-GCM for payload encryption
- PBKDF2-HMAC-SHA-256 for master password key derivation
- random per-envelope salt (master)
- random IV per encryption
- random 32-byte content keys

4. ULDA integration:
- `originPkg` is stored inside each encrypted plaintext document
- each update/delete uses `stepUp -> sign -> send`

---

## Security-first defaults

By default `UldaFront` rejects insecure transport.

Allowed by default:
- `https://...`
- `wss://...`

Blocked by default:
- `http://...`
- `ws://...`

Local demo exception:
- set `allowInsecureLocalhost: true` to allow `http://localhost` / `ws://localhost` / `127.0.0.1`

Other security behaviors:
- secrets are kept in memory only
- master key material is wiped on `close()`
- envelope role and schema are validated before decrypting data

---

## Storage model

Backend row shape is identical for all records:

- `id`
- `ulda_key`
- `content`

After decryption:

### Master plaintext document

```json
{
  "originPkg": "<opaque>",
  "links": {
    "name": { "id": 10, "key": "<base64-32-byte-key>" },
    "email": { "id": 11, "key": "<base64-32-byte-key>" }
  },
  "data": {
    "name": "Alice",
    "email": "alice@example.com"
  }
}
```

### Content plaintext document

```json
{
  "originPkg": "<opaque>",
  "data": "Alice"
}
```

`originPkg` is mandatory in both master and content documents.

---

## ULDA update flow

For every changed file (master or content):

1. read current `originPkg` from decrypted JSON
2. compute next origin: `stepUp(originPkg)`
3. compute signature: `sign(nextOriginPkg)`
4. write new encrypted content containing updated `originPkg`
5. send `PUT` or `DELETE` with forward signature

This matches server-side verification (`verify(storedKey, newKey)`).

---

## Public API

## Exports

- `default` -> `UldaFront`
- `createRestAdapter`
- `createSocketIOAdapter`
- `UldaFrontError`
- `UldaSecurityError`
- `UldaStateError`
- `UldaNotImplementedError`

## Constructor

```js
new UldaFront(id, password, serverConnection, {
  adapter,
  options
});
```

Parameters:

- `id`: `number|string|null` (master id)
- `password`: `string|Uint8Array|null`
- `serverConnection`: URL for REST/WS endpoint
- `adapter`: required adapter from one of factory functions
- `options`: behavior flags

## Options

- `autosave` (default `true`)
- `autosaveDebounceMs` (default `0`)
- `allowInsecureLocalhost` (default `false`)
- `maxMutationDepth` (default `64`)
- `maxLogicalNameLength` (default `128`)

## Properties

- `ulda.id`
- `ulda.data` (Proxy object)

## Methods

- `connect({ id, password, serverConnection })`
- `create({ password, serverConnection })`
- `update()` (force flush pending changes)
- `reload()` (refetch + rebuild cache)
- `delete(target?)`
- `close()`

Deletion modes:
- `delete()` -> delete full cabinet (master + best-effort content cleanup)
- `delete("name")` -> delete one logical content key

---

## `ulda.data` mutation semantics

Examples:

```js
ulda.data.name = "Alice";
ulda.data.profile = { city: "Paris" };
delete ulda.data.profile;
await ulda.update();
```

Notes:

- top-level assignment creates/updates corresponding content records
- deleting top-level key schedules content deletion + master update
- nested updates mutate the same top-level content record
- writes are serialized through an internal flush queue

---

## Adapter factories

## REST adapter

```js
import UldaFront, { createRestAdapter } from "./ulda-front.js";

const adapter = createRestAdapter({
  fetchImpl: fetch,            // optional, defaults to globalThis.fetch
  signConfig: null,            // optional; if omitted, loads /config
  configBaseUrl: null,         // optional override for /config base
  kdfIterations: 310000        // optional
});

const ulda = new UldaFront(null, null, "https://api.example.com", {
  adapter,
  options: {
    autosave: true,
    autosaveDebounceMs: 50
  }
});
```

REST adapter maps to:

- `POST /records`
- `GET /records/:id`
- `PUT /records/:id`
- `DELETE /records/:id`
- `GET /config` (if `signConfig` is not provided)

## Socket.IO adapter

You provide a connected socket instance (from `socket.io-client` in your app).

```js
import UldaFront, { createSocketIOAdapter } from "./ulda-front.js";
import { io } from "socket.io-client";

const socket = io("wss://api.example.com");

const adapter = createSocketIOAdapter({
  socket,                      // required
  fetchImpl: fetch,            // optional; used for /config if needed
  signConfig: null,            // optional; if omitted, /config is loaded via HTTP
  configBaseUrl: "https://api.example.com", // optional explicit /config base
  timeoutMs: 15000,            // optional per RPC timeout
  kdfIterations: 310000        // optional
});

const ulda = new UldaFront(null, null, "wss://api.example.com", {
  adapter,
  options: {
    allowInsecureLocalhost: false
  }
});
```

Socket adapter maps to server events:

- `create`
- `read`
- `update`
- `delete`

---

## Typical lifecycle

Create new cabinet:

```js
await ulda.create({ password: "master-password" });
ulda.data.name = "Alice";
await ulda.update();
```

Connect to existing cabinet:

```js
const ulda = new UldaFront(123, "master-password", "https://api.example.com", { adapter });
await ulda.connect();
console.log(ulda.data.name);
```

Delete one logical field:

```js
await ulda.delete("name");
```

Close and wipe in-memory secrets:

```js
await ulda.close();
```

---

## Error model

Typed errors:

- `UldaFrontError` (base)
- `UldaSecurityError`
- `UldaStateError`
- `UldaNotImplementedError`

Recommended handling:

1. treat `UldaSecurityError` as hard-stop
2. treat `UldaStateError` as usage/lifecycle issue
3. on remote signature rejection, call `reload()` and retry intentionally

---

## Security notes and current limits

This implementation is security-oriented but still demo-stage.

Strong points:

- AEAD encryption (AES-GCM)
- per-content random keys
- per-master-envelope random PBKDF2 salt
- forward ULDA signatures for mutation authorization

Not fully solved yet:

- multi-writer conflict resolution
- rollback policy enforcement beyond current server behavior
- transaction-like atomicity across master and multiple content writes
- independent cryptographic audit

For production:

1. enforce HTTPS/WSS end-to-end
2. add strict authn/authz layer server-side
3. add conflict strategy and idempotency policy
4. add full test suite (unit + integration + adversarial)
5. run external security review

---

## Compatibility

- Requires WebCrypto (`crypto.subtle`, `crypto.getRandomValues`)
- Browser: modern evergreen browsers
- Node.js: runtime with WebCrypto support and `fetch` (or pass custom `fetchImpl`)

---

## File reference

- Implementation: `packages/ulda-front/ulda-front.js`

