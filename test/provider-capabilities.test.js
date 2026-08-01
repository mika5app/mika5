'use strict';

// Contrato multi-provider. La regresión que estas pruebas impiden es AUD-006:
// un adapter que acepta `images`, las descarta en silencio y devuelve una
// respuesta de solo texto como si hubiera analizado la imagen.

const assert = require('assert');
const {
  CAPABILITY_KEYS,
  PROVIDER_CAPABILITIES,
  getProviderContract,
  resolveVisionSupport,
  assertVisionSupported,
  normalizeUsage,
  normalizeFinishReason,
  normalizeChatResult,
  attachOpenAIImages,
  buildAnthropicImageBlocks,
  matchesModelPattern
} = require('../src/main/provider-capabilities');
const { PROVIDERS } = require('../src/main/ai-providers');

const ALL_PROVIDERS = ['local', 'openai', 'anthropic', 'groq', 'moonshot', 'alibaba', 'llamacpp'];
const PNG = { mediaType: 'image/png', base64: 'aGVsbG8=' };

// --- 1. Forma del contrato --------------------------------------------------

for (const providerId of ALL_PROVIDERS) {
  const contract = getProviderContract(providerId);
  assert.deepEqual(
    Object.keys(contract).sort(),
    [...CAPABILITY_KEYS].sort(),
    `${providerId}: el contrato debe declarar exactamente las ${CAPABILITY_KEYS.length} capacidades`
  );
  for (const key of CAPABILITY_KEYS) {
    assert.equal(typeof contract[key], 'boolean', `${providerId}.${key} debe ser booleano, nunca undefined`);
  }
  assert.equal(contract.chat, true, `${providerId}: todos los proveedores hacen chat de texto`);
  assert(PROVIDERS[providerId], `${providerId} declarado en el contrato debe existir como adapter`);
}

// Un proveedor desconocido nunca hereda capacidades por omisión.
const unknown = getProviderContract('proveedor-inventado');
assert(CAPABILITY_KEYS.every(key => unknown[key] === false), 'proveedor desconocido: todo en false');

// Cada proveedor del contrato tiene adapter, y cada adapter tiene contrato.
assert.deepEqual(
  Object.keys(PROVIDER_CAPABILITIES).sort(),
  Object.keys(PROVIDERS).sort(),
  'contrato y adapters deben cubrir el mismo conjunto de proveedores'
);

// --- 2. Coherencia entre contrato e implementación --------------------------

// Declarar imageGeneration obliga a implementar generateImage, y al revés.
for (const providerId of ALL_PROVIDERS) {
  const contract = getProviderContract(providerId);
  const hasImpl = typeof PROVIDERS[providerId].generateImage === 'function';
  assert.equal(
    contract.imageGeneration, hasImpl,
    `${providerId}: imageGeneration declarado debe coincidir con generateImage implementado`
  );
  // Editar o variar exige poder generar.
  if (contract.imageEditing || contract.imageVariation) {
    assert(contract.imageGeneration, `${providerId}: edición/variación requiere generación`);
  }
}

// Hoy solo Alibaba tiene endpoints reales de generación/edición/variación.
assert.equal(getProviderContract('alibaba').imageGeneration, true);
for (const providerId of ALL_PROVIDERS.filter(id => id !== 'alibaba')) {
  const contract = getProviderContract(providerId);
  assert.equal(contract.imageGeneration, false, `${providerId} no genera imágenes`);
  assert.equal(contract.imageEditing, false, `${providerId} no edita imágenes`);
  assert.equal(contract.imageVariation, false, `${providerId} no hace variaciones`);
}

// --- 3. Resolución de visión por política -----------------------------------

// probe (Ollama): manda la sonda, no el nombre.
assert.equal(resolveVisionSupport({ providerId: 'local', modelId: 'llava:7b' }).supported, false,
  'sin sonda positiva, llava NO habilita visión aunque el nombre lo sugiera');
assert.equal(
  resolveVisionSupport({ providerId: 'local', modelId: 'llava:7b', modelMeta: { supportsVision: true } }).supported,
  true
);
assert.equal(
  resolveVisionSupport({ providerId: 'local', modelId: 'mistral:7b', modelMeta: { supportsVision: false } }).supported,
  false
);

// catalog (Alibaba): manda capabilities.vision del catálogo configurable.
assert.equal(
  resolveVisionSupport({
    providerId: 'alibaba', modelId: 'qwen3.7-plus', modelMeta: { capabilities: { vision: true } }
  }).supported, true
);
const undeclared = resolveVisionSupport({
  providerId: 'alibaba', modelId: 'modelo-custom', modelMeta: { capabilities: { vision: null } }
});
assert.equal(undeclared.supported, false);
assert.equal(undeclared.reason, 'model-undeclared', 'null no es "sí": es "sin declarar"');

// allowlist (OpenAI / Anthropic): lista curada, no patrones sueltos.
assert.equal(resolveVisionSupport({ providerId: 'openai', modelId: 'gpt-4o' }).supported, true);
assert.equal(resolveVisionSupport({ providerId: 'openai', modelId: 'gpt-4o-mini' }).supported, true);
assert.equal(resolveVisionSupport({ providerId: 'openai', modelId: 'gpt-3.5-turbo' }).supported, false);
assert.equal(resolveVisionSupport({ providerId: 'openai', modelId: 'gpt-4' }).supported, false,
  'gpt-4 original no acepta imágenes; solo la familia turbo/4o/4.1');
assert.equal(resolveVisionSupport({ providerId: 'anthropic', modelId: 'claude-3-haiku-20240307' }).supported, true);
assert.equal(resolveVisionSupport({ providerId: 'anthropic', modelId: 'claude-opus-4-5' }).supported, true);
assert.equal(resolveVisionSupport({ providerId: 'anthropic', modelId: 'claude-2.1' }).supported, false);

// pending (Groq / Moonshot): transporte listo, verificación pendiente.
for (const providerId of ['groq', 'moonshot']) {
  const resolution = resolveVisionSupport({ providerId, modelId: 'kimi-k2-vision-preview' });
  assert.equal(resolution.supported, false, `${providerId} no tiene modelos de visión verificados`);
  assert.equal(resolution.reason, 'provider-unverified',
    `${providerId} debe distinguirse de "no soportado": está pendiente de verificar`);
}

// none (llama.cpp): sin señal fiable del servidor.
assert.equal(resolveVisionSupport({ providerId: 'llamacpp', modelId: 'llava-v1.6' }).supported, false);

// Nombres que antes disparaban la heurística del renderer y ya no autorizan nada.
for (const [providerId, modelId] of [
  ['groq', 'llama-3.2-90b-vision-preview'],
  ['moonshot', 'kimi-k2'],
  ['llamacpp', 'pixtral-12b'],
  ['openai', 'gpt-4-vision-alpha-inventado']
]) {
  const resolution = resolveVisionSupport({ providerId, modelId });
  assert.equal(resolution.supported, false, `${providerId}/${modelId}: el nombre no es evidencia`);
}

assert.equal(matchesModelPattern('gpt-4o-2024-08-06', 'gpt-4o*'), true);
assert.equal(matchesModelPattern('gpt-4omni', 'gpt-4o*'), true);
assert.equal(matchesModelPattern('gpt-4', 'gpt-4o*'), false);
assert.equal(matchesModelPattern('claude-3-opus', 'claude-3-opus'), true);
assert.equal(matchesModelPattern('claude-3-opus-x', 'claude-3-opus'), false, 'sin * es coincidencia exacta');

// --- 4. La barrera lanza, nunca descarta ------------------------------------

// Sin imágenes, la barrera no interfiere.
assert.deepEqual(
  assertVisionSupported({ providerId: 'groq', modelId: 'llama-3.3-70b-versatile', imageCount: 0 }),
  { supported: true, reason: 'no-images' }
);

for (const providerId of ['groq', 'moonshot', 'llamacpp']) {
  assert.throws(
    () => assertVisionSupported({ providerId, modelId: 'cualquiera', imageCount: 1 }),
    error => {
      assert.equal(error.code, 'PROVIDER_VISION_UNSUPPORTED', `${providerId}: error tipado`);
      assert.equal(error.providerId, providerId);
      assert(error.message.length > 20, `${providerId}: el mensaje debe explicar el bloqueo`);
      return true;
    },
    `${providerId} debe lanzar al recibir una imagen`
  );
}

assert.throws(
  () => assertVisionSupported({ providerId: 'openai', modelId: 'gpt-3.5-turbo', imageCount: 1 }),
  /no acepta imágenes/
);
assert.doesNotThrow(() => assertVisionSupported({ providerId: 'openai', modelId: 'gpt-4o', imageCount: 1 }));

// --- 5. Ningún adapter descarta imágenes en silencio ------------------------
// Recorre TODOS los proveedores: enviar una imagen a un modelo sin visión debe
// terminar en error, jamás en una respuesta de texto que finja el análisis.

async function expectSilentDropIsImpossible(providerId, chatParams) {
  const previousFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => {
    networkCalls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Es una foto de un gato.' }, finish_reason: 'stop' }],
        content: [{ type: 'text', text: 'Es una foto de un gato.' }],
        stop_reason: 'end_turn'
      })
    };
  };
  try {
    await PROVIDERS[providerId].chat(chatParams);
    assert.fail(`${providerId}: aceptó una imagen sin declarar visión (regresión AUD-006)`);
  } catch (error) {
    assert.equal(error.code, 'PROVIDER_VISION_UNSUPPORTED',
      `${providerId}: debe fallar por capacidad, no por otra causa (${error.message})`);
    assert.equal(networkCalls, 0, `${providerId}: no debe llegar a la red con una imagen que no puede procesar`);
  } finally {
    global.fetch = previousFetch;
  }
}

(async () => {
  const baseMessages = [{ role: 'user', content: '¿Qué ves en esta imagen?' }];

  await expectSilentDropIsImpossible('openai', {
    model: 'gpt-3.5-turbo', messages: baseMessages, images: [PNG], apiKey: 'sk-test'
  });
  await expectSilentDropIsImpossible('anthropic', {
    model: 'claude-2.1', messages: baseMessages, images: [PNG], apiKey: 'sk-test'
  });
  await expectSilentDropIsImpossible('groq', {
    model: 'llama-3.3-70b-versatile', messages: baseMessages, images: [PNG], apiKey: 'gsk-test'
  });
  await expectSilentDropIsImpossible('moonshot', {
    model: 'kimi-k2', messages: baseMessages, images: [PNG], apiKey: 'sk-test'
  });
  await expectSilentDropIsImpossible('llamacpp', {
    model: 'llava-v1.6', messages: baseMessages, images: [PNG]
  });

  // --- 6. Visión REAL en OpenAI y Anthropic ---------------------------------
  // No basta con no fallar: la imagen debe viajar en el cuerpo de la petición.

  async function captureBody(providerId, chatParams, response) {
    const previousFetch = global.fetch;
    let body = null;
    global.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => response };
    };
    try {
      const out = await PROVIDERS[providerId].chat(chatParams);
      return { body, out };
    } finally {
      global.fetch = previousFetch;
    }
  }

  const openai = await captureBody('openai', {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: '¿Qué ves?' }],
    images: [PNG],
    apiKey: 'sk-test'
  }, {
    model: 'gpt-4o',
    choices: [{ message: { content: 'Un gato.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
  });
  const openaiContent = openai.body.messages.at(-1).content;
  assert(Array.isArray(openaiContent), 'OpenAI: el mensaje con imagen debe ser multiparte');
  assert.equal(openaiContent[0].type, 'text');
  assert.equal(openaiContent[0].text, '¿Qué ves?', 'el texto original se conserva íntegro');
  assert.equal(openaiContent[1].type, 'image_url');
  assert.equal(openaiContent[1].image_url.url, 'data:image/png;base64,aGVsbG8=');
  assert.equal(openai.out.provider, 'openai');
  assert.equal(openai.out.model, 'gpt-4o');
  assert.equal(openai.out.finishReason, 'stop');
  assert.deepEqual(openai.out.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });

  const anthropic = await captureBody('anthropic', {
    model: 'claude-3-5-sonnet-20241022',
    messages: [{ role: 'user', content: '¿Qué ves?' }],
    images: [{ mediaType: 'image/jpg', base64: 'aGVsbG8=' }],
    apiKey: 'sk-test'
  }, {
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'Un gato.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 30, output_tokens: 7 }
  });
  const anthropicContent = anthropic.body.messages.at(-1).content;
  assert(Array.isArray(anthropicContent), 'Anthropic: el mensaje con imagen debe ser multiparte');
  assert.equal(anthropicContent[1].type, 'image');
  assert.equal(anthropicContent[1].source.type, 'base64');
  assert.equal(anthropicContent[1].source.media_type, 'image/jpeg',
    'image/jpg debe traducirse a image/jpeg: la API de Anthropic rechaza el alias');
  assert.equal(anthropic.out.provider, 'anthropic');
  assert.equal(anthropic.out.finishReason, 'stop');
  assert.deepEqual(anthropic.out.usage, { inputTokens: 30, outputTokens: 7, totalTokens: 37 });

  // Ollama recibe base64 pelado venga como venga: string suelto, objeto
  // descriptivo o data-URL. Es el mismo array que usan los adapters cloud.
  const { ollamaApi } = require('../src/main/ollama');
  const previousOllamaChat = ollamaApi.chat;
  const previousOllamaShow = ollamaApi.show;
  ollamaApi.show = async () => ({ capabilities: ['vision'] });
  let sentToOllama = null;
  ollamaApi.chat = async params => {
    sentToOllama = params;
    return { model: 'llava:7b', message: { content: 'ok' }, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 };
  };
  try {
    const out = await PROVIDERS.local.chat({
      model: 'llava:7b',
      messages: [{ role: 'user', content: 'mira' }],
      images: ['aGVsbG8=', { mediaType: 'image/png', base64: 'd29ybGQ=' }, { base64: 'data:image/png;base64,Zm9v' }]
    });
    assert.deepEqual(sentToOllama.messages.at(-1).images, ['aGVsbG8=', 'd29ybGQ=', 'Zm9v'],
      'Ollama debe recibir base64 pelado, sin prefijo data:');
    assert.equal(out.provider, 'local');
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });

    // Sonda negativa: la imagen no se envía aunque el nombre diga "llava".
    ollamaApi.show = async () => ({ capabilities: [] });
    await assert.rejects(
      () => PROVIDERS.local.chat({
        model: 'llava:7b', messages: [{ role: 'user', content: 'mira' }], images: [PNG]
      }),
      error => error.code === 'PROVIDER_VISION_UNSUPPORTED'
    );
  } finally {
    ollamaApi.chat = previousOllamaChat;
    ollamaApi.show = previousOllamaShow;
  }

  // --- Truncamiento: los cuatro dialectos deben llegar a 'length' ------------
  // appendOutputLimitNotice() solo dispara con finishReason === 'length'. Si un
  // proveedor no normaliza, su respuesta cortada se mostraría como si estuviera
  // completa. Se comprueba sobre el adapter real, no sobre el helper.
  const truncations = [
    ['openai', { model: 'gpt-4o', apiKey: 'sk-t' },
      { choices: [{ message: { content: 'a medias' }, finish_reason: 'length' }] }],
    ['groq', { model: 'llama-3.3-70b-versatile', apiKey: 'gsk-t' },
      { choices: [{ message: { content: 'a medias' }, finish_reason: 'length' }] }],
    ['moonshot', { model: 'kimi-k2', apiKey: 'sk-t' },
      { choices: [{ message: { content: 'a medias' }, finish_reason: 'length' }] }],
    ['llamacpp', { model: 'local' },
      { choices: [{ message: { content: 'a medias' }, finish_reason: 'length' }] }],
    ['anthropic', { model: 'claude-3-5-haiku-20241022', apiKey: 'sk-t' },
      { content: [{ type: 'text', text: 'a medias' }], stop_reason: 'max_tokens' }]
  ];
  for (const [providerId, params, response] of truncations) {
    const { out } = await captureBody(providerId, {
      ...params, messages: [{ role: 'user', content: 'hola' }]
    }, response);
    assert.equal(out.finishReason, 'length',
      `${providerId}: una respuesta truncada debe normalizar a 'length'`);
    assert.equal(out.message.content, 'a medias',
      `${providerId}: el texto parcial se conserva íntegro`);
  }

  // Ollama por su propio campo `done_reason`.
  const previousChat = ollamaApi.chat;
  ollamaApi.chat = async () => ({ message: { content: 'a medias' }, done_reason: 'length' });
  try {
    const out = await PROVIDERS.local.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hola' }] });
    assert.equal(out.finishReason, 'length', "Ollama: done_reason 'length' normaliza a 'length'");
  } finally {
    ollamaApi.chat = previousChat;
  }

  // Alibaba ya se cubre en alibaba-provider.test.js; aquí solo el mapa.
  assert.equal(normalizeFinishReason('max_tokens'), 'length');

  // Sin imágenes, el contenido sigue siendo string plano (máxima compatibilidad).
  const plain = await captureBody('openai', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'hola' }], apiKey: 'sk-test'
  }, { choices: [{ message: { content: 'hola' }, finish_reason: 'stop' }] });
  assert.equal(typeof plain.body.messages.at(-1).content, 'string');

  console.log('Provider capabilities tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

// --- 7. Normalización transversal ------------------------------------------

// usage: los tres dialectos colapsan en una sola forma.
assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }),
  { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, 'dialecto OpenAI');
assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 20 }),
  { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, 'dialecto Anthropic: total calculado');
assert.deepEqual(normalizeUsage({ prompt_eval_count: 4, eval_count: 6 }),
  { inputTokens: 4, outputTokens: 6, totalTokens: 10 }, 'dialecto Ollama');
// Nunca se inventan ceros: sin datos, null.
assert.equal(normalizeUsage(null), null);
assert.equal(normalizeUsage({}), null);
assert.equal(normalizeUsage({ irrelevante: 1 }), null);
assert.deepEqual(normalizeUsage({ output_tokens: 5 }), { inputTokens: null, outputTokens: 5, totalTokens: 5 });

// finishReason: mismo vocabulario en los siete proveedores.
assert.equal(normalizeFinishReason('stop'), 'stop');
assert.equal(normalizeFinishReason('end_turn'), 'stop');
assert.equal(normalizeFinishReason('length'), 'length');
assert.equal(normalizeFinishReason('max_tokens'), 'length', 'truncamiento: mismo nombre en todos');
assert.equal(normalizeFinishReason('tool_calls'), 'tool_use');
assert.equal(normalizeFinishReason('tool_use'), 'tool_use');
assert.equal(normalizeFinishReason('content_filter'), 'content_filter');
assert.equal(normalizeFinishReason(null), null);
assert.equal(normalizeFinishReason('algo_nuevo'), 'unknown', 'un motivo desconocido se marca, no se descarta');

// El sobre común siempre tiene los cuatro campos, aunque valgan null.
const envelope = normalizeChatResult({ providerId: 'groq', model: 'x', content: 'hola' });
assert.deepEqual(Object.keys(envelope).sort(), ['finishReason', 'message', 'model', 'provider', 'usage']);
assert.equal(envelope.usage, null);
assert.equal(envelope.finishReason, null);
assert.equal(envelope.message.role, 'assistant');
assert.equal(normalizeChatResult({ providerId: 'x', model: 'y', content: undefined }).message.content, '');

// --- 8. Validación de imágenes ---------------------------------------------

assert.throws(() => buildAnthropicImageBlocks([{ mediaType: 'image/gif', base64: 'aa' }]),
  /no compatible/, 'GIF no está soportado');
assert.throws(() => buildAnthropicImageBlocks([{ mediaType: 'image/png', base64: '' }]),
  /vacía/);
assert.throws(() => attachOpenAIImages([{ role: 'user', content: 'x' }], [{ url: 'http://inseguro.test/a.png' }]),
  /HTTPS/, 'una URL de imagen no HTTPS se rechaza');
assert.throws(() => attachOpenAIImages([{ role: 'assistant', content: 'x' }], [PNG]),
  /No hay mensaje de usuario/);
// La imagen se adjunta al ÚLTIMO mensaje de usuario, no al último mensaje.
const attached = attachOpenAIImages([
  { role: 'user', content: 'primero' },
  { role: 'assistant', content: 'respuesta' },
  { role: 'user', content: 'segundo' }
], [PNG]);
assert.equal(typeof attached[0].content, 'string', 'los mensajes previos no se tocan');
assert(Array.isArray(attached[2].content));
assert.equal(attached[2].content[0].text, 'segundo');
