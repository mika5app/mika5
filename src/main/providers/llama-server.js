'use strict';

// Módulo auxiliar, no un adaptador: la fábrica de la que salen llamacpp y bitnet.
//
// El cliente HTTP se extrajo sin cambios de `providers/llamacpp.js`, que a su
// vez lo había extraído sin cambios de `ai-providers.js`. Conserva propiedades,
// firmas y mensajes; lo único parametrizado es lo que distingue a un servidor
// de otro.

const { assertVisionSupported, normalizeChatResult } = require('../provider-capabilities');
const {
  errorDeRespuesta, probeDeError, probeDeExito, probeDeRespuestaInvalida
} = require('../provider-errors');
const { createAbortContext } = require('../provider-runtime');

// Servidor `llama-server` local (API OpenAI-compatible).
//
// Es una fábrica porque dos proveedores hablan exactamente este protocolo:
// llama.cpp y BitNet. bitnet.cpp es un fork de llama.cpp y su
// `run_inference_server.py` arranca el mismo `llama-server`. Lo único que
// cambia entre ellos es el id, la etiqueta, el puerto por defecto y cómo se
// arranca el servidor; duplicar el cliente HTTP haría que los dos divergieran
// en silencio la primera vez que se corrigiera uno solo.
function crearAdaptadorServidorLlama({ providerId, name, etiqueta, baseUrl, comoIniciar }) {
  return {
    name,
    privacy: 'private',
    requiresKey: false,
    baseUrl,
    timeout: 300000, // 5 min — modelos grandes son lentos

    async chat({ model, messages, images = [], signal }) {
      const selectedModel = model || 'default';
      // llama-server no expone si tiene proyector multimodal cargado, así que
      // MIKA5 no declara visión: adjuntar una imagen falla en vez de perderse.
      assertVisionSupported({
        providerId,
        modelId: selectedModel,
        imageCount: images.length
      });
      const abortContext = createAbortContext(signal, this.timeout, etiqueta);
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
          throw new Error(err.error?.message || `${etiqueta} Error: ${res.status}`);
        }
        const data = await res.json();
        const choice = data.choices?.[0];
        return normalizeChatResult({
          providerId,
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
        if (error.code === 'ECONNREFUSED') throw new Error(`${etiqueta} no está corriendo. Inicia con: ${comoIniciar}`);
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
      const abortContext = createAbortContext(options.signal, 3000, etiqueta);
      let res;
      try {
        res = await fetch(`${this.baseUrl}/models`, { signal: abortContext.signal });
      } catch (error) {
        return { models: [], probe: probeDeError(abortContext.normalize(error)) };
      } finally {
        abortContext.cleanup();
      }
      if (!res.ok) {
        return { models: [], probe: probeDeError(errorDeRespuesta(res.status, etiqueta)) };
      }
      // Mismo contrato que los demás adaptadores de red. `authenticated` queda
      // en null: el servidor es local y no pide credencial, así que un 2xx no
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
            description: `${etiqueta} — ${m.id}`
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
        const error = errorDeRespuesta(res, etiqueta);
        return { ok: false, error, probe: probeDeError(error) };
      } catch (error) {
        // ECONNREFUSED, timeout o fallo de transporte: el error se pasa tal cual
        // para que lo clasifique quien sabe hacerlo.
        return { ok: false, error, probe: probeDeError(error) };
      }
    }
  };
}

module.exports = { crearAdaptadorServidorLlama };
