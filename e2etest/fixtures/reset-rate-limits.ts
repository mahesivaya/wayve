// Re-uses the raw RESP flush logic from global-setup but exposed as a
// callable so individual specs can clear the limiter between scenarios
// without restarting the whole worker. A no-op if Redis is unreachable.

import { createConnection } from "node:net";

const REDIS_HOST = process.env.E2E_REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT ?? 6379);

function encodeCommand(parts: string[]): Buffer {
  let out = `*${parts.length}\r\n`;
  for (const p of parts) {
    out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
  }
  return Buffer.from(out, "utf8");
}

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
        return lines[idx.cur++];
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
    setTimeout(() => sock.end(), 80);
  });
}

export async function resetRateLimits(): Promise<void> {
  try {
    let cursor = "0";
    do {
      const reply = (await sendCommand(["SCAN", cursor, "MATCH", "rl:*", "COUNT", "500"])) as
        | [string, string[]]
        | null;
      if (!reply) break;
      const [next, keys] = reply;
      cursor = next;
      if (keys.length > 0) {
        await sendCommand(["DEL", ...keys]);
      }
    } while (cursor !== "0");
  } catch {
    // Best-effort: if Redis is unreachable the suite has bigger problems
    // than rate limits anyway. Don't fail the test for a flush miss.
  }
}
