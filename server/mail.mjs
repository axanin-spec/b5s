/**
 * mail.mjs — отправка кодов подтверждения/сброса (Этап 16c).
 * Zero-dep SMTP-клиент для postfix на том же хосте (релей с localhost без auth/TLS).
 * Транспорты (env MAIL_TRANSPORT):
 *   smtp — через SMTP_HOST/SMTP_PORT (дефолт 127.0.0.1:25), MAIL_FROM (дефолт noreply@b5s.ru);
 *   log  — пишет коды JSON-строками в DATA_DIR/outbox.log (локальная разработка и автотесты);
 *   off  — почта выключена: регистрация legacy (без email, токен сразу).
 */

import net from "node:net";
import { appendFile } from "node:fs/promises";
import path from "node:path";

const SMTP_HOST = process.env.SMTP_HOST || "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 25;
const MAIL_FROM = process.env.MAIL_FROM || "noreply@b5s.ru";
const TRANSPORT = (process.env.MAIL_TRANSPORT || "off").toLowerCase();

export function mailEnabled() {
  return TRANSPORT === "smtp" || TRANSPORT === "log";
}

/** Текст письма с кодом — двуязычный (RU + EN одним письмом). */
function codeEmail(kind, code, username) {
  const subj =
    kind === "reset"
      ? "B5S: сброс пароля / password reset"
      : "B5S: код подтверждения / verification code";
  const ruText =
    kind === "reset"
      ? `Пилот ${username}, код для сброса пароля: ${code}\nКод действует 15 минут. Если это были не вы — проигнорируйте письмо.`
      : `Пилот ${username}, добро пожаловать в B5S — Beyond the 5th Sun!\nКод подтверждения: ${code}\nКод действует 15 минут.`;
  const enText =
    kind === "reset"
      ? `Pilot ${username}, your password reset code: ${code}\nValid for 15 minutes. If it wasn't you — ignore this email.`
      : `Pilot ${username}, welcome to B5S — Beyond the 5th Sun!\nYour verification code: ${code}\nValid for 15 minutes.`;
  return { subject: subj, text: `${ruText}\n\n---\n\n${enText}\n\nhttps://b5s.ru` };
}

/** Одна SMTP-сессия: greeting → HELO → MAIL → RCPT → DATA → QUIT. */
function smtpSend(to, subject, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SMTP_PORT, SMTP_HOST);
    let buf = "";
    let step = 0;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("smtp_timeout"));
    }, 10_000);
    const done = (err) => {
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve();
    };
    const headers =
      `From: B5S <${MAIL_FROM}>\r\nTo: <${to}>\r\nSubject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=\r\n` +
      "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n";
    const commands = [
      `HELO ${SMTP_HOST}\r\n`,
      `MAIL FROM:<${MAIL_FROM}>\r\n`,
      `RCPT TO:<${to}>\r\n`,
      "DATA\r\n",
      headers + text.replaceAll("\n", "\r\n") + "\r\n.\r\n",
      "QUIT\r\n",
    ];
    sock.on("error", () => done(new Error("smtp_connect")));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // ответ завершён, когда последняя строка — "<код><пробел>..." (мультилайн — "<код>-")
      const last = buf.trimEnd().split("\r\n").pop() || "";
      if (!/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      buf = "";
      if (code >= 400) return done(new Error("smtp_rejected_" + code));
      if (step === 0 && code !== 220) return done(new Error("smtp_greeting"));
      if (step >= commands.length) return done(null); // ответ на QUIT
      sock.write(commands[step++]);
    });
  });
}

/**
 * Отправляет код подтверждения/сброса. kind: "verify" | "reset".
 * Логирует факт отправки (без кода в smtp-режиме; с кодом — только в log-транспорте).
 * Бросает Error("smtp_*") при сбое SMTP; в режиме off — no-op.
 */
export async function sendCode(dataDir, { to, code, kind, username }) {
  if (TRANSPORT === "log") {
    const line = JSON.stringify({ ts: Date.now(), to, kind, code, username }) + "\n";
    await appendFile(path.join(dataDir, "outbox.log"), line, "utf8");
    console.log(`[mail:log] ${kind} code for ${to}`);
    return;
  }
  if (TRANSPORT === "off") return;
  const { subject, text } = codeEmail(kind, code, username);
  await smtpSend(to, subject, text);
  console.log(`[mail] ${kind} code sent to ${to}`);
}
