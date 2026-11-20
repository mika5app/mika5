'use strict';

// Adaptador de proveedor: moonshot.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const {
  assertVisionSupported, attachOpenAIImages, normalizeChatResult
} = require('../provider-capabilities');
const {
  errorDeRespuesta, probeDeError, probeDeExito, probeDeRespuestaInvalida, probeNoIntentada
} = require('../provider-errors');
const { createAbortContext, sanitizeForCloud } = require('../provider-runtime');

// MOONSHOT / Kimi (Cloud)
const adaptadorMoonshot = {
  name: 'Moonshot AI (Kimi 2.5)',
  // Catálogo oficial de este proveedor, para que el usuario explore modelos.
  // Cada proveedor tiene el suyo: ninguno hereda el de otro.
  libraryUrl: 'https://platform.kimi.ai/docs/models',
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

  // El catálogo se pregunta al proveedor: `GET /models`, con la clave del
  // usuario y contra la MISMA dirección que usa el chat. Antes era una lista
  // escrita aquí, que ni reflejaba lo que la cuenta puede usar ni se enteraba
  // de un modelo nuevo. Consultar el catálogo no es una inferencia y no
  // factura. La clave no se envía a ninguna otra dirección.
  async listModels(apiKey, _config, options = {}) {
    if (!apiKey) return { models: [], probe: probeNoIntentada() };
    const abortContext = createAbortContext(options.signal, 30000, 'Moonshot');
    let res;
    try {
      res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: abortContext.signal
      });
    } catch (error) {
      return { models: [], probe: probeDeError(abortContext.normalize(error)) };
    } finally {
      abortContext.cleanup();
    }
    if (!res.ok) {
      return { models: [], probe: probeDeError(errorDeRespuesta(res.status, 'Moonshot no devolvió el catálogo')) };
    }
    let data;
    try {
      data = await res.json();
    } catch (_) {
      return { models: [], probe: probeDeRespuestaInvalida({ httpStatus: res.status, authenticated: true }) };
    }
    if (!data || !Array.isArray(data.data)) {
      return { models: [], probe: probeDeRespuestaInvalida({ httpStatus: res.status, authenticated: true }) };
    }
    return {
      // El catálogo no informa de capacidades: no se inventa ninguna.
      models: data.data
        .filter(m => m && typeof m.id === 'string')
        .map(m => ({ name: m.id, size: 0, digest: m.id })),
      probe: probeDeExito({ httpStatus: res.status, authenticated: true })
    };
  }
};

module.exports = { adaptadorMoonshot };
