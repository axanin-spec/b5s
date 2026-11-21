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
  world.json            { registered: number }
```

Запись атомарна (tmp + rename), операции на файл сериализованы очередью.

## Дальше (не входит в 15a)

- 15b: world-state — общий шард, снапшот мира, присутствие игроков, +1M ₡ в пулы за регистрацию.
- Отзыв токенов, rate-limit, HTTPS-терминация — на стороне прокси при публикации.
