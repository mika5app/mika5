// src/main/ai-providers.js
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

// Sanitización básica de PII antes de enviar a cloud
function sanitizeForCloud(text) {
  if (!text) return text;
  return text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE]')
    .replace(/\b\d{8,}\b/g, '[ID]');
}

// --- Helpers locales ---
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function detectCapabilities(name) {
  const caps = [];
  if (!name) return caps;
  const n = name.toLowerCase();
  if (detectVisionByName(name)) caps.push('👁️ Visión');
  if (n.includes('code') || n.includes('codex')) caps.push('💻 Código');
  if (n.includes('embed') || n.includes('embedding')) caps.push('🔢 Embeddings');
  return caps;
}

function detectVisionByName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  const patterns = [
    'vision', 'vl', 'ocr', 'img', 'clip',
    'llava', 'bakllava', 'moondream', 'cogvlm', 'pixtral',
    'minicpm-v', 'gemma3', 'gemma-3',
    'gpt-4o', 'gpt-4-vision', 'gpt-4-turbo',
    'claude-3', 'claude-3.5', 'claude-4',
    'gemini-1.5', 'gemini-2', 'gemini',
    'kimi', 'glm',
  ];
  return patterns.some(p => n.includes(p));
}

const { ollamaApi } = require('./ollama');

const PROVIDERS = {
  // MODO LOCAL - 100% Privado (delegado a ollama.js robusto)
  local: {
    name: 'Ollama (Local)',
    privacy: 'private',
    requiresKey: false,
    
    async chat({ model, messages, images }) {
      // If images provided, attach them to the last user message (Ollama vision format)
      let finalMessages = messages;
      if (images && images.length > 0) {
        finalMessages = messages.map((m, i) => {
          if (i === messages.length - 1 && m.role === 'user') {
            return { ...m, images };
          }
          return m;
        });
      }

      return ollamaApi.chat({ model, messages: finalMessages });
    },
    
    async listModels() {
      try {
        const data = await ollamaApi.tags();
        const raw = data.models || data.tags || [];

        // Probe each model for vision capabilities via /api/show
        const models = [];
        for (const m of raw) {
          const name = m.name || m.tag || m.id;
          const entry = {
            name,
            size: m.size || 0,
            digest: (m.digest || m.id || '').toString().substring(0, 12) || 'local',
            sizeFormatted: formatBytes(m.size || 0),
            capabilities: detectCapabilities(name),
            supportsVision: false
          };

          try {
            const info = await ollamaApi.show(name);
            const infoKeys = Object.keys(info.model_info || {});
            const ollamaCaps = Array.isArray(info.capabilities) ? info.capabilities : [];
            // Local vision models have .vision.* keys; cloud models have capabilities array
            if (infoKeys.some(k => k.includes('.vision.') || k.includes('image_token'))
                || ollamaCaps.includes('vision')) {
              entry.supportsVision = true;
              if (!entry.capabilities.includes('👁️ Visión')) {
                entry.capabilities.push('👁️ Visión');
              }
            }
          } catch (_) {
            // Unavailable — fallback to name-based detection
            entry.supportsVision = detectVisionByName(name);
          }

          models.push(entry);
        }

        return { models };
      } catch (e) {
        console.warn('Ollama no disponible:', e.message || e);
        return { models: [] };
      }
    },
    
    async status() {
      return ollamaApi.status();
    }
  },

  // OPENAI - Cloud (No privado)
  openai: {
    name: 'OpenAI (Cloud)',
    privacy: 'cloud',
    requiresKey: true,
    baseUrl: 'https://api.openai.com/v1',
    timeout: 120000, // 2 minutes
    
    async chat({ model, messages, apiKey, sanitize = true }) {
      if (!apiKey) throw new Error('API Key requerida para OpenAI');
      
      const processedMessages = messages.map(m => ({
        role: m.role,
        content: sanitize ? sanitizeForCloud(m.content) : m.content
      }));
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'gpt-3.5-turbo',
            messages: processedMessages,
            temperature: 0.7
          }),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `OpenAI Error: ${res.status}`);
        }
        
        const data = await res.json();
        // Normalizar formato para que coincida con Ollama
        return {
          message: {
            role: 'assistant',
            content: data.choices[0].message.content
          }
        };
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    },
    
    async listModels(apiKey) {
      if (!apiKey) return { models: [] };
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error('API Key inválida');
      const data = await res.json();
      return {
        models: data.data
          .filter(m => m.id.includes('gpt'))
          .map(m => ({ name: m.id, size: 0, digest: m.id }))
      };
    }
  },

  // ANTHROPIC - Cloud (No privado)
  anthropic: {
    name: 'Anthropic Claude (Cloud)',
    privacy: 'cloud',
    requiresKey: true,
    baseUrl: 'https://api.anthropic.com/v1',
    timeout: 120000,

    async chat({ model, messages, apiKey, sanitize = true }) {
      if (!apiKey) throw new Error('API Key requerida para Anthropic');

      // Combine ALL system messages (project context + RAG context) into one string
      // Anthropic's API takes a single top-level "system" field
      const systemParts = messages
        .filter(m => m.role === 'system')
        .map(m => sanitize ? sanitizeForCloud(m.content) : m.content)
        .filter(Boolean);
      const systemContent = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

      // Anthropic requires strict user/assistant alternation — merge consecutive same-role msgs
      const rawConversation = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: sanitize ? sanitizeForCloud(m.content) : m.content
        }));

      // Merge consecutive messages of the same role
      const conversation = rawConversation.reduce((acc, msg) => {
        if (acc.length > 0 && acc[acc.length - 1].role === msg.role) {
          acc[acc.length - 1].content += '\n\n' + msg.content;
        } else {
          acc.push({ ...msg });
        }
        return acc;
      }, []);

      // Anthropic requires conversation to start with 'user'
      if (conversation.length > 0 && conversation[0].role !== 'user') {
        conversation.unshift({ role: 'user', content: '.' });
      }
      if (conversation.length === 0) {
        throw new Error('No hay mensajes de usuario para enviar a Anthropic');
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const body = {
          model: model || 'claude-3-5-haiku-20241022',
          max_tokens: 8096,
          messages: conversation
        };
        if (systemContent) body.system = systemContent;

        const res = await fetch(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.status === 401) throw new Error('API Key inválida o expirada');
        if (res.status === 429) throw new Error('Rate limit excedido');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `Anthropic Error: ${res.status}`);
        }

        const data = await res.json();
        return {
          message: {
            role: 'assistant',
            content: data.content[0].text
          }
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') throw new Error('Timeout: Claude está tardando demasiado');
        throw error;
      }
    },

    async listModels(apiKey) {
      if (!apiKey) return { models: [] };
      // Anthropic no tiene endpoint público de modelos — lista actualizada 2025/2026
      return {
        models: [
          { name: 'claude-opus-4-5', size: 0, description: 'Claude Opus 4.5 — máxima capacidad' },
          { name: 'claude-sonnet-4-5-20251001', size: 0, description: 'Claude Sonnet 4.5 — rápido y capaz' },
          { name: 'claude-3-5-sonnet-20241022', size: 0, description: 'Claude 3.5 Sonnet — equilibrio ideal' },
          { name: 'claude-3-5-haiku-20241022', size: 0, description: 'Claude 3.5 Haiku — ultra-rápido' },
          { name: 'claude-3-opus-20240229', size: 0, description: 'Claude 3 Opus — razonamiento profundo' },
          { name: 'claude-3-haiku-20240307', size: 0, description: 'Claude 3 Haiku — económico y veloz' }
        ]
      };
    }
  },

  // GROQ - Cloud (Llama / Mistral family — ultrarrápido)
  groq: {
    name: 'Groq (Cloud — Llama/Mistral)',
    privacy: 'cloud',
    requiresKey: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    timeout: 30000,

    async chat({ model, messages, apiKey, sanitize = true }) {
      if (!apiKey) throw new Error('API Key requerida. Obtén una en console.groq.com');

      const processedMessages = messages.map(m => ({
        role: m.role,
        content: sanitize ? sanitizeForCloud(m.content) : m.content
      }));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: processedMessages,
            temperature: 0.7,
            max_tokens: 8192
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.status === 401) throw new Error('API Key inválida o expirada');
        if (res.status === 429) throw new Error('Rate limit excedido en Groq');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `Groq Error: ${res.status}`);
        }

        const data = await res.json();
        return {
          message: {
            role: 'assistant',
            content: data.choices[0].message.content
          }
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') throw new Error('Timeout: Groq tardó demasiado');
        throw error;
      }
    },

    async listModels(apiKey) {
      if (!apiKey) return { models: [] };
      // Llamar al endpoint real de Groq para obtener modelos actualizados
      try {
        const res = await fetch(`${this.baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (res.ok) {
          const data = await res.json();
          const chatModels = (data.data || [])
            .filter(m => !m.id.includes('whisper') && !m.id.includes('tts'))
            .map(m => ({ name: m.id, size: 0, description: `Groq — ${m.id}` }));
          if (chatModels.length > 0) return { models: chatModels };
        }
      } catch (_) {}
      // Fallback estático si el endpoint falla
      return {
        models: [
          { name: 'llama-3.3-70b-versatile', size: 0, description: 'Llama 3.3 70B — calidad máxima' },
          { name: 'llama-3.1-8b-instant', size: 0, description: 'Llama 3.1 8B — ultra-rápido' },
          { name: 'mixtral-8x7b-32768', size: 0, description: 'Mixtral 8x7B — contexto 32k' },
          { name: 'gemma2-9b-it', size: 0, description: 'Gemma 2 9B — Google' },
          { name: 'deepseek-r1-distill-llama-70b', size: 0, description: 'DeepSeek-R1 70B — razonamiento' }
        ]
      };
    }
  },

  // MOONSHOT / Kimi (Cloud)
  moonshot: {
    name: 'Moonshot AI (Kimi 2.5)',
    privacy: 'cloud',
    requiresKey: true,
    baseUrl: 'https://api.moonshot.cn/v1',
    timeout: 120000,

    async chat({ model, messages, apiKey, sanitize = true }) {
      if (!apiKey) throw new Error('API Key requerida. Obtén una en platform.moonshot.cn');

      const processedMessages = messages.map(m => ({
        role: m.role,
        content: sanitize ? sanitizeForCloud(m.content) : m.content
      }));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'kimi-k2-5-latest',
            messages: processedMessages,
            temperature: 0.3,
            max_tokens: 8192
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.status === 401) throw new Error('API Key inválida o expirada');
        if (res.status === 429) throw new Error('Rate limit excedido (demasiadas peticiones)');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `Moonshot Error: ${res.status}`);
        }

        const data = await res.json();
        return {
          message: {
            role: 'assistant',
            content: data.choices[0].message.content
          }
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') throw new Error('Timeout: Kimi está tardando demasiado');
        throw error;
      }
    },

    async listModels(apiKey) {
      if (!apiKey) return { models: [] };
      return {
        models: [
          { name: 'moonshot-v1-128k', size: 0, description: 'Moonshot 128k — contexto ultra largo' },
          { name: 'moonshot-v1-32k', size: 0, description: 'Moonshot 32k — uso general' },
          { name: 'moonshot-v1-8k', size: 0, description: 'Moonshot 8k — rápido y económico' },
          { name: 'kimi-k2', size: 0, description: 'Kimi K2 — razonamiento avanzado (256k ctx)' }
        ]
      };
    }
  },

  // LLAMA.CPP - Local (servidor OpenAI-compatible)
  llamacpp: {
    name: 'llama.cpp (Local)',
    privacy: 'private',
    requiresKey: false,
    baseUrl: 'http://127.0.0.1:8080/v1',
    timeout: 300000, // 5 min — modelos grandes son lentos

    async chat({ model, messages }) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model || 'default',
            messages,
            temperature: 0.7,
            stream: false
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `llama.cpp Error: ${res.status}`);
        }
        const data = await res.json();
        return {
          message: {
            role: 'assistant',
            content: data.choices[0].message.content
          }
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') throw new Error('Timeout: llama.cpp tardó demasiado. Prueba un modelo más pequeño.');
        if (error.code === 'ECONNREFUSED') throw new Error('llama.cpp no está corriendo. Inicia con: ./server -m modelo.gguf --port 8080');
        throw error;
      }
    },

    async listModels() {
      try {
        const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { models: [] };
        const data = await res.json();
        return {
          models: (data.data || []).map(m => ({
            name: m.id,
            size: 0,
            digest: m.id,
            description: `llama.cpp — ${m.id}`
          }))
        };
      } catch (_) {
        return { models: [] };
      }
    },

    async status() {
      try {
        const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return { ok: true, message: 'llama.cpp server activo' };
        return { ok: false, message: 'llama.cpp responde con error' };
      } catch (_) {
        return { ok: false, message: 'llama.cpp no está corriendo. Inicia con: ./server -m modelo.gguf --port 8080' };
      }
    }
  }
};

class AIProviderManager {
  constructor(db) {
    this.db = db;
    this.currentProvider = 'local';
    this.apiKeys = {};
    this.sanitizeCloud = true;
    
    // Initialize encryption key with app userData path
    try {
      const { app } = require('electron');
      getEncryptionKey(app.getPath('userData'));
    } catch (_) {
      getEncryptionKey(null);
    }
    
    this.init();
  }
  
  init() {
    // Cargar configuración guardada
    const stmt = this.db.prepare('SELECT key, value FROM app_state WHERE key IN (?, ?, ?, ?, ?)');
    const rows = stmt.all('ai_provider', 'openai_key', 'anthropic_key', 'groq_key', 'moonshot_key');
    
    rows.forEach(row => {
      if (row.key === 'ai_provider') this.currentProvider = row.value;
      if (row.key === 'openai_key') this.apiKeys.openai = decrypt(row.value);
      if (row.key === 'anthropic_key') this.apiKeys.anthropic = decrypt(row.value);
      if (row.key === 'groq_key') this.apiKeys.groq = decrypt(row.value);
      if (row.key === 'moonshot_key') this.apiKeys.moonshot = decrypt(row.value);
    });
  }
  
  setProvider(providerId) {
    if (!PROVIDERS[providerId]) throw new Error('Proveedor no válido');
    this.currentProvider = providerId;
    
    const stmt = this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
    stmt.run('ai_provider', providerId);
    
    return { provider: providerId, privacy: PROVIDERS[providerId].privacy };
  }
  
  getProvider() {
    const config = PROVIDERS[this.currentProvider];
    return {
      id: this.currentProvider,
      name: config.name,
      privacy: config.privacy,
      requiresKey: config.requiresKey,
      privacyLabel: config.privacy === 'private' ? 'Privado' : 'Cloud'
    };
  }
  
  setApiKey(provider, key) {
    if (!PROVIDERS[provider].requiresKey) return false;
    this.apiKeys[provider] = key;
    
    const stmt = this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
    stmt.run(`${provider}_key`, encrypt(key));
    return true;
  }
  
  async chat(params) {
    const provider = PROVIDERS[this.currentProvider];
    
    const paramsWithKey = {
      ...params,
      apiKey: this.apiKeys[this.currentProvider],
      sanitize: this.sanitizeCloud
    };
    
    return provider.chat(paramsWithKey);
  }
  
  async listModels() {
    const provider = PROVIDERS[this.currentProvider];
    if (this.currentProvider === 'local') {
      return provider.listModels();
    }
    return provider.listModels(this.apiKeys[this.currentProvider]);
  }
  
  async status() {
    if (this.currentProvider === 'local') {
      return PROVIDERS.local.status();
    }
    if (this.currentProvider === 'llamacpp') {
      return PROVIDERS.llamacpp.status();
    }
    return {
      ok: !!this.apiKeys[this.currentProvider],
      message: this.apiKeys[this.currentProvider] ? 'API Key configurada' : 'API Key requerida'
    };
  }
  
  getAllProviders() {
    return Object.entries(PROVIDERS).map(([id, config]) => ({
      id,
      name: config.name,
      privacy: config.privacy,
      requiresKey: config.requiresKey,
      current: id === this.currentProvider
    }));
  }
}

module.exports = { AIProviderManager, PROVIDERS };