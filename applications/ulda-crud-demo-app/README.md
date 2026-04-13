# ulda-crud-demo-app

Минимальная self-contained демка:
- публичный HTTP сервер;
- PostgreSQL поднимается через Docker Compose;
- схема инициализируется автоматически через `db/init/001_init.sql`;
- есть smoke-test без ручного подключения к БД.

## Что это делает

Это не боевой ULDA-сервер, а минимальная демка приложения вокруг `UldaServerCRUD`.
По умолчанию она использует `DemoSigner`, чтобы проверить:
- transport;
- pipeline;
- PostgreSQL adapter;
- compare-and-swap для update/delete;
- публичные маршруты.

`DemoSigner` только проверяет, что новая подпись не пустая и отличается от предыдущей.
Для боевого режима его нужно заменить на реальный `UldaSign` из твоей монорепы.

## Быстрый запуск

```bash
docker compose up --build
```

После старта:
- API: `http://127.0.0.1:3010`
- health: `http://127.0.0.1:3010/health`

## Smoke test

```bash
docker compose --profile test up --build --abort-on-container-exit smoke
```

Если хочешь оставить app и db работать в фоне:

```bash
docker compose up -d --build
docker compose run --rm smoke
```

## Маршруты

Все CRUD маршруты принимают `POST` и короткое body:

```json
{
  "id": "1",
  "ulda": "base64",
  "load": "base64"
}
```

### Create
`POST /create`

```json
{
  "id": null,
  "ulda": "c2lnbi0x",
  "load": "aGVsbG8="
}
```

### Read
`POST /read`

```json
{
  "id": "1",
  "ulda": "",
  "load": ""
}
```

### Update
`POST /update`

```json
{
  "id": "1",
  "ulda": "c2lnbi0y",
  "load": "d29ybGQ="
}
```

### Delete
`POST /delete`

```json
{
  "id": "1",
  "ulda": "c2lnbi0z",
  "load": ""
}
```

## Что хранится в БД

Только это:
- `id`
- `sign`
- `data`
- `create_time`
- `update_time`

## Как заменить signer на реальный ULDA

В `src/server.mjs` замени:

```js
import DemoSigner from './DemoSigner.mjs';
const signer = new DemoSigner();
```

на реальный импорт из твоей монорепы, например:

```js
import UldaSign from '../packages/ulda-sign/ulda-sign.js';
const signer = new UldaSign({
  sign: {
    N: 5,
    mode: 'X',
    hash: 'SHA-256',
    originSize: 256
  }
});
```

При этом сам сервер уже будет использовать у signer только `verify()`.
