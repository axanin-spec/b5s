/**
 * index.mjs — MVP backend «Космический Рейнджер» (Этап 15a).
 * Zero-dep Node >= 18: аккаунты (scrypt + bearer token) и облачный сейв.
 * Контракт: см. CONTRACT.md рядом с этим файлом.
 */

import { createServer } from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleUpgrade } from "./ws.mjs";
import { createWorld, POOL_TOPUP_PER_PLAYER } from "./world.mjs";
import { createLedger } from "./ledger.mjs";
import { mailEnabled, sendCode } from "./mail.mjs";

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const SAVES_DIR = path.join(DATA_DIR, "saves");
const MAX_BODY = 5 * 1024 * 1024;
/** Принимаемые версии сейва (полная валидация — на клиенте, src/game/save.ts). */
const SAVE_VERSIONS = new Set([8, 9]);

// ---------- файловое хранилище с сериализацией записи ----------

const queues = new Map(); // file -> Promise chain

function withFileQueue(file, fn) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(file, next.catch(() => {}));
  return next;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await withFileQueue(file, async () => {
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify(value), "utf8");
    await rename(tmp, file);
  });
}

async function updateJson(file, fallback, mutator) {
  return withFileQueue(file, async () => {
    const cur = await readJson(file, fallback);
    const next = await mutator(cur);
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify(next), "utf8");
    await rename(tmp, file);
    return next;
  });
}

const USERS_FILE = path.join(DATA_DIR, "users.json");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");
const saveFile = (username) => path.join(SAVES_DIR, encodeURIComponent(username) + ".json");

// ---------- денежный авторитет (Этап 15c); journal.jsonl + balances.json ----------

const ledger = createLedger(DATA_DIR);

// ---------- общий шард (Этап 15b/15c); владеет world.json, торговля идёт через ledger ----------

const world = createWorld(DATA_DIR, ledger);

// ---------- auth ----------

const USERNAME_RE = /^[\p{L}\p{N}_-]{3,24}$/u;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,60}\.[^\s@]{2,24}$/;

/** Код подтверждения: 6 цифр, 15 минут, ≤5 попыток ввода. */
const CODE_TTL_MS = 15 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const newCode = () => String(Math.floor(100000 + Math.random() * 900000));

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
}

function verifyPassword(password, salt, hash) {
  const candidate = Buffer.from(scryptSync(password, salt, 32).toString("hex"), "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Токенов на пользователя не больше TOKENS_PER_USER — файл не разрастается от перелогинов. */
const TOKENS_PER_USER = 5;

async function issueToken(username) {
  const token = randomBytes(24).toString("hex");
  await updateJson(TOKENS_FILE, {}, (tokens) => {
    const kept = Object.entries(tokens).filter(([, u]) => u !== username);
    const mine = Object.entries(tokens).filter(([, u]) => u === username).slice(-(TOKENS_PER_USER - 1));
    return { ...Object.fromEntries(kept), ...Object.fromEntries(mine), [token]: username };
  });
  return token;
}

async function findUser(username) {
  const users = await readJson(USERS_FILE, {});
  const lower = username.toLowerCase();
  const key = Object.keys(users).find((u) => u.toLowerCase() === lower);
  return key ? { username: key, ...users[key] } : null;
}

async function findUserByEmail(email) {
  const users = await readJson(USERS_FILE, {});
  const lower = email.toLowerCase();
  const key = Object.keys(users).find((u) => (users[u].email || "").toLowerCase() === lower);
  return key ? { username: key, ...users[key] } : null;
}

/** Проверка кода из pending: "ok" | "bad_code" | "code_expired" | "too_many_attempts". */
function checkCode(user, kind, code) {
  const p = user.pending;
  if (!p || p.kind !== kind || typeof p.code !== "string") return "bad_code";
  if (p.exp < Date.now()) return "code_expired";
  if ((p.attempts || 0) >= CODE_MAX_ATTEMPTS) return "too_many_attempts";
  return p.code === code ? "ok" : "bad_code";
}

async function authUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const tokens = await readJson(TOKENS_FILE, {});
  return tokens[token] || null;
}

// ---------- http helpers ----------

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(payload);
}

const ok = (res, extra = {}) => send(res, 200, { ok: true, ...extra });
const fail = (res, status, error) => send(res, status, { ok: false, error });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

/** Облегчённая проверка формы сейва; полная — validateSave на клиенте. */
function isPlausibleSave(save) {
  if (typeof save !== "object" || save === null) return false;
  if (!SAVE_VERSIONS.has(save.v)) return false;
  if (typeof save.player !== "object" || save.player === null) return false;
  return typeof save.player.credits === "number" && Number.isFinite(save.player.credits);
}

// ---------- router ----------

const startedAt = Date.now();

/** Rate-limit на auth (scrypt дорогой — флуд login/register вешает CPU):
 *  не более AUTH_RATE_MAX попыток в минуту с одного IP. */
const AUTH_RATE_MAX = 20;
const AUTH_RATE_WINDOW_MS = 60_000;
const authAttempts = new Map(); // ip -> { count, resetAt }

function authRateLimited(req) {
  const ip = req.socket.remoteAddress || "?";
  const now = Date.now();
  let rec = authAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    rec = { count: 0, resetAt: now + AUTH_RATE_WINDOW_MS };
    authAttempts.set(ip, rec);
  }
  rec.count++;
  // уборка, чтобы карта не росла от перебора адресов
  if (authAttempts.size > 10_000) {
    for (const [k, v] of authAttempts) if (v.resetAt < now) authAttempts.delete(k);
  }
  return rec.count > AUTH_RATE_MAX;
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const method = req.method;

  if (method === "OPTIONS") return send(res, 204, {});
  if (method === "GET" && url.pathname === "/api/health") {
    return ok(res, { uptime: Math.round((Date.now() - startedAt) / 1000) });
  }

  const AUTH_PATHS = new Set([
    "/api/register",
    "/api/login",
    "/api/verify",
    "/api/verify-resend",
    "/api/reset-request",
    "/api/reset-confirm",
  ]);
  if (method === "POST" && AUTH_PATHS.has(url.pathname) && authRateLimited(req)) {
    return fail(res, 429, "rate_limited");
  }

  if (method === "POST" && url.pathname === "/api/register") {
    const { username, password, email } = await readBody(req);
    if (typeof username !== "string" || !USERNAME_RE.test(username)) return fail(res, 400, "bad_username");
    if (typeof password !== "string" || password.length < 6) return fail(res, 400, "bad_password");
    // 16c: при включённой почте email обязателен, регистрация завершается кодом с почты
    const mail = mailEnabled();
    if (mail && (typeof email !== "string" || !EMAIL_RE.test(email))) return fail(res, 400, "bad_email");
    const code = newCode();
    const { salt, hash } = hashPassword(password);
    // уникальность (имя + email) проверяется ВНУТРИ сериализованной очереди файла — гонки нет
    let created = false;
    let emailTaken = false;
    await updateJson(USERS_FILE, {}, (users) => {
      const lower = username.toLowerCase();
      if (Object.keys(users).some((u) => u.toLowerCase() === lower)) return users;
      if (mail && Object.values(users).some((u) => (u.email || "").toLowerCase() === email.toLowerCase())) {
        emailTaken = true;
        return users;
      }
      created = true;
      const record = { salt, hash, createdAt: Date.now() };
      if (mail) {
        record.email = email;
        record.emailVerified = false;
        record.pending = { kind: "verify", code, exp: Date.now() + CODE_TTL_MS, attempts: 0 };
      } else if (typeof email === "string" && EMAIL_RE.test(email)) {
        record.email = email;
        record.emailVerified = true; // почта выключена — подтверждать нечем
      }
      return { ...users, [username]: record };
    });
    if (!created) return fail(res, emailTaken ? 409 : 409, emailTaken ? "email_taken" : "username_taken");
    if (mail) {
      try {
        await sendCode(DATA_DIR, { to: email, code, kind: "verify", username });
      } catch (e) {
        console.error("[mail] send failed:", e.message);
        return fail(res, 502, "mail_failed");
      }
      // пулы и токен — только ПОСЛЕ подтверждения почты (/api/verify): иначе
      // фейковые регистрации фармили бы +1M ₡ в общие пулы
      return ok(res, { needVerification: true, username });
    }
    // legacy-путь (MAIL_TRANSPORT=off): токен сразу, пулы при регистрации
    await world.onRegistration();
    await ledger.systemTopup(POOL_TOPUP_PER_PLAYER, `register:${username}`);
    return ok(res, { token: await issueToken(username), username });
  }

  // 16c: подтверждение почты кодом → аккаунт активируется, пулы подпитываются
  if (method === "POST" && url.pathname === "/api/verify") {
    const { username, code } = await readBody(req);
    const user = typeof username === "string" ? await findUser(username) : null;
    if (!user || typeof code !== "string") return fail(res, 400, "bad_code");
    if (user.emailVerified) return ok(res, { token: await issueToken(user.username), username: user.username });
    const verdict = checkCode(user, "verify", code);
    if (verdict !== "ok") {
      if (verdict === "bad_code") {
        await updateJson(USERS_FILE, {}, (users) => {
          const u = users[user.username];
          if (u?.pending) u.pending.attempts = (u.pending.attempts || 0) + 1;
          return users;
        });
      }
      return fail(res, 400, verdict);
    }
    await updateJson(USERS_FILE, {}, (users) => {
      const u = users[user.username];
      if (u) {
        u.emailVerified = true;
        delete u.pending;
      }
      return users;
    });
    // Этап 15: регистрация подпитывает общие пулы (+1 000 000 ₡ пропорционально) — общий шард.
    await world.onRegistration();
    // 15c: та же эмиссия — в денежный журнал (ledger — авторитет по пулам).
    await ledger.systemTopup(POOL_TOPUP_PER_PLAYER, `register:${user.username}`);
    return ok(res, { token: await issueToken(user.username), username: user.username });
  }

  // 16c: повторная отправка кода подтверждения (своего, нечужого — ответ всегда ok)
  if (method === "POST" && url.pathname === "/api/verify-resend") {
    const { username } = await readBody(req);
    const user = typeof username === "string" ? await findUser(username) : null;
    if (user && !user.emailVerified && user.email && mailEnabled()) {
      const code = newCode();
      await updateJson(USERS_FILE, {}, (users) => {
        const u = users[user.username];
        if (u) u.pending = { kind: "verify", code, exp: Date.now() + CODE_TTL_MS, attempts: 0 };
        return users;
      });
      sendCode(DATA_DIR, { to: user.email, code, kind: "verify", username: user.username }).catch((e) =>
        console.error("[mail] resend failed:", e.message),
      );
    }
    return ok(res, {});
  }

  // 16c: сброс пароля по почте. Ответ всегда ok — не раскрываем наличие email.
  if (method === "POST" && url.pathname === "/api/reset-request") {
    const { email } = await readBody(req);
    if (typeof email !== "string" || !EMAIL_RE.test(email)) return fail(res, 400, "bad_email");
    const user = await findUserByEmail(email);
    if (user && mailEnabled()) {
      const code = newCode();
      await updateJson(USERS_FILE, {}, (users) => {
        const u = users[user.username];
        if (u) u.pending = { kind: "reset", code, exp: Date.now() + CODE_TTL_MS, attempts: 0 };
        return users;
      });
      sendCode(DATA_DIR, { to: user.email, code, kind: "reset", username: user.username }).catch((e) =>
        console.error("[mail] reset send failed:", e.message),
      );
    }
    return ok(res, {});
  }

  if (method === "POST" && url.pathname === "/api/reset-confirm") {
    const { email, code, password } = await readBody(req);
    if (typeof email !== "string" || typeof code !== "string") return fail(res, 400, "bad_code");
    if (typeof password !== "string" || password.length < 6) return fail(res, 400, "bad_password");
    const user = await findUserByEmail(email);
    if (!user) return fail(res, 400, "bad_code"); // без перебора: ответ одинаков
    const verdict = checkCode(user, "reset", code);
    if (verdict !== "ok") {
      if (verdict === "bad_code") {
        await updateJson(USERS_FILE, {}, (users) => {
          const u = users[user.username];
          if (u?.pending) u.pending.attempts = (u.pending.attempts || 0) + 1;
          return users;
        });
      }
      return fail(res, 400, verdict);
    }
    const { salt, hash } = hashPassword(password);
    await updateJson(USERS_FILE, {}, (users) => {
      const u = users[user.username];
      if (u) {
        u.salt = salt;
        u.hash = hash;
        delete u.pending;
      }
      return users;
    });
    // все старые токены отзываем — вдруг пароль увели
    await updateJson(TOKENS_FILE, {}, (tokens) =>
      Object.fromEntries(Object.entries(tokens).filter(([, u]) => u !== user.username)),
    );
    return ok(res, { token: await issueToken(user.username), username: user.username });
  }

  if (method === "POST" && url.pathname === "/api/login") {
    const { username, password } = await readBody(req);
    const user = typeof username === "string" ? await findUser(username) : null;
    if (!user || typeof password !== "string" || !verifyPassword(password, user.salt, user.hash)) {
      return fail(res, 401, "bad_credentials");
    }
    // 16c: почтовый аккаунт без подтверждения не пускаем (legacy-аккаунты без email — пускаем)
    if (mailEnabled() && user.email && !user.emailVerified) return fail(res, 403, "email_not_verified");
    return ok(res, { token: await issueToken(user.username), username: user.username });
  }

  if (url.pathname === "/api/me" && method === "GET") {
    const username = await authUser(req);
    if (!username) return fail(res, 401, "unauthorized");
    return ok(res, { username });
  }

  if (method === "GET" && url.pathname === "/api/world") {
    return ok(res, { world: world.publicWorld() });
  }

  // ---------- денежный авторитет (Этап 15c) ----------

  if (url.pathname === "/api/balance" && method === "GET") {
    const username = await authUser(req);
    if (!username) return fail(res, 401, "unauthorized");
    return ok(res, ledger.publicBalances(username));
  }

  if (url.pathname === "/api/ledger" && method === "GET") {
    const username = await authUser(req);
    if (!username) return fail(res, 401, "unauthorized");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    return ok(res, { entries: ledger.historyFor(username, limit) });
  }

  if ((url.pathname === "/api/tx" || url.pathname === "/api/grant") && method === "POST") {
    const username = await authUser(req);
    if (!username) return fail(res, 401, "unauthorized");
    const kind = url.pathname === "/api/tx" ? "tx" : "grant";
    try {
      const body = await readBody(req);
      const { entry, dedup } = await ledger.transact(username, kind, body || {});
      return ok(res, { tx: entry, dedup, balance: ledger.balanceOf(entry.to) });
    } catch (e) {
      if (e && typeof e.code === "string") {
        const status = { forbidden: 403, insufficient_funds: 402, grant_cap: 429 }[e.code] || 400;
        return fail(res, status, e.code);
      }
      throw e;
    }
  }

  if (url.pathname === "/api/save") {
    const username = await authUser(req);
    if (!username) return fail(res, 401, "unauthorized");
    if (method === "GET") {
      const record = await readJson(saveFile(username), null);
      return ok(res, { save: record?.save ?? null, updatedAt: record?.updatedAt ?? null });
    }
    if (method === "PUT") {
      const { save } = await readBody(req);
      if (!isPlausibleSave(save)) return fail(res, 400, "bad_save");
      const updatedAt = Date.now();
      await writeJson(saveFile(username), { save, updatedAt });
      return ok(res, { updatedAt });
    }
  }

  return fail(res, 404, "not_found");
}

// ---------- boot ----------

await mkdir(SAVES_DIR, { recursive: true });
await world.load();
await ledger.load(world.publicWorld().pools); // холодный старт: пулы из world.json

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error("[rangers-server] route error:", err);
    const code = err?.message === "body_too_large" ? 413 : err?.message === "bad_json" ? 400 : 500;
    fail(res, code, err?.message === "body_too_large" || err?.message === "bad_json" ? err.message : "internal_error");
  });
});

// WebSocket-вход в общий шард: GET /api/ws?token=<bearer> (Этап 15b)
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/api/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  handleUpgrade(
    req,
    socket,
    async () => {
      const token = url.searchParams.get("token") || "";
      if (!token) return null;
      const tokens = await readJson(TOKENS_FILE, {});
      return tokens[token] || null; // username как контекст соединения
    },
    (conn, username) => world.handleConnection(conn, username),
  );
});

server.listen(PORT, () => {
  console.log(`[rangers-server] listening on http://localhost:${PORT} (data: ${DATA_DIR})`);
  if (!mailEnabled()) {
    console.warn("[rangers-server] ВНИМАНИЕ: MAIL_TRANSPORT=off — регистрация без подтверждения почты (legacy-режим)");
  }
});
