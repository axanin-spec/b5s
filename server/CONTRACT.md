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
- `{ t: "state", x, y, a, sys?, hull?, hp?, maxHp? }` — позиция; x/y/a конечные
  числа (округляются до 0.01), sys/hull строки ≤ 64, hp/maxHp 0..1e6
  (необязательно, для PvP-оценки). Троттлинг: не чаще 20 Гц.
- `{ t: "hit", target, dmg }` — заявка о попадании (15c). Сервер верифицирует:
  цель жива и онлайн, одна система (если оба репортят sys), дистанция по
  последним state ≤ 3000, dmg целый 1..1000, темп ≤ 30 попаданий за 10 с.
  Невалидное молча отбрасывается.

Сервер → клиент:
- `{ t: "welcome", id, players: [{ id, username, state, dead? }], world }` — свой id и ростер.
- `{ t: "join", player: { id, username, state } }`
- `{ t: "leave", id }`
- `{ t: "state", id, x, y, a, sys?, hull?, hp?, maxHp? }` — ретрансляция чужих позиций.
- `{ t: "world", world }` — при изменении пулов/онлайна/счётчика убийств.
- `{ t: "hit", id, from, dmg, hp }` — верифицированное попадание: id — цель,
  from — атакующий, hp — серверная оценка здоровья цели (15c).
- `{ t: "kill", id, by }` — сервер объявил смерть игрока id от рук by.
- `{ t: "respawn", id }` — игрок вернулся в строй (первый state после смерти).

PvP — мягкая верификация: сервер не симулирует баллистику, а проверяет
согласованность (дистанция/система/темп/кап) и единолично объявляет kill.
Деньги боевые события НЕ двигают — только ledger. Убийства журналируются
(`world.kills`, `world.killsLog` — последние 50 записей {t, by, victim, sys}).

Автотест: `node server/test-pvp.mjs` (9 проверок: верификация, дистанция,
темп, кап урона, kill/respawn, персист killsLog).

### Торговля игрок↔игрок (15c, эскроу через ledger)

Клиент → сервер:
- `{ t: "trade_offer", id, to, giveCredits, wantCredits, giveGoods?, wantGoods? }`
  — оффер игроку `to`; TTL 60 с, оба должны быть онлайн, живы, в одной системе
  и на дистанции ≤ 1500. goods — объект `goodId → qty` (≤ 20 позиций, qty
  целое 1..100000). Лимит незавершённых офферов на игрока: 10.
- `{ t: "trade_accept" | "trade_decline", id }` — ответ адресата.
- `{ t: "trade_cancel", id }` — отзыв инициатором.

Сервер → клиент:
- `{ t: "trade_offer", id, from, fromName, ... }` — адресату.
- `{ t: "trade_done", id, ... }` — обоим: кредиты переведены атомарно через
  `ledger.executeTrade` (две встречные транзакции «всё или ничего», id
  `<deal>-a`/`<deal>-b`, журналируются kind:"trade"); ТОВАРЫ переходят на
  клиентах по этому событию (игровая интеграция — следующий шаг).
- `{ t: "trade_fail", id, reason }` — `insufficient_funds` / `offline` /
  `expired`. Отключение любой стороны отменяет её висящие сделки.
- `{ t: "trade_declined" | "trade_cancelled", id }`.

Незавершённые сделки живут в памяти сервера (рестарт = отмена).

Автотест: `node server/test-trade.mjs` (8 проверок: оффер, атомарный расчёт,
повторный акцепт, нехватка средств, отказ, дистанция, отмена при offline).

Heartbeat: сервер ping каждые 30 с, соединение без pong 60 с закрывается.
Клиентский транспорт — `src/net/world.ts` (реконнект с backoff 1с→30с,
отправка своего state таймером 10 Гц).

Автотест: `node server/test-world.mjs` (10 проверок: пулы, welcome/join/state/
leave, троттлинг, мусорные кадры, отказ по токену).

## Денежный авторитет (Этап 15c, серверная часть)

Счета: `player:<username>` и `pool:patrol|alliance|clan|stations`.
Журнал append-only `data/journal.jsonl` + снапшот `data/balances.json`
(при рестарте: снапшот → догон журналом; холодный старт сидирует пулы из
world.json). Эмиссия за регистрацию пишется системными записями
(`kind:"system"`, источник `system`). Файлы data/ — единое целое, удалять
вместе.

**Идемпотентность**: клиент даёт `id` (8–64 символа, UUID). Повтор с тем же
`id` → `{ dedup: true, tx: <исходная> }` без повторного проведения (в т.ч.
после рестарта сервера).

### `GET /api/balance` (Bearer)
→ `{ ok, player: number, pools: { patrol, alliance, clan, stations } }`

### `GET /api/ledger?limit=50` (Bearer)
→ `{ ok, entries: [...] }` — операции с участием игрока, новые первыми (≤ 200).

### `POST /api/tx` (Bearer)
Перевод со СВОЕГО счёта: `{ id, from: "player:<я>", to, amount, reason? }`.
`from` ≠ своему счёту → 403 `forbidden`; сумма не целое положительное ≤ 1e9 →
400 `bad_amount`; не хватает средств → 402 `insufficient_funds`
(игрок в минус не уходит; пулы могут в долг до −1e12).

### `POST /api/grant` (Bearer)
Награда из пула игроку: `{ id, from: "pool:<имя>", to: "player:<имя>", amount, reason? }`.
ВРЕМЕННО доверенный вызов с лимитом 500 000 ₡/час на игрока (429 `grant_cap`)
— до серверной валидации игровых событий.

→ оба: `{ ok, tx, dedup, balance }` (balance — счёт получателя).

Автотест: `node server/test-ledger.mjs` (13 проверок: эмиссия, гранты,
переводы, идемпотентность, лимиты, персист через рестарт).

## Дальше (не входит в 15a/15b)

- Интеграция шарда в игровой цикл (рендер чужих кораблей, позывные, отправка
  позиции из game.ts) — трек Б / следующий шаг.
- 15c: авторитет сервера по деньгам и смертям, PvP-розыск, торговля игрок↔игрок.
- Отзыв токенов, rate-limit, HTTPS-терминация — на стороне прокси при публикации.
