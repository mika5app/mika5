'use strict';

// Configuración, catálogo y normalización de Alibaba Cloud Model Studio.
//
// Alibaba es el único proveedor con configuración editable por el usuario, y
// eso arrastra su propio vocabulario: preajustes, tipos de tarea, migración de
// `max_tokens`, endpoints del plan de tokens y normalización de entrada y
// salida. Vivía dentro de `ai-providers.js`, intercalado con constantes de
// enrutado visual que NO son suyas y que se quedan donde estaban.
//
// Se mueve sin tocarlo. En particular se conservan tal cual dos
// comportamientos documentados que no son fallos:
//
//   - `normalizeAlibabaConfig()` reinyecta siempre los preajustes, así que
//     `saveProviderConfig()` los devuelve aunque el llamante los omita y
//     `deleteProviderModel()` no puede retirarlos.
//   - El catálogo es estático: sale de la configuración, no de la red, y por
//     eso el adaptador declara `probeNoIntentada()` y no aporta evidencia de
//     conectividad.

const { sanitizeForCloud, isProviderNetworkError, delay, normalizeProviderNetworkError } = require('../provider-runtime');

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

module.exports = {
  fetchWithProviderRetry,
  getAlibabaHttpError,
  ALIBABA_PROVIDER_ID,
  ALIBABA_CONFIG_KEY,
  ALIBABA_TOKEN_PLAN_ENDPOINT,
  ALIBABA_TOKEN_PLAN_IMAGE_ENDPOINT,
  ALIBABA_DEFAULT_MODEL_ID,
  ALIBABA_TOKEN_PLAN_MODELS,
  ALIBABA_TASK_TYPES,
  ALIBABA_DEFAULT_MAX_TOKENS,
  ALIBABA_LEGACY_MAX_TOKENS,
  ALIBABA_TEXT_TASK_TYPES,
  migrateAlibabaOfficialMaxTokens,
  createAlibabaPresetModel,
  ALIBABA_DEFAULT_CONFIG,
  normalizeAlibabaModel,
  normalizeAlibabaModels,
  normalizeAlibabaConfig,
  buildAnthropicMessagesPayload,
  formatAlibabaHttpError,
  normalizeAlibabaInputImage,
  extractAlibabaUsage,
  normalizeAlibabaAssistantOutput
};
