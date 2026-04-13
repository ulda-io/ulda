Ты работаешь внутри моей репозитории ULDA и должен переписать текущий CRUD-сервер под новую минимальную модель.

Сначала ОБЯЗАТЕЛЬНО изучи:
1. `packages/ulda-sign/ulda-sign.js`
2. текущие файлы CRUD-сервера в репе
3. текущие тесты, если они есть

Твоя задача — не написать абстрактный пример, а сделать реальный patch в репозитории.

# Главная цель

Переписать CRUD-сервер так, чтобы:
- тело запроса всегда было максимально коротким;
- action не лежал в body;
- payload не парсился как бизнес-объект;
- в БД хранились только бинарные поля записи плюс серверные timestamps;
- `ulda-sign` использовался только для `verify()`;
- update/delete были защищены compare-and-swap, чтобы не было гонок.

# Стиль кода

Нужно ориентироваться на стиль `packages/ulda-sign/ulda-sign.js`:
- один основной класс;
- конструктор нормализует конфиг в духе `this.globalConfig = {...}`;
- логика разбита на именованные группы на `this`;
- публичные методы короткие и тонкие;
- не разносить всё на множество мелких классов без необходимости;
- request-scoped состояние нельзя хранить в `this`, оно должно жить только в `ctx`.

Ожидаемая форма:

```js
class UldaServerCRUD {
  LocalVar
  Constructor f[]
  PipelineConstructor f[]
  Transport f[]
  DB f[]
  Actions f[]
  Helper f[]
}
```

# Жёсткие требования к модели данных

## Request body

Body всегда только такой:

```json
{
  "id": "...",
  "ulda": "...",
  "load": "..."
}
```

Больше никаких пользовательских полей в body.
Никаких meta, auth, resource, payload, flags, owner и так далее.

## Семантика полей

- `id` — идентификатор записи
- `ulda` — байты подписи
- `load` — байты payload

## Важно

- `action` НЕ хранится в body;
- `action` определяется transport-ом;
- `load` — opaque bytes, сервер не должен интерпретировать его структуру;
- `ulda` — opaque bytes для сервера, кроме передачи в `verify()`.

# Внутренний нормализованный request после parse-stage

Внутри pipeline после parse-stage должно быть ровно это:

```js
{
  id: bigint | null,
  ulda: Buffer,
  load: Buffer
}
```

# Схема БД

В БД хранить только:

```text
id          bigint auto increment primary key
sign        bytes / blob / bytea
data        bytes / blob / bytea
create_time timestamp
update_time timestamp
```

Никаких других обязательных полей.

# CRUD semantics

## Create

Вход:
```js
{ id: null, ulda, load }
```

Логика:
- `verify()` НЕ вызывается;
- сохранить:
  - `sign = ulda`
  - `data = load`
  - `create_time = now`
  - `update_time = now`
- вернуть `{ id }`

## Read

Вход:
```js
{ id, ulda: empty, load: empty }
```

Логика:
- прочитать запись по `id`
- вернуть:
```js
{ id, ulda: sign, load: data }
```

## Update

Вход:
```js
{ id, ulda: nextSign, load: nextData }
```

Логика:
1. прочитать запись по `id`
2. взять `storedSign`
3. вызвать `verify(storedSign, nextSign)`
4. если `verify === false`, вернуть reject
5. если `verify === true`, сделать compare-and-swap update:
   - обновить `sign = nextSign`
   - обновить `data = nextData`
   - обновить `update_time = now`
   - но только если текущий `sign` в БД всё ещё равен `storedSign`
6. если CAS не прошёл, вернуть conflict
7. если всё прошло, вернуть `{ id }`

## Delete

Вход:
```js
{ id, ulda: nextSign, load: empty }
```

Логика:
1. прочитать запись по `id`
2. взять `storedSign`
3. вызвать `verify(storedSign, nextSign)`
4. если `verify === false`, вернуть reject
5. если `verify === true`, сделать compare-and-swap delete:
   - удалить запись только если `sign` всё ещё равен `storedSign`
6. если CAS не прошёл, вернуть conflict
7. если всё прошло, вернуть `{ id }`

# Использование ulda-sign

Разрешено использовать пакет `ulda-sign` ТОЛЬКО для:

```js
await signer.verify(oldSign, newSign)
```

НЕЛЬЗЯ использовать в сервере:
- `New()`
- `stepUp()`
- `sign()`

Генерация и развитие цепочки подписи происходят только на клиенте.

# Transport

Сделай transport так, чтобы action определялся НЕ из body.

Базовый HTTP transport, который нужно реализовать:
- `POST /create`
- `POST /read`
- `POST /update`
- `POST /delete`

Почему так:
- body должен оставаться коротким и однотипным
- `load` может быть пустым, поэтому action нельзя выводить из body

Поддержка transport-уровня должна быть построена так, чтобы при желании можно было добавить другой adapter (например socket/websocket), не переписывая CRUD-ядро.

# Byte handling

На transport-уровне байты можно принимать в одном выбранном codec, например `base64` или `hex`.

Требование:
- снаружи можно сериализовать bytes как `base64` или `hex`
- внутри pipeline после parse-stage это всегда `Buffer`
- при `read` наружу возвращать тот же transport codec

# Error model

Минимальные error bodies:

```json
{ "error": "bad_request" }
{ "error": "not_found" }
{ "error": "verify_failed" }
{ "error": "conflict" }
{ "error": "internal" }
```

Рекомендуемые status codes:
- 201 create success
- 200 read/update/delete success
- 400 bad_request
- 403 verify_failed
- 404 not_found
- 409 conflict
- 500 internal

# Пайплайн

Пайплайн должен быть именно таким:

```text
request
-> transport input
-> parsing
-> CRUD action
-> transport output
```

Где:

## transport input
Извлекает:
- action
- body
- method/path при HTTP

## parsing
Преобразует body в:

```js
{ id: bigint | null, ulda: Buffer, load: Buffer }
```

## CRUD action
Работает уже только с:
- нормализованным request
- row из БД вида `{ id, sign, data, create_time, update_time }`

## transport output
Сериализует ответ обратно в transport-safe форму.

# Что нужно изменить в репозитории

1. Найти текущий CRUD-server код и заменить архитектуру на новую минимальную модель.
2. Сохранить читаемость и стиль, близкий к `ulda-sign`.
3. Если в проекте уже есть transport/bootstrap, аккуратно адаптировать его.
4. Если есть текущие DB adapters — переписать их под новую схему `id/sign/data/create_time/update_time`.
5. Убрать логику старых сложных request schemas, meta/auth/resource/payload и т.п.
6. Убрать серверную зависимость от любых методов `ulda-sign`, кроме `verify()`.
7. Добавить или обновить тесты.

# Что должно получиться в результате

Нужен рабочий patch, а не описание.

Сделай:
- основной класс `UldaServerCRUD`
- минимальный HTTP bootstrap
- адаптер БД или обновление текущего адаптера
- тесты
- при необходимости короткий README/комментарии по новому contract

# Обязательные тесты

Добавь тесты минимум на это:

1. create сохраняет `sign`, `data`, `create_time`, `update_time`
2. read возвращает `{ id, ulda, load }`
3. update с valid verify проходит
4. update с invalid verify падает с `verify_failed`
5. delete с valid verify проходит
6. update возвращает `conflict`, если compare-and-swap не прошёл
7. delete возвращает `conflict`, если compare-and-swap не прошёл
8. read для отсутствующей записи возвращает `not_found`

# Важно для редактирования кода

- Не ломай публичные entry points без необходимости.
- Если меняешь route layout, обнови bootstrap и тесты вместе.
- Если в репе уже есть соглашения по именованию файлов, сохрани их.
- Если есть монорепа и локальный пакет `ulda-sign`, используй локальный import path этой репы, а не придумывай новый.
- Если есть существующий DB слой, не переписывай всё лишнее; меняй только то, что нужно для новой модели.

# Финальный результат от тебя

1. Внеси patch в код.
2. Покажи список изменённых файлов.
3. Кратко объясни архитектуру нового CRUD.
4. Отдельно укажи, где именно происходит:
   - transport action detection
   - parse to Buffer
   - verify gate
   - compare-and-swap update/delete
