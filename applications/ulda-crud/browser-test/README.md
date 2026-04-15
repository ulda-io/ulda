# ulda-crud browser-test (manual UI + stress test)

This folder contains a simple browser client used for:
- manual CRUD actions (`index.html`)
- throughput / stress testing (`throughput.html`)

The client fetches `/config` from the server, then locally:
- creates an origin package
- generates ULDA signatures
- performs `stepUp + sign` for each update

---

## Where this README belongs

Place this file at:

- `applications/ulda-crud/browser-test/README.md`

---

## Prerequisites
1) Start the server:
```bash
cd applications/ulda-crud
npm install
npm run dev
```

2) Open the UI:
- `http://localhost:8787/browser-test/`

---

## 1) Manual UI (index.html)

Typical flow:
1) **Create**: creates a record in the DB and keeps local state:
   - `originPkg` (client state)
   - `currentSig` (current ULDA signature)
2) **Update**: performs `originPkg = stepUp(originPkg)` → `sign(originPkg)` and sends `PUT`.
3) **Read**: reads the record from the server.
4) **Delete**: requires a **forward signature** (see below).

### Important: Delete requires a forward signature
The server authorizes DELETE using `verify()`. In ULDA, `verify(A, A) = false`, so:
- sending the current `currentSig` will fail
- you must generate the **next** signature:
  - `nextPkg = stepUp(originPkg)`
  - `sigDel = sign(nextPkg)`
  - `DELETE` with `sigDel`

If delete fails, confirm that `main.js` is generating a forward signature for delete.

---

## 2) Throughput / Stress test (throughput.html)

### Parameters
- **Record count**: number of records to create before the test
- **Concurrency**: number of parallel workers
- **Duration (sec)**: test run time
- **doRead**: whether to perform `READ` after each `UPDATE`
- **doDelete**: whether to delete all records at the end

### Reported metrics
- `avgClientMs`: client-side time (fetch + JSON parsing)
- `avgServerMs`: server-side time as reported by the server (`durationMs`)
- `opsPerSec`: total operations per second (create + update + read + delete)

### Important: Delete in stress test
Same rule as manual UI: `DELETE` must use a **forward signature**, otherwise you will see `delete.failures = count`.

In `throughput.js`, delete should do:
- `nextPkg = stepUp(record.originPkg)`
- `sigDel = sign(nextPkg)`
- `DELETE` with `sigDel`

---

## ULDA algorithm unit tests
ULDA unit tests live in `packages/ulda-sign/tests/`.

Run from the repository root:
```bash
node --test packages/ulda-sign/tests/ulda-sign.test.mjs
```

(Node 18+ required)
