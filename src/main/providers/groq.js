'use strict';

// Adaptador de proveedor: groq.
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

// GROQ - Cloud (Llama / Mistral family — ultrarrápido)
const adaptadorGroq = {
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
};

module.exports = { adaptadorGroq };
