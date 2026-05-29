// Global setup: clear the per-IP auth rate-limit counters that
// middleware/rate_limit.rs writes to Redis under the `rl:*` prefix.
// Without this, a suite that registers ~10 users in 30s tips over the
// 5-per-5-minutes window and every test that needs a fresh user fails
// with 429. We only clear `rl:*` so other Redis state (RBAC cache,
// /api/me cache) survives.
//
// Redis container is exposed on localhost:6379 by the dev compose.
// We talk raw RESP over a TCP socket rather than pulling in `ioredis`
// — it's 30 lines and means no extra dependency in the test harness.

import { createConnection } from "node:net";

const REDIS_HOST = process.env.E2E_REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT ?? 6379);
const RL_PATTERN = "rl:*";

// Minimal RESP encoder for an array command. Enough for SCAN + DEL.
function encodeCommand(parts: string[]): Buffer {
  let out = `*${parts.length}\r\n`;
  for (const p of parts) {
    out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
  }
  return Buffer.from(out, "utf8");
}

// Naive RESP reader — only handles what we need (simple string,
// integer, error, bulk string, array of bulk strings).
function parseReply(buf: Buffer): unknown {
  const text = buf.toString("utf8");
  const lines = text.split("\r\n");
  const idx = { cur: 0 };

  function read(): unknown {
    const line = lines[idx.cur++];
    if (line === undefined) return null;
    const type = line[0];
    const rest = line.slice(1);
    switch (type) {
      case "+":
        return rest;
      case "-":
        throw new Error(`Redis error: ${rest}`);
      case ":":
        return Number(rest);
      case "$": {
        if (rest === "-1") return null;
        const value = lines[idx.cur++];
        return value;
      }
      case "*": {
        const n = Number(rest);
        if (n < 0) return null;
        const arr: unknown[] = [];
        for (let i = 0; i < n; i++) arr.push(read());
        return arr;
      }
      default:
        return null;
    }
  }

  return read();
}

async function sendCommand(parts: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: REDIS_HOST, port: REDIS_PORT });
    const chunks: Buffer[] = [];
    let settled = false;
    sock.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    sock.on("data", (chunk) => chunks.push(chunk));
    sock.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(parseReply(Buffer.concat(chunks)));
      } catch (err) {
        reject(err);
      }
    });
    sock.write(encodeCommand(parts));
    // Some Redis builds keep the connection open after a single reply
    // until the client closes it — close from our side after a tick.
    setTimeout(() => sock.end(), 80);
  });
}

async function flushRateLimitKeys() {
  let cursor = "0";
  let total = 0;
  do {
    const reply = (await sendCommand(["SCAN", cursor, "MATCH", RL_PATTERN, "COUNT", "500"])) as
      | [string, string[]]
      | null;
    if (!reply) break;
    const [next, keys] = reply;
    cursor = next;
    if (keys.length > 0) {
      await sendCommand(["DEL", ...keys]);
      total += keys.length;
    }
  } while (cursor !== "0");
  return total;
}

export default async function globalSetup() {
  try {
    const cleared = await flushRateLimitKeys();
    // eslint-disable-next-line no-console
    console.log(`[e2e setup] flushed ${cleared} rate-limit key(s)`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[e2e setup] could not flush rate-limit keys — proceeding anyway (${(err as Error).message})`,
    );
  }
}
