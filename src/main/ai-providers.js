// src/main/ai-providers.js
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  describirError, sanearMensaje, errorDeRespuesta, ProviderError,
  probeDeError, probeDeExito, probeDeRespuestaInvalida, probeNoIntentada
} = require('./provider-errors');
const {
  getProviderContract,
  resolveVisionSupport,
  describeVisionBlock,
  assertVisionSupported,
  normalizeChatResult,
  attachOpenAIImages,
  buildAnthropicImageBlocks
} = require('./provider-capabilities');
const {
  sanitizeForCloud, formatBytes, detectCapabilities, createAbortContext, probeOllamaVision
} = require('./provider-runtime');

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




// Solo se conserva como heurística de sugerencia para catálogos sin sonda.
// Prohibido usarla para autorizar el envío de imágenes.
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

function isProviderNetworkError(error) {
  if (!error || error.name === 'AbortError') return false;
  const details = [
    error.name,
    error.code,
    error.message,
    error.cause?.name,
    error.cause?.code,
    error.cause?.message
  ].filter(Boolean).join(' ');
  return /fetch failed|UND_ERR_CONNECT_TIMEOUT|ConnectTimeoutError|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(details);
}

function normalizeProviderNetworkError(_error, providerLabel = 'el proveedor') {
  return `No se pudo conectar con ${providerLabel}. Revisa conexión, VPN, endpoint o vuelve a intentar.`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}


async function fetchWithProviderRetry(url, options = {}, context = {}) {
  const providerLabel = context.providerLabel || 'el proveedor';
  const attempts = Math.max(1, Math.floor(Number(context.attempts) || 2));
  const retryDelayMs = Math.max(0, Number(context.retryDelayMs) || 700);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) throw error;
      if (!isProviderNetworkError(error)) throw error;
      if (attempt === attempts) {
        throw new Error(normalizeProviderNetworkError(error, providerLabel));
      }
      await delay(retryDelayMs * attempt);
    }
  }
  throw new Error(normalizeProviderNetworkError(null, providerLabel));
}

function getAlibabaHttpError(status) {
  if (status === 401 || status === 403) {
    return 'Alibaba Cloud Model Studio rechazó la autenticación. Revisa la API key y permisos.';
  }
  if (status === 429) {
    return 'Alibaba Cloud Model Studio limitó la solicitud. Espera unos segundos y vuelve a intentar.';
  }
  if (status >= 500 && status <= 599) {
    return 'Alibaba Cloud Model Studio no pudo procesar la solicitud temporalmente. Vuelve a intentar.';
  }
  return `Alibaba Cloud Model Studio respondió con estado HTTP ${status}.`;
}

const ALIBABA_PROVIDER_ID = 'alibaba';
const ALIBABA_CONFIG_KEY = 'alibaba_config';
const ALIBABA_TOKEN_PLAN_ENDPOINT = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic';
const ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const ALIBABA_DEFAULT_MODEL_ID = 'qwen3.7-max';
// Únicos modos de plan visual autorizados a producir una imagen como respuesta terminal.
const GENERATIVE_VISUAL_MODES = ['image-generation', 'image-edit', 'image-variation'];
// Señales ya existentes de detectUserIntentDetailed, clasificadas para detectar
// cuándo una misma solicitud pide análisis y generación a la vez.
const ANALYSIS_INTENT_SIGNALS = [
  'analysis-verb',
  'visual-explanation-request',
  'descriptive-visual-question'
];
const GENERATIVE_INTENT_SIGNALS = [
  'from-scratch-generation',
  'reference-variation',
  'apply-suggestions-and-generate',
  'generate-new-visual-from-reference',
  'edit-operation',
  'approximate-edit-verb',
  'background-target',
  'color-target'
];
// Margen a partir del cual una instrucción generativa se considera dominante de
// forma segura pese a que también haya señales de análisis.
const UNAMBIGUOUS_GENERATION_MARGIN = 10;
const ALIBABA_TOKEN_PLAN_MODELS = [
  { id: ALIBABA_DEFAULT_MODEL_ID, taskType: 'chat', vision: false, reasoning: true },
  { id: 'GLM-5.2', taskType: 'chat', vision: false, reasoning: null },
  { id: 'deepseek-v4-pro', taskType: 'chat', vision: false, reasoning: true },
  { id: 'qwen3.8-max-preview', taskType: 'vision', vision: true, reasoning: true },
  { id: 'qwen3.7-plus', taskType: 'vision', vision: true, reasoning: true },
  { id: 'qwen3.6-flash', taskType: 'vision', vision: true, reasoning: true },
  { id: 'wan2.7-image', taskType: 'image-generation', vision: null, reasoning: null },
  { id: 'wan2.7-image-pro', taskType: 'image-generation', vision: null, reasoning: null },
  { id: 'happyhorse-1.1-t2v', taskType: 'video-generation', vision: null, reasoning: null },
  { id: 'happyhorse-1.1-i2v', taskType: 'video-generation', vision: null, reasoning: null },
  { id: 'happyhorse-1.1-r2v', taskType: 'video-generation', vision: null, reasoning: null }
];
const ALIBABA_TASK_TYPES = new Set(['chat', 'vision', 'image-generation', 'video-generation']);
// Límite de salida por defecto para chat y visión. El valor legado (1024) cortaba las
// respuestas a mitad de frase, así que se migra en los modelos oficiales.
const ALIBABA_DEFAULT_MAX_TOKENS = 8192;
const ALIBABA_LEGACY_MAX_TOKENS = 1024;
const ALIBABA_TEXT_TASK_TYPES = ['chat', 'vision'];

// Solo para modelos oficiales: si no hay límite o si es el legado, se usa el nuevo
// default. Un valor elegido a mano por la usuaria se respeta tal cual.
function migrateAlibabaOfficialMaxTokens(parameters, taskType) {
  const current = parameters && typeof parameters === 'object' ? parameters : {};
  if (!ALIBABA_TEXT_TASK_TYPES.includes(taskType)) return current;
  if (Number.isFinite(current.max_tokens) && current.max_tokens !== ALIBABA_LEGACY_MAX_TOKENS) {
    return current;
  }
  return { ...current, max_tokens: ALIBABA_DEFAULT_MAX_TOKENS };
}

function createAlibabaPresetModel(preset) {
  return {
    id: preset.id,
    displayName: preset.id,
    taskType: preset.taskType,
    capabilities: {
      tools: null,
      vision: preset.vision,
      reasoning: preset.reasoning,
      streaming: null,
      structuredJson: null
    },
    parameters: ALIBABA_TEXT_TASK_TYPES.includes(preset.taskType)
      ? { max_tokens: ALIBABA_DEFAULT_MAX_TOKENS }
      : {}
  };
}

const ALIBABA_DEFAULT_CONFIG = {
  mode: 'token-plan',
  endpoint: ALIBABA_TOKEN_PLAN_ENDPOINT,
  protocol: 'anthropic-compatible',
  region: 'ap-southeast-1',
  workspace: '',
  billingMode: 'token-plan',
  models: ALIBABA_TOKEN_PLAN_MODELS.map(createAlibabaPresetModel)
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeAlibabaModel(model) {
  const id = String(model?.id || model?.name || '').trim();
  if (!id || id.length > 200) throw new Error('Identificador de modelo no válido');
  const capabilities = model?.capabilities && typeof model.capabilities === 'object'
    ? model.capabilities
    : {};
  const parameters = model?.parameters && typeof model.parameters === 'object' && !Array.isArray(model.parameters)
    ? model.parameters
    : {};
  const reservedParameters = ['model', 'messages', 'system', 'stream'];
  if (Object.keys(parameters).some(key => reservedParameters.includes(key))) {
    throw new Error('Los parámetros del modelo contienen campos reservados');
  }
  if (JSON.stringify(parameters).length > 16384) throw new Error('Parámetros del modelo demasiado grandes');
  return {
    id,
    displayName: String(model?.displayName || id).trim().slice(0, 200),
    taskType: ALIBABA_TASK_TYPES.has(model?.taskType) ? model.taskType : 'chat',
    capabilities: {
      tools: capabilities.tools === true ? true : capabilities.tools === false ? false : null,
      vision: capabilities.vision === true ? true : capabilities.vision === false ? false : null,
      reasoning: capabilities.reasoning === true ? true : capabilities.reasoning === false ? false : null,
      streaming: capabilities.streaming === true ? true : capabilities.streaming === false ? false : null,
      structuredJson: capabilities.structuredJson === true ? true : capabilities.structuredJson === false ? false : null
    },
    parameters
  };
}

function normalizeAlibabaModels(models, previousModels) {
  const byId = new Map();
  const normalizeModels = (items) => {
    const normalizedItems = [];
    if (!Array.isArray(items)) return normalizedItems;
    for (const item of items) {
      try {
        normalizedItems.push(normalizeAlibabaModel(item));
      } catch (_) {
        // Invalid catalog entries are ignored; presets below keep the provider usable.
      }
    }
    return normalizedItems;
  };
  const addModels = (items) => {
    for (const normalized of items) {
      byId.set(normalized.id, normalized);
    }
  };
  const normalizedSource = normalizeModels(models);
  const presets = normalizeModels(ALIBABA_TOKEN_PLAN_MODELS.map(createAlibabaPresetModel));
  addModels(presets);
  if (normalizedSource.length === 0) addModels(normalizeModels(previousModels));
  addModels(normalizedSource);
  // Official preset metadata wins over stale persisted null capabilities.
  // El límite de salida legado se migra aquí: una config guardada con 1024 no puede
  // seguir truncando respuestas. Los modelos manuales/custom no pasan por este bucle.
  for (const preset of presets) {
    const current = byId.get(preset.id);
    byId.set(preset.id, {
      ...current,
      taskType: preset.taskType,
      capabilities: {
        ...current.capabilities,
        vision: preset.capabilities.vision,
        reasoning: preset.capabilities.reasoning
      },
      parameters: migrateAlibabaOfficialMaxTokens(current.parameters, preset.taskType)
    });
  }
  return Array.from(byId.values());
}

function normalizeAlibabaConfig(input, previous = ALIBABA_DEFAULT_CONFIG) {
  const source = input && typeof input === 'object' ? input : {};
  const protocol = String(source.protocol ?? previous.protocol ?? '').trim();
  if (protocol !== 'anthropic-compatible') throw new Error('Protocolo de Alibaba no compatible');

  const billingMode = String(source.billingMode ?? previous.billingMode ?? 'token-plan').trim().slice(0, 100) || 'token-plan';
  const mode = String(source.mode ?? previous.mode ?? billingMode).trim().slice(0, 100) || 'token-plan';
  const workspace = String(source.workspace ?? previous.workspace ?? '').trim().slice(0, 200);
  const region = String(source.region ?? previous.region ?? '').trim().slice(0, 100);
  let endpoint = String(source.endpoint ?? previous.endpoint ?? '').trim().replace(/\/+$/, '');
  if (!endpoint || endpoint.length > 2048) throw new Error('Endpoint de Alibaba no válido');

  const workspacePlaceholder = /<workspace-id>|\{WorkspaceId\}/gi;
  if (workspacePlaceholder.test(endpoint)) {
    if (billingMode === 'token-plan') {
      endpoint = ALIBABA_TOKEN_PLAN_ENDPOINT;
    } else if (!workspace) {
      throw new Error('Configura el Workspace de Alibaba para completar el endpoint');
    } else if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/.test(workspace)) {
      throw new Error('Workspace de Alibaba no válido');
    } else {
      endpoint = endpoint.replace(workspacePlaceholder, workspace);
    }
  }
  if (/[<>]/.test(endpoint) || /\{WorkspaceId\}/i.test(endpoint) || /workspace-id/i.test(endpoint)) {
    throw new Error('El endpoint de Alibaba contiene un Workspace sin resolver');
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (_) {
    throw new Error('Endpoint de Alibaba no válido');
  }
  if (parsed.protocol !== 'https:') throw new Error('El endpoint de Alibaba debe usar HTTPS');
  const endpointPath = parsed.pathname.toLowerCase().replace(/\/+$/, '');
  if (
    endpointPath.endsWith('/v1/messages')
    || endpointPath.endsWith('/compatible-mode/v1')
    || endpointPath.endsWith('/v1')
  ) {
    throw new Error('Usa el endpoint base Anthropic-compatible sin /v1 ni /v1/messages');
  }
  if (!endpointPath.endsWith('/apps/anthropic')) {
    throw new Error('El endpoint Anthropic-compatible debe terminar en /apps/anthropic');
  }

  const models = normalizeAlibabaModels(source.models, previous.models);
  return {
    mode,
    endpoint,
    protocol,
    region,
    workspace,
    billingMode,
    models
  };
}

function buildAnthropicMessagesPayload({ model, messages, images = [], sanitize = true }) {
  const systemParts = messages
    .filter(message => message.role === 'system')
    .map(message => sanitize ? sanitizeForCloud(message.content) : message.content)
    .filter(Boolean);
  const rawConversation = messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: sanitize ? sanitizeForCloud(message.content) : message.content
    }));
  const conversation = rawConversation.reduce((result, message) => {
    const previous = result[result.length - 1];
    if (previous?.role === message.role) previous.content += '\n\n' + message.content;
    else result.push({ ...message });
    return result;
  }, []);
  if (conversation[0]?.role !== 'user') conversation.unshift({ role: 'user', content: '.' });
  if (!conversation.length) throw new Error('No hay mensajes de usuario para enviar a Alibaba');
  if (images.length) {
    if (model.capabilities?.vision !== true) {
      throw new Error('Este modelo no analiza imágenes. Cambia a qwen3.7-plus, qwen3.8-max-preview o qwen3.6-flash.');
    }
    const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
    const imageBlocks = images.map(image => {
      if (image?.url) {
        let parsedUrl;
        try {
          parsedUrl = new URL(image.url);
        } catch (_) {
          throw new Error('URL de imagen no válida');
        }
        if (parsedUrl.protocol !== 'https:') throw new Error('La URL de imagen debe usar HTTPS');
        return { type: 'image', source: { type: 'url', url: parsedUrl.toString() } };
      }
      const mediaType = String(image?.mediaType || image?.media_type || '').toLowerCase();
      if (!supportedTypes.has(mediaType)) {
        throw new Error('Formato de imagen no compatible. Usa PNG, JPEG o WebP.');
      }
      const data = String(image?.base64 || image?.data || '').replace(/^data:[^;]+;base64,/, '');
      if (!data) throw new Error('La imagen adjunta está vacía');
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    const lastUser = [...conversation].reverse().find(message => message.role === 'user');
    lastUser.content = [{ type: 'text', text: lastUser.content }, ...imageBlocks];
  }

  const body = { ...model.parameters, model: model.id, messages: conversation };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  return body;
}

function formatAlibabaHttpError(error, status, fallbackLabel) {
  const message = error?.error?.message || error?.message || `${fallbackLabel}: ${status}`;
  const code = error?.error?.code || error?.code;
  const requestId = error?.request_id || error?.requestId || error?.error?.request_id;
  return [message, code && `Código: ${code}`, requestId && `Request ID: ${requestId}`]
    .filter(Boolean)
    .join(' · ');
}

function normalizeAlibabaInputImage(image) {
  if (!image || typeof image !== 'object') {
    throw new Error('La imagen de referencia no es válida');
  }

  const url = String(image.url || '').trim();
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      throw new Error('La URL de la imagen de referencia no es válida');
    }

    if (parsed.protocol !== 'https:') {
      throw new Error('La imagen remota de referencia debe usar HTTPS');
    }

    return parsed.toString();
  }

  const mediaType = String(image.mediaType || image.media_type || '').toLowerCase();
  const allowedTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/bmp']);

  if (!allowedTypes.has(mediaType)) {
    throw new Error('Formato de imagen de referencia no compatible');
  }

  const base64 = String(image.base64 || image.data || '')
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '');

  if (!base64) {
    throw new Error('La imagen de referencia está vacía');
  }

  return `data:${mediaType};base64,${base64}`;
}

function normalizeIntentText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(?:cambibia|canbia|cambiale)\b/g, 'cambia')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractVisualSuggestions(analysisText) {
  const text = String(analysisText || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { suggestions: [], source: 'none' };
  const cleanSuggestion = value => String(value || '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const structured = text
    .split('\n')
    .filter(line => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line))
    .map(cleanSuggestion)
    .filter(Boolean)
    .slice(0, 6);
  if (structured.length) return { suggestions: structured, source: 'structured' };
  const heuristic = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => /\b(sugier|recom|mejor|conviene|podri|deberi|ajust|cambi)\w*/i.test(sentence))
    .map(cleanSuggestion)
    .filter(Boolean)
    .slice(0, 6);
  return heuristic.length
    ? { suggestions: heuristic, source: 'heuristic' }
    : { suggestions: [], source: 'none' };
}

function hasApproximateVisualEditVerb(normalizedText) {
  const targets = ['cambia', 'modifica', 'edita', 'quita', 'agrega', 'reemplaza', 'sustituye'];
  const distance = (left, right) => {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= right.length; j++) {
        const saved = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
        previous = saved;
      }
    }
    return row[right.length];
  };
  return normalizedText.split(' ').some(token =>
    token.length >= 4 && targets.some(target => Math.abs(token.length - target.length) <= 2 && distance(token, target) <= 2)
  );
}

// Verbos que abren una creación. `rediseña` queda FUERA a propósito: implica
// que ya existe algo que rediseñar.
const CREATE_FROM_SCRATCH_VERB = '(?:crea|crear|creame|genera|generar|generame|dibuja|dibujar|dibujame|ilustra|ilustrame|pinta|pintame|hazme|haz|disena|disename)';
const CREATE_FROM_SCRATCH_LEAD = '(?:por favor\\s+|porfa\\s+|quiero que\\s+|quiero\\s+|puedes\\s+|podrias\\s+|me\\s+)*';
const CREATE_FROM_SCRATCH_RE = new RegExp(`^${CREATE_FROM_SCRATCH_LEAD}${CREATE_FROM_SCRATCH_VERB}\\b`);

// Marcadores que delatan una referencia a algo ya existente. Si aparece
// cualquiera, la orden NO es autosuficiente y se resuelve por el camino normal.
// Son deliberadamente específicos: un demostrativo suelto ("que esta en la
// oficina") no puede bloquear una creación legítima.
const ANAPHORIC_MARKERS = [
  /\b(?:est[ae]|es[ae])\s+(?:imagen|foto|fotografia|tarjeta|logo|diseno|captura|escena|version|composicion|ilustracion)\b/,
  /\banterior(?:es)?\b/,
  // "otra/nueva VERSIÓN" sí es anáfora; "otra/nueva IMAGEN" no lo es por sí
  // sola: "crea una nueva imagen de una playa" es una creación legítima.
  /\b(?:otra|otro|nueva|nuevo)\s+(?:version|opcion|variante)\b/,
  /\bmism[ao]\b/,
  /\b(?:mejor|peor)\b/,
  /\bbasad[oa]\s+en\b/,
  /\bcon\s+(?:esos|estos|los)\s+cambios\b/,
  /\b(?:conserva|conservando|preserva|preservando|manten|manteniendo)\b/,
  /\b(?:usa|con|sobre|desde|para)\s+la\s+(?:imagen|foto|tarjeta|captura)\b/,
  /\b(?:ponlo|ponla|quitalo|quitala|cambiala|cambialo|hazlo|hazla|dejalo|dejala|vuelvelo|vuelvela|modificala|modificalo|editala|editalo)\b/,
  /\bredisen/
];

// El adjunto del turno se usa SOLO si el texto lo menciona.
const ATTACHMENT_REQUIRED_RE = /\b(?:usa|usando|utiliza|toma|parte|basate|basandote|con|sobre|desde|para)\s+(?:est[ae]|es[ae]|la|el)\s+(?:imagen|foto|fotografia|tarjeta|captura|logo|adjunto|archivo)\b|\bcomo\s+referencia\b|\b(?:la|el)\s+(?:imagen|foto|archivo)\s+adjunt[ao]\b|\b(?:est[ae]|es[ae])\s+(?:imagen|foto|fotografia|tarjeta|captura|logo)\b/;

// Y se prohíbe explícitamente si el texto lo excluye.
const ATTACHMENT_FORBIDDEN_RE = /\bdesde cero\b|\b(?:sin|no)\s+(?:usar|uses|utilizar|utilices|tomar|tomes)\s+(?:la|el|est[ae])?\s*(?:imagen|foto|tarjeta|adjunto|referencia)\b|\bignora\s+(?:la|el|est[ae])\s+(?:imagen|foto|adjunto)\b/;

/**
 * ¿Es el texto una orden autosuficiente de crear un concepto o escena nueva?
 *
 * Motivo: en un chat con historial visual, "crea una imagen de una chica en la
 * oficina…" activaba a la vez `referencesPrevious` (por el artículo "la") y
 * `hasImplicitVisualSignal` (por "imagen", "rojo", "azul"), y el resolutor
 * entregaba la última imagen generada como fuente. El mismo texto en un chat
 * nuevo funcionaba, porque no había candidatos.
 */
function detectCreateFromScratch(normalizedText) {
  const text = String(normalizedText || '');
  if (!CREATE_FROM_SCRATCH_RE.test(text)) return false;
  return !ANAPHORIC_MARKERS.some(marker => marker.test(text));
}

function resolveVisualContext({
  text = '',
  attachments = [],
  chatId = null,
  lastUserImage = null,
  lastUploadedImage = null,
  lastGeneratedImage = null,
  lastAnalyzedImage = null
} = {}) {
  const normalizedText = normalizeIntentText(text);
  const currentImage = Array.isArray(attachments)
    ? attachments.find(item => item?.type === 'image' || String(item?.mediaType || '').startsWith('image/'))
    : null;
  // Hueco preexistente: la familia cambiala/modificala/editala/retocala no
  // estaba, así que "cámbiala" a secas no resolvía ninguna imagen previa
  // — el pronombre enclítico es exactamente la referencia anafórica.
  const referencesPrevious = /\b(anterior|esa|esta|la|del|de la|de esta|de esa|ponlo|ponla|quitalo|quitala|hazlo|hazla|dejalo|dejala|vuelvelo|vuelvela|cambiala|cambialo|modificala|modificalo|editala|editalo|retocala|retocalo|arreglala|arreglalo|basad[oa] en|mismo plano|misma linea visual|otra opcion|nueva version|version nueva|otra version|nueva imagen con esos cambios)\b/.test(normalizedText);
  const hasImplicitVisualSignal = /\b(fondo|color|imagen|foto|captura|pantalla|screenshot|codigo|logo|producto|empaque|texto|objeto|contenido|vasija|tarjeta|diseno|composicion|azul|rojo|verde|dorado|blanco|negro|oscuro|claro|moderno|grande|pequeno|alineado|de frente)\b/.test(normalizedText)
    || /\bmas\s+(oscuro|claro|moderno|grande|pequeno|legible)\b/.test(normalizedText);
  const belongsToChat = imageRef => imageRef && (!chatId || imageRef.chatId === chatId);
  const createFromScratch = detectCreateFromScratch(normalizedText);
  if (currentImage) {
    if (!chatId || !currentImage.chatId || currentImage.chatId === chatId) {
      // Política explícita para el adjunto del turno. Antes se devolvía siempre,
      // así que "crea una imagen de X" con un adjunto no mencionado lo
      // convertía en edición sin decirlo.
      if (ATTACHMENT_FORBIDDEN_RE.test(normalizedText)) {
        return {
          hasVisualContext: false, source: null, imageRef: null, confidence: 0,
          createFromScratch: true, policy: 'forbidden-current-attachment'
        };
      }
      if (ATTACHMENT_REQUIRED_RE.test(normalizedText)) {
        return {
          hasVisualContext: true, source: 'current-attachment', imageRef: currentImage,
          confidence: 1, createFromScratch: false, policy: 'required-current-attachment'
        };
      }
      // Orden autosuficiente + adjunto NO mencionado: se crea desde cero. El
      // adjunto sigue visible y persistido, simplemente no viaja al generador.
      if (createFromScratch) {
        return {
          hasVisualContext: false, source: null, imageRef: null, confidence: 0,
          createFromScratch: true, policy: 'forbidden-unmentioned-attachment'
        };
      }
      return {
        hasVisualContext: true, source: 'current-attachment', imageRef: currentImage,
        confidence: 1, createFromScratch: false
      };
    }
  }
  // POLÍTICA FORBIDDEN: una orden autosuficiente de creación no puede heredar
  // ninguna imagen del historial. La memoria visual sigue almacenada en el chat
  // —"ahora ponlo verde" la seguirá encontrando— pero no viaja al generador.
  if (createFromScratch) {
    return {
      hasVisualContext: false,
      source: null,
      imageRef: null,
      confidence: 0,
      createFromScratch: true,
      policy: 'forbidden-historical-reference'
    };
  }
  if (referencesPrevious || hasImplicitVisualSignal) {
    const candidates = [
      { source: 'previous-user-image', imageRef: lastUserImage, confidence: 0.95, priority: 4 },
      { source: 'previous-user-image', imageRef: lastUploadedImage, confidence: 0.95, priority: 3 },
      { source: 'previous-generated-image', imageRef: lastGeneratedImage, confidence: 0.9, priority: 2 },
      { source: 'previous-analyzed-image', imageRef: lastAnalyzedImage, confidence: 0.9, priority: 1 }
    ].filter(candidate => belongsToChat(candidate.imageRef));
    candidates.sort((a, b) =>
      (Number(b.imageRef.updatedAt) - Number(a.imageRef.updatedAt)) || (b.priority - a.priority)
    );
    if (candidates[0]) {
      const { source, imageRef, confidence } = candidates[0];
      return { hasVisualContext: true, source, imageRef, confidence, createFromScratch: false };
    }
  }
  return {
    hasVisualContext: false, source: null, imageRef: null, confidence: 0,
    createFromScratch: false
  };
}

function detectUserIntentDetailed(input = {}) {
  const normalizedText = normalizeIntentText(input.text);
  const visualContext = resolveVisualContext(input);
  const matchedSignals = [];
  const editSubtypes = [];
  const variationSignals = [];
  const scores = {
    'normal-chat': 1,
    'vision-analysis': 0,
    'image-edit': 0,
    'image-variation': 0,
    'image-generation': 0,
    'video-generation': 0,
    'ambiguous-visual': 0
  };
  const add = (intent, score, signal) => {
    scores[intent] += score;
    matchedSignals.push(signal);
  };

  if (/\b(crea|crear|genera|generar|haz|hacer|produce|producir)\b[\s\S]{0,40}\bvideo\b/.test(normalizedText)) {
    add('video-generation', 10, 'video-request');
  }
  if (/\b(analiza|analizar|describe|describir|explica|explicar|lee|leer|mira|mirar|ve|ves|ver|observa|observar|identifica|identificar)\b/.test(normalizedText)) {
    add('vision-analysis', visualContext.hasVisualContext ? 9 : 3, 'analysis-verb');
  }
  const visualExplanationPattern = /\b(explicame|explica|analiza|interpreta|revisa|lee|describe|ayudame a entender|que hace|que significa|que ves)\b[\s\S]{0,60}\b(codigo|imagen|captura|pantalla|screenshot|foto)\b/;
  if (visualContext.hasVisualContext && visualExplanationPattern.test(normalizedText)) {
    add('vision-analysis', 12, 'visual-explanation-request');
  }
  if (/\bque\s+(color\s+tiene|logo\s+aparece|aparece|hay|ves)\b/.test(normalizedText)) {
    add('vision-analysis', visualContext.hasVisualContext ? 9 : 3, 'descriptive-visual-question');
  }
  const applySuggestionsPattern = /\b(aplica|usa|haz|toma)\b[\s\S]{0,45}\b(cambios|mejoras|recomendaciones)\b[\s\S]{0,25}\b(sugerid[oa]s?|anteriores|que sugeriste)\b|\baplica las recomendaciones\b|\bcon esos cambios\b/;
  const createNewVisualPattern = /\b(crea|crear|genera|generar)\b[\s\S]{0,30}\b(nueva imagen|imagen nueva|nueva version|version nueva)\b/;
  const requestsFromScratch = /\bdesde cero\b/.test(normalizedText);
  const appliesPreviousSuggestions = applySuggestionsPattern.test(normalizedText);
  const createsReferencedVariation = createNewVisualPattern.test(normalizedText);
  const variationPattern = /\b(nueva version|otra version|otra opcion|misma linea visual|basad[oa] en (esta|esa|la)|version mas|nueva imagen con esos cambios)\b/;
  if (variationPattern.test(normalizedText)) {
    add('image-variation', visualContext.hasVisualContext ? 11 : 6, 'reference-variation');
    variationSignals.push('reference-based-version');
  }
  if (appliesPreviousSuggestions) {
    variationSignals.push('apply-previous-suggestions');
  }
  if (appliesPreviousSuggestions && createsReferencedVariation && !requestsFromScratch) {
    add('image-variation', visualContext.hasVisualContext ? 20 : 14, 'apply-suggestions-and-generate');
  } else if (visualContext.hasVisualContext && createsReferencedVariation && !requestsFromScratch) {
    add('image-variation', 12, 'generate-new-visual-from-reference');
    variationSignals.push('reference-based-version');
  }
  const editVerb = /\b(edita|editar|cambia|cambiar|cambio|modifica|modificar|quita|quitar|remueve|remover|elimina|eliminar|agrega|agregar|anade|anadir|sustituye|sustituir|reemplaza|reemplazar|pon|poner|coloca|colocar|hazle|hazlo|dejalo|vuelvelo|mueve|mover|agranda|agrandar|reduce|reducir|alinea|alinear|redisena|redisenar|moderniza|modernizar|renueva|renovar|actualiza|actualizar)\b|hacer(?:la|lo)?\s+mas/;
  if (editVerb.test(normalizedText) && visualContext.hasVisualContext) add('image-edit', 9, 'edit-operation');
  else if (visualContext.hasVisualContext && hasApproximateVisualEditVerb(normalizedText)) add('image-edit', 7, 'approximate-edit-verb');
  if (/\bfondo\b/.test(normalizedText)) {
    editSubtypes.push('background-change');
    if (visualContext.hasVisualContext) add('image-edit', 4, 'background-target');
  }
  if (/\bcolor\b|\b(azul|rojo|verde|dorado|blanco|negro|gris)\b/.test(normalizedText)) {
    editSubtypes.push('color-change');
    if (visualContext.hasVisualContext) add('image-edit', 3, 'color-target');
  }
  if (/\b(quita|remueve|elimina)\b.*\bfondo\b/.test(normalizedText)) editSubtypes.push('background-removal');
  if (/\b(agrega|anade|pon)\b/.test(normalizedText)) editSubtypes.push('element-addition');
  if (/\b(reemplaza|sustituye)\b/.test(normalizedText)) editSubtypes.push('element-replacement');
  if (/\b(moderno|hazlo|dejalo|vuelvelo|redisena|redisenar|moderniza|modernizar|renueva|renovar|actualiza|actualizar)\b/.test(normalizedText)) editSubtypes.push('style-change');
  if (/\b(agranda|reduce|mas grande|mas pequeno)\b/.test(normalizedText)) editSubtypes.push('resize');
  if (/\b(mueve|alinea|mismo plano|en linea|de frente)\b/.test(normalizedText)) editSubtypes.push('layout-adjustment');

  // Tres formas de pedir una imagen nueva. Antes solo se reconocía la primera,
  // así que "dibuja un gato" o "crea una fotografía de…" caían en normal-chat.
  const createsImage =
    // 1. verbo de creación + sustantivo visual cercano
    /\b(crea|crear|creame|genera|generar|generame|dibuja|dibujar|produce|producir|disena|disenar)\b[\s\S]{0,50}\b(imagen|image|ilustracion|dibujo|fotografia|foto|escena|render|retrato|poster|cartel|logo|wallpaper|pintura)\b/.test(normalizedText)
    // 2. verbo intrínsecamente gráfico: "dibuja un gato" no necesita sustantivo
    || /\b(dibuja|dibujame|dibujar|ilustra|ilustrame|ilustrar|pinta|pintame|pintar)\b/.test(normalizedText)
    // 3. "desde cero" con verbo de creación
    || /\b(crea|crear|genera|generar|haz|hazme)\b[\s\S]{0,30}\bdesde cero\b/.test(normalizedText);
  if (createsImage && !visualContext.hasVisualContext) add('image-generation', 10, 'from-scratch-generation');
  if (visualContext.hasVisualContext) add('ambiguous-visual', 2, 'visual-context-present');

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let [intent, score] = ranked[0];
  const secondScore = ranked[1][1];
  if (appliesPreviousSuggestions && createsReferencedVariation && !requestsFromScratch) {
    intent = 'image-variation';
    score = scores['image-variation'];
  }
  if (visualContext.hasVisualContext && score <= 2) intent = 'ambiguous-visual';
  if (intent === 'normal-chat' && visualContext.hasVisualContext) intent = 'ambiguous-visual';
  const usesPreviousImageContext = Boolean(visualContext.hasVisualContext && visualContext.source !== 'current-attachment');
  const analysisSignals = matchedSignals.filter(signal => ANALYSIS_INTENT_SIGNALS.includes(signal));
  // createsImage cuenta como señal generativa aunque no haya puntuado por existir
  // contexto visual: la intención textual de generar sigue presente.
  const generationSignals = [...new Set([
    ...matchedSignals.filter(signal => GENERATIVE_INTENT_SIGNALS.includes(signal)),
    ...(createsImage ? ['from-scratch-generation'] : [])
  ])];
  const analysisScore = scores['vision-analysis'];
  const generationScore = Math.max(
    scores['image-generation'],
    scores['image-edit'],
    scores['image-variation']
  );
  const dominantGeneration = generationScore - analysisScore >= UNAMBIGUOUS_GENERATION_MARGIN;
  // Mejor intent generativo puntuado, aunque el análisis haya ganado el ranking: es la
  // petición que quedaría sin atender cuando ambas señales coexisten.
  const generationCandidate = GENERATIVE_VISUAL_MODES
    .map(candidate => [candidate, scores[candidate]])
    .sort((a, b) => b[1] - a[1])
    .filter(([, candidateScore]) => candidateScore > 0)
    .map(([candidate]) => candidate)[0] || null;
  const analysisAndGeneration = analysisSignals.length > 0
    && generationSignals.length > 0
    && !dominantGeneration;
  return {
    intent,
    confidence: Math.max(0.35, Math.min(1, (score - secondScore + 5) / 10)),
    score,
    normalizedText,
    matchedSignals: [...new Set(matchedSignals)],
    requiresVisualContext: ['vision-analysis', 'image-edit', 'image-variation'].includes(intent),
    usesPreviousImageContext,
    editSubtypes: [...new Set(editSubtypes)],
    variationSignals,
    analysisSignals,
    generationSignals,
    generationCandidate,
    intentConflicts: { analysisAndGeneration },
    reason: `Señales dominantes para ${intent}: ${matchedSignals.join(', ') || 'ninguna'}`,
    visualContext
  };
}

function detectUserIntent(input = {}) {
  return detectUserIntentDetailed(input).intent;
}

function buildImageEditPlan({ text = '', detailed, visualContext } = {}) {
  const normalized = detailed?.normalizedText || normalizeIntentText(text);
  const objective = String(text || '').trim();
  const operations = [...new Set(detailed?.editSubtypes || [])];
  const preserve = [];
  const qualityGoals = [];
  const constraints = [];

  if (/\b(lea|leer|legible|legibilidad|contenido)\b/.test(normalized)) preserve.push('content-readability');
  if (/\b(no sea|sin|evita|evitar)\s+(el\s+)?gris\b/.test(normalized)) constraints.push('avoid-gray');
  if (/\bmoderno\b/.test(normalized)) qualityGoals.push('modern-appearance');
  if (preserve.includes('content-readability')) qualityGoals.push('clear-readable-content');

  return {
    mode: 'image-edit',
    objective,
    sourceImage: visualContext?.imageRef || null,
    operations,
    preserve,
    qualityGoals,
    constraints,
    needsClarification:
      !visualContext?.hasVisualContext
      || !visualContext?.imageRef
      || operations.length === 0
      || !objective,
    reason: detailed?.reason || 'Edición visual detectada',
    visualContext
  };
}

function buildImageVariationPlan({ text = '', detailed, visualContext, lastVisualAnalysis = null } = {}) {
  const normalized = detailed?.normalizedText || normalizeIntentText(text);
  const preserve = ['primary-visual-identity'];
  const allowChanges = ['composition-variation'];
  const styleGoals = [];
  const analysisBelongsToSource = lastVisualAnalysis
    && (!visualContext?.imageRef?.chatId || lastVisualAnalysis.chatId === visualContext.imageRef.chatId);
  const extraction = analysisBelongsToSource
    ? extractVisualSuggestions(lastVisualAnalysis.analysisText)
    : { suggestions: [], source: 'none' };
  const appliedSuggestions = extraction.suggestions
    .map(item => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 6);
  if (/\bmisma linea visual\b/.test(normalized)) preserve.push('visual-language');
  if (/\bcontenido\b/.test(normalized)) preserve.push('core-content');
  if (/\bmoderno\b/.test(normalized)) styleGoals.push('modern-style');
  if (/\botra opcion|nueva version\b/.test(normalized)) allowChanges.push('layout');
  return {
    mode: 'image-variation',
    objective: text,
    sourceImage: visualContext?.imageRef || null,
    preserve: [...new Set(preserve)],
    allowChanges: [...new Set(allowChanges)],
    styleGoals,
    referenceStrength: appliedSuggestions.length ? 'high' : 'medium',
    constraints: [],
    appliedSuggestions,
    suggestionSource: extraction.source,
    needsClarification: !visualContext?.hasVisualContext,
    reason: detailed?.reason || 'Variación visual detectada',
    visualContext
  };
}

function buildVisionAnalysisPlan({ text = '', visualContext } = {}) {
  return { mode: 'vision-analysis', objective: text, constraints: ['describe-only-do-not-edit'], needsClarification: !visualContext?.hasVisualContext, visualContext };
}

function buildImageGenerationPlan({ text = '', visualContext = null } = {}) {
  const createFromScratch = visualContext?.createFromScratch === true;
  return {
    mode: 'image-generation',
    objective: text,
    qualityGoals: ['coherent-composition'],
    constraints: [],
    // Explícito: ninguna imagen del historial entra en una creación desde cero.
    createFromScratch,
    sourceImage: null,
    needsClarification: !String(text).trim()
  };
}

// Constructor único de planes por intent: lo usan tanto el intent efectivo como la
// alternativa generativa conservada cuando el guard de routing mixto degrada la ruta.
function buildPlanForIntent({ intent, text, detailed, visualContext, lastVisualAnalysis } = {}) {
  if (intent === 'image-edit') return buildImageEditPlan({ text, detailed, visualContext });
  if (intent === 'image-variation') {
    return buildImageVariationPlan({ text, detailed, visualContext, lastVisualAnalysis });
  }
  if (intent === 'vision-analysis') return buildVisionAnalysisPlan({ text, detailed, visualContext });
  if (intent === 'image-generation') return buildImageGenerationPlan({ text, detailed, visualContext });
  return null;
}

function validateVisualTaskPlan(plan, capabilities = {}) {
  const errors = [];
  if (['image-edit', 'image-variation', 'vision-analysis'].includes(plan?.mode) && !plan?.visualContext?.hasVisualContext) errors.push('visual-context-required');
  const capabilityKey = {
    'image-edit': 'imageEdit',
    'image-variation': 'imageVariation',
    'vision-analysis': 'vision',
    'image-generation': 'imageGeneration'
  }[plan?.mode];
  if (capabilityKey && capabilities[capabilityKey] !== true) errors.push(`${capabilityKey}-unavailable`);
  if (plan?.needsClarification) errors.push('clarification-required');
  const contradictions = (plan?.preserve || []).filter(item => (plan?.allowChanges || []).includes(item));
  if (contradictions.length) errors.push('contradictory-instructions');
  return { valid: errors.length === 0, errors, shouldOfferFallback: errors.length > 0 };
}

function buildModelPromptFromPlan(plan) {
  if (plan?.mode === 'image-variation' && plan.appliedSuggestions?.length) {
    return [
      'Genera una nueva imagen usando la imagen previa como referencia.',
      `Solicitud actual: ${String(plan.objective || '').trim()}`,
      `Aplica las mejoras sugeridas previamente: ${plan.appliedSuggestions.join(' | ')}.`,
      'Preserva la identidad visual principal.',
      'Mejora fondo, composición, legibilidad y dinamismo según las sugerencias disponibles.',
      'No devuelvas instrucciones ni texto explicativo; genera únicamente la imagen.'
    ].join('\n');
  }
  const lines = [`Tarea visual: ${plan.mode}.`];
  if (plan.objective) lines.push(`Objetivo: ${plan.objective}`);
  if (plan.operations?.length) lines.push(`Operaciones: ${plan.operations.join(', ')}.`);
  if (plan.preserve?.length) lines.push(`Preservar: ${plan.preserve.join(', ')}.`);
  if (plan.allowChanges?.length) lines.push(`Cambios permitidos: ${plan.allowChanges.join(', ')}.`);
  if (plan.styleGoals?.length) lines.push(`Estilo: ${plan.styleGoals.join(', ')}.`);
  if (plan.qualityGoals?.length) lines.push(`Calidad: ${plan.qualityGoals.join(', ')}.`);
  if (plan.constraints?.length) lines.push(`Restricciones: ${plan.constraints.join(', ')}.`);
  return lines.join('\n');
}

function buildImageGenerationPromptFromVisualPlan(plan = {}) {
  const lines = [
    'Genera una imagen nueva basada en este plan visual.',
    'No copies artefactos ni introduzcas texto ilegible.'
  ];

  if (plan.objective) {
    lines.push(`Solicitud exacta del usuario: ${String(plan.objective).trim()}`);
  }

  if (plan.mode === 'image-edit') {
    lines.push('Edita la imagen de referencia proporcionada; no generes un sujeto diferente.');
    lines.push('Modifica únicamente los elementos solicitados y preserva el sujeto principal, identidad, forma, proporciones y contenido.');
  }

  if (plan.operations?.length) lines.push(`Aplica estos cambios: ${plan.operations.join(', ')}.`);
  if (plan.preserve?.length) lines.push(`Mantén: ${plan.preserve.join(', ')}.`);
  else lines.push('Mantén los elementos principales y el contenido esencial de la referencia.');
  if (plan.qualityGoals?.length) lines.push(`Objetivos de calidad: ${plan.qualityGoals.join(', ')}.`);
  if (plan.styleGoals?.length) lines.push(`Objetivos de estilo: ${plan.styleGoals.join(', ')}.`);
  if (plan.constraints?.length) lines.push(`Restricciones obligatorias: ${plan.constraints.join(', ')}.`);
  if (plan.allowChanges?.length) lines.push(`Puedes variar: ${plan.allowChanges.join(', ')}.`);
  if (plan.appliedSuggestions?.length) lines.push(`Aplica las mejoras sugeridas previamente: ${plan.appliedSuggestions.join(' | ')}.`);
  if (plan.mode === 'image-variation') {
    lines.push('Usa la imagen previa como referencia y preserva la identidad visual principal.');
    lines.push('Mejora fondo, composición, legibilidad y dinamismo según las sugerencias disponibles.');
    lines.push('No devuelvas instrucciones ni texto explicativo; genera únicamente la imagen.');
  }
  lines.push('No alteres elementos principales salvo cuando una operación lo solicite explícitamente.');
  return lines.join('\n');
}

// Lista blanca de contadores de uso: nunca se propaga nada más de la respuesta cruda,
// para que no viaje ningún dato sensible hacia el renderer.
function extractAlibabaUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const safe = {};
  for (const key of [
    'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'
  ]) {
    if (Number.isFinite(usage[key])) safe[key] = usage[key];
  }
  return Object.keys(safe).length ? safe : null;
}

// Solo un bloque estructurado real cuenta como llamada de herramienta.
// El texto libre (Markdown, JSON mostrado, código, logs) nunca se interpreta,
// aunque contenga literalmente tool_use o generate_image.
function normalizeAlibabaAssistantOutput(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const toolUse = blocks.find(block => block?.type === 'tool_use' && typeof block?.name === 'string');
  const text = blocks.filter(block => block?.type === 'text').map(block => String(block.text || '')).join('');
  // stop_reason es metadato de la respuesta, no un fallo de red: se propaga tal cual.
  const stopReason = typeof data?.stop_reason === 'string' ? data.stop_reason : null;
  const usage = extractAlibabaUsage(data?.usage);
  if (toolUse) {
    return {
      content: text,
      stopReason,
      usage,
      blockedToolUse: {
        name: toolUse.name,
        input: toolUse.name === 'generate_image' && toolUse.input && typeof toolUse.input === 'object'
          ? { prompt: typeof toolUse.input.prompt === 'string' ? toolUse.input.prompt : '' }
          : {}
      }
    };
  }
  return { content: text, stopReason, usage, blockedToolUse: null };
}

async function executeGenerateImageToolUse({ toolUse, visualExecution, generateImage }) {
  if (toolUse?.name !== 'generate_image') {
    throw new Error('La herramienta visual solicitada no está soportada');
  }
  const plan = visualExecution?.plan;
  const validation = visualExecution?.validation;
  if (!plan || validation?.valid !== true || typeof generateImage !== 'function') {
    throw new Error('No se pudo generar la imagen: no existe un plan visual seguro');
  }
  // Barrera terminal: vision-analysis y normal-chat nunca pueden generar imagen.
  const allowedModes = new Set(GENERATIVE_VISUAL_MODES);
  if (!allowedModes.has(plan?.mode)) {
    throw new Error(
      'No se pudo ejecutar la generación de imagen: la tarea actual no es generativa'
    );
  }
  const prompt = String(visualExecution.generationPrompt || '').trim();
  if (!prompt) throw new Error('No se pudo generar la imagen: el plan visual no contiene una instrucción segura');
  const model = String(visualExecution.model || '').trim();
  if (!model) throw new Error('No se pudo generar la imagen: falta un modelo de imagen configurado');
  const sourceImage =
    plan.sourceImage
    || visualExecution?.visualContext?.imageRef
    || plan.visualContext?.imageRef
    || null;
  if (['image-edit', 'image-variation'].includes(plan.mode) && !sourceImage) {
    throw new Error('No se pudo generar la imagen: falta la imagen de referencia');
  }
  const generated = await generateImage({
    model,
    prompt,
    sourceImages: sourceImage ? [sourceImage] : []
  });
  if (!Array.isArray(generated?.images) || generated.images.length === 0) {
    throw new Error('No se pudo generar la imagen: el generador no devolvió imágenes');
  }
  return { ok: true, type: 'image', images: generated.images };
}

function routeIntent(intent, { currentProvider = '', currentModel = '' } = {}) {
  const capabilities = getProviderVisualCapabilities(currentProvider);
  const defaultImageModel = getDefaultImageModelForProvider(currentProvider);
  const defaultVisionModel = getDefaultVisionModelForProvider(currentProvider);
  if (intent === 'normal-chat') {
    return {
      intent,
      action: 'chat',
      model: currentModel || (currentProvider === ALIBABA_PROVIDER_ID ? ALIBABA_DEFAULT_MODEL_ID : null)
    };
  }
  if (intent === 'vision-analysis') {
    return {
      intent,
      action: 'chat',
      model: defaultVisionModel || currentModel || null
    };
  }
  if (intent === 'image-generation') {
    if (capabilities.imageGeneration) {
      return { intent, action: 'generate-image', model: defaultImageModel || currentModel || null };
    }
    return {
      intent,
      action: 'unsupported',
      model: null,
      message: 'El proveedor actual no soporta generación de imágenes. Cambia a un proveedor con modelos de imagen.'
    };
  }
  if (intent === 'image-edit' || intent === 'image-variation') {
    const supported = intent === 'image-edit' ? capabilities.imageEdit : capabilities.imageVariation;
    if (supported) {
      return { intent, action: 'generate-image', model: defaultImageModel || currentModel || null };
    }
    return {
      intent,
      action: 'unsupported',
      model: null,
      message: 'El proveedor actual no soporta edición o variación de imágenes. Cambia a un proveedor con modelos de imagen.'
    };
  }
  if (intent === 'ambiguous-visual' || intent === 'image-ambiguous') {
    return {
      intent,
      action: 'unsupported',
      message: '¿Quieres analizar la imagen, editarla o generar una nueva versión?'
    };
  }
  if (intent === 'video-generation') {
    return {
      intent,
      action: 'unsupported',
      message: 'La generación de video está disponible próximamente en MIKA5.'
    };
  }
  return { intent, action: 'chat', model: currentModel || null };
}

const { ollamaApi } = require('./ollama');


/**
 * Códigos que impiden usar el proveedor aunque haya catálogo. Un 403, un 429 o
 * un 500 pueden llegar junto al respaldo declarado del adaptador: sin esta
 * comprobación, ese respaldo dejaría el proveedor como utilizable pese a que
 * el servicio acaba de decir que no.
 */
const ERRORES_QUE_IMPIDEN_USO = new Set([
  'PROVIDER_AUTH_REJECTED',
  'PROVIDER_FORBIDDEN',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TRANSPORT_UNREACHABLE',
  'PROVIDER_UNKNOWN_ERROR',
  // Un proveedor que contesta con algo que no se entiende no es utilizable,
  // por mucho que el 2xx demuestre que está vivo.
  'PROVIDER_RESPONSE_INVALID'
]);

/**
 * Cualquier error HTTP del proveedor cuenta, no sólo los enumerados: la
 * familia `PROVIDER_HTTP_*` es abierta por definición —un 502, un 503— y
 * dejarla fuera permitía que un 500 con catálogo de respaldo pasara por
 * utilizable. Lo detectó la prueba de groq degradando con un 500 encima.
 */
function impideUso(errorCode) {
  if (!errorCode) return false;
  return ERRORES_QUE_IMPIDEN_USO.has(errorCode) || errorCode.startsWith('PROVIDER_HTTP_');
}

/**
 * Log del proceso principal. El detalle saneado se queda aquí: al renderer
 * sólo cruzan `errorCode` y `httpStatus`, nunca el texto de un error.
 */
function registrarFalloDeProveedor(providerId, operacion, error) {
  const d = describirError(error);
  const detalle = d.logMessage ? ` — ${d.logMessage}` : '';
  console.warn(`[provider:${providerId}] ${operacion}: ${d.errorCode}${detalle}`);
}

/**
 * Cómo debe presentarse un proveedor.
 *
 * Ocho estados y no dos porque «alcanzable» y «utilizable» son cosas
 * distintas, y agruparlas obligaba a mentir. Un 404, un 429 y un 500 prueban
 * que hay alguien al otro lado y ninguno de los tres significa que el
 * proveedor funcione: pintarlos en verde como «Conectado» afirmaba algo falso.
 * Un 401 y un 403 tampoco son lo mismo: el primero dice que la credencial no
 * vale, el segundo que el servidor la reconoce y no autoriza la operación.
 *
 * `UNKNOWN` existe para no afirmar sin prueba: es lo que queda cuando nadie ha
 * hablado con el servidor todavía.
 */
const UI_STATE = Object.freeze({
  CONNECTED: 'connected',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
  CONFIGURATION_REQUIRED: 'configuration-required',
  AUTHENTICATION_REJECTED: 'authentication-rejected',
  AUTHORIZATION_FORBIDDEN: 'authorization-forbidden',
  RATE_LIMITED: 'rate-limited',
  PROVIDER_ERROR: 'provider-error'
});

/**
 * Qué estado corresponde a cada código de fallo. Sólo los códigos listados
 * tienen estado propio; el resto cae al genérico de la evidencia.
 */
const ESTADO_POR_ERROR = Object.freeze({
  PROVIDER_AUTH_REJECTED: UI_STATE.AUTHENTICATION_REJECTED,
  PROVIDER_FORBIDDEN: UI_STATE.AUTHORIZATION_FORBIDDEN,
  PROVIDER_RATE_LIMITED: UI_STATE.RATE_LIMITED,
  PROVIDER_TRANSPORT_UNREACHABLE: UI_STATE.OFFLINE,
  PROVIDER_TIMEOUT: UI_STATE.UNKNOWN,
  PROVIDER_ABORTED: UI_STATE.UNKNOWN,
  PROVIDER_RESPONSE_INVALID: UI_STATE.PROVIDER_ERROR
});

/**
 * Prioridad: lo que el usuario debe resolver primero manda. Primero lo que
 * depende de él —configurar, corregir la clave—, después lo que depende del
 * proveedor, y sólo al final la conectividad genérica.
 */
function resolverUiState({ configured, reachable, authenticated, errorCode } = {}) {
  if (!configured) return UI_STATE.CONFIGURATION_REQUIRED;
  if (authenticated === false) return UI_STATE.AUTHENTICATION_REJECTED;

  if (errorCode) {
    const propio = ESTADO_POR_ERROR[errorCode];
    if (propio) return propio;
    // Un error del proveedor con el servidor vivo: 404, 500, respuesta
    // ilegible. Alcanzable, pero el servicio no está sirviendo.
    if (errorCode.startsWith('PROVIDER_HTTP_') || errorCode === 'PROVIDER_UNKNOWN_ERROR') {
      return UI_STATE.PROVIDER_ERROR;
    }
  }

  if (reachable === false) return UI_STATE.OFFLINE;
  if (reachable === true) return UI_STATE.CONNECTED;
  return UI_STATE.UNKNOWN;
}
const PROVIDERS = {
  // MODO LOCAL - 100% Privado (delegado a ollama.js robusto)
  local: {
    name: 'Ollama (Local)',
    privacy: 'private',
    requiresKey: false,
    visualCapabilities: {
      vision: true
    },
    
    async chat({ model, messages, images, signal }) {
      const imageList = Array.isArray(images) ? images : [];
      // La sonda es la única fuente de verdad para Ollama, y se consulta justo
      // antes de enviar: no se hereda de un estado de UI que puede estar obsoleto.
      if (imageList.length) {
        const supportsVision = await probeOllamaVision(model);
        assertVisionSupported({
          providerId: 'local',
          modelId: model,
          modelMeta: { supportsVision },
          imageCount: imageList.length
        });
      }

      // Ollama espera base64 pelado. El resto de la app usa el objeto descriptivo
      // { mediaType, base64 } que sí necesitan los adapters cloud, así que aquí
      // se acepta cualquiera de las dos formas y se reduce a lo que Ollama entiende.
      let finalMessages = messages;
      if (imageList.length > 0) {
        const ollamaImages = imageList.map(image => {
          const raw = typeof image === 'string' ? image : (image?.base64 || image?.data || '');
          const cleaned = String(raw).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
          if (!cleaned) throw new Error('La imagen adjunta está vacía');
          return cleaned;
        });
        finalMessages = messages.map((m, i) => {
          if (i === messages.length - 1 && m.role === 'user') {
            return { ...m, images: ollamaImages };
          }
          return m;
        });
      }

      const data = await ollamaApi.chat({ model, messages: finalMessages, signal });
      return normalizeChatResult({
        providerId: 'local',
        model: data?.model || model || null,
        content: data?.message?.content ?? '',
        rawUsage: data,
        rawFinishReason: data?.done_reason
      });
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

          // Única fuente: la sonda. Si /api/show falla, el modelo queda sin visión
          // y adjuntar una imagen se bloqueará con un mensaje claro. Antes se caía
          // a detección por nombre y la imagen se perdía en silencio.
          entry.supportsVision = await probeOllamaVision(name);
          if (entry.supportsVision && !entry.capabilities.includes('👁️ Visión')) {
            entry.capabilities.push('👁️ Visión');
          }

          models.push(entry);
        }

        // Ollama contestó: eso es evidencia de conectividad. No pide
        // credencial, así que `authenticated` se queda en null.
        return { models, probe: probeDeExito({ authenticated: null }) };
      } catch (e) {
        console.warn('Ollama no disponible:', sanearMensaje(e && e.message));
        return { models: [], probe: probeDeError(e) };
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
    
    async chat({ model, messages, images = [], apiKey, sanitize = true, signal }) {
      if (!apiKey) throw new Error('API Key requerida para OpenAI');
      const selectedModel = model || 'gpt-3.5-turbo';
      // Barrera dura: si el modelo no acepta imágenes, la petición falla aquí.
      // Nunca se envía descartando el adjunto.
      assertVisionSupported({
        providerId: 'openai',
        modelId: selectedModel,
        imageCount: images.length
      });

      const processedMessages = messages.map(m => ({
        role: m.role,
        content: sanitize ? sanitizeForCloud(m.content) : m.content
      }));
      const finalMessages = attachOpenAIImages(processedMessages, images);

      const abortContext = createAbortContext(signal, this.timeout, 'OpenAI');

      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: finalMessages,
            temperature: 0.7
          }),
          signal: abortContext.signal
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `OpenAI Error: ${res.status}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        return normalizeChatResult({
          providerId: 'openai',
          model: data.model || selectedModel,
          content: choice?.message?.content ?? '',
          rawUsage: data.usage,
          rawFinishReason: choice?.finish_reason
        });
      } catch (error) {
        throw abortContext.normalize(error);
      } finally {
        abortContext.cleanup();
      }
    },

    // Devuelve `{ models, probe }`. La sonda es la ÚNICA fuente de evidencia
    // sobre conectividad y credencial: nadie la deduce del tamaño del catálogo.
    // Un 200 con lista vacía prueba que el servidor respondió y aceptó la
    // clave, y aun así no deja nada utilizable.
    async listModels(apiKey) {
      if (!apiKey) return { models: [], probe: probeNoIntentada() };
      let res;
      try {
        res = await fetch(`${this.baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
      } catch (error) {
        return { models: [], probe: probeDeError(error) };
      }
      if (!res.ok) {
        return {
          models: [],
          probe: probeDeError(errorDeRespuesta(res.status, 'OpenAI no devolvió el catálogo'))
        };
      }
      // Un cuerpo ilegible tras un 2xx no borra lo que el 2xx ya demostró: el
      // servidor respondió y aceptó la credencial. Conservarlo es la
      // diferencia entre «el proveedor devolvió algo que no entiendo» y «no
      // pude hablar con el proveedor».
      let data;
      try {
        data = await res.json();
      } catch (_) {
        return {
          models: [],
          probe: probeDeRespuestaInvalida({ httpStatus: res.status, authenticated: true })
        };
      }
      if (!data || !Array.isArray(data.data)) {
        return {
          models: [],
          probe: probeDeRespuestaInvalida({ httpStatus: res.status, authenticated: true })
        };
      }
      return {
        models: data.data
          .filter(m => m && typeof m.id === 'string' && m.id.includes('gpt'))
          .map(m => ({
            name: m.id,
            size: 0,
            digest: m.id,
            supportsVision: resolveVisionSupport({ providerId: 'openai', modelId: m.id }).supported
          })),
        probe: probeDeExito({ httpStatus: res.status, authenticated: true })
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

    async chat({ model, messages, images = [], apiKey, sanitize = true, signal }) {
      if (!apiKey) throw new Error('API Key requerida para Anthropic');
      const selectedModel = model || 'claude-3-5-haiku-20241022';
      assertVisionSupported({
        providerId: 'anthropic',
        modelId: selectedModel,
        imageCount: images.length
      });

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

      if (images.length) {
        const imageBlocks = buildAnthropicImageBlocks(images);
        const lastUserIndex = conversation.map(m => m.role).lastIndexOf('user');
        const lastUser = conversation[lastUserIndex];
        lastUser.content = [{ type: 'text', text: lastUser.content }, ...imageBlocks];
      }

      const abortContext = createAbortContext(signal, this.timeout, 'Claude');

      try {
        const body = {
          model: selectedModel,
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
          signal: abortContext.signal
        });

        if (res.status === 401) throw new Error('API Key inválida o expirada');
        if (res.status === 429) throw new Error('Rate limit excedido');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `Anthropic Error: ${res.status}`);
        }

        const data = await res.json();
        const textParts = (Array.isArray(data.content) ? data.content : [])
          .filter(block => block?.type === 'text')
          .map(block => block.text)
          .filter(Boolean);
        return normalizeChatResult({
          providerId: 'anthropic',
          model: data.model || selectedModel,
          content: textParts.join('\n\n'),
          rawUsage: data.usage,
          rawFinishReason: data.stop_reason
        });
      } catch (error) {
        throw abortContext.normalize(error);
      } finally {
        abortContext.cleanup();
      }
    },

    async listModels(apiKey) {
      if (!apiKey) return { models: [] };
      // Anthropic no tiene endpoint público de modelos — lista actualizada 2025/2026
      const catalog = [
        { name: 'claude-opus-4-5', size: 0, description: 'Claude Opus 4.5 — máxima capacidad' },
        { name: 'claude-sonnet-4-5-20251001', size: 0, description: 'Claude Sonnet 4.5 — rápido y capaz' },
        { name: 'claude-3-5-sonnet-20241022', size: 0, description: 'Claude 3.5 Sonnet — equilibrio ideal' },
        { name: 'claude-3-5-haiku-20241022', size: 0, description: 'Claude 3.5 Haiku — ultra-rápido' },
        { name: 'claude-3-opus-20240229', size: 0, description: 'Claude 3 Opus — razonamiento profundo' },
        { name: 'claude-3-haiku-20240307', size: 0, description: 'Claude 3 Haiku — económico y veloz' }
      ];
      return {
        models: catalog.map(model => ({
          ...model,
          supportsVision: resolveVisionSupport({ providerId: 'anthropic', modelId: model.name }).supported
        })),
        // Catálogo declarado en el propio adaptador: no se ha hablado con
        // ningún servidor, así que no hay evidencia que aportar.
        probe: probeNoIntentada()
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

    async chat({ model, messages, images = [], apiKey, sanitize = true, signal }) {
      if (!apiKey) throw new Error('API Key requerida. Obtén una en console.groq.com');
      // Groq no tiene modelos de visión verificados en MIKA5: esto lanza siempre
      // que llegue una imagen, en vez de descartarla. El transporte de abajo ya
      // está listo para cuando se verifique modelo por modelo.
      assertVisionSupported({ providerId: 'groq', modelId: model, imageCount: images.length });

      const processedMessages = messages.map(m => ({
        role: m.role,
        content: sanitize ? sanitizeForCloud(m.content) : m.content
      }));
      const finalMessages = attachOpenAIImages(processedMessages, images);

      const abortContext = createAbortContext(signal, this.timeout, 'Groq');

      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: finalMessages,
            temperature: 0.7,
            max_tokens: 8192
          }),
          signal: abortContext.signal
        });

        if (res.status === 401) throw new Error('API Key inválida o expirada');
        if (res.status === 429) throw new Error('Rate limit excedido en Groq');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `Groq Error: ${res.status}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        return normalizeChatResult({
          providerId: 'groq',
          model: data.model || model || null,
          content: choice?.message?.content ?? '',
          rawUsage: data.usage,
          rawFinishReason: choice?.finish_reason
        });
      } catch (error) {
        throw abortContext.normalize(error);
      } finally {
        abortContext.cleanup();
      }
    },

    // Groq cae a una lista fija cuando su endpoint falla. Esa degradación es
    // deliberada y se conserva, pero la sonda registra qué ocurrió de verdad:
    // sin ella, un catálogo de respaldo era indistinguible de uno obtenido por
    // red y se leía como prueba de que el servidor respondía.
    async listModels(apiKey) {
      if (!apiKey) return { models: [], probe: probeNoIntentada() };
      let probe = probeNoIntentada();
      try {
        const res = await fetch(`${this.baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (res.ok) {
          // Mismo contrato que el resto: un 2xx ilegible conserva la evidencia
          // que el 2xx ya dio, y se distingue de un fallo de transporte.
          let data;
          try {
            data = await res.json();
          } catch (_) {
            data = null;
          }
          if (!data || !Array.isArray(data.data)) {
            probe = probeDeRespuestaInvalida({ httpStatus: res.status, authenticated: true });
          } else {
            const chatModels = data.data
              .filter(m => m && typeof m.id === 'string' && !m.id.includes('whisper') && !m.id.includes('tts'))
              .map(m => ({ name: m.id, size: 0, description: `Groq — ${m.id}` }));
            probe = probeDeExito({ httpStatus: res.status, authenticated: true });
            if (chatModels.length > 0) return { models: chatModels, probe };
          }
        } else {
          probe = probeDeError(errorDeRespuesta(res.status, 'Groq'));
        }
      } catch (error) {
        probe = probeDeError(error);
      }
      // Fallback estático si el endpoint falla
      return {
        models: [
          { name: 'llama-3.3-70b-versatile', size: 0, description: 'Llama 3.3 70B — calidad máxima' },
          { name: 'llama-3.1-8b-instant', size: 0, description: 'Llama 3.1 8B — ultra-rápido' },
          { name: 'mixtral-8x7b-32768', size: 0, description: 'Mixtral 8x7B — contexto 32k' },
          { name: 'gemma2-9b-it', size: 0, description: 'Gemma 2 9B — Google' },
          { name: 'deepseek-r1-distill-llama-70b', size: 0, description: 'DeepSeek-R1 70B — razonamiento' }
        ],
        probe
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

    async chat({ model, messages, images = [], apiKey, sanitize = true, signal }) {
      if (!apiKey) throw new Error('API Key requerida. Obtén una en platform.moonshot.cn');
      const selectedModel = model || 'kimi-k2-5-latest';
      // El nombre "kimi" activaba la heurística de visión del renderer y la imagen
      // se descartaba en silencio. Ahora se bloquea hasta verificar modelo por modelo.
      assertVisionSupported({
        providerId: 'moonshot',
        modelId: selectedModel,
        imageCount: images.length
      });

      const processedMessages = messages.map(m => ({
        role: m.role,
        content: sanitize ? sanitizeForCloud(m.content) : m.content
      }));
      const finalMessages = attachOpenAIImages(processedMessages, images);

      const abortContext = createAbortContext(signal, this.timeout, 'Kimi');

      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: finalMessages,
            temperature: 0.3,
            max_tokens: 8192
          }),
          signal: abortContext.signal
        });

        if (res.status === 401) throw new Error('API Key inválida o expirada');
        if (res.status === 429) throw new Error('Rate limit excedido (demasiadas peticiones)');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `Moonshot Error: ${res.status}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        return normalizeChatResult({
          providerId: 'moonshot',
          model: data.model || selectedModel,
          content: choice?.message?.content ?? '',
          rawUsage: data.usage,
          rawFinishReason: choice?.finish_reason
        });
      } catch (error) {
        throw abortContext.normalize(error);
      } finally {
        abortContext.cleanup();
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
        ],
        // Catálogo declarado: sin intento de red, sin evidencia.
        probe: probeNoIntentada()
      };
    }
  },

  alibaba: {
    name: 'Alibaba Cloud Model Studio',
    privacy: 'cloud',
    requiresKey: true,

    /**
     * Alibaba es el único adaptador con configuración editable, así que estar
     * «configurado» es más que tener credencial: sin endpoint no hay a dónde
     * enviar. Devuelve un veredicto estructurado con código estable, no un
     * booleano, para que la interfaz pueda decir qué falta.
     */
    validateConfig(providerConfig, apiKey) {
      if (!apiKey) return { ok: false, errorCode: 'PROVIDER_CREDENTIAL_REQUIRED' };
      const config = normalizeAlibabaConfig(providerConfig);
      if (!config.endpoint) return { ok: false, errorCode: 'PROVIDER_ENDPOINT_REQUIRED' };
      if (!Array.isArray(config.models) || config.models.length === 0) {
        return { ok: false, errorCode: 'PROVIDER_CATALOG_REQUIRED' };
      }
      return { ok: true };
    },

    visualCapabilities: {
      vision: true,
      sourceImages: true,
      imageEdit: true,
      imageVariation: true,
      defaultVisionModel: 'qwen3.7-plus',
      defaultImageModel: 'wan2.7-image'
    },
    timeout: 120000,

    async chat({ model, messages, images = [], apiKey, sanitize = true, providerConfig, signal }) {
      if (!apiKey) throw new Error('API Key requerida para Alibaba Cloud Model Studio');
      const config = normalizeAlibabaConfig(providerConfig);
      const selectedModelId = model || ALIBABA_DEFAULT_MODEL_ID;
      const selectedModel = config.models.find(item => item.id === selectedModelId);
      if (!selectedModel) throw new Error('El modelo no está configurado para Alibaba');
      if (selectedModel.taskType === 'image-generation') {
        throw new Error('Este modelo genera imágenes. Usa generateImage.');
      }
      if (selectedModel.taskType === 'video-generation') {
        throw new Error('Este modelo genera video y no puede usarse en chat.');
      }

      const abortContext = createAbortContext(signal, this.timeout, 'Alibaba');
      try {
        const res = await fetchWithProviderRetry(`${config.endpoint}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(buildAnthropicMessagesPayload({
            model: selectedModel,
            messages,
            images,
            sanitize
          })),
          signal: abortContext.signal
        }, {
          providerLabel: 'Alibaba Cloud Model Studio',
          attempts: 2
        });
        if (!res.ok) {
          throw new Error(getAlibabaHttpError(res.status));
        }
        const data = await res.json();
        const normalizedOutput = normalizeAlibabaAssistantOutput(data);
        return normalizeChatResult({
          providerId: ALIBABA_PROVIDER_ID,
          model: selectedModel.id,
          content: normalizedOutput.content,
          rawUsage: normalizedOutput.usage,
          rawFinishReason: normalizedOutput.stopReason,
          extra: {
            // Campos nativos de Alibaba: se conservan junto a los normalizados
            // porque el flujo visual (tool use, truncamiento) los usa tal cual.
            stopReason: normalizedOutput.stopReason,
            rawUsage: normalizedOutput.usage,
            blockedToolUse: normalizedOutput.blockedToolUse
          }
        });
      } catch (error) {
        throw abortContext.normalize(error);
      } finally {
        abortContext.cleanup();
      }
    },

    async listModels(_apiKey, providerConfig) {
      const config = normalizeAlibabaConfig(providerConfig);
      return {
        models: config.models
          .filter(model => model.taskType === 'chat' || model.taskType === 'vision')
          .map(model => ({
          name: model.id,
          description: model.displayName,
          taskType: model.taskType,
          supportsVision: model.capabilities.vision === true,
          capabilities: model.capabilities,
          parameters: model.parameters
        })),
        // El catálogo sale de la configuración del usuario, no de la red.
        probe: probeNoIntentada()
      };
    },

      async generateImage({
        model,
        prompt,
        sourceImages = [],
        apiKey,
        providerConfig,
        signal
      }) {
        if (!apiKey) throw new Error('API Key requerida para Alibaba Cloud Model Studio');
        const config = normalizeAlibabaConfig(providerConfig);
        const selectedModel = config.models.find(item => item.id === model);
        if (!selectedModel || selectedModel.taskType !== 'image-generation') {
          throw new Error('Selecciona un modelo de generación de imagen de Alibaba');
        }
        const cleanPrompt = String(prompt || '').trim();
        if (!cleanPrompt) throw new Error('Escribe una descripción para crear la imagen');

        const normalizedInputImages = (Array.isArray(sourceImages) ? sourceImages : [])
          .slice(0, 9)
          .map(normalizeAlibabaInputImage);

        const content = [
          ...normalizedInputImages.map(image => ({ image })),
          { text: cleanPrompt }
        ];

        const abortContext = createAbortContext(signal, this.timeout, 'Alibaba Cloud Model Studio');
        try {
          const res = await fetchWithProviderRetry(ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: selectedModel.id,
              input: { messages: [{ role: 'user', content }] },
              parameters: { size: '1024*1024' }
            }),
            signal: abortContext.signal
          }, {
            providerLabel: 'Alibaba Cloud Model Studio',
            attempts: 2
          });
          if (!res.ok) throw new Error(getAlibabaHttpError(res.status));
          const data = await res.json();
          const images = (data.output?.choices || [])
            .flatMap(choice => choice.message?.content || [])
            .map(item => item.image)
            .filter(image => {
              try {
                return new URL(image).protocol === 'https:';
              } catch (_) {
                return false;
              }
            });
          if (!images.length) throw new Error('Alibaba no devolvió ninguna imagen');
          return {
            ok: true,
            images,
            requestId: data.request_id || data.requestId || null
          };
        } catch (error) {
          throw abortContext.normalize(error);
        } finally {
          abortContext.cleanup();
        }
      }
  },

  // LLAMA.CPP - Local (servidor OpenAI-compatible)
  llamacpp: {
    name: 'llama.cpp (Local)',
    privacy: 'private',
    requiresKey: false,
    baseUrl: 'http://127.0.0.1:8080/v1',
    timeout: 300000, // 5 min — modelos grandes son lentos

    async chat({ model, messages, images = [], signal }) {
      const selectedModel = model || 'default';
      // llama.cpp no expone si tiene proyector multimodal cargado, así que MIKA5
      // no declara visión: adjuntar una imagen falla en vez de perderse.
      assertVisionSupported({
        providerId: 'llamacpp',
        modelId: selectedModel,
        imageCount: images.length
      });
      const abortContext = createAbortContext(signal, this.timeout, 'llama.cpp');
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: selectedModel,
            messages,
            temperature: 0.7,
            stream: false
          }),
          signal: abortContext.signal
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `llama.cpp Error: ${res.status}`);
        }
        const data = await res.json();
        const choice = data.choices?.[0];
        return normalizeChatResult({
          providerId: 'llamacpp',
          model: data.model || selectedModel,
          content: choice?.message?.content ?? '',
          rawUsage: data.usage,
          rawFinishReason: choice?.finish_reason
        });
      } catch (error) {
        const normalized = abortContext.normalize(error);
        if (normalized.code === 'PROVIDER_TIMEOUT') {
          normalized.message += '. Prueba un modelo más pequeño.';
        }
        if (error.code === 'ECONNREFUSED') throw new Error('llama.cpp no está corriendo. Inicia con: ./server -m modelo.gguf --port 8080');
        throw normalized;
      } finally {
        abortContext.cleanup();
      }
    },

    // El fallo se sigue capturando —la lista vacía es una respuesta válida—,
    // pero ahora se conserva POR QUÉ está vacía. Antes se perdía y una caída
    // de red era indistinguible de un servidor sin modelos cargados.
    async listModels() {
      let res;
      try {
        res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
      } catch (error) {
        return { models: [], probe: probeDeError(error) };
      }
      if (!res.ok) {
        return { models: [], probe: probeDeError(errorDeRespuesta(res.status, 'llama.cpp')) };
      }
      // Mismo contrato que los demás adaptadores de red. `authenticated` queda
      // en null: llama.cpp es local y no pide credencial, así que un 2xx no
      // prueba nada sobre una autenticación que no existe.
      let data;
      try {
        data = await res.json();
      } catch (_) {
        return { models: [], probe: probeDeRespuestaInvalida({ httpStatus: res.status }) };
      }
      if (!data || !Array.isArray(data.data)) {
        return { models: [], probe: probeDeRespuestaInvalida({ httpStatus: res.status }) };
      }
      return {
        models: data.data
          .filter(m => m && typeof m.id === 'string')
          .map(m => ({
            name: m.id,
            size: 0,
            digest: m.id,
            description: `llama.cpp — ${m.id}`
          })),
        probe: probeDeExito({ httpStatus: res.status })
      };
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

function getProviderVisualCapabilities(providerId) {
  const provider = PROVIDERS[providerId];
  const declared = provider?.visualCapabilities || {};
  const imageGeneration = typeof provider?.generateImage === 'function';
  const sourceImages = imageGeneration
    && (declared.sourceImages === true || providerId === ALIBABA_PROVIDER_ID);
  return {
    vision: declared.vision === true,
    imageGeneration,
    imageEdit: sourceImages,
    imageVariation: sourceImages,
    sourceImages,
    defaultVisionModel: declared.defaultVisionModel || null,
    defaultImageModel: declared.defaultImageModel || null
  };
}

function providerSupportsImageGeneration(providerId) {
  return getProviderVisualCapabilities(providerId).imageGeneration;
}

function providerSupportsImageEdit(providerId) {
  return getProviderVisualCapabilities(providerId).imageEdit;
}

function providerSupportsImageVariation(providerId) {
  return getProviderVisualCapabilities(providerId).imageVariation;
}

function getDefaultImageModelForProvider(providerId) {
  return getProviderVisualCapabilities(providerId).defaultImageModel;
}

function getDefaultVisionModelForProvider(providerId) {
  return getProviderVisualCapabilities(providerId).defaultVisionModel;
}

function providerSupportsVisionRouting(providerId) {
  return getProviderVisualCapabilities(providerId).vision;
}

class AIProviderManager {
  constructor(db) {
    this.db = db;
    this.currentProvider = 'local';
    this.apiKeys = {};
    this.providerConfigs = {
      [ALIBABA_PROVIDER_ID]: cloneJson(ALIBABA_DEFAULT_CONFIG)
    };
    // Future redaction is opt-in, visible and auditable. Normal cloud requests
    // preserve the exact accepted content and never apply silent rewriting.
    this.sanitizeCloud = false;
    
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
    const stmt = this.db.prepare('SELECT key, value FROM app_state WHERE key IN (?, ?, ?, ?, ?, ?, ?)');
    const rows = stmt.all('ai_provider', 'openai_key', 'anthropic_key', 'groq_key', 'moonshot_key', 'alibaba_key', ALIBABA_CONFIG_KEY);
    
    let hasAlibabaConfig = false;
    let alibabaConfigNeedsPersist = false;
    rows.forEach(row => {
      // Un identificador que ya no existe en el registro (proveedor retirado o
      // valor corrupto) no puede quedar activo: `getProvider()` leería
      // `undefined.privacy` y la rehidratación fallaría entera. Se ignora y se
      // conserva el local por defecto.
      if (row.key === 'ai_provider' && PROVIDERS[row.value]) this.currentProvider = row.value;
      if (row.key === 'openai_key') this.apiKeys.openai = decrypt(row.value);
      if (row.key === 'anthropic_key') this.apiKeys.anthropic = decrypt(row.value);
      if (row.key === 'groq_key') this.apiKeys.groq = decrypt(row.value);
      if (row.key === 'moonshot_key') this.apiKeys.moonshot = decrypt(row.value);
      if (row.key === 'alibaba_key') this.apiKeys.alibaba = decrypt(row.value);
      if (row.key === ALIBABA_CONFIG_KEY) {
        hasAlibabaConfig = true;
        try {
          const storedConfig = JSON.parse(row.value);
          this.providerConfigs.alibaba = normalizeAlibabaConfig(storedConfig);
          alibabaConfigNeedsPersist = JSON.stringify(storedConfig) !== JSON.stringify(this.providerConfigs.alibaba);
        } catch (error) {
          console.warn('Configuración de Alibaba ignorada:', error.message);
          alibabaConfigNeedsPersist = true;
        }
      }
    });
    if (!hasAlibabaConfig || alibabaConfigNeedsPersist) {
      this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
        .run(ALIBABA_CONFIG_KEY, JSON.stringify(this.providerConfigs.alibaba));
    }
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
      privacyLabel: config.privacy === 'private' ? 'Privado' : 'Cloud',
      capabilities: this.getCapabilities(this.currentProvider)
    };
  }
  
  setApiKey(provider, key) {
    if (!PROVIDERS[provider].requiresKey) return false;
    this.apiKeys[provider] = key;
    
    const stmt = this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
    stmt.run(`${provider}_key`, encrypt(key));
    if (provider === ALIBABA_PROVIDER_ID
      && this.providerConfigs.alibaba.billingMode === 'token-plan'
      && !String(key).startsWith('sk-sp-')) {
      return {
        ok: true,
        warning: 'Para Token Plan normalmente la clave debe empezar con sk-sp-'
      };
    }
    return true;
  }

  getProviderConfig(providerId) {
    if (providerId !== ALIBABA_PROVIDER_ID) throw new Error('Proveedor sin configuración editable');
    return cloneJson(this.providerConfigs[providerId]);
  }

  saveProviderConfig(providerId, config) {
    if (providerId !== ALIBABA_PROVIDER_ID) throw new Error('Proveedor sin configuración editable');
    const normalized = normalizeAlibabaConfig(config, this.providerConfigs[providerId]);
    this.providerConfigs[providerId] = normalized;
    this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)')
      .run(ALIBABA_CONFIG_KEY, JSON.stringify(normalized));
    return cloneJson(normalized);
  }

  addProviderModel(providerId, model) {
    const config = this.getProviderConfig(providerId);
    const normalized = normalizeAlibabaModel(model);
    if (config.models.some(item => item.id === normalized.id)) throw new Error('El modelo ya existe');
    config.models.push(normalized);
    return this.saveProviderConfig(providerId, config);
  }

  updateProviderModel(providerId, existingId, model) {
    const config = this.getProviderConfig(providerId);
    const index = config.models.findIndex(item => item.id === existingId);
    if (index < 0) throw new Error('Modelo no encontrado');
    config.models[index] = normalizeAlibabaModel(model);
    return this.saveProviderConfig(providerId, config);
  }

  deleteProviderModel(providerId, modelId) {
    const config = this.getProviderConfig(providerId);
    const nextModels = config.models.filter(item => item.id !== modelId);
    if (nextModels.length === config.models.length) throw new Error('Modelo no encontrado');
    config.models = nextModels;
    return this.saveProviderConfig(providerId, config);
  }

  async chat(params) {
    const provider = PROVIDERS[this.currentProvider];
    if (this.currentProvider === ALIBABA_PROVIDER_ID) {
      const selectedModelId = params.model || ALIBABA_DEFAULT_MODEL_ID;
      const selectedModel = this.providerConfigs.alibaba.models.find(model => model.id === selectedModelId);
      if (selectedModel?.taskType === 'image-generation') {
        throw new Error('Este modelo genera imágenes. Usa generateImage.');
      }
      if (selectedModel?.taskType === 'video-generation') {
        throw new Error('Este modelo genera video y no puede usarse en chat.');
      }
    }
    
    const paramsWithKey = {
      ...params,
      apiKey: this.apiKeys[this.currentProvider],
      providerConfig: this.providerConfigs[this.currentProvider],
      sanitize: this.sanitizeCloud
    };
    
    const result = await provider.chat(paramsWithKey);
    if (this.currentProvider === ALIBABA_PROVIDER_ID && result?.blockedToolUse) {
      // Sin un plan generativo activo, una herramienta visual jamás se ejecuta:
      // una petición de chat o de análisis nunca puede terminar en imagen.
      const mode = params.visualExecution?.plan?.mode;
      if (!GENERATIVE_VISUAL_MODES.includes(mode)) {
        const assistantText = String(result?.message?.content || '').trim();
        if (assistantText) {
          return {
            ...result,
            message: { role: 'assistant', content: assistantText },
            blockedToolUse: null
          };
        }
        throw new Error('El modelo intentó ejecutar una herramienta visual fuera de la tarea solicitada.');
      }
      const terminal = await executeGenerateImageToolUse({
        toolUse: result.blockedToolUse,
        visualExecution: params.visualExecution,
        generateImage: generationParams => this.generateImage(generationParams)
      });
      return {
        message: {
          role: 'assistant',
          content: terminal.images.map(image => `![Imagen generada](${image})`).join('\n\n')
        },
        provider: ALIBABA_PROVIDER_ID,
        model: params.visualExecution?.model || result.model || null,
        usage: result.usage ?? null,
        finishReason: 'stop',
        images: terminal.images,
        terminalType: 'image'
      };
    }
    return result;
  }

  // Contrato de capacidades. Es la única fuente que la interfaz debe consultar
  // para decidir qué ofrecer; nunca el nombre del modelo.
  getCapabilities(providerId = this.currentProvider) {
    const contract = getProviderContract(providerId);
    const visual = getProviderVisualCapabilities(providerId);
    return {
      provider: providerId,
      ...contract,
      defaultVisionModel: visual.defaultVisionModel,
      defaultImageModel: visual.defaultImageModel
    };
  }

  // Resolución de visión para un modelo concreto, con motivo legible.
  // ÚNICA fuente de verdad: el renderer no replica allowlists ni políticas, la
  // consulta por IPC y muestra el `message` que sale de aquí. Es la misma
  // resolución que usa la barrera de los adapters, así que UI y red no pueden
  // divergir.
  async resolveVision({ provider = this.currentProvider, model, modelMeta = null } = {}) {
    let meta = modelMeta;
    if (!meta && provider === ALIBABA_PROVIDER_ID) {
      const configured = this.providerConfigs.alibaba?.models?.find(item => item.id === model);
      if (configured) meta = { capabilities: configured.capabilities };
    }
    if (!meta && provider === 'local' && model) {
      // Misma sonda que ejecuta el adapter antes de enviar: la UI no puede
      // autorizar algo que la barrera vaya a rechazar después.
      meta = { supportsVision: await probeOllamaVision(model) };
    }
    const resolution = resolveVisionSupport({ providerId: provider, modelId: model, modelMeta: meta });
    return {
      provider,
      model: model || null,
      ...resolution,
      message: resolution.supported
        ? null
        : describeVisionBlock({ providerId: provider, modelId: model, reason: resolution.reason })
    };
  }

  async generateImage(params) {
    const provider = PROVIDERS[this.currentProvider];
    if (!provider || typeof provider.generateImage !== 'function') {
      throw new Error('El proveedor actual no soporta generación de imágenes');
    }
    return provider.generateImage({
      ...params,
      apiKey: this.apiKeys[this.currentProvider],
      providerConfig: this.providerConfigs[this.currentProvider]
    });
  }

  routeIntent(params) {
    const detailed = detectUserIntentDetailed({
      ...params,
      currentProvider: this.currentProvider
    });
    const visualContext = detailed.visualContext;
    // Guard de routing mixto: si la solicitud pide análisis y generación a la vez
    // sin que una instrucción generativa domine con claridad, no se abre la ruta
    // directa de generación. Se degrada a análisis o chat, y el plan resultante
    // deja de ser generativo, así que las barreras posteriores también aplican.
    let effectiveIntent = detailed.intent;
    if (detailed.intentConflicts?.analysisAndGeneration
      && GENERATIVE_VISUAL_MODES.includes(effectiveIntent)) {
      effectiveIntent = visualContext.hasVisualContext ? 'vision-analysis' : 'normal-chat';
    }
    // El plan corresponde siempre al intent efectivo, nunca al detectado.
    const buildPlan = intent => buildPlanForIntent({
      intent,
      text: params?.text,
      detailed,
      visualContext,
      lastVisualAnalysis: params?.lastVisualAnalysis
    });
    const plan = buildPlan(effectiveIntent);
    const routed = routeIntent(effectiveIntent, {
      currentProvider: this.currentProvider,
      currentModel: params?.currentModel
    });
    const appliesPreviousSuggestions = detailed.variationSignals.includes('apply-previous-suggestions');
    if (plan?.mode === 'image-variation' && appliesPreviousSuggestions && plan.appliedSuggestions.length === 0) {
      if (visualContext.hasVisualContext) {
        routed.intent = 'ambiguous-visual';
        routed.action = 'unsupported';
        routed.model = null;
        routed.message = 'No encontré sugerencias visuales aplicables en el análisis anterior. Indica cambios concretos para generar la nueva imagen.';
      } else {
        routed.action = 'error';
        routed.model = null;
        routed.message = 'No se pudo generar la nueva imagen: falta una imagen de referencia.';
      }
    }
    const capabilities = getProviderVisualCapabilities(this.currentProvider);
    // Cuando análisis y generación coexisten, la petición generativa no se descarta:
    // se conserva como alternativa que solo puede ejecutarse con confirmación explícita
    // del usuario. Aplica tanto si el guard degradó la ruta como si el análisis ya
    // ganaba el ranking por sí solo, que es el caso más común. Se exige contexto visual,
    // así que la alternativa siempre opera sobre una imagen real: una petición
    // generativa que solo aparece en el texto pegado no se ofrece nunca.
    let conflictAlternative = null;
    const alternativeIntent = GENERATIVE_VISUAL_MODES.includes(detailed.intent)
      ? detailed.intent
      : detailed.generationCandidate;
    if (detailed.intentConflicts?.analysisAndGeneration
      && visualContext.hasVisualContext
      && alternativeIntent
      && alternativeIntent !== effectiveIntent) {
      const alternativePlan = buildPlan(alternativeIntent);
      const alternativeValidation = alternativePlan
        ? validateVisualTaskPlan(alternativePlan, capabilities)
        : null;
      const alternativeRoute = routeIntent(alternativeIntent, {
        currentProvider: this.currentProvider,
        currentModel: params?.currentModel
      });
      if (alternativePlan
        && GENERATIVE_VISUAL_MODES.includes(alternativePlan.mode)
        && alternativeValidation?.valid === true
        && alternativeRoute.action === 'generate-image'
        && alternativeRoute.model) {
        const alternativeGenerationPrompt = buildImageGenerationPromptFromVisualPlan(alternativePlan);
        conflictAlternative = {
          intent: alternativeIntent,
          action: 'generate-image',
          model: alternativeRoute.model,
          plan: alternativePlan,
          validation: alternativeValidation,
          generationPrompt: alternativeGenerationPrompt,
          visualExecution: {
            plan: alternativePlan,
            visualContext,
            validation: alternativeValidation,
            model: alternativeRoute.model,
            generationPrompt: alternativeGenerationPrompt
          }
        };
      }
    }
    const options = null;
    if (options && !/\n1\./.test(routed.message || '')) {
      routed.message += '\nPuedo:\n1. Analizar la imagen actual\n2. Generar una nueva imagen basada en tu instrucción';
    }
    return {
      ...routed,
      capabilities,
      detailed,
      visualContext,
      conflictAlternative,
      plan,
      validation: plan ? validateVisualTaskPlan(plan, capabilities) : null,
      modelPrompt: plan ? buildModelPromptFromPlan(plan) : params?.text,
      generationPrompt: plan && ['image-edit', 'image-variation'].includes(plan.mode)
        ? buildImageGenerationPromptFromVisualPlan(plan)
        : null,
      options,
      visualExecution: plan ? {
        plan,
        visualContext,
        validation: validateVisualTaskPlan(plan, capabilities),
        model: routed.model,
        generationPrompt: ['image-edit', 'image-variation'].includes(plan.mode)
          ? buildImageGenerationPromptFromVisualPlan(plan)
          : null
      } : null
    };
  }
  
  async listModels() {
    const provider = PROVIDERS[this.currentProvider];
    if (this.currentProvider === 'local') {
      return provider.listModels();
    }
    return provider.listModels(this.apiKeys[this.currentProvider], this.providerConfigs[this.currentProvider]);
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

  /**
   * Disponibilidad de un proveedor, en estados que antes viajaban colapsados.
   *
   *   configured       su configuración es utilizable
   *   reachable        su endpoint contestó (null = nadie lo ha comprobado)
   *   authenticated    la credencial fue aceptada (null = sin evidencia)
   *   modelsAvailable  cuántos modelos ofrece
   *   canAttempt       está configurado para intentarlo: hay con qué probar,
   *                    pero NADIE ha verificado que funcione
   *   ready            verificado utilizable: hay evidencia de que el servidor
   *                    contestó, la credencial no fue rechazada y hay catálogo
   *   uiState          cómo presentarlo, de un conjunto cerrado de ocho
   *   errorCode        contrato estable; el renderer traduce a partir de él
   *   httpStatus       único metadato numérico que cruza al renderer
   *
   * `canAttempt` y `ready` son distintos a propósito. Un catálogo declarado en
   * el propio adaptador y una clave meramente presente permiten INTENTARLO,
   * pero no prueban nada: el proveedor puede estar caído y la clave caducada,
   * y sólo el primer envío lo dirá. Llamar «listo» a eso era afirmar una
   * verificación que nunca ocurrió.
   *
   * La evidencia NO se deduce del tamaño del catálogo ni del tipo de
   * adaptador. Viene de dos fuentes explícitas y de ninguna más: la sonda
   * `status()` del adaptador, y el objeto `probe` que `listModels()` devuelve.
   * Un 200 con catálogo vacío da `reachable: true`, `authenticated: true` y
   * `modelsAvailable: 0`: el servidor respondió y aceptó la clave, y aun así
   * no hay nada que usar.
   */
  async getAvailability(providerId = this.currentProvider) {
    const config = PROVIDERS[providerId];
    if (!config) {
      return {
        providerId, configured: false, reachable: null, authenticated: null,
        modelsAvailable: 0, models: [], canAttempt: false, ready: false,
        uiState: UI_STATE.CONFIGURATION_REQUIRED,
        errorCode: 'PROVIDER_UNKNOWN', httpStatus: null
      };
    }

    // `configured` puede venir del propio adaptador, que sabe si su
    // configuración es utilizable. Sin `validateConfig()` se cae al criterio
    // mínimo: la credencial que el adaptador declare necesitar.
    let configured;
    let errorCode = null;
    let httpStatus = null;
    if (typeof config.validateConfig === 'function') {
      let veredicto;
      try {
        veredicto = await config.validateConfig(
          this.providerConfigs[providerId],
          this.apiKeys[providerId]
        );
      } catch (error) {
        registrarFalloDeProveedor(providerId, 'validateConfig', error);
        veredicto = { ok: false, errorCode: 'PROVIDER_CONFIG_INVALID' };
      }
      configured = Boolean(veredicto && veredicto.ok);
      if (!configured) errorCode = (veredicto && veredicto.errorCode) || 'PROVIDER_CONFIG_REQUIRED';
    } else {
      configured = !config.requiresKey || Boolean(this.apiKeys[providerId]);
      if (!configured) errorCode = 'PROVIDER_CREDENTIAL_REQUIRED';
    }

    let reachable = null;
    let authenticated = null;

    /** Incorpora una sonda. Una evidencia concreta sustituye a la ausencia. */
    const incorporar = (probe) => {
      if (!probe || probe.attempted !== true) return;
      if (probe.reachable === true || probe.reachable === false) reachable = probe.reachable;
      if (probe.authenticated === true || probe.authenticated === false) authenticated = probe.authenticated;
      if (Number.isInteger(probe.httpStatus)) httpStatus = probe.httpStatus;
      if (probe.errorCode && !errorCode) errorCode = probe.errorCode;
    };

    if (typeof config.status === 'function') {
      let sonda;
      try {
        sonda = await config.status();
      } catch (error) {
        sonda = { ok: false, error };
      }
      if (sonda && sonda.ok) {
        incorporar(probeDeExito({ authenticated: null }));
      } else {
        const fallo = (sonda && (sonda.error || sonda.message)) || null;
        registrarFalloDeProveedor(providerId, 'status', fallo);
        const probe = probeDeError(fallo);
        // Una sonda que falla sin código reconocible sigue significando que no
        // se pudo hablar con el servidor: para eso está la sonda.
        if (probe.reachable === null) probe.reachable = false;
        if (!probe.errorCode || probe.errorCode === 'PROVIDER_UNKNOWN_ERROR') {
          probe.errorCode = 'PROVIDER_TRANSPORT_UNREACHABLE';
        }
        incorporar(probe);
      }
    }

    const cerrar = (extra = {}) => {
      const base = {
        providerId, configured, reachable, authenticated,
        modelsAvailable: 0, models: [], errorCode, httpStatus, ...extra
      };
      const sinRechazo = base.configured
        && base.authenticated !== false
        && base.modelsAvailable > 0
        && !impideUso(base.errorCode);
      base.canAttempt = Boolean(sinRechazo && base.reachable !== false);
      base.ready = Boolean(sinRechazo && base.reachable === true);
      base.uiState = resolverUiState(base);
      return base;
    };

    // Sin configuración utilizable no se consulta nada: una petición condenada
    // al rechazo no aporta información y sí gasta red.
    if (!configured) return cerrar();
    if (reachable === false) return cerrar();

    let models = [];
    try {
      const respuesta = await config.listModels(
        this.apiKeys[providerId],
        this.providerConfigs[providerId]
      );
      models = Array.isArray(respuesta) ? respuesta : ((respuesta && respuesta.models) || []);
      // Única vía de evidencia del catálogo: la sonda que el adaptador declara.
      incorporar(respuesta && respuesta.probe);
    } catch (error) {
      registrarFalloDeProveedor(providerId, 'listModels', error);
      const probe = probeDeError(error);
      incorporar(probe);
      return cerrar({ errorCode: probe.errorCode || errorCode });
    }

    if (models.length === 0 && !errorCode) errorCode = 'PROVIDER_CATALOG_EMPTY';

    return cerrar({ modelsAvailable: models.length, models, errorCode });
  }
  getAllProviders() {
    return Object.entries(PROVIDERS).map(([id, config]) => ({
      id,
      name: config.name,
      privacy: config.privacy,
      requiresKey: config.requiresKey,
      current: id === this.currentProvider,
      capabilities: this.getCapabilities(id)
    }));
  }
}

module.exports = {
  AIProviderManager,
  PROVIDERS,
  UI_STATE,
  resolverUiState,
  probeOllamaVision,
  getProviderContract,
  resolveVisionSupport,
  describeVisionBlock,
  assertVisionSupported,
  normalizeChatResult,
  sanitizeForCloud,
  ALIBABA_DEFAULT_CONFIG,
  ALIBABA_DEFAULT_MODEL_ID,
  ALIBABA_DEFAULT_MAX_TOKENS,
  ALIBABA_LEGACY_MAX_TOKENS,
  createAlibabaPresetModel,
  migrateAlibabaOfficialMaxTokens,
  extractAlibabaUsage,
  ALIBABA_TOKEN_PLAN_ENDPOINT,
  ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT,
  normalizeAlibabaConfig,
  normalizeAlibabaModel,
  extractVisualSuggestions,
  buildAnthropicMessagesPayload,
  normalizeIntentText,
  detectUserIntent,
  detectUserIntentDetailed,
  detectCreateFromScratch,
  resolveVisualContext,
  routeIntent,
  buildImageEditPlan,
  buildImageVariationPlan,
  buildVisionAnalysisPlan,
  buildImageGenerationPlan,
  validateVisualTaskPlan,
  buildModelPromptFromPlan,
  buildImageGenerationPromptFromVisualPlan,
  normalizeAlibabaAssistantOutput,
  executeGenerateImageToolUse,
  providerSupportsImageGeneration,
  providerSupportsImageEdit,
  providerSupportsImageVariation,
  getDefaultImageModelForProvider,
  getDefaultVisionModelForProvider,
  providerSupportsVisionRouting,
  getProviderVisualCapabilities,
  isProviderNetworkError,
  normalizeProviderNetworkError,
  createAbortContext,
  delay,
  fetchWithProviderRetry
};
