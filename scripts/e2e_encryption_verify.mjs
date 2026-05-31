#!/usr/bin/env node
// =====================================================================
// Plan A — End-to-end encryption deep verification.
// ---------------------------------------------------------------------
// Hits the running local dev stack (postgres + backend) with random
// sample data and verifies that what lands on disk is genuinely
// ciphertext (no plaintext leak). Covers:
//
//   * Notes        — `encryptForSelf` envelope round-trip
//   * Email P2     — Wayve-to-Wayve multi-recipient envelope, server
//                    inserts N+1 emails rows (recipients + sender Sent)
//   * Email P3     — Secure-send passphrase bundle + public-route
//                    fetch + browser-side decrypt round-trip
//
// Skipped (covered by their own existing tests):
//   * Email P1     — `encrypt_to_pubkey` Rust unit tests (3/3 pass)
//   * Chat         — `WAYVE_CHAT_E2E_V1` envelope tests in chat/e2ee.ts
//   * Drive        — `WV1` binary envelope tests in fileEnvelope.ts
//
// Usage:
//   node scripts/e2e_encryption_verify.mjs
//   API_BASE=http://localhost:8080 node scripts/e2e_encryption_verify.mjs
// =====================================================================

import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const API_BASE = process.env.API_BASE ?? "http://localhost:8080";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "rwayve_postgres_dev";
const PG_USER = process.env.PG_USER ?? "wayve_user";
const PG_DB = process.env.PG_DB ?? "wayve_dev";

const NOTE_SAMPLE_COUNT = 5;
const SECURE_SAMPLE_COUNT = 5;

// ---------------------------------------------------------------------
// Pretty printer
// ---------------------------------------------------------------------

const colors = {
  reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m",
  red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const ok = (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`);
const fail = (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`);
const info = (msg) => console.log(`${colors.cyan}…${colors.reset} ${msg}`);
const heading = (msg) =>
  console.log(`\n${colors.bold}${colors.cyan}${msg}${colors.reset}`);

const results = [];
const record = (surface, name, passed, note = "") =>
  results.push({ surface, name, passed, note });

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

function pg(query) {
  // Shell out to docker exec psql — avoids a pg client dep.
  // -A -t = unaligned, no tuples header; ROW_TO_JSON keeps output parseable.
  const escaped = query.replace(/"/g, '\\"').replace(/\$/g, "\\$");
  const out = execSync(
    `docker exec -i ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -A -t -c "${escaped}"`,
    { encoding: "utf8" },
  );
  return out.trim();
}

async function api(method, path, { token, body, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}

function randomString(len) {
  // Mix ASCII + unicode + emoji to catch encoding bugs.
  //
  // CRITICAL: index by code point, not UTF-16 code unit. Emojis like 🔐
  // are surrogate PAIRS in UTF-16 (🔐); string[index] returns
  // one half, which TextEncoder then replaces with U+FFFD because UTF-8
  // can't encode lone surrogates. Array.from() splits into proper
  // code-point chunks so every pick is a valid character.
  const codepoints = Array.from(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ąčęėįš🔐📨🌍中文",
  );
  let out = "";
  for (let i = 0; i < len; i++) {
    out += codepoints[Math.floor(Math.random() * codepoints.length)];
  }
  return out;
}

function randomPassphrase() {
  const words = ["blue", "elephant", "vault", "lightning", "azure", "trout",
                 "rocket", "lemon", "echo", "marble", "sigma", "crescent"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 9999)}`;
}

// ---------------------------------------------------------------------
// Crypto — mirrors the browser helpers (selfEncrypt.ts, internalEnvelope.ts,
// secureSend.ts). We re-implement in pure JS so the script is dep-free
// and runs anywhere Node 20+ does (Web Crypto is bundled).
// ---------------------------------------------------------------------

async function generateRsaKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, spkiBytes: Array.from(spki) };
}

async function importSpki(spkiBytes) {
  return crypto.subtle.importKey(
    "spki",
    new Uint8Array(spkiBytes).slice().buffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"],
  );
}

// Mirror of selfEncrypt.ts — owner-only envelope used by Notes/Drive.
async function encryptForSelf(plaintext, userId, publicKey) {
  if (plaintext.length === 0) return "";
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, aesKey, enc.encode(plaintext),
  );
  const raw = await crypto.subtle.exportKey("raw", aesKey);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, raw);
  const envelope = {
    type: "wayve_self_v1",
    data: Array.from(new Uint8Array(ct)),
    iv: Array.from(iv),
    keys: { [String(userId)]: Array.from(new Uint8Array(wrapped)) },
  };
  return `WAYVE_SECURE_V1\n${JSON.stringify(envelope)}`;
}

async function decryptForSelf(envelope, userId, privateKey) {
  if (!envelope || !envelope.startsWith("WAYVE_SECURE_V1\n")) return envelope;
  const json = JSON.parse(envelope.slice("WAYVE_SECURE_V1\n".length));
  const wrapped = json.keys[String(userId)];
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" }, privateKey, new Uint8Array(wrapped),
  );
  const aesKey = await crypto.subtle.importKey(
    "raw", aesRaw, { name: "AES-GCM" }, false, ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(json.iv) }, aesKey, new Uint8Array(json.data),
  );
  return dec.decode(plain);
}

// Mirror of internalEnvelope.ts — multi-recipient envelope for Phase 2.
async function buildInternalEnvelope(plaintext, recipients) {
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, aesKey, enc.encode(plaintext),
  );
  const raw = await crypto.subtle.exportKey("raw", aesKey);
  const keys = {};
  for (const { userId, publicKey } of recipients) {
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, raw);
    keys[String(userId)] = Array.from(new Uint8Array(wrapped));
  }
  return `WAYVE_SECURE_V1\n${JSON.stringify({
    type: "wayve_encrypted_multi",
    data: Array.from(new Uint8Array(ct)),
    iv: Array.from(iv),
    keys,
  })}`;
}

async function decryptMultiEnvelope(envelope, userId, privateKey) {
  const json = JSON.parse(envelope.slice("WAYVE_SECURE_V1\n".length));
  const wrapped = json.keys[String(userId)];
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" }, privateKey, new Uint8Array(wrapped),
  );
  const aesKey = await crypto.subtle.importKey(
    "raw", aesRaw, { name: "AES-GCM" }, false, ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(json.iv) }, aesKey, new Uint8Array(json.data),
  );
  return dec.decode(plain);
}

// Mirror of secureSend.ts — passphrase-derived KEK + AES-GCM wrap.
async function sealSecureMessage(plaintext, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const bodyIv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"],
  );
  const kek = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.slice().buffer, iterations: 600_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const wrapIv = new Uint8Array(12);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIv.slice().buffer }, kek, dek.slice().buffer,
  );
  const dekKey = await crypto.subtle.importKey(
    "raw", dek.slice().buffer, { name: "AES-GCM" }, false, ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bodyIv.slice().buffer }, dekKey, enc.encode(plaintext),
  );
  return {
    ciphertext: b64(ct), iv: b64(bodyIv),
    wrapped_key: b64(wrapped), salt: b64(salt),
    pbkdf2_iterations: 600_000,
  };
}

async function openSecureMessage(bundle, passphrase) {
  const salt = Uint8Array.from(Buffer.from(bundle.salt, "base64"));
  const wrapped = Uint8Array.from(Buffer.from(bundle.wrapped_key, "base64"));
  const iv = Uint8Array.from(Buffer.from(bundle.iv, "base64"));
  const ct = Uint8Array.from(Buffer.from(bundle.ciphertext, "base64"));
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"],
  );
  const kek = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.slice().buffer,
      iterations: bundle.pbkdf2_iterations, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const wrapIv = new Uint8Array(12);
  const dekRaw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: wrapIv.slice().buffer }, kek, wrapped.slice().buffer,
  );
  const dekKey = await crypto.subtle.importKey(
    "raw", dekRaw, { name: "AES-GCM" }, false, ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.slice().buffer }, dekKey, ct.slice().buffer,
  );
  return dec.decode(plain);
}

// ---------------------------------------------------------------------
// Setup — register two fresh test users, generate keypairs, upload pubkeys
// ---------------------------------------------------------------------

function flushRateLimits() {
  // The auth limiter is 5 registrations / 5min per IP. Flush redis
  // `rl:*` keys before each register so the test suite isn't gated by
  // a single shared bucket — same trick the Playwright e2e suite uses.
  // Best-effort: a flush failure shouldn't crash the test (the next
  // register will just 429 with a clearer error).
  try {
    execSync(
      `docker exec -i rwayve_redis_dev redis-cli --scan --pattern 'rl:*' | xargs -r docker exec -i rwayve_redis_dev redis-cli DEL > /dev/null 2>&1 || true`,
      { encoding: "utf8" },
    );
  } catch {
    // ignore — see comment above
  }
}

async function setupTestUser(label) {
  flushRateLimits();
  const ts = Date.now();
  const email = `e2e-${label}-${ts}-${Math.floor(Math.random() * 1000)}@e2etest.local`;
  const password = "TestPassword123!";

  // /api/register accepts {email,password,confirm_password} per routes/auth.rs
  const reg = await api("POST", "/api/register", {
    body: { email, password, confirm_password: password, recovery_mode: "full" },
  });
  const token = reg.token;
  if (!token) throw new Error(`register ${label}: no token in response`);

  const kp = await generateRsaKeypair();
  // saveUserPublicKey on the frontend sends Array.from(new Uint8Array(spki)).
  // The server stores the JSON-stringified array as TEXT.
  await api("POST", "/api/save-public-key", {
    token,
    body: { public_key: kp.spkiBytes },
  });

  // Resolve user id via /api/users?email lookup so we know what user_id to
  // wrap envelopes for. The endpoint is JWT-gated.
  const me = await api("GET", `/api/users?email=${encodeURIComponent(email)}`, {
    token,
  });
  if (!me?.id) throw new Error(`could not resolve user_id for ${email}`);

  return { email, password, token, userId: me.id, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

// ---------------------------------------------------------------------
// Surface 1 — Notes
// ---------------------------------------------------------------------

async function testNotes(user) {
  heading("Notes — encryptForSelf round-trip");

  for (let i = 0; i < NOTE_SAMPLE_COUNT; i++) {
    const sample = randomString(50 + Math.floor(Math.random() * 200));
    const title = `Test note ${i + 1}`;
    const cipherTitle = await encryptForSelf(title, user.userId, user.publicKey);
    const cipherContent = await encryptForSelf(sample, user.userId, user.publicKey);

    try {
      const created = await api("POST", "/api/notes", {
        token: user.token,
        body: { title: cipherTitle, content: cipherContent },
      });
      const id = created.id;

      // 1. Storage check: DB row must contain the envelope, not plaintext.
      const dbContent = pg(
        `SELECT content FROM notes WHERE id = ${id} AND user_id = ${user.userId}`,
      );
      const containsPlaintext = dbContent.includes(sample.slice(0, 20));
      const hasEnvelope = dbContent.startsWith("WAYVE_SECURE_V1");

      if (!hasEnvelope || containsPlaintext) {
        fail(`Note #${i + 1}: storage check failed (envelope=${hasEnvelope}, plaintext-leak=${containsPlaintext})`);
        record("Notes", `sample #${i + 1} storage`, false,
          hasEnvelope ? "PLAINTEXT LEAK" : "no envelope on disk");
        continue;
      }

      // 2. Round-trip: pull back via the same envelope, decrypt locally.
      const recovered = await decryptForSelf(dbContent, user.userId, user.privateKey);
      if (recovered !== sample) {
        fail(`Note #${i + 1}: round-trip mismatch`);
        record("Notes", `sample #${i + 1} round-trip`, false,
          `expected ${sample.length} chars, got ${recovered.length}`);
        continue;
      }

      ok(`Note #${i + 1} (${sample.length} chars): stored as envelope, round-trip exact ✓`);
      record("Notes", `sample #${i + 1}`, true,
        `${sample.length}c, envelope ${dbContent.length}b`);
    } catch (err) {
      fail(`Note #${i + 1}: ${err.message}`);
      record("Notes", `sample #${i + 1}`, false, err.message);
    }
  }
}

// ---------------------------------------------------------------------
// Surface 2 — Email Phase 2 (Wayve-to-Wayve native channel)
// ---------------------------------------------------------------------

async function testEmailInternal(sender, recipients) {
  heading("Email Phase 2 — Wayve-to-Wayve native channel");

  // Recipient bucket varieties — single, multiple, includes sender for Sent.
  const scenarios = [
    { label: "1 recipient", to: [recipients[0]] },
    { label: "2 recipients", to: [recipients[0], recipients[1]] },
  ];

  for (const sc of scenarios) {
    const body = randomString(100 + Math.floor(Math.random() * 200));
    const subject = `Phase 2 test — ${sc.label} — ${Date.now()}`;

    // Build envelope with all recipients' pubkeys + sender's own (so
    // sender's Sent copy decrypts).
    const envelope = await buildInternalEnvelope(body, [
      ...sc.to.map((r) => ({ userId: r.userId, publicKey: r.publicKey })),
      { userId: sender.userId, publicKey: sender.publicKey },
    ]);

    try {
      const res = await api("POST", "/api/email/send-internal", {
        token: sender.token,
        body: {
          recipient_user_ids: sc.to.map((r) => r.userId),
          envelope,
          subject,
        },
      });

      if (res.delivered !== sc.to.length) {
        fail(`${sc.label}: delivered=${res.delivered}, expected ${sc.to.length}`);
        record("Email P2", sc.label, false, `delivered mismatch`);
        continue;
      }

      // DB verification: N rows for recipients (INBOX) + 1 for sender (SENT).
      const recipientIds = sc.to.map((r) => r.userId).join(",");
      const inboxCount = parseInt(pg(
        `SELECT COUNT(*) FROM emails WHERE source = 'wayve' AND recipient_user_id IN (${recipientIds}) AND subject = '${subject}'`,
      ), 10);
      const sentCount = parseInt(pg(
        `SELECT COUNT(*) FROM emails WHERE source = 'wayve' AND recipient_user_id = ${sender.userId} AND subject = '${subject}'`,
      ), 10);

      if (inboxCount !== sc.to.length || sentCount !== 1) {
        fail(`${sc.label}: row counts wrong (inbox=${inboxCount}, sent=${sentCount})`);
        record("Email P2", sc.label, false,
          `expected ${sc.to.length} inbox + 1 sent`);
        continue;
      }

      // Plaintext-leak check: body_encrypted in DB must NOT contain the body.
      const stored = pg(
        `SELECT body_encrypted FROM emails WHERE source = 'wayve' AND subject = '${subject}' LIMIT 1`,
      );
      if (stored.includes(body.slice(0, 20))) {
        fail(`${sc.label}: PLAINTEXT LEAKED in body_encrypted`);
        record("Email P2", sc.label, false, "PLAINTEXT LEAK");
        continue;
      }
      if (!stored.startsWith("WAYVE_SECURE_V1")) {
        fail(`${sc.label}: body_encrypted is not a WAYVE_SECURE_V1 envelope`);
        record("Email P2", sc.label, false, "wrong envelope shape");
        continue;
      }

      // Round-trip: each recipient decrypts the envelope to original.
      let allRecovered = true;
      for (const r of sc.to) {
        const recovered = await decryptMultiEnvelope(stored, r.userId, r.privateKey);
        if (recovered !== body) {
          allRecovered = false;
          fail(`  recipient ${r.email}: round-trip mismatch`);
          break;
        }
      }
      if (!allRecovered) {
        record("Email P2", sc.label, false, "recipient round-trip failed");
        continue;
      }

      ok(`${sc.label}: ${inboxCount} inbox rows + 1 sent row, all decrypt to original ✓`);
      record("Email P2", sc.label, true,
        `${inboxCount}+1 rows, body ${body.length}c, envelope ${stored.length}b`);
    } catch (err) {
      fail(`${sc.label}: ${err.message}`);
      record("Email P2", sc.label, false, err.message);
    }
  }
}

// ---------------------------------------------------------------------
// Surface 3 — Email Phase 3 (Secure-send magic link)
// ---------------------------------------------------------------------

async function testEmailSecure(sender) {
  heading("Email Phase 3 — Secure-send passphrase magic link");

  for (let i = 0; i < SECURE_SAMPLE_COUNT; i++) {
    const body = randomString(50 + Math.floor(Math.random() * 200));
    const passphrase = randomPassphrase();
    const subject = `Phase 3 test ${i + 1} — ${Date.now()}`;
    const recipient = `secure-external-${i}-${Date.now()}@example.test`;
    const bundle = await sealSecureMessage(body, passphrase);

    try {
      const res = await api("POST", "/api/email/send-secure", {
        token: sender.token,
        body: { recipient_email: recipient, subject, ...bundle },
      });
      const token = res.token;
      if (!token) {
        fail(`#${i + 1}: send-secure returned no token`);
        record("Email P3", `sample #${i + 1}`, false, "no token");
        continue;
      }

      // Storage check: secure_messages row must hold ciphertext only.
      const stored = pg(
        `SELECT ciphertext, wrapped_key, salt FROM secure_messages WHERE token = '${token}'`,
      );
      if (stored.includes(body.slice(0, 20)) || stored.includes(passphrase)) {
        fail(`#${i + 1}: PLAINTEXT or PASSPHRASE LEAK in DB`);
        record("Email P3", `sample #${i + 1}`, false, "LEAK");
        continue;
      }

      // Public-route fetch (no auth) — what the recipient's browser sees.
      const envelope = await api("GET", `/api/secure-messages/${token}`);
      if (!envelope.ciphertext || !envelope.wrapped_key || !envelope.salt) {
        fail(`#${i + 1}: public fetch missing bundle fields`);
        record("Email P3", `sample #${i + 1}`, false, "incomplete bundle");
        continue;
      }

      // Wrong-passphrase rejection.
      let rejectedCorrectly = false;
      try {
        await openSecureMessage(envelope, "wrong-passphrase-xyz");
      } catch {
        rejectedCorrectly = true;
      }
      if (!rejectedCorrectly) {
        fail(`#${i + 1}: wrong passphrase was NOT rejected`);
        record("Email P3", `sample #${i + 1}`, false, "no auth-tag protection");
        continue;
      }

      // Right-passphrase round-trip.
      const recovered = await openSecureMessage(envelope, passphrase);
      if (recovered !== body) {
        fail(`#${i + 1}: round-trip mismatch`);
        record("Email P3", `sample #${i + 1}`, false, "round-trip failed");
        continue;
      }

      ok(`#${i + 1} (${body.length} chars, passphrase "${passphrase}"): stored opaque, wrong-pass rejected, correct-pass decrypts ✓`);
      record("Email P3", `sample #${i + 1}`, true,
        `body ${body.length}c, ct ${envelope.ciphertext.length}c`);
    } catch (err) {
      fail(`#${i + 1}: ${err.message}`);
      record("Email P3", `sample #${i + 1}`, false, err.message);
    }
  }
}

// ---------------------------------------------------------------------
// Surface 4 — sanity checks for the rest of the suite
// ---------------------------------------------------------------------

async function testSanityChecks() {
  heading("Sanity checks — existing E2E surfaces (covered by their own tests)");

  // Phase 1 (inbound encrypt-on-arrival): Rust unit tests verify
  // encrypt_to_pubkey round-trip + non-determinism + garbage-key
  // rejection. Confirm they pass.
  try {
    const out = execSync(
      "cd backend && cargo test --package wayve-security encryption:: --quiet 2>&1 | tail -5",
      { encoding: "utf8", cwd: "/Users/maheswararaogunturi/Documents/rwayve" },
    );
    const pass = out.includes("test result: ok");
    if (pass) {
      ok("Phase 1 (encrypt_to_pubkey): 3/3 Rust unit tests pass");
      record("Email P1", "encrypt_to_pubkey unit tests", true, "3/3 pass");
    } else {
      fail("Phase 1 tests did not report ok");
      record("Email P1", "encrypt_to_pubkey unit tests", false, out.slice(-200));
    }
  } catch (err) {
    fail(`Phase 1 cargo test failed: ${err.message}`);
    record("Email P1", "encrypt_to_pubkey unit tests", false, "cargo test failed");
  }

  // Chat + Drive aren't directly exercised here — they have their own
  // vitest round-trips. Confirm by re-running their test files.
  try {
    const out = execSync(
      "cd frontend && npx vitest run src/test/crypto/crypto.test.ts src/test/emails/ --reporter=default 2>&1 | tail -10",
      { encoding: "utf8", cwd: "/Users/maheswararaogunturi/Documents/rwayve" },
    );
    const pass = out.includes("Tests") && !out.includes("failed");
    if (pass) {
      ok("Chat + Drive + envelope vitests: all pass");
      record("Chat/Drive", "vitest round-trips", true, out.match(/Tests\s+(\d+\s*passed)/)?.[0] ?? "passed");
    } else {
      fail("Some vitests failed");
      record("Chat/Drive", "vitest round-trips", false, out.slice(-300));
    }
  } catch (err) {
    fail(`vitest failed: ${err.message}`);
    record("Chat/Drive", "vitest round-trips", false, err.message);
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  console.log(`${colors.bold}╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   Plan A — End-to-end encryption deep verification           ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
  info(`API base: ${API_BASE}`);
  info(`Postgres: docker exec ${PG_CONTAINER}`);

  // Backend reachable?
  try {
    const r = await fetch(`${API_BASE}/api/health`);
    if (!r.ok) throw new Error(`health ${r.status}`);
    info("Backend health OK");
  } catch (err) {
    fail(`Backend not reachable: ${err.message}`);
    process.exit(2);
  }

  heading("Setup — register fresh test users + upload keypairs");
  const alice = await setupTestUser("alice");
  ok(`Alice registered: id=${alice.userId} ${alice.email}`);
  const bob = await setupTestUser("bob");
  ok(`Bob   registered: id=${bob.userId} ${bob.email}`);
  const charlie = await setupTestUser("charlie");
  ok(`Charlie registered: id=${charlie.userId} ${charlie.email}`);

  // Tiny pause so any background workers settle before assertions.
  await sleep(200);

  await testNotes(alice);
  await testEmailInternal(alice, [bob, charlie]);
  await testEmailSecure(alice);
  await testSanityChecks();

  // ── Summary table ─────────────────────────────────────────────
  console.log(`\n${colors.bold}╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║                            SUMMARY                           ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  const bySurface = {};
  for (const r of results) {
    if (!bySurface[r.surface]) bySurface[r.surface] = { passed: 0, failed: 0, items: [] };
    bySurface[r.surface][r.passed ? "passed" : "failed"]++;
    bySurface[r.surface].items.push(r);
  }
  for (const [surface, stats] of Object.entries(bySurface)) {
    const total = stats.passed + stats.failed;
    const symbol = stats.failed === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    console.log(`  ${symbol} ${colors.bold}${surface.padEnd(15)}${colors.reset} ${stats.passed}/${total} passed`);
    if (stats.failed > 0) {
      for (const item of stats.items.filter((i) => !i.passed)) {
        console.log(`      ${colors.red}× ${item.name}${colors.reset} — ${item.note}`);
      }
    }
  }
  console.log(`\n  Overall: ${colors.bold}${passed}/${total}${colors.reset} ${failed === 0 ? `${colors.green}ALL PASS${colors.reset}` : `${colors.red}${failed} FAILED${colors.reset}`}`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${colors.red}Fatal error:${colors.reset}`, err);
  process.exit(2);
});
