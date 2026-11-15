// One saved login (email + password) for the login page to fill in, so people
// don't retype their password every time the app signs them out.
//
// The password is encrypted with Electron's safeStorage, whose key lives in the
// macOS Keychain, and only the ciphertext is written to disk, in a file only
// this user can read. Nothing here leaves the machine.
//
// Pure functions over a directory and a safeStorage-like object, so they can be
// tested without Electron (see savedLogin.test.cjs).

const fs = require("fs");
const path = require("path");

const FILE_NAME = "saved-login.json";
// Generous bounds; anything past them is not a real login.
const EMAIL_MAX = 254;
const PASSWORD_MAX = 1024;

function filePath(dir) {
  return path.join(dir, FILE_NAME);
}

function isValid(email, password) {
  return (
    typeof email === "string" &&
    typeof password === "string" &&
    email.trim().length > 0 &&
    email.length <= EMAIL_MAX &&
    password.length > 0 &&
    password.length <= PASSWORD_MAX
  );
}

/** The saved `{ email, password }`, or null when there is none or it can't be read. */
function read(dir, safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(filePath(dir), "utf8"));
  } catch {
    return null;
  }
  if (!saved || typeof saved.email !== "string" || typeof saved.password !== "string") {
    return null;
  }
  try {
    const password = safeStorage.decryptString(Buffer.from(saved.password, "base64"));
    return isValid(saved.email, password) ? { email: saved.email, password } : null;
  } catch {
    // Encrypted under a different Keychain key (e.g. copied from another Mac):
    // unusable, so drop it.
    clear(dir);
    return null;
  }
}

/** Saves (replacing any earlier one). Returns whether it was saved. */
function save(dir, safeStorage, email, password) {
  if (!isValid(email, password) || !safeStorage.isEncryptionAvailable()) return false;
  const body = JSON.stringify({
    email: email.trim(),
    password: safeStorage.encryptString(password).toString("base64"),
  });
  const target = filePath(dir);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Write then rename, so a crash never leaves half a file.
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

function clear(dir) {
  fs.rmSync(filePath(dir), { force: true });
}

module.exports = { read, save, clear, FILE_NAME };
