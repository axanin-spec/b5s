# API-контракт сервера «Космический Рейнджер» (Этап 15a)

MVP-бэкенд многопользовательского режима: аккаунты + облачный сейв.
Zero-dep Node (>= 18), CommonJS-free ESM, порт по умолчанию `8787`.

Запуск: `node server/index.mjs` (или `npm start` в `server/`).
Переменные окружения: `PORT` (по умолчанию 8787), `DATA_DIR` (по умолчанию `server/data`).

Клиент указывает адрес через `VITE_API_URL` (см. `.env.example`),
по умолчанию `http://localhost:8787`.

## Общее

- Все ответы JSON: `{ ok: true, ... }` либо `{ ok: false, error: string }`.
- CORS открыт (`Access-Control-Allow-Origin: *`) — сервер рассчитан на публичную публикацию.
- Авторизация: заголовок `Authorization: Bearer <token>`.
- Токены и пароли: scrypt (соль 16 байт) для паролей, токен — 24 случайных байта hex. Токены бессрочные (MVP), хранятся в `data/tokens.json`.

## Эндпоинты

### `GET /api/health`
→ `{ ok: true, uptime: number }`

### `POST /api/register`
Тело: `{ username: string, password: string }`
- username: 3–24 символа `[\p{L}\p{N}_-]` (кириллица разрешена), уникален без учёта регистра.
- password: ≥ 6 символов.
→ `{ ok: true, token, username }`
Побочный эффект: `data/world.json.registered += 1` — счётчик зарегистрированных
игроков для экономического решения «+1 000 000 ₡ в пулы за игрока» (Этап 15, world-state).
Ошибки: `username_taken`, `bad_username`, `bad_password`.

### `POST /api/login`
Тело: `{ username, password }` → `{ ok: true, token, username }`
Ошибка: `bad_credentials`.

### `GET /api/me` (Bearer)
→ `{ ok: true, username }` — проверка токена.

### `GET /api/save` (Bearer)
→ `{ ok: true, save: object | null, updatedAt: number | null }`

### `PUT /api/save` (Bearer)
Тело: `{ save: object }` (сырой объект сейва игры).
Сервер валидирует облегчённо: объект, `v` ∈ {8, 9}, `player.credits` — конечное число.
Полная валидация остаётся на клиенте (`validateSave`, src/game/save.ts).
→ `{ ok: true, updatedAt }`
Ошибка: `bad_save`.

## Хранилище (файловое, MVP)

```
data/
  users.json            { [username]: { salt, hash, createdAt } }
  tokens.json           { [token]: username }
  saves/<user>.json     { save, updatedAt }   (имя файла = encodeURIComponent(username))
  world.json            { registered, pools: { patrol, alliance, clan, stations }, updatedAt }
```

Запись атомарна (tmp + rename), операции на файл сериализованы очередью.

## Общий шард (Этап 15b)

### `GET /api/world`
→ `{ ok: true, world: { pools, online, registered, updatedAt } }` — общие пулы и онлайн.
Каждая регистрация добавляет в пулы +1 000 000 ₡ пропорционально
(patrol 200k / alliance 260k / clan 140k / stations 400k).

### WebSocket `GET /api/ws?token=<bearer>`
Текстовые JSON-кадры. Невалидный токен — HTTP 401 до рукопожатия.
Лимит: 200 игроков на шард (`{ t: "error", error: "shard_full" }`).

Клиент → сервер:
- `{ t: "state", x, y, a, sys?, hull? }` — позиция; x/y/a конечные числа
  (округляются до 0.01), sys/hull строки ≤ 64. Троттлинг: не чаще 20 Гц,
  избыточные кадры молча отбрасываются.

Сервер → клиент:
- `{ t: "welcome", id, players: [{ id, username, state }], world }` — свой id и ростер.
- `{ t: "join", player: { id, username, state } }`
- `{ t: "leave", id }`
- `{ t: "state", id, x, y, a, sys?, hull? }` — ретрансляция чужих позиций.
- `{ t: "world", world }` — при изменении пулов/онлайна.

Heartbeat: сервер ping каждые 30 с, соединение без pong 60 с закрывается.
Клиентский транспорт — `src/net/world.ts` (реконнект с backoff 1с→30с,
отправка своего state таймером 10 Гц).

Автотест: `node server/test-world.mjs` (10 проверок: пулы, welcome/join/state/
leave, троттлинг, мусорные кадры, отказ по токену).

## Дальше (не входит в 15a/15b)

- Интеграция шарда в игровой цикл (рендер чужих кораблей, позывные, отправка
  позиции из game.ts) — трек Б / следующий шаг.
- 15c: авторитет сервера по деньгам и смертям, PvP-розыск, торговля игрок↔игрок.
- Отзыв токенов, rate-limit, HTTPS-терминация — на стороне прокси при публикации.
