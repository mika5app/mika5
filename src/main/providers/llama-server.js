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
  providerId, name, etiqueta, baseUrl, comoIniciar, paquete, descargaHf, guia, compatibilidad, aceptaEjecutable, catalogo,
  instalacion, libraryUrl, requisitos, argumentos, variantes, runtimes, experimental, contexto
}) {
  // Tokens que se reservan para la respuesta cuando el motor declara una
  // ventana pequeña. Con menos sitio que esto no se envía la petición.
  const RESERVA_DE_RESPUESTA = 512;
  // Tope de la respuesta en un motor con la ventana pequeña. Son motores de
  // CPU: con la ventana casi llena se midieron entre 4 y 20 tokens por segundo,
  // y una respuesta sin tope no terminaba dentro del plazo de la petición.
  const RESPUESTA_CON_VENTANA = 768;

  /**
   * Cuántos tokens ocupa la entrada y de cuántos dispone el servidor. Se le
   * pregunta al propio servidor: es su tokenizador y su ventana real —la de la
   * variante con la que arrancó—. Si no contesta, se estima por lo alto.
   */
  async function medirEntrada(raiz, messages, signal) {
    const texto = messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
    const pedir = async (ruta, opciones) => {
      try {
        const res = await fetch(`${raiz}${ruta}`, { ...opciones, signal });
        return res.ok ? await res.json() : null;
      } catch (error) {
        // Cancelar o vencer el plazo no es «el servidor no sabe contar»: se
        // propaga, y la conversación no llega a enviarse.
        if (signal && signal.aborted) throw error;
        return null;
      }
    };
    const [tokenizado, propiedades] = await Promise.all([
      pedir('/tokenize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: texto })
      }),
      pedir('/props')
    ]);
    const contados = tokenizado && Array.isArray(tokenizado.tokens) ? tokenizado.tokens.length : null;
    const ventana = Number(propiedades && propiedades.default_generation_settings
      && propiedades.default_generation_settings.n_ctx);
    return {
      // Unos tokens por mensaje para los marcadores de la plantilla de chat.
      entrada: (contados === null ? Math.ceil(texto.length / 2.5) : contados) + 8 * messages.length + 8,
      ventana: Number.isInteger(ventana) && ventana > 0 ? Math.min(ventana, contexto.tokens) : contexto.tokens
    };
  }

  const noCabe = (entrada, ventana, motivo) => {
    const error = new Error(`${etiqueta}: el texto enviado no cabe en la ventana de este modelo `
      + `(${entrada} tokens de ${ventana})${motivo ? `, ${motivo}` : ''}. Envía un documento más corto, `
      + 'súbelo a la base de conocimiento del proyecto para consultar sus partes, o usa otro proveedor.');
    error.code = 'PROVIDER_CONTEXT_EXCEEDED';
    return error;
  };

  // Lectura por partes de un texto que no cabe en la ventana.
  //
  // Un documento adjunto de unas pocas páginas ya no cabe en 4 096 tokens.
  // Rechazarlo deja al usuario sin respuesta, y dejar que el servidor lo
  // recorte le da una respuesta sobre un texto mutilado. Aquí se lee ENTERO:
  // se trocea, el modelo anota de cada tramo lo que sirve para la petición, y
  // la respuesta final se da con todas las notas delante. Es más lento y las
  // notas pierden detalle; el resultado dice que se hizo así (`readInParts`).
  const NOTAS_POR_PARTE = 300; // tokens
  const NOTAS_MINIMAS = 100;
  // Cada parte cuesta alrededor de un minuto en CPU: más que esto ya no es una
  // respuesta de chat, y se le dice al usuario en vez de tenerlo esperando.
  const MAXIMO_DE_PARTES = 8;

  const trocear = (texto, partes) => {
    const piezas = [];
    let inicio = 0;
    for (let i = 1; i <= partes; i += 1) {
      let fin = i === partes ? texto.length : Math.round((texto.length * i) / partes);
      if (i < partes) {
        // Se corta en un límite natural cercano: párrafo, línea o frase.
        const ventanaDeCorte = texto.slice(Math.max(inicio, fin - 400), fin);
        for (const marca of ['\n\n', '\n', '. ']) {
          const donde = ventanaDeCorte.lastIndexOf(marca);
          if (donde > 0) { fin = fin - ventanaDeCorte.length + donde + marca.length; break; }
        }
      }
      if (fin > inicio) piezas.push(texto.slice(inicio, fin));
      inicio = fin;
    }
    return piezas;
  };

  async function leerPorPartes({ raiz, messages, medida, conPlazo, completar, resultado, onProgress }) {
    const texto = (m) => (typeof m.content === 'string' ? m.content : '');
    // El texto largo es el mensaje más extenso; el resto es la conversación.
    let largo = 0;
    messages.forEach((m, i) => { if (texto(m).length > texto(messages[largo]).length) largo = i; });
    const contenido = texto(messages[largo]);
    const ultimoUsuario = messages.map(m => m.role).lastIndexOf('user');

    // Qué pide el usuario. Si el texto largo viaja en su último mensaje, la
    // petición es lo que escribió antes del adjunto (hasta la primera línea en
    // blanco); si no, es su último mensaje.
    let peticion = '';
    let cuerpo = contenido;
    if (largo === ultimoUsuario) {
      const corte = contenido.indexOf('\n\n');
      if (corte > 0 && corte <= 600 && !contenido.startsWith('--- ')) {
        peticion = contenido.slice(0, corte).trim();
        cuerpo = contenido.slice(corte + 2);
      }
    } else if (ultimoUsuario >= 0) {
      peticion = texto(messages[ultimoUsuario]).slice(0, 600).trim();
    }
    if (!peticion) peticion = 'Analiza el texto y explica sus puntos principales.';

    const contar = async (cadena) => {
      const r = await conPlazo(senal => medirEntrada(raiz, [{ role: 'user', content: cadena }], senal));
      return r.entrada;
    };
    const tokensDelCuerpo = await contar(cuerpo);
    const tokensDeLaPeticion = Math.ceil(peticion.length / 2.5) + 20;
    const tokensDelResto = Math.max(0, medida.entrada - tokensDelCuerpo);
    const caracteresPorToken = cuerpo.length / tokensDelCuerpo;

    // Cada parte ha de caber con sus instrucciones y dejar sitio a las notas.
    const tokensPorParte = Math.floor((medida.ventana - NOTAS_POR_PARTE - 150 - tokensDeLaPeticion) * 0.85);
    const partes = Math.ceil(cuerpo.length / (tokensPorParte * caracteresPorToken));
    // Y al final han de caber todas las notas, la conversación y la respuesta.
    const notasPorParte = Math.min(NOTAS_POR_PARTE,
      Math.floor((medida.ventana - RESERVA_DE_RESPUESTA - 100 - tokensDelResto - tokensDeLaPeticion) / partes));
    if (tokensPorParte < 500 || partes > MAXIMO_DE_PARTES || notasPorParte < NOTAS_MINIMAS) {
      throw noCabe(medida.entrada, medida.ventana, 'ni siquiera leyéndolo por partes');
    }

    const piezas = trocear(cuerpo, partes);
    const uso = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const sumar = (u) => { for (const k of Object.keys(uso)) uso[k] += Number(u && u[k]) || 0; };
    const notas = [];
    for (let i = 0; i < piezas.length; i += 1) {
      if (typeof onProgress === 'function') onProgress({ part: i + 1, parts: piezas.length });
      const data = await completar([
        {
          role: 'system',
          content: `Estás leyendo un texto largo por partes porque no cabe entero. Esta es la parte ${i + 1} de ${piezas.length}. `
            + 'Anota de forma breve y fiel lo que esta parte dice que sirva para atender la petición. '
            + 'No añadas nada que no esté en el texto. Escribe en el idioma de la petición.'
        },
        { role: 'user', content: `Petición: ${peticion}\n\nParte ${i + 1} de ${piezas.length}:\n${piezas[i]}` }
      ], notasPorParte);
      sumar(data.usage);
      notas.push(String(data.choices?.[0]?.message?.content ?? '').trim() || '(esta parte no aportó nada a la petición)');
    }

    const resumen = `[El texto es largo y se leyó completo en ${piezas.length} partes. Estas son las notas de cada parte, en orden. `
      + `Responde a partir de ellas.]\n\n${notas.map((n, i) => `Parte ${i + 1} de ${piezas.length}:\n${n}`).join('\n\n')}`;
    const finales = messages.map((m, i) => (i !== largo ? m : {
      ...m, content: largo === ultimoUsuario ? `${peticion}\n\n${resumen}` : resumen
    }));
    const final = await conPlazo(senal => medirEntrada(raiz, finales, senal));
    const libres = final.ventana - final.entrada;
    // Otro texto largo en la conversación, además del que se leyó por partes.
    if (libres < RESERVA_DE_RESPUESTA / 2) throw noCabe(final.entrada, final.ventana, 'ni siquiera leyéndolo por partes');
    if (typeof onProgress === 'function') onProgress({ part: piezas.length, parts: piezas.length, answering: true });
    const data = await completar(finales, Math.min(RESPUESTA_CON_VENTANA, libres));
    sumar(data.usage);
    return resultado({ ...data, usage: uso }, { readInParts: piezas.length });
  }

  const adaptador = {
    name,
    // Dónde explorar modelos para este motor. No es el de otro proveedor.
    libraryUrl: libraryUrl || null,
    privacy: 'private',
    requiresKey: false,
    baseUrl,
    timeout: 300000, // 5 min — modelos grandes son lentos

    // Motor gestionable: con el ejecutable y un modelo GGUF elegidos una vez,
    // MIKA5 arranca `llama-server` al seleccionar el proveedor. Host y puerto
    // salen de la `baseUrl` del adaptador, la misma dirección que consulta el
    // cliente: no hay un segundo sitio donde declararlos.
    engine: {
      // A qué proveedor pertenece esta declaración.
      id: providerId,
      tipo: 'managed',
      // Motores ya compilados que MIKA5 puede descargar, por sistema: URL
      // exacta, tamaño y SHA-256. Vacío si todavía no hay ninguno publicado.
      runtimes: Array.isArray(runtimes) ? runtimes : [],
      // Experimental: todavía no hay un motor preparado para todos los sistemas.
      experimental: experimental === true,
      // Ventana pequeña que obliga a enviar menos texto, o null si no hay tal.
      contexto: contexto || null,
      // Nombre del motor tal y como se le enseña al usuario junto al modelo.
      etiqueta,
      ejecutable: 'llama-server',
      requiereModelo: true,
      baseUrl: () => adaptador.baseUrl,
      // Gestor de paquetes oficial con el que se puede instalar, si lo hay,
      // y página oficial de instalación para cuando no.
      paquete: paquete || null,
      guia: guia || null,
      // `source`: no hay instalador, se compila en el equipo.
      instalacion: instalacion || (paquete ? 'package' : null),
      // Herramientas que hacen falta para compilarlo, si no hay instalador.
      requisitos: Array.isArray(requisitos) ? requisitos : [],
      // Qué puede decirse de un GGUF sin cargarlo, a partir de lo que declara.
      compatibilidad: compatibilidad || (() => 'unverified'),
      // `-hf` hace que el propio servidor descargue un GGUF de Hugging Face a
      // su caché. Sólo se usa tras autorizarlo el usuario.
      descargaHf: descargaHf === true,
      // `--alias` da al modelo cargado el nombre que el usuario eligió.
      // Host y puerto van SIEMPRE explícitos: el puerto por defecto del
      // ejecutable cambia entre versiones (8080, 9931) y no es el de MIKA5.
      argumentos: argumentos || (({ host, port, model, hf, alias, ctx, cpu }) => [
        ...(hf ? ['-hf', hf] : ['-m', model]),
        ...(alias ? ['--alias', alias] : []),
        // Sin `-c` el servidor reserva el contexto MÁXIMO del modelo —131 072
        // tokens en algunos— y la memoria que eso pide lo tumba al arrancar.
        ...(ctx ? ['-c', String(ctx)] : []),
        // Un solo usuario: una ranura, y no cuatro repartiéndose la memoria.
        '-np', '1',
        ...(cpu ? ['-ngl', '0'] : []),
        '--host', host, '--port', String(port)
      ]),
      // Formas de arrancar, de más a menos exigente. Si el motor se cierra
      // antes de servir el modelo se prueba la siguiente: lo habitual es que
      // la tarjeta gráfica integrada se quede sin memoria, no que el modelo
      // no sirva.
      variantes: variantes || [{ ctx: 16384 }, { ctx: 8192 }, { ctx: 8192, cpu: true }],
      aceptaEjecutable: aceptaEjecutable || null,
      // Modelos que MIKA5 sabe ofrecer para este motor, con su origen exacto.
      catalogo: Array.isArray(catalogo) ? catalogo : []
    },

    async chat({ model, messages, images = [], signal, onProgress }) {
      const selectedModel = model || 'default';
      // llama-server no expone si tiene proyector multimodal cargado, así que
      // MIKA5 no declara visión: adjuntar una imagen falla en vez de perderse.
      assertVisionSupported({
        providerId,
        modelId: selectedModel,
        imageCount: images.length
      });
      const timeout = this.timeout;
      const baseUrl = this.baseUrl;

      // Una petición al servidor, con su propio plazo. Leer un documento por
      // partes son varias seguidas: cada una tiene el plazo completo, y la
      // cancelación del usuario las corta todas.
      const conPlazo = async (tarea) => {
        const abortContext = createAbortContext(signal, timeout, etiqueta);
        try {
          return await tarea(abortContext.signal);
        } catch (error) {
          if (error.code === 'PROVIDER_CONTEXT_EXCEEDED') throw error;
          const normalized = abortContext.normalize(error);
          // El servidor aceptó la conexión y la cortó sin responder: el proceso
          // del motor se cerró a mitad de la petición. Sin esto el usuario veía
          // un «no se pudo completar la solicitud» que no decía nada.
          const causa = error.cause && error.cause.code;
          if (causa === 'ECONNRESET' || causa === 'UND_ERR_SOCKET' || causa === 'EPIPE') {
            const cerrado = new Error(`${etiqueta}: el motor local se cerró mientras respondía. Vuelve a elegir el modelo para iniciarlo de nuevo.`);
            cerrado.code = 'ENGINE_CLOSED_DURING_REQUEST';
            throw cerrado;
          }
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
      };

      const completar = (mensajes, maxTokens) => conPlazo(async (senal) => {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: selectedModel,
            messages: mensajes,
            temperature: 0.7,
            stream: false,
            max_tokens: maxTokens,
            chat_template_kwargs: { enable_thinking: false }
          }),
          signal: senal
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
        return res.json();
      });

      const resultado = (data, extra = null) => {
        const choice = data.choices?.[0];
        return normalizeChatResult({
          providerId,
          model: data.model || selectedModel,
          content: choice?.message?.content ?? '',
          rawUsage: data.usage,
          rawFinishReason: choice?.finish_reason,
          extra
        });
      };

      // Mismo criterio que la ruta de Ollama (`num_predict: 4096`,
      // `think: false`). Sin tope, un modelo pequeño de razonamiento
      // genera hasta llenar el contexto: medido con el servidor real,
      // la petición no terminaba y vencía el plazo de cinco minutos.
      const TOPE_DE_RESPUESTA = 4096;
      if (!contexto) return resultado(await completar(messages, TOPE_DE_RESPUESTA));

      const raiz = baseUrl.replace(/\/v1\/?$/, '');
      const medida = await conPlazo(senal => medirEntrada(raiz, messages, senal));
      const libres = medida.ventana - medida.entrada;
      // La respuesta no puede pasar de lo que queda de ventana.
      if (libres >= RESERVA_DE_RESPUESTA) {
        return resultado(await completar(messages, Math.min(RESPUESTA_CON_VENTANA, libres)));
      }
      return leerPorPartes({ raiz, messages, medida, conPlazo, completar, resultado, onProgress });
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
