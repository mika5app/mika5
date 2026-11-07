'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const source = fs.readFileSync(path.join(__dirname, '../src/main/provider-credentials.js'), 'utf8');
const sample = 'synthetic-not-a-real-credential';
const saltPath = path.join('/fixture', '.mika5-salt');
const markerPath = path.join('/fixture', '.mika5-key-marker');
const salt = crypto.randomBytes(32);
const osKey = crypto.randomBytes(32);
function ciphertext(text, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}
function plaintext(text, key) {
  const [iv, tag, data] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}
function load(files, { available = true, backend = 'secret_service', locked = false, failWrites = false } = {}) {
  const context = { module: { exports: {} }, Buffer, console: { error() {} }, process: { env: {} }, require(name) {
    if (name === 'crypto') return crypto;
    if (name === 'path') return path;
    if (name === 'fs') return {
      existsSync: p => files.has(p), readFileSync: p => files.get(p), mkdirSync() {},
      writeFileSync: (p, data) => { if (failWrites) throw new Error('read only'); files.set(p, data); }
    };
    if (name === 'electron') return { safeStorage: {
      isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
      encryptString: text => { if (locked) throw new Error('locked'); return Buffer.from(ciphertext(text, osKey)); },
      decryptString: value => { if (locked) throw new Error('locked'); return plaintext(value.toString(), osKey); }
    } };
    throw new Error(name);
  } };
  vm.runInNewContext(source, context);
  const api = context.module.exports;
  api.getEncryptionKey('/fixture');
  return api;
}
const files = new Map([[saltPath, salt]]);
const first = load(files);
assert(first.canPersistCredentials());
const encrypted = first.encrypt(sample);
assert.strictEqual(encrypted.split(':').length, 3);
assert.notStrictEqual(first.encrypt(sample), encrypted);
assert(!encrypted.includes(sample));
assert.strictEqual(load(files).decrypt(encrypted), sample, 'OS-backed records survive restart');
const legacyKey = crypto.scryptSync('mika5-local-key-2024', salt, 32);
assert.throws(() => plaintext(encrypted, legacyKey), 'public legacy secret cannot decrypt new writes');
const legacy = ciphertext(sample, legacyKey);
assert.strictEqual(first.decrypt(legacy), sample, 'old records can migrate without re-entering the key');
assert.strictEqual(first.decryptRecord(legacy).needsMigration, true);
assert.strictEqual(first.decryptRecord(encrypted).needsMigration, false);
const basicText = load(new Map(files), { backend: 'basic_text' });
assert.strictEqual(basicText.decrypt(encrypted), sample, 'old basic_text markers remain readable for session migration');
assert.strictEqual(basicText.decryptRecord(encrypted).needsMigration, true);
for (const options of [{ locked: true }, { failWrites: true }]) {
  const fresh = load(new Map(), options);
  assert.strictEqual(fresh.canPersistCredentials(), false, 'failed initialization must not claim protected persistence');
  assert.throws(() => fresh.encrypt(sample), /CREDENTIAL_STORAGE_UNAVAILABLE/);
}
for (const options of [{ available: false }, { backend: 'basic_text' }, { locked: true }]) {
  const copy = new Map(files);
  const unavailable = load(copy, options);
  assert.strictEqual(unavailable.canPersistCredentials(), false);
  assert.throws(() => unavailable.encrypt(sample), /CREDENTIAL_STORAGE_UNAVAILABLE/);
  assert.strictEqual(unavailable.decrypt(legacy), sample);
  assert.deepStrictEqual(copy.get(markerPath), files.get(markerPath), 'locked stores must not overwrite the marker');
}
for (const invalid of ['', 'invalid', 'aa:bb:cc', 'zz:zz:zz']) {
  assert.strictEqual(first.decrypt(invalid), null);
}
console.log('Provider credentials: protected restart, legacy migration, unavailable/basic_text/locked storage PASS');
