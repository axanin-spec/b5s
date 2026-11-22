/**
 * test-ws.mjs — протокольные проверки WebSocket-слоя (аудит безопасности).
 * Сырой TCP-клиент: рукопожатие вручную, кадры собираются байтами.
 * Сценарии: немаскированный кадр → закрытие; фрагментация > 256 КБ без FIN → закрытие;
 * валидный маскированный кадр работает.
 * Запуск: node server/test-ws.mjs  (exit 0 = всё зелёное)
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const check = (name, cond) => {
  results[name] = !!cond;
  console.log(`${cond ? "✓" : "✗"} ${name}`);
};

/** Рукопожатие вручную; резолвит сокет после 101. */
function handshake(token) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes("\r\n\r\n")) {
        const head = buf.toString("utf8");
        if (!head.startsWith("HTTP/1.1 101")) return reject(new Error("handshake refused: " + head.split("\r\n")[0]));
        sock.removeAllListeners("data");
        resolve(sock);
      }
    });
    sock.on("error", reject);
    sock.write(
      `GET /api/ws?token=${encodeURIComponent(token)} HTTP/1.1\r\n` +
        `Host: localhost:${PORT}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
  });
}

/** Кадр клиент→сервер. masked=false — намеренно невалидный кадр. */
function buildFrame({ fin = true, opcode = 0x1, payload, masked = true }) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | len]);
  } else {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = (masked ? 0x80 : 0) | 126;
    head.writeUInt16BE(len, 2);
  }
  if (!masked) return Buffer.concat([head, payload]);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/** Ждёт закрытия сокета сервером (или таймаут → false). */
function waitClosed(sock, ms = 2000) {
  return new Promise((resolve) => {
    sock.on("close", () => resolve(true));
    sock.on("error", () => {});
    setTimeout(() => resolve(false), ms);
  });
}

const dataDir = await mkdtemp(path.join(tmpdir(), "rangers-ws-"));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "inherit"],
});
child.stdout.on("data", () => {});

let failed = false;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/api/health`).then((r) => r.json())).ok === true;
    } catch {
      await sleep(100);
    }
  }
  check("server up", up);

  const reg = await fetch(`${BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "WsProbe", password: "secret123" }),
  }).then((r) => r.json());
  const token = reg.token;

  // 1. валидный маскированный кадр → соединение живо (welcome приходит на WS)
  {
    const sock = await handshake(token);
    const closed = waitClosed(sock, 300);
    sock.write(buildFrame({ payload: Buffer.from(JSON.stringify({ t: "state", x: 1, y: 1, a: 0 })) }));
    check("валидный маскированный кадр не рвёт соединение", !(await closed));
    sock.destroy();
  }

  // 2. немаскированный кадр → сервер обязан закрыть (RFC 6455 §5.1)
  {
    const sock = await handshake(token);
    const closed = waitClosed(sock);
    sock.write(buildFrame({ masked: false, payload: Buffer.from("{}") }));
    check("немаскированный кадр → соединение закрыто", await closed);
    sock.destroy();
  }

  // 3. фрагменты без FIN суммарно > 256 КБ → закрытие (анти-DoS)
  {
    const sock = await handshake(token);
    const closed = waitClosed(sock);
    const chunk = Buffer.alloc(60 * 1024, 0x61); // 60 КБ < MAX_PAYLOAD на кадр
    sock.write(buildFrame({ fin: false, opcode: 0x1, payload: chunk }));
    for (let i = 0; i < 4; i++) sock.write(buildFrame({ fin: false, opcode: 0x0, payload: chunk })); // 300 КБ суммарно
    check("фрагментация > 256 КБ без FIN → соединение закрыто", await closed);
    sock.destroy();
  }
} catch (e) {
  failed = true;
  console.error("WS TEST ERROR:", e.message);
} finally {
  child.kill();
  await sleep(200);
  await rm(dataDir, { recursive: true, force: true });
}

const ok = !failed && Object.values(results).every(Boolean);
console.log(`\nWS ${ok ? "OK" : "FAIL"}: ${Object.values(results).filter(Boolean).length}/${Object.keys(results).length} проверок`);
process.exit(ok ? 0 : 1);
