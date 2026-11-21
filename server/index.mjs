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
const WORLD_FILE = path.join(DATA_DIR, "world.json");
const saveFile = (username) => path.join(SAVES_DIR, encodeURIComponent(username) + ".json");

// ---------- auth ----------

const USERNAME_RE = /^[\p{L}\p{N}_-]{3,24}$/u;

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
}

function verifyPassword(password, salt, hash) {
  const candidate = Buffer.from(scryptSync(password, salt, 32).toString("hex"), "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function issueToken(username) {
  const token = randomBytes(24).toString("hex");
  await updateJson(TOKENS_FILE, {}, (tokens) => ({ ...tokens, [token]: username }));
  return token;
}

async function usernameTaken(username) {
  const users = await readJson(USERS_FILE, {});
  const lower = username.toLowerCase();
  return Object.keys(users).some((u) => u.toLowerCase() === lower);
}

async function findUser(username) {
  const users = await readJson(USERS_FILE, {});
  const lower = username.toLowerCase();
  const key = Object.keys(users).find((u) => u.toLowerCase() === lower);
  return key ? { username: key, ...users[key] } : null;
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

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const method = req.method;

  if (method === "OPTIONS") return send(res, 204, {});
  if (method === "GET" && url.pathname === "/api/health") {
    return ok(res, { uptime: Math.round((Date.now() - startedAt) / 1000) });
  }

  if (method === "POST" && url.pathname === "/api/register") {
    const { username, password } = await readBody(req);
    if (typeof username !== "string" || !USERNAME_RE.test(username)) return fail(res, 400, "bad_username");
    if (typeof password !== "string" || password.length < 6) return fail(res, 400, "bad_password");
    if (await usernameTaken(username)) return fail(res, 409, "username_taken");
    const { salt, hash } = hashPassword(password);
    await updateJson(USERS_FILE, {}, (users) => ({ ...users, [username]: { salt, hash, createdAt: Date.now() } }));
    // Этап 15: каждая регистрация увеличивает счётчик — база для «+1 000 000 ₡ в пулы».
    await updateJson(WORLD_FILE, { registered: 0 }, (w) => ({ ...w, registered: (w.registered || 0) + 1 }));
    return ok(res, { token: await issueToken(username), username });
  }

  if (method === "POST" && url.pathname === "/api/login") {
    const { username, password } = await readBody(req);
    const user = typeof username === "string" ? await findUser(username) : null;
    if (!user || typeof password !== "string" || !verifyPassword(password, user.salt, user.hash)) {
      return fail(res, 401, "bad_credentials");
    }
    return ok(res, { token: await issueToken(user.username), username: user.username });
  }

  if (url.pathname === "/api/me" && method === "GET") {
    const username = await authUser(req);
    if (!username) return fail(res, 401, "unauthorized");
    return ok(res, { username });
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

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    const code = err?.message === "body_too_large" ? 413 : err?.message === "bad_json" ? 400 : 500;
    fail(res, code, err?.message === "body_too_large" || err?.message === "bad_json" ? err.message : "internal_error");
  });
});

server.listen(PORT, () => {
  console.log(`[rangers-server] listening on http://localhost:${PORT} (data: ${DATA_DIR})`);
});
