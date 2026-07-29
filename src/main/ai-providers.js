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

const ALIBABA_PROVIDER_ID = 'alibaba';
const ALIBABA_CONFIG_KEY = 'alibaba_config';
const ALIBABA_TOKEN_PLAN_ENDPOINT = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic';
const ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const ALIBABA_DEFAULT_MODEL_ID = 'qwen3.7-max';
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
    parameters: ['chat', 'vision'].includes(preset.taskType) ? { max_tokens: 1024 } : {}
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
  for (const preset of presets) {
    const current = byId.get(preset.id);
    byId.set(preset.id, {
      ...current,
      taskType: preset.taskType,
      capabilities: {
        ...current.capabilities,
        vision: preset.capabilities.vision,
        reasoning: preset.capabilities.reasoning
      }
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
  const referencesPrevious = /\b(anterior|esa|esta|la|del|de la|de esta|de esa|ponlo|quitalo|hazlo|dejalo|vuelvelo|basad[oa] en|mismo plano|misma linea visual|otra opcion)\b/.test(normalizedText);
  const hasImplicitVisualSignal = /\b(fondo|color|imagen|foto|logo|producto|empaque|texto|objeto|contenido|vasija|tarjeta|diseno|composicion|azul|rojo|verde|dorado|blanco|negro|oscuro|claro|moderno|grande|pequeno|alineado|de frente)\b/.test(normalizedText)
    || /\bmas\s+(oscuro|claro|moderno|grande|pequeno|legible)\b/.test(normalizedText);
  const belongsToChat = imageRef => imageRef && (!chatId || imageRef.chatId === chatId);
  if (currentImage) {
    if (!chatId || !currentImage.chatId || currentImage.chatId === chatId) {
      return { hasVisualContext: true, source: 'current-attachment', imageRef: currentImage, confidence: 1 };
    }
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
      return { hasVisualContext: true, source, imageRef, confidence };
    }
  }
  return { hasVisualContext: false, source: null, imageRef: null, confidence: 0 };
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
  const editVerb = /\b(edita|editar|cambia|cambiar|cambio|modifica|modificar|quita|quitar|remueve|remover|elimina|eliminar|agrega|agregar|anade|anadir|sustituye|sustituir|reemplaza|reemplazar|pon|poner|coloca|colocar|hazle|hazlo|dejalo|vuelvelo|mueve|mover|agranda|agrandar|reduce|reducir|alinea|alinear)\b|hacer(?:la|lo)?\s+mas/;
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
  if (/\b(moderno|hazlo|dejalo|vuelvelo)\b/.test(normalizedText)) editSubtypes.push('style-change');
  if (/\b(agranda|reduce|mas grande|mas pequeno)\b/.test(normalizedText)) editSubtypes.push('resize');
  if (/\b(mueve|alinea|mismo plano|en linea|de frente)\b/.test(normalizedText)) editSubtypes.push('layout-adjustment');

  const createsImage = /\b(crea|crear|genera|generar|dibuja|dibujar|produce|producir)\b[\s\S]{0,50}\b(imagen|image|ilustracion|dibujo)\b/.test(normalizedText);
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
    reason: `Señales dominantes para ${intent}: ${matchedSignals.join(', ') || 'ninguna'}`,
    visualContext
  };
}

function detectUserIntent(input = {}) {
  return detectUserIntentDetailed(input).intent;
}

function buildImageEditPlan({ text = '', detailed, visualContext } = {}) {
  const normalized = detailed?.normalizedText || normalizeIntentText(text);
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
    operations,
    preserve,
    qualityGoals,
    constraints,
    needsClarification: !visualContext?.hasVisualContext || operations.length === 0,
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

function buildImageGenerationPlan({ text = '' } = {}) {
  return { mode: 'image-generation', objective: text, qualityGoals: ['coherent-composition'], constraints: [], needsClarification: !String(text).trim() };
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

function normalizeAlibabaAssistantOutput(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const toolUse = blocks.find(block => block?.type === 'tool_use');
  const text = blocks.filter(block => block?.type === 'text').map(block => String(block.text || '')).join('');
  const inspectableText = text.replace(/\\/g, '');
  const rawToolUse = /["']type["']\s*:\s*["']tool_use["']|["']name["']\s*:\s*["']generate_image["']/i.test(inspectableText);
  if (toolUse || rawToolUse) {
    return {
      content: '',
      blockedToolUse: {
        name: toolUse?.name || (rawToolUse ? 'generate_image' : 'unknown'),
        input: toolUse?.name === 'generate_image' && toolUse.input && typeof toolUse.input === 'object'
          ? { prompt: typeof toolUse.input.prompt === 'string' ? toolUse.input.prompt : '' }
          : {}
      }
    };
  }
  return { content: text, blockedToolUse: null };
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
  const prompt = String(visualExecution.generationPrompt || '').trim();
  if (!prompt) throw new Error('No se pudo generar la imagen: el plan visual no contiene una instrucción segura');
  const generated = await generateImage({
    model: visualExecution.model || 'wan2.7-image',
    prompt
  });
  if (!Array.isArray(generated?.images) || generated.images.length === 0) {
    throw new Error('No se pudo generar la imagen: el generador no devolvió imágenes');
  }
  return { ok: true, type: 'image', images: generated.images };
}

function routeIntent(intent, { currentProvider = '', currentModel = '' } = {}) {
  if (currentProvider !== ALIBABA_PROVIDER_ID) {
    return { intent, action: 'chat', model: currentModel || null };
  }
  const routes = {
    'normal-chat': { action: 'chat', model: currentModel || ALIBABA_DEFAULT_MODEL_ID },
    'vision-analysis': { action: 'chat', model: 'qwen3.7-plus' },
    'image-generation': { action: 'generate-image', model: 'wan2.7-image' },
    'image-edit': {
      action: 'generate-image',
      model: 'wan2.7-image'
    },
    'image-variation': {
      action: 'generate-image',
      model: 'wan2.7-image'
    },
    'ambiguous-visual': {
      action: 'unsupported',
      message: '¿Quieres analizar la imagen, editarla o generar una nueva versión?'
    },
    'image-ambiguous': {
      action: 'unsupported',
      message: '¿Quieres analizar la imagen, editarla o generar una nueva versión?'
    },
    'video-generation': {
      action: 'unsupported',
      message: 'La generación de video está disponible próximamente en MIKA5.'
    }
  };
  return { intent, ...(routes[intent] || routes['normal-chat']) };
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

  alibaba: {
    name: 'Alibaba Cloud Model Studio',
    privacy: 'cloud',
    requiresKey: true,
    timeout: 120000,

    async chat({ model, messages, images = [], apiKey, sanitize = true, providerConfig }) {
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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        const res = await fetch(`${config.endpoint}/v1/messages`, {
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
          signal: controller.signal
        });
        if (res.status === 401) throw new Error('API Key de Alibaba inválida o expirada');
        if (res.status === 429) throw new Error('Rate limit excedido en Alibaba');
        if (!res.ok) {
          const error = await res.json().catch(() => ({}));
          throw new Error(formatAlibabaHttpError(error, res.status, 'Alibaba Error'));
        }
        const data = await res.json();
        const normalizedOutput = normalizeAlibabaAssistantOutput(data);
        return {
          message: { role: 'assistant', content: normalizedOutput.content },
          blockedToolUse: normalizedOutput.blockedToolUse
        };
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('Timeout: Alibaba tardó demasiado');
        throw error;
      } finally {
        clearTimeout(timeoutId);
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
        }))
      };
    },

    async generateImage({ model, prompt, apiKey, providerConfig }) {
      if (!apiKey) throw new Error('API Key requerida para Alibaba Cloud Model Studio');
      const config = normalizeAlibabaConfig(providerConfig);
      const selectedModel = config.models.find(item => item.id === model);
      if (!selectedModel || selectedModel.taskType !== 'image-generation') {
        throw new Error('Selecciona un modelo de generación de imagen de Alibaba');
      }
      const cleanPrompt = String(prompt || '').trim();
      if (!cleanPrompt) throw new Error('Escribe una descripción para crear la imagen');
      const res = await fetch(ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: selectedModel.id,
          input: { messages: [{ role: 'user', content: [{ text: cleanPrompt }] }] },
          parameters: { size: '1024*1024' }
        })
      });
      if (res.status === 401) throw new Error('API Key de Alibaba inválida o expirada');
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(formatAlibabaHttpError(error, res.status, 'Alibaba Image Error'));
      }
      const data = await res.json();
      const images = (data.output?.choices || [])
        .flatMap(choice => choice.message?.content || [])
        .map(content => content.image)
        .filter(image => {
          try {
            return new URL(image).protocol === 'https:';
          } catch (_) {
            return false;
          }
        });
      if (!images.length) throw new Error('Alibaba no devolvió ninguna imagen');
      return { ok: true, images };
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
    this.providerConfigs = {
      [ALIBABA_PROVIDER_ID]: cloneJson(ALIBABA_DEFAULT_CONFIG)
    };
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
    const stmt = this.db.prepare('SELECT key, value FROM app_state WHERE key IN (?, ?, ?, ?, ?, ?, ?)');
    const rows = stmt.all('ai_provider', 'openai_key', 'anthropic_key', 'groq_key', 'moonshot_key', 'alibaba_key', ALIBABA_CONFIG_KEY);
    
    let hasAlibabaConfig = false;
    let alibabaConfigNeedsPersist = false;
    rows.forEach(row => {
      if (row.key === 'ai_provider') this.currentProvider = row.value;
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
      privacyLabel: config.privacy === 'private' ? 'Privado' : 'Cloud'
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
        images: terminal.images,
        terminalType: 'image'
      };
    }
    return result;
  }

  async generateImage(params) {
    if (this.currentProvider !== ALIBABA_PROVIDER_ID) {
      throw new Error('La generación de imagen requiere Alibaba Cloud Model Studio');
    }
    return PROVIDERS.alibaba.generateImage({
      ...params,
      apiKey: this.apiKeys.alibaba,
      providerConfig: this.providerConfigs.alibaba
    });
  }

  routeIntent(params) {
    const detailed = detectUserIntentDetailed({
      ...params,
      currentProvider: this.currentProvider
    });
    const visualContext = detailed.visualContext;
    let plan = null;
    if (detailed.intent === 'image-edit') plan = buildImageEditPlan({ text: params?.text, detailed, visualContext });
    if (detailed.intent === 'image-variation') {
      plan = buildImageVariationPlan({
        text: params?.text,
        detailed,
        visualContext,
        lastVisualAnalysis: params?.lastVisualAnalysis
      });
    }
    if (detailed.intent === 'vision-analysis') plan = buildVisionAnalysisPlan({ text: params?.text, detailed, visualContext });
    if (detailed.intent === 'image-generation') plan = buildImageGenerationPlan({ text: params?.text, detailed, visualContext });
    const routed = routeIntent(detailed.intent, {
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
    const capabilities = {
      vision: true,
      imageGeneration: true,
      imageEdit: true,
      imageVariation: true
    };
    const options = null;
    if (options && !/\n1\./.test(routed.message || '')) {
      routed.message += '\nPuedo:\n1. Analizar la imagen actual\n2. Generar una nueva imagen basada en tu instrucción';
    }
    return {
      ...routed,
      detailed,
      visualContext,
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

module.exports = {
  AIProviderManager,
  PROVIDERS,
  ALIBABA_DEFAULT_CONFIG,
  ALIBABA_DEFAULT_MODEL_ID,
  ALIBABA_TOKEN_PLAN_ENDPOINT,
  ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT,
  normalizeAlibabaConfig,
  normalizeAlibabaModel,
  extractVisualSuggestions,
  buildAnthropicMessagesPayload,
  normalizeIntentText,
  detectUserIntent,
  detectUserIntentDetailed,
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
  executeGenerateImageToolUse
};
