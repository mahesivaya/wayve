// Run with: node --test   (from desktop/)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const savedLogin = require("./savedLogin.cjs");

// Stands in for Electron's safeStorage: reversible, but not plaintext.
function fakeSafeStorage({ available = true, key = 7 } = {}) {
  const flip = (buf) => Buffer.from(buf.map((b) => b ^ key));
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => flip(Buffer.from(s, "utf8")),
    decryptString: (buf) => {
      const out = flip(buf).toString("utf8");
      if (!out.startsWith("pw:")) throw new Error("bad key");
      return out;
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fluxze-saved-login-"));
}

test("saves and reads back a login", () => {
  const dir = tempDir();
  const ss = fakeSafeStorage();
  assert.strictEqual(savedLogin.save(dir, ss, " me@x.com ", "pw:secret"), true);
  assert.deepStrictEqual(savedLogin.read(dir, ss), { email: "me@x.com", password: "pw:secret" });
});

test("never writes the password in plaintext, and the file is owner-only", () => {
  const dir = tempDir();
  savedLogin.save(dir, fakeSafeStorage(), "me@x.com", "pw:secret");
  const file = path.join(dir, savedLogin.FILE_NAME);
  assert.ok(!fs.readFileSync(file, "utf8").includes("pw:secret"));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test("a new save replaces the old one", () => {
  const dir = tempDir();
  const ss = fakeSafeStorage();
  savedLogin.save(dir, ss, "a@x.com", "pw:one");
  savedLogin.save(dir, ss, "b@x.com", "pw:two");
  assert.deepStrictEqual(savedLogin.read(dir, ss), { email: "b@x.com", password: "pw:two" });
});

test("clear removes it", () => {
  const dir = tempDir();
  const ss = fakeSafeStorage();
  savedLogin.save(dir, ss, "me@x.com", "pw:secret");
  savedLogin.clear(dir);
  assert.strictEqual(savedLogin.read(dir, ss), null);
  savedLogin.clear(dir); // clearing nothing is fine
});

test("does nothing without OS encryption", () => {
  const dir = tempDir();
  const ss = fakeSafeStorage({ available: false });
  assert.strictEqual(savedLogin.save(dir, ss, "me@x.com", "pw:secret"), false);
  assert.ok(!fs.existsSync(path.join(dir, savedLogin.FILE_NAME)));
  assert.strictEqual(savedLogin.read(dir, ss), null);
});

test("rejects empty or oversized values", () => {
  const dir = tempDir();
  const ss = fakeSafeStorage();
  assert.strictEqual(savedLogin.save(dir, ss, "", "pw:secret"), false);
  assert.strictEqual(savedLogin.save(dir, ss, "me@x.com", ""), false);
  assert.strictEqual(savedLogin.save(dir, ss, "me@x.com", "pw:" + "x".repeat(2000)), false);
  assert.strictEqual(savedLogin.save(dir, ss, 42, "pw:secret"), false);
});

test("a login encrypted under another key is dropped", () => {
  const dir = tempDir();
  savedLogin.save(dir, fakeSafeStorage({ key: 7 }), "me@x.com", "pw:secret");
  assert.strictEqual(savedLogin.read(dir, fakeSafeStorage({ key: 9 })), null);
  assert.ok(!fs.existsSync(path.join(dir, savedLogin.FILE_NAME)));
});

test("a corrupt file reads as nothing", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, savedLogin.FILE_NAME), "{not json");
  assert.strictEqual(savedLogin.read(dir, fakeSafeStorage()), null);
});
