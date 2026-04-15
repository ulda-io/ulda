# ULDA CRUD prototype

Минимальный бинарный CRUD-сервер с commit-gate через `verify()`.

## Что принимает сервер

На уровне transport body всегда только это:

```json
{
  "id": "1",
  "ulda": "...bytes...",
  "load": "...bytes..."
}
```

- `action` не лежит в body;
- `action` задаётся transport-ом;
- в текущем HTTP bootstrap используются маршруты:
  - `POST /create`
  - `POST /read`
  - `POST /update`
  - `POST /delete`

## Что хранится в базе

```text
id          bigint / autoincrement primary key
sign        bytes / blob / bytea
data        bytes / blob / bytea
create_time timestamp
update_time timestamp
```

Во внешнем API timestamps не возвращаются. Это внутренние поля адаптера БД.

## Внутренний pipeline

```text
request
-> transport input
-> parse to { id: bigint | null, ulda: Buffer, load: Buffer }
-> CRUD action
-> transport output
```

CRUD-семантика:

- `create`
  - verify не вызывается;
  - сохраняет `sign = ulda`, `data = load`;
  - пишет `create_time`, `update_time`.
- `read`
  - читает запись по `id`;
  - возвращает `{ id, ulda, load }`, где
    - `ulda = sign`
    - `load = data`
- `update`
  - читает строку;
  - вызывает `verify(oldSign, nextSign)`;
  - делает compare-and-swap update по `id + oldSign`;
  - обновляет `sign`, `data`, `update_time`.
- `delete`
  - читает строку;
  - вызывает `verify(oldSign, nextSign)`;
  - делает compare-and-swap delete по `id + oldSign`.

## Что уже есть в прототипе

- `src/UldaServerCRUD.mjs` — основной класс
- `src/DbAdapterContract.mjs` — контракт адаптера БД
- `src/MemoryDbAdapter.mjs` — in-memory adapter для тестов
- `src/bootstrap-http.mjs` — минимальный HTTP bootstrap
- `test/UldaServerCRUD.test.mjs` — тесты на pipeline, verify gate и CAS

## Как подключить реальный ulda-sign в твоей монорепе

Пример:

```js
import UldaSign from '../packages/ulda-sign/ulda-sign.js';
import MemoryDbAdapter from './src/MemoryDbAdapter.mjs';
import { startHttpCrudServer } from './src/bootstrap-http.mjs';

const signer = new UldaSign({
  sign: { N: 5, mode: 'X', hash: 'SHA-256', originSize: 256 },
});

const db = new MemoryDbAdapter();

await startHttpCrudServer({
  signer,
  db,
  config: {
    codec: { bytes: 'base64' },
    http: {
      host: '127.0.0.1',
      port: 3000,
    },
  },
});
```

Важно: сервер использует у signer только `verify(a, b)`.

## Формат байтов на transport-уровне

По умолчанию в прототипе используется `base64`.

Можно переключить на `hex`:

```js
new UldaServerCRUD({
  signer,
  db,
  codec: { bytes: 'hex' },
});
```

Внутри pipeline это всё равно всегда `Buffer`.

## DB adapter contract

Адаптер должен реализовать 4 метода:

```js
async create({ sign, data, create_time, update_time })
async read(id)
async updateChecked({ id, expectedSign, nextSign, nextData, update_time })
async deleteChecked({ id, expectedSign })
```

### Ожидаемые return values

```js
create(...) -> Promise<bigint>

read(...) -> Promise<{
  id: bigint,
  sign: Buffer | Uint8Array,
  data: Buffer | Uint8Array,
  create_time: any,
  update_time: any,
} | null>

updateChecked(...) -> Promise<boolean>
deleteChecked(...) -> Promise<boolean>
```

## Минимальные success responses

```json
// create
{ "id": "1" }

// read
{ "id": "1", "ulda": "...", "load": "..." }

// update
{ "id": "1" }

// delete
{ "id": "1" }
```

## Минимальные error responses

```json
{ "error": "bad_request" }
{ "error": "not_found" }
{ "error": "verify_failed" }
{ "error": "conflict" }
{ "error": "internal" }
```

## Тесты

```bash
npm test
```

В текущем прототипе тесты идут через stub signer, чтобы проверять логику сервера отдельно от криптографического пакета.
