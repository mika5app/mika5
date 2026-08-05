'use strict';

// Adaptador de proveedor: llamacpp.
//
// Extraído sin cambios desde `ai-providers.js`, que lo sigue componiendo en
// el registro `PROVIDERS`. El objeto conserva sus propiedades, sus firmas y su
// comportamiento: este módulo sólo cambia dónde vive el código.

const { assertVisionSupported, normalizeChatResult } = require('../provider-capabilities');
const {
  errorDeRespuesta, probeDeError, probeDeExito, probeDeRespuestaInvalida
} = require('../provider-errors');
const { createAbortContext } = require('../provider-runtime');

// LLAMA.CPP - Local (servidor OpenAI-compatible)
const adaptadorLlamacpp = {
  name: 'llama.cpp (Local)',
  privacy: 'private',
  requiresKey: false,
  baseUrl: 'http://127.0.0.1:8080/v1',
  timeout: 300000, // 5 min — modelos grandes son lentos

  async chat({ model, messages, images = [], signal }) {
    const selectedModel = model || 'default';
    // llama.cpp no expone si tiene proyector multimodal cargado, así que MIKA5
    // no declara visión: adjuntar una imagen falla en vez de perderse.
    assertVisionSupported({
      providerId: 'llamacpp',
      modelId: selectedModel,
      imageCount: images.length
    });
    const abortContext = createAbortContext(signal, this.timeout, 'llama.cpp');
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          temperature: 0.7,
          stream: false
        }),
        signal: abortContext.signal
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `llama.cpp Error: ${res.status}`);
      }
      const data = await res.json();
      const choice = data.choices?.[0];
      return normalizeChatResult({
        providerId: 'llamacpp',
        model: data.model || selectedModel,
        content: choice?.message?.content ?? '',
        rawUsage: data.usage,
        rawFinishReason: choice?.finish_reason
      });
    } catch (error) {
      const normalized = abortContext.normalize(error);
      if (normalized.code === 'PROVIDER_TIMEOUT') {
        normalized.message += '. Prueba un modelo más pequeño.';
      }
      if (error.code === 'ECONNREFUSED') throw new Error('llama.cpp no está corriendo. Inicia con: ./server -m modelo.gguf --port 8080');
      throw normalized;
    } finally {
      abortContext.cleanup();
    }
  },

  // El fallo se sigue capturando —la lista vacía es una respuesta válida—,
  // pero ahora se conserva POR QUÉ está vacía. Antes se perdía y una caída
  // de red era indistinguible de un servidor sin modelos cargados.
  // Tercer parámetro opcional y retrocompatible. El plazo interno de tres
  // segundos se conserva; ahora convive con una cancelación externa y las dos
  // se distinguen: PROVIDER_ABORTED frente a PROVIDER_TIMEOUT.
  async listModels(_apiKey, _config, options = {}) {
    const abortContext = createAbortContext(options.signal, 3000, 'llama.cpp');
    let res;
    try {
      res = await fetch(`${this.baseUrl}/models`, { signal: abortContext.signal });
    } catch (error) {
      return { models: [], probe: probeDeError(abortContext.normalize(error)) };
    } finally {
      abortContext.cleanup();
    }
    if (!res.ok) {
      return { models: [], probe: probeDeError(errorDeRespuesta(res.status, 'llama.cpp')) };
    }
    // Mismo contrato que los demás adaptadores de red. `authenticated` queda
    // en null: llama.cpp es local y no pide credencial, así que un 2xx no
    // prueba nada sobre una autenticación que no existe.
    let data;
    try {
      data = await res.json();
    } catch (_) {
      return { models: [], probe: probeDeRespuestaInvalida({ httpStatus: res.status }) };
    }
    if (!data || !Array.isArray(data.data)) {
      return { models: [], probe: probeDeRespuestaInvalida({ httpStatus: res.status }) };
    }
    return {
      models: data.data
        .filter(m => m && typeof m.id === 'string')
        .map(m => ({
          name: m.id,
          size: 0,
          digest: m.id,
          description: `llama.cpp — ${m.id}`
        })),
      probe: probeDeExito({ httpStatus: res.status })
    };
  },

  // La sonda devuelve EVIDENCIA, no una frase. Antes tragaba el error real y
  // devolvía texto suelto: `clasificarError()` no encuentra nada estructurado
  // en una cadena, así que todo caía en PROVIDER_UNKNOWN_ERROR y el registro
  // decía «no verificado» donde lo cierto era «no hay nadie escuchando en el
  // 8080». Distinguir esas dos cosas es justo para lo que existen los ocho
  // estados. El HTTP no-2xx tampoco es lo mismo: prueba que el servidor está
  // ahí, y su código tiene que llegar entero al contrato.
  async status() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return { ok: true, probe: probeDeExito({ authenticated: null }) };
      const error = errorDeRespuesta(res, 'llama.cpp');
      return { ok: false, error, probe: probeDeError(error) };
    } catch (error) {
      // ECONNREFUSED, timeout o fallo de transporte: el error se pasa tal cual
      // para que lo clasifique quien sabe hacerlo.
      return { ok: false, error, probe: probeDeError(error) };
    }
  }
};

module.exports = { adaptadorLlamacpp };
