#!/usr/bin/env node
// =====================================================================
// Organization Master Key — end-to-end verification.
// ---------------------------------------------------------------------
// Mirrors scripts/e2e_encryption_verify.mjs but for the org-key flows:
//
//   * Bootstrap     — Owner mints org keypair, mnemonic wrap, and a
//                     personal-pubkey wrap. DB sanity-check.
//   * Provisioning  — POST /admin/users for an org member triggers
//                     server-side RSA keypair gen + escrow under org
//                     pubkey + PBKDF2(password) wrap. DB sanity-check.
//   * Member login  — Member logs in, receives login_wrap, unwraps with
//                     PBKDF2(password), gets working private key.
//   * Round-trip    — Member encrypts a note with their key; owner uses
//                     org master key to recover member's key and decrypt
//                     the same note. Crypto closure verified.
//   * Audit         — fetch_member_escrow leaves a row in
//                     org_key_audit_log.
//   * Reset         — Admin-initiated password reset rotates the wrap;
//                     member logs in with new password and still
//                     decrypts pre-reset notes.
//   * Negative      — Wrong password fails to unwrap; provisioning
//                     before bootstrap is refused; re-bootstrap is
//                     refused.
//
// Usage:
//   node scripts/org_key_verify.mjs
//   API_BASE=http://localhost:8080 node scripts/org_key_verify.mjs
// =====================================================================

import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const API_BASE = process.env.API_BASE ?? "http://localhost:8080";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "rwayve_postgres_dev";
const PG_USER = process.env.PG_USER ?? "wayve_user";
const PG_DB = process.env.PG_DB ?? "wayve_dev";

const PBKDF2_ITERATIONS = 600_000;
const NOTE_SAMPLE = "owner can read my secret org notes 🔐 — hello from the member side";

// ---------------------------------------------------------------------
// Pretty printer
// ---------------------------------------------------------------------

const colors = {
  reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m",
  red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};
const ok = (m) => console.log(`${colors.green}✓${colors.reset} ${m}`);
const fail = (m) => console.log(`${colors.red}✗${colors.reset} ${m}`);
const info = (m) => console.log(`${colors.cyan}…${colors.reset} ${m}`);
const heading = (m) => console.log(`\n${colors.bold}${colors.cyan}${m}${colors.reset}`);

const results = [];
const record = (surface, name, passed, note = "") =>
  results.push({ surface, name, passed, note });

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const b64dec = (s) => new Uint8Array(Buffer.from(s, "base64"));

function pg(query) {
  const escaped = query.replace(/"/g, '\\"').replace(/\$/g, "\\$");
  return execSync(
    `docker exec -i ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -A -t -c "${escaped}"`,
    { encoding: "utf8" },
  ).trim();
}

async function api(method, path, { token, body, raw, expectFail } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  if (!res.ok) {
    if (expectFail) {
      // Caller is checking for the failure intentionally — return the
      // status + body so they can assert on it.
      const text = await res.text();
      return { __failed: true, status: res.status, text };
    }
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}

function flushRateLimits() {
  try {
    execSync(
      `docker exec -i rwayve_redis_dev redis-cli --scan --pattern 'rl:*' | xargs -r docker exec -i rwayve_redis_dev redis-cli DEL > /dev/null 2>&1 || true`,
    );
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------
// Crypto helpers — pure JS, mirror frontend/src/orgKeys/*.ts
// ---------------------------------------------------------------------

async function generateRsaKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["wrapKey", "unwrapKey", "encrypt", "decrypt"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return { publicKey: kp.publicKey, privateKey: kp.privateKey,
           spkiBytes: Array.from(spki), pkcs8: pkcs8.buffer };
}

async function importPrivatePkcs8(pkcs8) {
  return crypto.subtle.importKey(
    "pkcs8", pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"],
  );
}

async function importPublicSpki(spki) {
  return crypto.subtle.importKey(
    "spki", spki,
    { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
}

// Mirror frontend/src/orgKeys/envelopeCodec.ts wrapPkcs8ToRsaPubkey:
// AES-GCM the PKCS8 with a fresh key; RSA-OAEP-wrap that AES key;
// pack {wrapped_aes, body} JSON into the ct field.
async function wrapPkcs8ToRsaPubkey(pkcs8, recipientSpkiBytes) {
  const recipientPub = await importPublicSpki(new Uint8Array(recipientSpkiBytes).slice().buffer);
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt"],
  );
  const aesRaw = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedAes = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, recipientPub, aesRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, pkcs8);
  const inner = JSON.stringify({
    wrapped_aes: Array.from(new Uint8Array(wrappedAes)),
    body: Array.from(new Uint8Array(ct)),
  });
  return { iv: b64(iv), ct: b64(enc.encode(inner)) };
}

// Mirror frontend/src/orgKeys/envelopeCodec.ts unwrapPkcs8WithRsaKey:
async function unwrapPkcs8WithRsaKey(iv, ct, recipientPrivate) {
  const ivBytes = b64dec(iv);
  const innerJson = dec.decode(b64dec(ct));
  const inner = JSON.parse(innerJson);
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" }, recipientPrivate, new Uint8Array(inner.wrapped_aes).slice().buffer,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw", aesRaw, { name: "AES-GCM" }, false, ["decrypt"],
  );
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes.slice().buffer }, aesKey, new Uint8Array(inner.body).slice().buffer,
  );
}

// Mirror frontend/src/orgKeys/envelopeCodec.ts unwrapPkcs8WithPbkdf2:
async function unwrapPkcs8WithPbkdf2(iv, ct, inputMaterial, saltB64, iterations) {
  const ivBytes = b64dec(iv);
  const ctBytes = b64dec(ct);
  const salt = b64dec(saltB64);
  const baseKey = await crypto.subtle.importKey(
    "raw", inputMaterial, { name: "PBKDF2" }, false, ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.slice().buffer, iterations, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes.slice().buffer }, aesKey, ctBytes.slice().buffer,
  );
}

// Mirror backend encrypt_to_pubkey: produces the WAYVE_SECURE_V1 envelope
// that member_wrapped_keys.ct stores. Used here to verify it's exactly
// the shape ownerImpersonate parses (defensive — backend builds these).
function decodeWayveSecureV1Envelope(envelope) {
  const newlineIdx = envelope.indexOf("\n");
  if (newlineIdx < 0) throw new Error("envelope missing newline");
  if (envelope.slice(0, newlineIdx) !== "WAYVE_SECURE_V1") {
    throw new Error(`unexpected envelope prefix: ${envelope.slice(0, newlineIdx)}`);
  }
  const body = JSON.parse(envelope.slice(newlineIdx + 1));
  if (body.type !== "wayve_encrypted") {
    throw new Error(`unexpected envelope type: ${body.type}`);
  }
  return body;
}

async function unwrapMemberEscrow(envelope, orgPrivateKey) {
  const body = decodeWayveSecureV1Envelope(envelope);
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" }, orgPrivateKey, new Uint8Array(body.key).slice().buffer,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw", aesRaw, { name: "AES-GCM" }, false, ["decrypt"],
  );
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(body.iv).slice().buffer },
    aesKey, new Uint8Array(body.data).slice().buffer,
  );
}

// Selfencrypt the way frontend/src/crypto/selfEncrypt.ts does — used so
// the member writes a real WAYVE_SECURE_V1 envelope to /api/notes that
// the owner can later decrypt via the recovered member key.
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
  return `WAYVE_SECURE_V1\n${JSON.stringify({
    type: "wayve_self_v1",
    data: Array.from(new Uint8Array(ct)),
    iv: Array.from(iv),
    keys: { [String(userId)]: Array.from(new Uint8Array(wrapped)) },
  })}`;
}

async function decryptForSelf(envelope, userId, privateKey) {
  if (!envelope || !envelope.startsWith("WAYVE_SECURE_V1\n")) return envelope;
  const json = JSON.parse(envelope.slice("WAYVE_SECURE_V1\n".length));
  const wrapped = json.keys[String(userId)];
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" }, privateKey, new Uint8Array(wrapped).slice().buffer,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw", aesRaw, { name: "AES-GCM" }, false, ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(json.iv).slice().buffer },
    aesKey, new Uint8Array(json.data).slice().buffer,
  );
  return dec.decode(plain);
}

// Bootstrap: build the two wrapped envelopes the backend expects from
// /api/organizations/{id}/keys. Mnemonic-side mirrors orgKeypair.ts'
// PBKDF2 + AES-GCM wrap of the org PKCS8; user-side mirrors
// wrapPkcs8ToRsaPubkey above.
async function buildBootstrapEnvelopes(orgPkcs8, mnemonicEntropy, founderSpki) {
  // Mnemonic wrap
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw", mnemonicEntropy, { name: "PBKDF2" }, false, ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.slice().buffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, orgPkcs8);
  const wrapped_mnemonic = {
    iv: b64(iv),
    ct: b64(new Uint8Array(ct)),
    pbkdf2_salt: b64(salt),
    pbkdf2_iterations: PBKDF2_ITERATIONS,
  };

  // User-pubkey wrap (founder)
  const wrapped_user = await wrapPkcs8ToRsaPubkey(orgPkcs8, founderSpki);

  return { wrapped_mnemonic, wrapped_user };
}

// ---------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------

async function registerPersonalUser(label) {
  flushRateLimits();
  const ts = Date.now();
  const email = `org-${label}-${ts}-${Math.floor(Math.random() * 1000)}@orgtest.local`;
  const password = "TestPassword123!";
  const reg = await api("POST", "/api/register", {
    body: { email, password, confirm_password: password, recovery_mode: "full" },
  });
  if (!reg.token) throw new Error(`register ${label}: no token`);

  // Personal users still generate their own keypair client-side per the
  // existing flow — replicate that.
  const kp = await generateRsaKeypair();
  await api("POST", "/api/save-public-key", {
    token: reg.token,
    body: { public_key: kp.spkiBytes },
  });

  // Resolve user_id via the standard email lookup the frontend uses.
  const me = await api("GET", `/api/users?email=${encodeURIComponent(email)}`, {
    token: reg.token,
  });
  if (!me?.id) throw new Error(`could not resolve user_id for ${email}`);

  return {
    email, password, token: reg.token, userId: me.id,
    publicKey: kp.publicKey, privateKey: kp.privateKey,
    spkiBytes: kp.spkiBytes, pkcs8: kp.pkcs8,
  };
}

async function selfServeCreateOrg(founder, name) {
  const res = await api("POST", "/api/organizations", {
    token: founder.token,
    body: { name, place: null },
  });
  if (!res.organization_id) throw new Error("self-serve org create: no id");
  // Re-fetch token via login — account_type just flipped to
  // organization_admin, role context cache was invalidated, but the
  // existing JWT carries the old account_type claim. Get a fresh JWT.
  const fresh = await api("POST", "/api/login", {
    body: { email: founder.email, password: founder.password },
  });
  founder.token = fresh.token;
  return res.organization_id;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

async function testBootstrap(founder, orgId) {
  heading("Bootstrap — owner mints org keypair + wraps");

  // Generate org keypair + mnemonic entropy on the script side (mirrors
  // BootstrapPage which does this in the browser).
  const orgKp = await generateRsaKeypair();
  const mnemonicEntropy = crypto.getRandomValues(new Uint8Array(32));

  const { wrapped_mnemonic, wrapped_user } = await buildBootstrapEnvelopes(
    orgKp.pkcs8, mnemonicEntropy, founder.spkiBytes,
  );

  await api("POST", `/api/organizations/${orgId}/keys`, {
    token: founder.token,
    body: {
      public_key: JSON.stringify(orgKp.spkiBytes),
      wrapped_mnemonic,
      wrapped_user,
    },
  });
  ok("bootstrap POST accepted");

  // DB sanity: one organization_keys row + one mnemonic + one user_pubkey wrap.
  const keyCount = parseInt(pg(
    `SELECT COUNT(*) FROM organization_keys WHERE organization_id = ${orgId}`,
  ), 10);
  const mWrapCount = parseInt(pg(
    `SELECT COUNT(*) FROM organization_wrapped_keys WHERE organization_id = ${orgId} AND wrap_method = 'mnemonic'`,
  ), 10);
  const uWrapCount = parseInt(pg(
    `SELECT COUNT(*) FROM organization_wrapped_keys WHERE organization_id = ${orgId} AND wrap_method = 'user_pubkey' AND holder_user_id = ${founder.userId}`,
  ), 10);

  if (keyCount === 1 && mWrapCount === 1 && uWrapCount === 1) {
    ok(`DB: 1 organization_keys + 1 mnemonic wrap + 1 founder user_pubkey wrap`);
    record("Bootstrap", "DB rows", true, "all 3 inserted");
  } else {
    fail(`DB row counts wrong (keys=${keyCount}, mnem=${mWrapCount}, user=${uWrapCount})`);
    record("Bootstrap", "DB rows", false, "row count mismatch");
  }

  // Negative: re-bootstrap must be refused.
  const second = await api("POST", `/api/organizations/${orgId}/keys`, {
    token: founder.token,
    body: {
      public_key: JSON.stringify(orgKp.spkiBytes),
      wrapped_mnemonic, wrapped_user,
    },
    expectFail: true,
  });
  if (second.__failed && second.status === 400) {
    ok(`re-bootstrap rejected with 400 (${second.text.slice(0, 60)}...)`);
    record("Bootstrap", "re-bootstrap rejection", true, "400 as expected");
  } else {
    fail(`re-bootstrap should have failed with 400, got ${JSON.stringify(second).slice(0, 80)}`);
    record("Bootstrap", "re-bootstrap rejection", false, "not rejected");
  }

  // Audit log row for bootstrap.
  const auditCount = parseInt(pg(
    `SELECT COUNT(*) FROM org_key_audit_log WHERE organization_id = ${orgId} AND action = 'bootstrap'`,
  ), 10);
  if (auditCount >= 1) {
    ok(`audit log: ${auditCount} bootstrap row(s)`);
    record("Bootstrap", "audit row", true, `${auditCount} bootstrap entries`);
  } else {
    fail("audit log missing bootstrap row");
    record("Bootstrap", "audit row", false, "no audit row");
  }

  return { orgKp, mnemonicEntropy };
}

async function testProvisionMember(founder, orgId, label) {
  heading(`Provision member (${label}) — server-side keypair gen + escrow`);
  flushRateLimits();
  const handle = `member-${label}-${Date.now()}`;
  const email = `${handle}@orgkey.test`;
  const tempPassword = "MemberTempPassword123!";

  const res = await api("POST", "/api/admin/users", {
    token: founder.token,
    body: {
      email, username: handle, password: tempPassword,
      account_type: "organization", role: "member",
    },
  });

  // The response MUST NOT include any private key material.
  const responseStr = JSON.stringify(res);
  if (/private_key|pkcs8|wrap/i.test(responseStr)) {
    fail("response leaked private-key-like field");
    record("Provision", `${label} response`, false, "response contained crypto material");
    return null;
  }
  ok(`response clean (id=${res.id}, no private key fields)`);

  // DB sanity: 3 rows for the new member.
  const userPk = pg(`SELECT public_key FROM users WHERE id = ${res.id}`);
  const escrowCt = pg(`SELECT ct FROM member_wrapped_keys WHERE user_id = ${res.id}`);
  const loginCt = pg(`SELECT ct FROM member_login_wrapped_keys WHERE user_id = ${res.id}`);

  if (userPk.length < 100) {
    fail(`users.public_key not populated (length=${userPk.length})`);
    record("Provision", `${label} pubkey`, false, "empty public_key");
    return null;
  }
  if (!escrowCt.startsWith("WAYVE_SECURE_V1")) {
    fail(`member_wrapped_keys.ct not a WAYVE_SECURE_V1 envelope`);
    record("Provision", `${label} escrow`, false, "wrong envelope shape");
    return null;
  }
  if (loginCt.length < 100) {
    fail(`member_login_wrapped_keys.ct not populated (length=${loginCt.length})`);
    record("Provision", `${label} login wrap`, false, "empty login wrap");
    return null;
  }
  ok(`DB: public_key + member_wrapped_keys + member_login_wrapped_keys all populated`);
  record("Provision", `${label} db rows`, true, "3 rows present + clean response");

  return { id: res.id, email, password: tempPassword };
}

async function testMemberLogin(member) {
  heading(`Member login — PBKDF2 unwrap of server-provisioned key`);

  const loginRes = await api("POST", "/api/login", {
    body: { email: member.email, password: member.password },
  });
  if (!loginRes.token) {
    fail("login: no token");
    return null;
  }
  if (!loginRes.login_wrap) {
    fail("login response missing login_wrap (org members should get one)");
    record("Login", "wrap presence", false, "no login_wrap in response");
    return null;
  }
  ok(`login response carries login_wrap (iters=${loginRes.login_wrap.iterations})`);
  record("Login", "wrap presence", true, "login_wrap returned");

  // Right password unwrap — must yield a valid PKCS8 + RSA private key.
  let pkcs8;
  try {
    pkcs8 = await unwrapPkcs8WithPbkdf2(
      loginRes.login_wrap.iv,
      loginRes.login_wrap.ct,
      enc.encode(member.password),
      loginRes.login_wrap.salt,
      loginRes.login_wrap.iterations,
    );
  } catch (err) {
    fail(`PBKDF2 unwrap with correct password failed: ${err.message}`);
    return null;
  }
  const privateKey = await importPrivatePkcs8(pkcs8);
  ok("PBKDF2(password) unwrapped PKCS8 → valid RSA-OAEP private key");
  record("Login", "right password unwrap", true, `pkcs8 ${pkcs8.byteLength}b`);

  // Wrong password — auth tag must reject.
  let rejected = false;
  try {
    await unwrapPkcs8WithPbkdf2(
      loginRes.login_wrap.iv, loginRes.login_wrap.ct,
      enc.encode("wrong-password-xyz"),
      loginRes.login_wrap.salt, loginRes.login_wrap.iterations,
    );
  } catch { rejected = true; }
  if (rejected) {
    ok("wrong password rejected by AES-GCM auth tag ✓");
    record("Login", "wrong password rejection", true, "auth-tag rejected");
  } else {
    fail("wrong password did NOT reject — auth tag broken?");
    record("Login", "wrong password rejection", false, "no auth-tag protection");
  }

  // Derive the matching SPKI from the recovered PKCS8 so we can use it
  // to encrypt-to-self notes below.
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const pubKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true, key_ops: ["encrypt"] },
    { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"],
  );

  return { token: loginRes.token, privateKey, publicKey: pubKey, pkcs8 };
}

async function testCryptoClosure(founder, orgId, member, memberSession) {
  heading("Round-trip — member writes encrypted note; owner recovers and decrypts");

  // Member encrypts a note with their own key and posts it.
  const cipherTitle = await encryptForSelf("recovered title", member.id, memberSession.publicKey);
  const cipherContent = await encryptForSelf(NOTE_SAMPLE, member.id, memberSession.publicKey);
  const note = await api("POST", "/api/notes", {
    token: memberSession.token,
    body: { title: cipherTitle, content: cipherContent },
  });
  ok(`member wrote note #${note.id} (content is encrypted envelope)`);

  // Sanity check: DB content is opaque.
  const dbContent = pg(`SELECT content FROM notes WHERE id = ${note.id}`);
  if (dbContent.includes(NOTE_SAMPLE.slice(0, 20))) {
    fail("PLAINTEXT LEAK in notes.content");
    record("Round-trip", "no leak", false, "plaintext leak");
    return;
  }
  ok("DB content is opaque envelope (no plaintext leak)");

  // Owner side: fetch their own user_pubkey wrap of the org key.
  const keys = await api("GET", `/api/organizations/${orgId}/keys`, {
    token: founder.token,
  });
  if (!keys.wrapped_user) {
    fail("owner has no wrapped_user envelope");
    record("Round-trip", "owner key", false, "no wrap");
    return;
  }
  const orgPkcs8 = await unwrapPkcs8WithRsaKey(
    keys.wrapped_user.iv, keys.wrapped_user.ct, founder.privateKey,
  );
  const orgPrivateKey = await importPrivatePkcs8(orgPkcs8);
  ok("owner unwrapped org master private key via their personal RSA key");

  // Fetch the member's escrow envelope.
  const escrow = await api("GET", `/api/organizations/${orgId}/members/${member.id}/escrow`, {
    token: founder.token,
  });
  ok(`fetched member escrow (${escrow.envelope.length} chars)`);

  // Unwrap the member's PKCS8 using the org private key.
  const memberPkcs8 = await unwrapMemberEscrow(escrow.envelope, orgPrivateKey);
  ok(`unwrapped member's PKCS8 via org master key (${memberPkcs8.byteLength} bytes)`);

  // Cross-check: recovered PKCS8 should match the member's session PKCS8.
  const a = new Uint8Array(memberPkcs8);
  const b = new Uint8Array(memberSession.pkcs8);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    fail("recovered PKCS8 does NOT match member's session PKCS8");
    record("Round-trip", "key identity", false, "byte mismatch");
    return;
  }
  ok("recovered PKCS8 is byte-identical to the member's working private key");
  record("Round-trip", "key identity", true, "PKCS8 byte-equal");

  // Final: use the recovered key to decrypt the note. This is what the
  // owner-impersonation page does.
  const recoveredKey = await importPrivatePkcs8(memberPkcs8);
  const plaintext = await decryptForSelf(dbContent, member.id, recoveredKey);
  if (plaintext !== NOTE_SAMPLE) {
    fail(`note decrypt mismatch: expected ${NOTE_SAMPLE.length} chars, got ${plaintext.length}`);
    record("Round-trip", "note decrypt", false, "mismatch");
    return;
  }
  ok(`note decrypted via owner-recovered key — matches original verbatim ✓`);
  record("Round-trip", "note decrypt", true, `${NOTE_SAMPLE.length}c roundtrip`);

  // Audit row for fetch_member_escrow.
  const auditCount = parseInt(pg(
    `SELECT COUNT(*) FROM org_key_audit_log WHERE organization_id = ${orgId} AND action = 'fetch_member_escrow' AND target_user_id = ${member.id}`,
  ), 10);
  if (auditCount >= 1) {
    ok(`audit log: ${auditCount} fetch_member_escrow row(s) for this member`);
    record("Round-trip", "audit row", true, `${auditCount} entries`);
  } else {
    fail("audit log missing fetch_member_escrow row");
    record("Round-trip", "audit row", false, "no audit row");
  }

  return { orgPrivateKey, originalNoteId: note.id };
}

async function testAdminPasswordReset(founder, orgId, member, memberSession, ctx) {
  heading("Admin-initiated password reset — wrap rotation");

  const newPassword = "MemberRotatedPassword456!";

  // Re-wrap the member's PKCS8 under the new password (PBKDF2 + AES-GCM,
  // mirrors ownerImpersonate.rewrapPkcs8UnderPassword).
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(newPassword), { name: "PBKDF2" }, false, ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.slice().buffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, memberSession.pkcs8);
  const newWrap = {
    iv: b64(iv), ct: b64(new Uint8Array(ct)),
    salt: b64(salt), iterations: PBKDF2_ITERATIONS,
  };

  await api("POST", `/api/organizations/${orgId}/members/${member.id}/reset-password`, {
    token: founder.token,
    body: { new_password: newPassword, new_login_wrap: newWrap },
  });
  ok(`reset-password accepted; member's new password queued`);

  // Member logs in with new password — must succeed AND server must
  // return the new login_wrap.
  const reLogin = await api("POST", "/api/login", {
    body: { email: member.email, password: newPassword },
  });
  if (!reLogin.token || !reLogin.login_wrap) {
    fail("re-login with new password failed or missing login_wrap");
    record("Reset", "new login", false, "incomplete response");
    return;
  }
  ok("member logged in with NEW password; new login_wrap returned");

  // Member unwraps with new password.
  const pkcs8 = await unwrapPkcs8WithPbkdf2(
    reLogin.login_wrap.iv, reLogin.login_wrap.ct,
    enc.encode(newPassword),
    reLogin.login_wrap.salt, reLogin.login_wrap.iterations,
  );
  const newKey = await importPrivatePkcs8(pkcs8);

  // Decrypt the pre-reset note — must still work because the keypair is
  // unchanged; only the wrap rotated.
  const dbContent = pg(`SELECT content FROM notes WHERE id = ${ctx.originalNoteId}`);
  const plaintext = await decryptForSelf(dbContent, member.id, newKey);
  if (plaintext !== NOTE_SAMPLE) {
    fail("pre-reset note no longer decrypts after password reset");
    record("Reset", "old data decrypt", false, "mismatch");
    return;
  }
  ok("pre-reset note still decrypts cleanly — password rotation preserved key access ✓");
  record("Reset", "old data decrypt", true, "post-reset decrypt OK");

  // Old password must NOT log in anymore.
  const old = await api("POST", "/api/login", {
    body: { email: member.email, password: member.password },
    expectFail: true,
  });
  if (old.__failed && old.status === 401) {
    ok("old password rejected (401) ✓");
    record("Reset", "old password rejection", true, "401 as expected");
  } else {
    fail(`old password should have been rejected, got ${JSON.stringify(old).slice(0, 80)}`);
    record("Reset", "old password rejection", false, "old still works");
  }
}

async function testNegativeProvisionBeforeBootstrap(founder, label) {
  heading("Negative — provision member into org with no bootstrapped key");
  flushRateLimits();

  // Need a SECOND fresh founder + org that hasn't been bootstrapped.
  const founder2 = await registerPersonalUser(`f2-${label}`);
  const orgId2 = await selfServeCreateOrg(founder2, `NegativeCo-${Date.now()}`);
  ok(`spun up un-bootstrapped org #${orgId2}`);

  const res = await api("POST", "/api/admin/users", {
    token: founder2.token,
    body: {
      email: `should-not-exist-${Date.now()}@blockedorg.test`,
      username: `nope-${Date.now()}`,
      password: "AnyPasswordWillBe rejected",
      account_type: "organization",
      role: "member",
    },
    expectFail: true,
  });
  if (res.__failed && res.status === 400) {
    ok(`provision before bootstrap refused (400: ${res.text.slice(0, 80)}...)`);
    record("Negative", "provision-before-bootstrap", true, "400 as expected");
  } else {
    fail(`provision should have failed with 400, got ${JSON.stringify(res).slice(0, 80)}`);
    record("Negative", "provision-before-bootstrap", false, "not rejected");
  }
}

// ---------------------------------------------------------------------
//   Impersonation reads — all 6 surfaces
// ---------------------------------------------------------------------

async function testImpersonationReads(founder, orgId, member, memberSession) {
  heading("Impersonation reads — all 6 surfaces accessible to key holder");

  const surfaces = [
    { path: "notes", e2e: true },
    { path: "emails", e2e: true },
    { path: "messages", e2e: true },          // direct chat
    { path: "channel-messages", e2e: true },
    { path: "files", e2e: false },             // drive — listing only
    { path: "tasks", e2e: false },             // plaintext per plan
    { path: "meetings", e2e: false },          // plaintext per plan
  ];

  for (const s of surfaces) {
    try {
      const rows = await api(
        "GET",
        `/api/organizations/${orgId}/members/${member.id}/${s.path}`,
        { token: founder.token },
      );
      if (!Array.isArray(rows)) {
        fail(`${s.path}: response is not an array`);
        record("Impersonate", s.path, false, "non-array response");
        continue;
      }
      ok(`${s.path}: ${rows.length} row(s) returned to owner`);
      record("Impersonate", s.path, true, `${rows.length} rows`);
    } catch (err) {
      fail(`${s.path}: ${err.message}`);
      record("Impersonate", s.path, false, err.message);
    }
  }

  // Audit log should now contain one row per surface fetched.
  const expectedActions = [
    "list_member_notes",
    "list_member_emails",
    "list_member_messages",
    "list_member_channel_messages",
    "list_member_files",
    "list_member_tasks",
    "list_member_meetings",
  ];
  for (const action of expectedActions) {
    const count = parseInt(
      pg(
        `SELECT COUNT(*) FROM org_key_audit_log WHERE organization_id = ${orgId} AND action = '${action}' AND target_user_id = ${member.id}`,
      ),
      10,
    );
    if (count >= 1) {
      ok(`audit: ${action} row(s) present`);
      record("Impersonate", `audit ${action}`, true, `${count} entries`);
    } else {
      fail(`audit: ${action} missing`);
      record("Impersonate", `audit ${action}`, false, "no audit row");
    }
  }
}

async function testImpersonationReadsDeniedToMember(orgId, member, memberSession) {
  heading("Impersonation reads — member role denied (defense in depth)");
  const surfaces = [
    "notes", "emails", "messages", "channel-messages",
    "files", "tasks", "meetings",
  ];
  for (const path of surfaces) {
    const r = await api(
      "GET",
      `/api/organizations/${orgId}/members/${member.id}/${path}`,
      { token: memberSession.token, expectFail: true },
    );
    if (r.__failed && r.status === 403) {
      ok(`${path}: role='member' denied (403)`);
      record("Impersonate-Deny", path, true, "403 as expected");
    } else {
      fail(`${path}: expected 403, got ${JSON.stringify(r).slice(0, 80)}`);
      record("Impersonate-Deny", path, false, "wrongly allowed");
    }
  }
}

async function testNonOwnerCannotFetchEscrow(founder, orgId, member, memberSession) {
  heading("Negative — non-key-holder cannot fetch member escrow");

  // Reuse the member's existing session JWT — JWTs are stateless so it
  // remains valid even after the password rotation above. The member
  // holds role='member' which lacks OrgKeysUseMaster.
  const denied = await api("GET", `/api/organizations/${orgId}/members/${member.id}/escrow`, {
    token: memberSession.token,
    expectFail: true,
  });
  if (denied.__failed && (denied.status === 403 || denied.status === 401)) {
    ok(`role='member' fetching escrow → ${denied.status} ${denied.text.slice(0, 40)}...`);
    record("Negative", "member-cannot-fetch-escrow", true, `${denied.status} denied`);
  } else {
    fail(`expected 403 for role='member' escrow fetch, got ${JSON.stringify(denied).slice(0, 80)}`);
    record("Negative", "member-cannot-fetch-escrow", false, "wrongly allowed");
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  console.log(`${colors.bold}╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   Org Master Key — end-to-end verification                   ║`);
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

  heading("Setup — register founder + self-serve org create");
  const founder = await registerPersonalUser("founder");
  ok(`founder: id=${founder.userId} ${founder.email}`);

  const orgId = await selfServeCreateOrg(founder, `OrgKeyTest-${Date.now()}`);
  ok(`organization created: id=${orgId}`);

  await sleep(100);

  // --- the meat ---
  await testBootstrap(founder, orgId);
  await sleep(100);

  const member = await testProvisionMember(founder, orgId, "alice");
  if (!member) {
    fail("provisioning failed — aborting downstream tests");
    return summaryAndExit();
  }
  await sleep(100);

  const memberSession = await testMemberLogin(member);
  if (!memberSession) {
    fail("member login failed — aborting downstream tests");
    return summaryAndExit();
  }
  await sleep(100);

  const ctx = await testCryptoClosure(founder, orgId, member, memberSession);
  await sleep(100);

  if (ctx) {
    await testAdminPasswordReset(founder, orgId, member, memberSession, ctx);
    await sleep(100);
  }

  await testNonOwnerCannotFetchEscrow(founder, orgId, member, memberSession);
  await sleep(100);
  await testImpersonationReads(founder, orgId, member, memberSession);
  await sleep(100);
  await testImpersonationReadsDeniedToMember(orgId, member, memberSession);
  await sleep(100);
  await testNegativeProvisionBeforeBootstrap(founder, "neg");

  summaryAndExit();
}

function summaryAndExit() {
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
    const t = stats.passed + stats.failed;
    const symbol = stats.failed === 0 ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    console.log(`  ${symbol} ${colors.bold}${surface.padEnd(14)}${colors.reset} ${stats.passed}/${t} passed`);
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
  console.error(err.stack);
  process.exit(2);
});
