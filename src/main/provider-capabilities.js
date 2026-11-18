'use strict';

// Contrato de capacidades por proveedor.
//
// Regla única del módulo: MIKA5 nunca deduce una capacidad del nombre del modelo
// en tiempo de ejecución. Cada adapter declara aquí lo que realmente implementa,
// y la interfaz consulta esta declaración. Si un adapter no transporta imágenes,
// adjuntar una imagen falla de forma explícita y visible: jamás se descarta en
// silencio para que el modelo conteste solo con el texto (AUD-006).
//
// "Declarado aquí" significa implementado en `ai-providers.js`. Añadir `vision: true`
// a un proveedor sin implementar el transporte de imágenes en su `chat()` reintroduce
// exactamente el fallo que este módulo existe para impedir.

const CAPABILITY_KEYS = [
  'chat',
  'vision',
  'imageGeneration',
  'imageEditing',
  'imageVariation',
  'toolUse',
  'streaming',
  'usage',
  'finishReason',
  'configurableModels'
];

const FALSE_CONTRACT = Object.freeze(
  CAPABILITY_KEYS.reduce((acc, key) => ({ ...acc, [key]: false }), {})
);

// Política de resolución de visión por modelo:
//   'none'      — el adapter no transporta imágenes en absoluto.
//   'probe'     — el propio backend informa la capacidad (Ollama /api/show).
//   'catalog'   — el catálogo configurable declara capabilities.vision por modelo.
//   'allowlist' — lista curada y auditable a mano (APIs sin endpoint de capacidades).
//   'pending'   — el transporte existe pero ningún modelo está verificado todavía.
const VISION_POLICIES = new Set(['none', 'probe', 'catalog', 'allowlist', 'pending']);

// Listas curadas a mano. Se mantienen aquí y en ningún otro sitio.
// Cada entrada es un id exacto o un prefijo de familia terminado en '*'.
// Añadir una entrada es afirmar que se verificó que ese modelo acepta imágenes
// por la API que usa el adapter correspondiente.
const OPENAI_VISION_MODELS = [
  'gpt-4o*',
  'gpt-4.1*',
  'gpt-4-turbo*',
  'gpt-5*',
  'o3*',
  'o4-mini*'
];

const ANTHROPIC_VISION_MODELS = [
  'claude-3-*',
  'claude-3.5-*',
  'claude-opus-4*',
  'claude-sonnet-4*',
  'claude-haiku-4*',
  'claude-opus-5*',
  'claude-sonnet-5*'
];

const PROVIDER_CAPABILITIES = {
  local: {
    label: 'Ollama (Local)',
    contract: {
      chat: true,
      vision: true,
      imageGeneration: false,
      imageEditing: false,
      imageVariation: false,
      toolUse: false,
      streaming: false,
      usage: true,
      finishReason: true,
      configurableModels: false
    },
    vision: { policy: 'probe' }
  },

  openai: {
    label: 'OpenAI (Cloud)',
    contract: {
      chat: true,
      vision: true,
      imageGeneration: false,
      imageEditing: false,
      imageVariation: false,
      toolUse: false,
      streaming: false,
      usage: true,
      finishReason: true,
      configurableModels: false
    },
    vision: { policy: 'allowlist', models: OPENAI_VISION_MODELS }
  },

  anthropic: {
    label: 'Anthropic Claude (Cloud)',
    contract: {
      chat: true,
      vision: true,
      imageGeneration: false,
      imageEditing: false,
      imageVariation: false,
      toolUse: false,
      streaming: false,
      usage: true,
      finishReason: true,
      configurableModels: false
    },
    vision: { policy: 'allowlist', models: ANTHROPIC_VISION_MODELS }
  },

  groq: {
    label: 'Groq (Cloud)',
    contract: {
      chat: true,
      // El transporte OpenAI-compatible está implementado, pero ningún modelo de
      // Groq está verificado todavía. Hasta que se verifique modelo por modelo,
      // el contrato declara vision:false y adjuntar imágenes se bloquea.
      vision: false,
      imageGeneration: false,
      imageEditing: false,
      imageVariation: false,
      toolUse: false,
      streaming: false,
      usage: true,
      finishReason: true,
      configurableModels: false
    },
    vision: { policy: 'pending', models: [] }
  },

  moonshot: {
    label: 'Moonshot AI (Kimi)',
    contract: {
      chat: true,
      // Igual que Groq: transporte listo, verificación por modelo pendiente.
      vision: false,
      imageGeneration: false,
      imageEditing: false,
      imageVariation: false,
      toolUse: false,
      streaming: false,
      usage: true,
      finishReason: true,
      configurableModels: false
    },
    vision: { policy: 'pending', models: [] }
  },

  alibaba: {
    label: 'Alibaba Cloud Model Studio',
    contract: {
      chat: true,
      vision: true,
      imageGeneration: true,
      imageEditing: true,
      imageVariation: true,
      toolUse: true,
      streaming: false,
      usage: true,
      finishReason: true,
      configurableModels: true
    },
    vision: { policy: 'catalog' },
    defaultVisionModel: 'qwen3.7-plus',
    defaultImageModel: 'wan2.7-image'
  },

  llamacpp: {
    label: 'llama.cpp (Local)',
    contract: {
      chat: true,
      // El servidor llama.cpp puede o no tener un proyector multimodal cargado y
      // no lo expone por /v1/models. Sin señal fiable, no se declara visión.
      vision: false,
      imageGeneration: false,
      imageEditing: false,
      imageVariation: false,
      toolUse: false,
      streaming: false,
      usage: true,
      finishReason: true,
      configurableModels: false
    },
    vision: { policy: 'none' }
  },

  bitnet: {
    label: 'BitNet (Local)',
    contract: {
      chat: true,
      // bitnet.cpp sirve modelos de texto con el mismo `llama-server` que
      // llama.cpp, que no expone proyector multimodal. Sin señal, no hay visión.
      vision: false,
      imageGeneration: false,
      imageEditing: false,
      imageVariation: false,
      toolUse: false,
      streaming: false,
      usage: true,
      finishReason: true,
      configurableModels: false
    },
    vision: { policy: 'none' }
  }
};

function matchesModelPattern(modelId, pattern) {
  const id = String(modelId || '').toLowerCase();
  const raw = String(pattern || '').toLowerCase();
  if (!id || !raw) return false;
  if (raw.endsWith('*')) return id.startsWith(raw.slice(0, -1));
  return id === raw;
}

function getProviderCapabilityEntry(providerId) {
  return PROVIDER_CAPABILITIES[providerId] || null;
}

// Contrato completo del proveedor. Un proveedor desconocido devuelve todo en false:
// una capacidad nunca se asume por omisión.
function getProviderContract(providerId) {
  const entry = getProviderCapabilityEntry(providerId);
  if (!entry) return { ...FALSE_CONTRACT };
  return CAPABILITY_KEYS.reduce((acc, key) => {
    acc[key] = entry.contract[key] === true;
    return acc;
  }, {});
}

function getVisionPolicy(providerId) {
  const entry = getProviderCapabilityEntry(providerId);
  const policy = entry?.vision?.policy;
  return VISION_POLICIES.has(policy) ? policy : 'none';
}

/**
 * Resuelve si un modelo concreto acepta imágenes.
 *
 * `modelMeta` es la metadata que el propio backend/catálogo ya produjo:
 *   - Ollama  → { supportsVision: boolean } de la sonda /api/show
 *   - Alibaba → { capabilities: { vision: true|false|null } } del catálogo
 *
 * Devuelve siempre un motivo legible para que la interfaz explique el bloqueo
 * en vez de fallar en silencio.
 */
function resolveVisionSupport({ providerId, modelId, modelMeta = null }) {
  const contract = getProviderContract(providerId);
  const policy = getVisionPolicy(providerId);

  if (!getProviderCapabilityEntry(providerId)) {
    return { supported: false, reason: 'unknown-provider', policy };
  }
  if (!contract.vision) {
    return {
      supported: false,
      reason: policy === 'pending' ? 'provider-unverified' : 'provider-unsupported',
      policy
    };
  }
  if (!modelId) {
    return { supported: false, reason: 'no-model', policy };
  }

  if (policy === 'probe') {
    const probed = modelMeta?.supportsVision;
    if (probed === true) return { supported: true, reason: 'probe', policy };
    return { supported: false, reason: 'model-unsupported', policy };
  }

  if (policy === 'catalog') {
    const declared = modelMeta?.capabilities?.vision;
    if (declared === true) return { supported: true, reason: 'catalog', policy };
    if (declared === false) return { supported: false, reason: 'model-unsupported', policy };
    return { supported: false, reason: 'model-undeclared', policy };
  }

  if (policy === 'allowlist') {
    const patterns = getProviderCapabilityEntry(providerId)?.vision?.models || [];
    const hit = patterns.some(pattern => matchesModelPattern(modelId, pattern));
    return {
      supported: hit,
      reason: hit ? 'allowlist' : 'model-unsupported',
      policy
    };
  }

  return { supported: false, reason: 'provider-unsupported', policy };
}

const VISION_BLOCK_MESSAGES = {
  'unknown-provider': 'Proveedor desconocido: no se pueden enviar imágenes.',
  'provider-unsupported': providerLabel =>
    `${providerLabel} no procesa imágenes en MIKA5. Cambia a un proveedor con visión antes de adjuntar.`,
  'provider-unverified': providerLabel =>
    `${providerLabel} todavía no tiene modelos de visión verificados en MIKA5. Adjuntar imágenes está bloqueado para no enviarlas y perderlas en silencio.`,
  'no-model': 'Selecciona un modelo antes de adjuntar una imagen.',
  'model-unsupported': (providerLabel, modelId) =>
    `El modelo ${modelId} no acepta imágenes en ${providerLabel}. Selecciona un modelo con visión.`,
  'model-undeclared': (providerLabel, modelId) =>
    `El modelo ${modelId} no declara soporte de visión en el catálogo de ${providerLabel}. Márcalo como modelo de visión o elige otro.`
};

function describeVisionBlock({ providerId, modelId, reason }) {
  const label = getProviderCapabilityEntry(providerId)?.label || providerId || 'El proveedor';
  const message = VISION_BLOCK_MESSAGES[reason];
  if (typeof message === 'function') return message(label, modelId);
  return message || 'Este proveedor no acepta imágenes.';
}

/**
 * Barrera obligatoria antes de enviar imágenes. Lanza un error tipado en vez de
 * dejar que el adapter descarte el campo `images`.
 */
function assertVisionSupported({ providerId, modelId, modelMeta = null, imageCount = 0 }) {
  if (!imageCount) return { supported: true, reason: 'no-images' };
  const resolution = resolveVisionSupport({ providerId, modelId, modelMeta });
  if (resolution.supported) return resolution;
  const error = new Error(describeVisionBlock({ providerId, modelId, reason: resolution.reason }));
  error.code = 'PROVIDER_VISION_UNSUPPORTED';
  error.providerId = providerId;
  error.modelId = modelId || null;
  error.reason = resolution.reason;
  throw error;
}

// --- Normalización transversal de la respuesta ------------------------------

const FINISH_REASON_MAP = {
  // OpenAI-compatible (OpenAI, Groq, Moonshot, llama.cpp, BitNet)
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'content_filter',
  // Anthropic-compatible (Anthropic, Alibaba)
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_use',
  refusal: 'content_filter',
  // Ollama
  unload: 'stop'
};

function normalizeFinishReason(raw) {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  return FINISH_REASON_MAP[key] || 'unknown';
}

function toTokenCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null;
}

/**
 * Normaliza el `usage` de cualquiera de los tres dialectos a una forma única.
 * Devuelve null si el proveedor no informó nada utilizable, nunca ceros falsos.
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inputTokens = toTokenCount(
    raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens ?? raw.promptTokens ?? raw.prompt_eval_count
  );
  const outputTokens = toTokenCount(
    raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens ?? raw.completionTokens ?? raw.eval_count
  );
  const declaredTotal = toTokenCount(raw.total_tokens ?? raw.totalTokens);
  if (inputTokens === null && outputTokens === null && declaredTotal === null) return null;
  const totalTokens = declaredTotal !== null
    ? declaredTotal
    : (inputTokens ?? 0) + (outputTokens ?? 0);
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Envoltura común de toda respuesta de chat. Garantiza que `provider`, `model`,
 * `usage` y `finishReason` existan siempre con la misma forma, aunque valgan null.
 */
function normalizeChatResult({
  providerId,
  model,
  content,
  rawUsage = null,
  rawFinishReason = null,
  extra = null
}) {
  const result = {
    message: { role: 'assistant', content: typeof content === 'string' ? content : '' },
    provider: providerId || null,
    model: model || null,
    usage: normalizeUsage(rawUsage),
    finishReason: normalizeFinishReason(rawFinishReason)
  };
  if (extra && typeof extra === 'object') Object.assign(result, extra);
  return result;
}

/**
 * Bloques de imagen en formato OpenAI-compatible (`image_url`).
 * Comparte validación con el camino Anthropic: mismos formatos, mismo rechazo
 * de URLs no HTTPS y de adjuntos vacíos.
 */
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

function buildOpenAIImageBlocks(images) {
  return (Array.isArray(images) ? images : []).map(image => {
    if (image?.url) {
      let parsed;
      try {
        parsed = new URL(image.url);
      } catch (_) {
        throw new Error('URL de imagen no válida');
      }
      if (parsed.protocol !== 'https:') throw new Error('La URL de imagen debe usar HTTPS');
      return { type: 'image_url', image_url: { url: parsed.toString() } };
    }
    const mediaType = String(image?.mediaType || image?.media_type || '').toLowerCase();
    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      throw new Error('Formato de imagen no compatible. Usa PNG, JPEG o WebP.');
    }
    const data = String(image?.base64 || image?.data || '')
      .replace(/^data:[^;]+;base64,/, '')
      .replace(/\s+/g, '');
    if (!data) throw new Error('La imagen adjunta está vacía');
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
  });
}

function buildAnthropicImageBlocks(images) {
  return (Array.isArray(images) ? images : []).map(image => {
    if (image?.url) {
      let parsed;
      try {
        parsed = new URL(image.url);
      } catch (_) {
        throw new Error('URL de imagen no válida');
      }
      if (parsed.protocol !== 'https:') throw new Error('La URL de imagen debe usar HTTPS');
      return { type: 'image', source: { type: 'url', url: parsed.toString() } };
    }
    const rawType = String(image?.mediaType || image?.media_type || '').toLowerCase();
    if (!SUPPORTED_IMAGE_TYPES.has(rawType)) {
      throw new Error('Formato de imagen no compatible. Usa PNG, JPEG o WebP.');
    }
    // La API de Anthropic solo acepta image/jpeg, no el alias image/jpg.
    const mediaType = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
    const data = String(image?.base64 || image?.data || '')
      .replace(/^data:[^;]+;base64,/, '')
      .replace(/\s+/g, '');
    if (!data) throw new Error('La imagen adjunta está vacía');
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });
}

/**
 * Adjunta los bloques de imagen al último mensaje de usuario de una conversación
 * OpenAI-compatible, convirtiéndolo a contenido multiparte. Si no hay imágenes,
 * la conversación se devuelve intacta (contenido string, máxima compatibilidad).
 */
function attachOpenAIImages(conversation, images) {
  const blocks = buildOpenAIImageBlocks(images);
  if (!blocks.length) return conversation;
  const lastUserIndex = conversation.map(m => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) throw new Error('No hay mensaje de usuario al que adjuntar la imagen');
  return conversation.map((message, index) => {
    if (index !== lastUserIndex) return message;
    const text = typeof message.content === 'string' ? message.content : '';
    return { ...message, content: [{ type: 'text', text }, ...blocks] };
  });
}

module.exports = {
  CAPABILITY_KEYS,
  PROVIDER_CAPABILITIES,
  OPENAI_VISION_MODELS,
  ANTHROPIC_VISION_MODELS,
  getProviderContract,
  getVisionPolicy,
  resolveVisionSupport,
  describeVisionBlock,
  assertVisionSupported,
  normalizeFinishReason,
  normalizeUsage,
  normalizeChatResult,
  buildOpenAIImageBlocks,
  buildAnthropicImageBlocks,
  attachOpenAIImages,
  matchesModelPattern
};
