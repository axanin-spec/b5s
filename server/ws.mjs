/**
 * ws.mjs — минимальный WebSocket-сервер (RFC 6455) без зависимостей (Этап 15b).
 * Только текстовые кадры ≤ 64 КБ; фрагментация собирается, ping/pong и close — по стандарту.
 * Клиент для тестов — нативный global WebSocket из Node >= 22.
 */

import { createHash, randomUUID } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 64 * 1024;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** Кодирует один кадр сервер→клиент (без маски). */
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export class WsConnection {
  constructor(socket) {
    this.id = randomUUID();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = []; // накопленные кадры фрагментированного сообщения
    this.fragmentOpcode = 0;
    this.alive = true;
    this.lastPong = Date.now();
    this.onMessage = null; // (text: string) => void
    this.onClose = null; // () => void

    socket.on("data", (chunk) => this.#feed(chunk));
    socket.on("error", () => this.#teardown());
    socket.on("close", () => this.#teardown());

    this.pingTimer = setInterval(() => {
      if (!this.alive) return;
      if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) return this.#teardown();
      this.#sendRaw(encodeFrame(0x9, Buffer.alloc(0)));
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  send(text) {
    if (!this.alive) return;
    this.#sendRaw(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  close() {
    if (!this.alive) return;
    this.#sendRaw(encodeFrame(0x8, Buffer.alloc(0)));
    this.#teardown();
  }

  #sendRaw(buf) {
    try {
      this.socket.write(buf);
    } catch {
      this.#teardown();
    }
  }

  #teardown() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this.pingTimer);
    try {
      this.socket.destroy();
    } catch {}
    this.onClose?.();
  }

  #feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.#parseFrame();
      if (!frame) break;
      this.#handle(frame);
      if (!this.alive) break;
    }
  }

  #parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) return this.#protocolError();
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_PAYLOAD) return this.#protocolError();
    const maskLen = masked ? 4 : 0;
    if (b.length < offset + maskLen + len) return null;
    let payload = b.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = b.subarray(offset, offset + 4);
      const un = Buffer.alloc(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
      payload = un;
    }
    this.buffer = b.subarray(offset + maskLen + len);
    return { fin, opcode, payload };
  }

  #protocolError() {
    this.#teardown();
    return null;
  }

  #handle({ fin, opcode, payload }) {
    if (opcode === 0x8) return this.close(); // close
    if (opcode === 0x9) return this.#sendRaw(encodeFrame(0xA, payload)); // ping → pong
    if (opcode === 0xA) {
      this.lastPong = Date.now();
      return;
    }
    if (opcode === 0x1 || opcode === 0x0) {
      // текст / продолжение: собираем фрагменты до FIN
      if (opcode === 0x1 && this.fragments.length > 0) return this.#protocolError();
      if (opcode === 0x0 && this.fragments.length === 0) return this.#protocolError();
      this.fragments.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this.fragments);
      this.fragments = [];
      if (full.length > MAX_PAYLOAD) return this.#protocolError();
      try {
        this.onMessage?.(full.toString("utf8"));
      } catch {
        // обработчик не должен ронять соединение
      }
    }
    // бинарные кадры (0x2) игнорируем — протокол текстовый
  }
}

/**
 * Обрабатывает HTTP Upgrade. auth(req) — синхронная или async; должна вернуть
 * контекст (например username) или null — тогда сокет закрывается 401 без
 * WS-рукопожатия. onConnection(conn, authCtx) вызывается после рукопожатия.
 */
export function handleUpgrade(req, socket, auth, onConnection) {
  const key = req.headers["sec-websocket-key"];
  Promise.resolve(key ? auth(req) : null)
    .then((ctx) => {
      if (!ctx) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
      socket.setNoDelay(true);
      onConnection(new WsConnection(socket), ctx);
    })
    .catch(() => {
      socket.destroy();
    });
}
