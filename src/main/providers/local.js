'use strict';

// Adaptador de proveedor: local.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const { ollamaApi, resolverBaseOllama, ollamaHostEsElPorDefecto } = require('../ollama');
const { assertVisionSupported, normalizeChatResult } = require('../provider-capabilities');
const { probeDeError, probeDeExito, sanearMensaje } = require('../provider-errors');
const { formatBytes, detectCapabilities, probeOllamaVision } = require('../provider-runtime');
const { ollamaModelPrivacy } = require('../request-privacy');

// MODO LOCAL - 100% Privado (delegado a ollama.js robusto)
const adaptadorLocal = {
  name: 'Ollama (Local)',
  privacy: 'private',
  requiresKey: false,
  visualCapabilities: {
    vision: true
  },

  // Ollama es un servicio externo: normalmente ya está en marcha y MIKA5 sólo
  // lo reutiliza. Si está instalado y parado, se puede arrancar con su propio
  // `ollama serve`, que es el mecanismo que documenta. No se arranca cuando el
  // usuario lo ha configurado para escuchar en otro sitio: con `OLLAMA_HOST`
  // fuera de bucle local MIKA5 lanzaría un servidor expuesto a la red, y con
  // otro puerto uno que escucharía donde MIKA5 no consulta. Tampoco se
  // sobrescribe esa variable para forzarlo: es una decisión del usuario.
  engine: {
    tipo: 'external-service',
    ejecutable: 'ollama',
    requiereModelo: false,
    unidadesDelSistema: ['/etc/systemd/system/ollama.service'],
    baseUrl: () => resolverBaseOllama(process.env.MIKA5_OLLAMA_BASE),
    arrancable: ({ env }) => !env.MIKA5_OLLAMA_BASE && ollamaHostEsElPorDefecto(env.OLLAMA_HOST),
    argumentos: () => ['serve']
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

  // Cancelación, y NADA MÁS que cancelación.
  //
  // Una señal externa da PROVIDER_ABORTED; el plazo de `fetchWithTimeout`
  // —diez minutos por petición, el mismo de v0.2.0— da PROVIDER_TIMEOUT. Los
  // dos con `reachable: null`: nadie llegó a saber si el servidor estaba.
  //
  // Aquí NO se impone un plazo propio al catálogo entero. Una versión anterior
  // de este cambio ponía 30 s al conjunto, y eso no era añadir cancelación sino
  // cambiar el comportamiento: son N+1 peticiones en serie —una por modelo para
  // la sonda de visión— y en una máquina lenta o con muchos modelos el catálogo
  // volvía vacío donde v0.2.0 seguía esperando. El techo sigue siendo el de
  // siempre, por petición.
  async listModels(_apiKey, _config, options = {}) {
    try {
      const data = await ollamaApi.tags({ signal: options.signal });
      const raw = data.models || data.tags || [];

      // Probe each model for vision capabilities via /api/show
      const models = [];
      for (const m of raw) {
        const name = m.name || m.tag || m.id;
        const entry = {
          name,
          privacy: ollamaModelPrivacy(m, name),
          size: m.size || 0,
          digest: (m.digest || m.id || '').toString().substring(0, 12) || 'local',
          sizeFormatted: formatBytes(m.size || 0),
          capabilities: detectCapabilities(name),
          supportsVision: false
        };

        // Única fuente: la sonda. Si /api/show falla, el modelo queda sin visión
        // y adjuntar una imagen se bloqueará con un mensaje claro. Antes se caía
        // a detección por nombre y la imagen se perdía en silencio.
        try {
          const info = await ollamaApi.show(name, { signal: options.signal });
          entry.privacy = entry.privacy === 'cloud' ? 'cloud' : ollamaModelPrivacy(info, name);
          const keys = Object.keys(info?.model_info || {});
          entry.supportsVision = keys.some(key => key.includes('.vision.') || key.includes('image_token'))
            || (Array.isArray(info?.capabilities) && info.capabilities.includes('vision'));
        } catch (error) {
          if (error?.name === 'AbortError' || error?.code === 'PROVIDER_TIMEOUT') throw error;
        }
        if (entry.supportsVision && !entry.capabilities.includes('👁️ Visión')) {
          entry.capabilities.push('👁️ Visión');
        }

        models.push(entry);
      }

      // Ollama contestó: eso es evidencia de conectividad. No pide
      // credencial, así que `authenticated` se queda en null.
      return { models, probe: probeDeExito({ authenticated: null }) };
    } catch (error) {
      console.warn('Ollama no disponible:', sanearMensaje(error && error.message));
      return { models: [], probe: probeDeError(error) };
    }
  },

  async status(options = {}) {
    return ollamaApi.status({ signal: options.signal });
  }
};

module.exports = { adaptadorLocal };
