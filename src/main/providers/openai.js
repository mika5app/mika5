'use strict';

// Adaptador de proveedor: openai.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const {
  assertVisionSupported, attachOpenAIImages, normalizeChatResult, resolveVisionSupport
} = require('../provider-capabilities');
const {
  errorDeRespuesta, probeDeError, probeDeExito, probeDeRespuestaInvalida, probeNoIntentada
} = require('../provider-errors');
const { createAbortContext, sanitizeForCloud } = require('../provider-runtime');

// Families served by this adapter's Chat Completions endpoint. Exclude
// specialized endpoints even when their names share the gpt prefix.
function isChatModel(id) {
  return /^(?:gpt-(?:3\.5-turbo|4|5)|chatgpt-4o|o[134](?:-|$))/.test(id)
    && !/(?:embedding|instruct|realtime|audio|transcribe|tts|image|codex|deep-research|(?:^|-)pro(?:-|$))/.test(id);
}

// OPENAI - Cloud (No privado)
const adaptadorOpenai = {
  name: 'OpenAI (Cloud)',
  // Catálogo oficial de este proveedor, para que el usuario explore modelos.
  // Cada proveedor tiene el suyo: ninguno hereda el de otro.
  libraryUrl: 'https://developers.openai.com/api/docs/models',
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
          ...(/^(?:o[134](?:-|$)|gpt-5)/.test(selectedModel) ? {} : { temperature: 0.7 })
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
  // Tercer parámetro opcional y retrocompatible: las llamadas existentes sin
  // `options` siguen funcionando igual. Con `options.signal`, una cancelación
  // externa produce PROVIDER_ABORTED y el plazo interno produce
  // PROVIDER_TIMEOUT: `createAbortContext()` distingue los dos y limpia su
  // temporizador y su oyente en `cleanup()`. No se usa AbortSignal.any.
  async listModels(apiKey, _config, options = {}) {
    if (!apiKey) return { models: [], probe: probeNoIntentada() };
    const abortContext = createAbortContext(options.signal, this.timeout || 30000, 'OpenAI');
    let res;
    try {
      res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: abortContext.signal
      });
    } catch (error) {
      return { models: [], probe: probeDeError(abortContext.normalize(error)) };
    } finally {
      abortContext.cleanup();
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
        .filter(m => m && typeof m.id === 'string' && isChatModel(m.id))
        .map(m => ({
          name: m.id,
          size: 0,
          digest: m.id,
          supportsVision: resolveVisionSupport({ providerId: 'openai', modelId: m.id }).supported
        })),
      probe: probeDeExito({ httpStatus: res.status, authenticated: true })
    };
  }
};

module.exports = { adaptadorOpenai };
