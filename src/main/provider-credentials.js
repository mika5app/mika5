'use strict';

// Cifrado y custodia de las credenciales de proveedor.
//
// Se aísla de `ai-providers.js` por ser la pieza con más superficie de
// seguridad del módulo: aquí viven la derivación de clave, el formato
// persistido y la compatibilidad con instalaciones anteriores.
//
// El código se mueve sin tocarlo. El formato persistido no cambia y no hay
// migración: una base escrita por la versión anterior se lee igual, incluida la
// ruta heredada por salt cuando `safeStorage` no está disponible.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Encryption key - uses Electron safeStorage when available, else per-installation salt
let ENCRYPTION_KEY = null;
let LEGACY_ENCRYPTION_KEY = null; // For backward-compat decryption

function getEncryptionKey(userDataPath) {
  if (ENCRYPTION_KEY) return ENCRYPTION_KEY;

  // --- Per-installation salt (always needed) ---
  let salt;
  const saltPath = userDataPath ? path.join(userDataPath, '.mika5-salt') : null;
  try {
    if (saltPath && fs.existsSync(saltPath)) {
      salt = fs.readFileSync(saltPath);
    } else {
      salt = crypto.randomBytes(32);
      if (saltPath) {
        fs.mkdirSync(path.dirname(saltPath), { recursive: true });
        fs.writeFileSync(saltPath, salt);
      }
    }
  } catch (_) {
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
      const markerPath = userDataPath ? path.join(userDataPath, '.mika5-key-marker') : null;
      if (markerPath && fs.existsSync(markerPath)) {
        const encryptedMarker = fs.readFileSync(markerPath);
        secret = safeStorage.decryptString(encryptedMarker);
      } else {
        secret = crypto.randomBytes(48).toString('hex');
        if (markerPath) {
          const encryptedMarker = safeStorage.encryptString(secret);
          fs.mkdirSync(path.dirname(markerPath), { recursive: true });
          fs.writeFileSync(markerPath, encryptedMarker);
        }
      }
    }
  } catch (_) {}

  // --- Derive final key ---
  if (secret) {
    ENCRYPTION_KEY = crypto.scryptSync(secret, salt, 32);
  } else {
    // Fallback: use legacy key (env var or hardcoded — same as before)
    ENCRYPTION_KEY = LEGACY_ENCRYPTION_KEY;
  }

  return ENCRYPTION_KEY;
}

function encrypt(text) {
  if (!text) return null;
  const key = getEncryptionKey(null);
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

function decrypt(text) {
  if (!text) return null;
  // Try current key first
  try {
    return decryptWithKey(text, getEncryptionKey(null));
  } catch (_) {}
  // Fallback: try legacy key (backward compat after safeStorage migration)
  if (LEGACY_ENCRYPTION_KEY && LEGACY_ENCRYPTION_KEY !== ENCRYPTION_KEY) {
    try {
      return decryptWithKey(text, LEGACY_ENCRYPTION_KEY);
    } catch (_) {}
  }
  console.error('Error decrypting: all keys failed');
  return null;
}

module.exports = {
  getEncryptionKey,
  encrypt,
  decrypt
};
