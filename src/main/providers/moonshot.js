'use strict';

// Adaptador de proveedor: moonshot.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const {
  assertVisionSupported, attachOpenAIImages, normalizeChatResult
} = require('../provider-capabilities');
const { probeNoIntentada } = require('../provider-errors');
const { createAbortContext, sanitizeForCloud } = require('../provider-runtime');

// MOONSHOT / Kimi (Cloud)
const adaptadorMoonshot = {
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
};

module.exports = { adaptadorMoonshot };
