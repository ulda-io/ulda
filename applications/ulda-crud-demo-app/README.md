# ulda-crud-demo-app

Минимальная self-contained демка с несколькими smoke-тестами:
- core smoke без сети;
- REST smoke;
- WebSocket smoke;
- race smoke для compare-and-swap.

## Что проверяется

### smoke-core
Проверяет только ядро:
- create
- read
- update
- verify fail
- delete
- read after delete

Запуск локально:

```bash
npm install
npm run smoke:core
```

### smoke-rest
Проверяет:
- HTTP transport
- route -> action mapping
- JSON body
- base64 codec
- HTTP statuses

### smoke-ws
Проверяет:
- WebSocket transport `/ws`
- envelope `{ op, body }`
- reuse одного и того же core

### smoke-race
Проверяет:
- два параллельных update от одной и той же старой подписи
- ожидается: один `200`, один `409`

## Быстрый запуск сервера

```bash
docker compose up --build
```

После старта:
- HTTP: `http://127.0.0.1:3010`
- Health: `http://127.0.0.1:3010/health`
- WS: `ws://127.0.0.1:3010/ws`

## Запуск smoke-тестов в Docker

REST:

```bash
docker compose --profile test up --build --abort-on-container-exit smoke-rest
```

WebSocket:

```bash
docker compose --profile test up --build --abort-on-container-exit smoke-ws
```

Race:

```bash
docker compose --profile test up --build --abort-on-container-exit smoke-race
```

Если сервер уже поднят в фоне:

```bash
docker compose run --rm smoke-rest
docker compose run --rm smoke-ws
docker compose run --rm smoke-race
```

## Формат body

Во всех CRUD transport-ах логическая форма остаётся одной и той же:

```json
{
  "id": "1",
  "ulda": "base64",
  "load": "base64"
}
```

### Для WebSocket

Транспортный envelope такой:

```json
{
  "op": "update",
  "body": {
    "id": "1",
    "ulda": "base64",
    "load": "base64"
  }
}
```

## Важный момент

В этой демке стоит `DemoSigner`, а не реальный `ulda-sign`.
Он нужен только для transport/db/cas smoke-тестов.
Чтобы использовать настоящий ULDA, замени `DemoSigner` в `src/server.mjs` на импорт твоего реального `UldaSign`.


## Throughput benchmark на 10 секунд

Добавлен отдельный benchmark-скрипт `scripts/bench-throughput.mjs`.
По умолчанию он меряет режим `update`, то есть именно путь:

```
read -> verify -> compare-and-swap update
```

Параметры по умолчанию:
- duration: `10000 ms`
- concurrency: `20`
- payload: `64 bytes`
- mode: `update`

### REST benchmark

```bash
docker compose --profile bench up --build --abort-on-container-exit bench-rest
```

### WebSocket benchmark

```bash
docker compose --profile bench up --build --abort-on-container-exit bench-ws
```

Если сервер уже поднят в фоне:

```bash
docker compose run --rm bench-rest
docker compose run --rm bench-ws
```

### Локальный запуск

```bash
npm install
BENCH_TRANSPORT=rest BENCH_DURATION_MS=10000 npm run bench:throughput
```

### Доступные env-параметры

- `BENCH_TRANSPORT=rest|ws`
- `BENCH_MODE=create|read|update`
- `BENCH_DURATION_MS=10000`
- `BENCH_CONCURRENCY=20`
- `BENCH_PAYLOAD_BYTES=64`
- `BASE_URL=http://127.0.0.1:3010`
- `BASE_WS_URL=ws://127.0.0.1:3010/ws`

### Что выводится

Скрипт печатает JSON-отчёт:
- `totalOps`
- `okOps`
- `failedOps`
- `statusCounts`
- `opsPerSec`
- `avgLatencyMs`
- `minLatencyMs`
- `maxLatencyMs`
