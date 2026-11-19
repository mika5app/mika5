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
function crearAdaptadorServidorLlama({
  providerId, name, etiqueta, baseUrl, comoIniciar, paquete, descargaHf, guia, compatibilidad, aceptaEjecutable, catalogo
}) {
  const adaptador = {
    name,
    privacy: 'private',
    requiresKey: false,
    baseUrl,
    timeout: 300000, // 5 min — modelos grandes son lentos

    // Motor gestionable: con el ejecutable y un modelo GGUF elegidos una vez,
    // MIKA5 arranca `llama-server` al seleccionar el proveedor. Host y puerto
    // salen de la `baseUrl` del adaptador, la misma dirección que consulta el
    // cliente: no hay un segundo sitio donde declararlos.
    engine: {
      tipo: 'managed',
      ejecutable: 'llama-server',
      requiereModelo: true,
      baseUrl: () => adaptador.baseUrl,
      // Gestor de paquetes oficial con el que se puede instalar, si lo hay,
      // y página oficial de instalación para cuando no.
      paquete: paquete || null,
      guia: guia || null,
      // Qué puede decirse de un GGUF sin cargarlo, a partir de lo que declara.
      compatibilidad: compatibilidad || (() => 'unverified'),
      // `-hf` hace que el propio servidor descargue un GGUF de Hugging Face a
      // su caché. Sólo se usa tras autorizarlo el usuario.
      descargaHf: descargaHf === true,
      // `--alias` da al modelo cargado el nombre que el usuario eligió.
      // Host y puerto van SIEMPRE explícitos: el puerto por defecto del
      // ejecutable cambia entre versiones (8080, 9931) y no es el de MIKA5.
      argumentos: ({ host, port, model, hf, alias, ctx, cpu }) => [
        ...(hf ? ['-hf', hf] : ['-m', model]),
        ...(alias ? ['--alias', alias] : []),
        // Sin `-c` el servidor reserva el contexto MÁXIMO del modelo —131 072
        // tokens en algunos— y la memoria que eso pide lo tumba al arrancar.
        ...(ctx ? ['-c', String(ctx)] : []),
        // Un solo usuario: una ranura, y no cuatro repartiéndose la memoria.
        '-np', '1',
        ...(cpu ? ['-ngl', '0'] : []),
        '--host', host, '--port', String(port)
      ],
      // Formas de arrancar, de más a menos exigente. Si el motor se cierra
      // antes de servir el modelo se prueba la siguiente: lo habitual es que
      // la tarjeta gráfica integrada se quede sin memoria, no que el modelo
      // no sirva.
      variantes: [{ ctx: 16384 }, { ctx: 8192 }, { ctx: 8192, cpu: true }],
      aceptaEjecutable: aceptaEjecutable || null,
      // Modelos que MIKA5 sabe ofrecer para este motor, con su origen exacto.
      catalogo: Array.isArray(catalogo) ? catalogo : []
    },

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
            stream: false,
            // Mismo criterio que la ruta de Ollama (`num_predict: 4096`,
            // `think: false`). Sin tope, un modelo pequeño de razonamiento
            // genera hasta llenar el contexto: medido con el servidor real,
            // la petición no terminaba y vencía el plazo de cinco minutos.
            max_tokens: 4096,
            chat_template_kwargs: { enable_thinking: false }
          }),
          signal: abortContext.signal
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          // El mensaje no cambia; el código HTTP viaja con el error para que
          // `clasificarError()` distinga un 503 «cargando modelo» o un 401 de
          // un fallo desconocido. Antes se perdía y todo era UNKNOWN.
          const httpError = new Error(err.error?.message || `${etiqueta} Error: ${res.status}`);
          httpError.status = res.status;
          throw httpError;
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
        // `fetch` (undici) no pone el código en el error: lo envuelve en
        // `TypeError: fetch failed` y lo deja en `cause.code`. Mirando sólo
        // `error.code` esta pista era inalcanzable y el usuario veía un genérico.
        if ((error.code ?? error.cause?.code) === 'ECONNREFUSED') {
          const notRunning = new Error(`${etiqueta} no está corriendo. Inicia con: ${comoIniciar}`);
          notRunning.code = 'ECONNREFUSED';
          throw notRunning;
        }
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
        // `errorDeRespuesta` espera el código, no la respuesta. Con el objeto
        // entero un 503 «Loading model» salía como «HTTP [object Response]»,
        // sin status, y la disponibilidad lo pintaba como servidor caído.
        const error = errorDeRespuesta(res.status, etiqueta);
        return { ok: false, error, probe: probeDeError(error) };
      } catch (error) {
        // ECONNREFUSED, timeout o fallo de transporte: el error se pasa tal cual
        // para que lo clasifique quien sabe hacerlo.
        return { ok: false, error, probe: probeDeError(error) };
      }
    }
  };
  return adaptador;
}

module.exports = { crearAdaptadorServidorLlama };
