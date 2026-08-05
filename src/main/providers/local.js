'use strict';

// Adaptador de proveedor: local.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const { ollamaApi } = require('../ollama');
const { assertVisionSupported, normalizeChatResult } = require('../provider-capabilities');
const { probeDeError, probeDeExito, sanearMensaje } = require('../provider-errors');
const { formatBytes, detectCapabilities, probeOllamaVision, createAbortContext } = require('../provider-runtime');

// MODO LOCAL - 100% Privado (delegado a ollama.js robusto)
const adaptadorLocal = {
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

  // Mismo contrato de cancelación que openai, groq y llamacpp: una señal
  // externa da PROVIDER_ABORTED y el plazo propio da PROVIDER_TIMEOUT, ambos
  // con `reachable: null` porque nadie llegó a saber si el servidor estaba.
  // Antes `local` no podía cancelarse: no hace fetch propio, delega en
  // ollamaApi, y ollamaApi no aceptaba señal.
  //
  // El plazo cubre el catálogo COMPLETO, sondas de visión incluidas: son N+1
  // peticiones en serie y darle a cada una su propio plazo dejaría el total
  // sin techo.
  async listModels(_apiKey, _config, options = {}) {
    const abortContext = createAbortContext(options.signal, 30000, 'Ollama');
    try {
      const data = await ollamaApi.tags({ signal: abortContext.signal });
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
        entry.supportsVision = await probeOllamaVision(name, { signal: abortContext.signal });
        if (entry.supportsVision && !entry.capabilities.includes('👁️ Visión')) {
          entry.capabilities.push('👁️ Visión');
        }

        models.push(entry);
      }

      // Ollama contestó: eso es evidencia de conectividad. No pide
      // credencial, así que `authenticated` se queda en null.
      return { models, probe: probeDeExito({ authenticated: null }) };
    } catch (e) {
      const error = abortContext.normalize(e);
      console.warn('Ollama no disponible:', sanearMensaje(error && error.message));
      return { models: [], probe: probeDeError(error) };
    } finally {
      abortContext.cleanup();
    }
  },

  async status(options = {}) {
    return ollamaApi.status({ signal: options.signal });
  }
};

module.exports = { adaptadorLocal };
