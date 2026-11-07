'use strict';

// Cifrado y custodia de las credenciales de proveedor.
//
// Se aísla de `ai-providers.js` por ser la pieza con más superficie de
// seguridad del módulo: aquí viven la derivación de clave, el formato
// persistido y la compatibilidad con instalaciones anteriores.
//
// Legacy records remain readable for migration. New persistence requires an
// OS-protected secret; without it credentials stay in this process only.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// New persistence always requires protected Electron safeStorage.
let ENCRYPTION_KEY = null;
let LEGACY_ENCRYPTION_KEY = null; // For backward-compat decryption
let LEGACY_MARKER_KEY = null;
let persistentStorage = false;

function getEncryptionKey(userDataPath) {
  if (ENCRYPTION_KEY) return ENCRYPTION_KEY;

  // --- Per-installation salt (always needed) ---
  let salt;
  let saltPersisted = Boolean(userDataPath);
  const saltPath = userDataPath ? path.join(userDataPath, '.mika5-salt') : null;
  try {
    if (saltPath && fs.existsSync(saltPath)) {
      salt = fs.readFileSync(saltPath);
      if (salt.length !== 32) throw new Error('INVALID_CREDENTIAL_SALT');
    } else {
      salt = crypto.randomBytes(32);
      if (saltPath) {
        fs.mkdirSync(path.dirname(saltPath), { recursive: true });
        fs.writeFileSync(saltPath, salt, { mode: 0o600 });
      }
    }
  } catch (_) {
    saltPersisted = false;
    salt = crypto.randomBytes(32);
  }

  // --- Compute legacy key first (for backward-compat decryption) ---
  LEGACY_ENCRYPTION_KEY = crypto.scryptSync(
    process.env.MIKA5_SECRET || 'mika5-local-key-2024',
    salt,
    32
  );

  // --- Try Electron safeStorage for a machine-specific secret ---
  let secret = null;
  try {
    const { safeStorage } = require('electron');
    if (safeStorage.isEncryptionAvailable()) {
      const protectedBackend = safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
      const markerPath = userDataPath ? path.join(userDataPath, '.mika5-key-marker') : null;
      if (markerPath && fs.existsSync(markerPath)) {
        const encryptedMarker = fs.readFileSync(markerPath);
        secret = safeStorage.decryptString(encryptedMarker);
        if (!protectedBackend) {
          LEGACY_MARKER_KEY = crypto.scryptSync(secret, salt, 32);
          secret = null;
        }
      } else if (protectedBackend) {
        secret = crypto.randomBytes(48).toString('hex');
        if (markerPath) {
          const encryptedMarker = safeStorage.encryptString(secret);
          fs.mkdirSync(path.dirname(markerPath), { recursive: true });
          fs.writeFileSync(markerPath, encryptedMarker, { mode: 0o600 });
        }
      }
    }
  } catch (_) { secret = null; }

  // --- Derive final key ---
  if (secret) {
    ENCRYPTION_KEY = crypto.scryptSync(secret, salt, 32);
    persistentStorage = saltPersisted;
  } else {
    ENCRYPTION_KEY = crypto.randomBytes(32);
  }

  return ENCRYPTION_KEY;
}

function encrypt(text) {
  if (!text) return null;
  const key = getEncryptionKey(null);
  if (!persistentStorage) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decryptWithKey(text, key) {
  const parts = text.split(':');
  if (parts.length < 3) return null;
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function decryptRecord(text) {
  if (!text) return null;
  // Try current key first
  try {
    return { value: decryptWithKey(text, getEncryptionKey(null)), needsMigration: false };
  } catch (_) {}
  // Fallback: try legacy key (backward compat after safeStorage migration)
  for (const legacy of [LEGACY_MARKER_KEY, LEGACY_ENCRYPTION_KEY]) {
    if (!legacy || legacy === ENCRYPTION_KEY) continue;
    try {
      return { value: decryptWithKey(text, legacy), needsMigration: true };
    } catch (_) {}
  }
  console.error('Error decrypting: all keys failed');
  return null;
}

function decrypt(text) {
  return decryptRecord(text)?.value ?? null;
}

module.exports = {
  getEncryptionKey,
  canPersistCredentials: () => persistentStorage,
  encrypt,
  decryptRecord,
  decrypt
};
