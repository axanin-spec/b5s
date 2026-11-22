/**
 * test-mail.mjs — автотест регистрации через почту (Этап 16c).
 * Сервер поднимается с MAIL_TRANSPORT=log: коды падают в DATA_DIR/outbox.log.
 * Сценарии: обязательный email, регистрация без токена до verify, блокировка
 * login до подтверждения, код (верный/неверный), уникальность email, сброс
 * пароля (без enumeration), отзыв старых токенов при сбросе.
 * Запуск: node server/test-mail.mjs  (exit 0 = всё зелёное)
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const check = (name, cond) => {
  results[name] = !!cond;
  console.log(`${cond ? "✓" : "✗"} ${name}`);
};

async function api(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ...(await r.json()) };
}

const dataDir = await mkdtemp(path.join(tmpdir(), "rangers-mail-"));
const OUTBOX = path.join(dataDir, "outbox.log");

/** Последний код из outbox для пары (email, kind). */
async function lastCode(email, kind) {
  const lines = (await readFile(OUTBOX, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const hit = [...lines].reverse().find((e) => e.to === email && e.kind === kind);
  return hit?.code || null;
}

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MAIL_TRANSPORT: "log" },
  stdio: ["ignore", "pipe", "inherit"],
});
child.stdout.on("data", () => {});

let failed = false;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await api("GET", "/api/health")).ok === true;
    } catch {
      await sleep(100);
    }
  }
  check("server up", up);

  // регистрация: без email — отказ; с email — needVerification без токена
  const noMail = await api("POST", "/api/register", { username: "Delta", password: "secret123" });
  check("без email → bad_email", noMail.error === "bad_email");
  const reg = await api("POST", "/api/register", { username: "Delta", password: "secret123", email: "delta@b5s.ru" });
  check("регистрация → needVerification, токена нет", reg.needVerification === true && !reg.token);

  // пулы НЕ подпитаны до подтверждения
  const w0 = (await api("GET", "/api/world")).world;
  check("пулы не подпитываются до verify (registered=0)", w0.registered === 0);

  // login до verify запрещён
  const early = await api("POST", "/api/login", { username: "Delta", password: "secret123" });
  check("login до verify → email_not_verified", early.error === "email_not_verified");

  // неверный код → bad_code; верный → токен + пулы
  const bad = await api("POST", "/api/verify", { username: "Delta", code: "000000" });
  check("неверный код → bad_code", bad.error === "bad_code");
  const code = await lastCode("delta@b5s.ru", "verify");
  check("код verify найден в outbox", typeof code === "string" && code.length === 6);
  const ver = await api("POST", "/api/verify", { username: "Delta", code });
  check("verify → токен", typeof ver.token === "string");
  const w1 = (await api("GET", "/api/world")).world;
  check("после verify пулы подпитаны (registered=1)", w1.registered === 1);
  const me = await api("GET", "/api/me", undefined, ver.token);
  check("токен работает (/api/me)", me.username === "Delta");

  // повторная регистрация на тот же email
  const dup = await api("POST", "/api/register", { username: "Echo", password: "secret123", email: "DELTA@b5s.ru" });
  check("email занят (без учёта регистра) → email_taken", dup.error === "email_taken");

  // resend: новый код приходит
  await api("POST", "/api/verify-resend", { username: "Delta" });
  await sleep(100);
  check("verify-resend шлёт новый код (Delta уже подтверждён — письма нет)",
    (await lastCode("delta@b5s.ru", "verify")) === code);

  // сброс пароля: чужой email — молча ok (без enumeration); свой — код в outbox
  const anon = await api("POST", "/api/reset-request", { email: "nobody@b5s.ru" });
  check("reset-request чужого email → ok (нет enumeration)", anon.ok === true);
  await api("POST", "/api/reset-request", { email: "delta@b5s.ru" });
  await sleep(100);
  const rcode = await lastCode("delta@b5s.ru", "reset");
  check("reset-request своего email → код в outbox", typeof rcode === "string");

  // неверный код сброса; верный — меняет пароль и отзывает старый токен
  const rbad = await api("POST", "/api/reset-confirm", { email: "delta@b5s.ru", code: "000000", password: "newsecret1" });
  check("reset-confirm неверный код → bad_code", rbad.error === "bad_code");
  const rok = await api("POST", "/api/reset-confirm", { email: "delta@b5s.ru", code: rcode, password: "newsecret1" });
  check("reset-confirm → новый токен", typeof rok.token === "string");
  const oldMe = await api("GET", "/api/me", undefined, ver.token);
  check("старый токен отозван после сброса", oldMe.error === "unauthorized");
  const oldPass = await api("POST", "/api/login", { username: "Delta", password: "secret123" });
  const newPass = await api("POST", "/api/login", { username: "Delta", password: "newsecret1" });
  check("старый пароль не работает, новый — работает", oldPass.error === "bad_credentials" && !!newPass.token);
} catch (e) {
  failed = true;
  console.error("MAIL TEST ERROR:", e.message);
} finally {
  child.kill();
  await sleep(200);
  await rm(dataDir, { recursive: true, force: true });
}

const ok = !failed && Object.values(results).every(Boolean);
console.log(`\nMAIL ${ok ? "OK" : "FAIL"}: ${Object.values(results).filter(Boolean).length}/${Object.keys(results).length} проверок`);
process.exit(ok ? 0 : 1);
