// src/main/ollama.js
const { spawn } = require("child_process");
const http = require("http");

const BASE_POR_DEFECTO = "http://127.0.0.1:11434";

// Base de Ollama. El valor por defecto es el de siempre y es el único que se
// usa en producción: el comportamiento para el usuario no cambia. La variable
// existe para que las pruebas levanten su propio servidor en un puerto efímero
// y no golpeen el Ollama real de la máquina, que hace el gate lento y
// dependiente del catálogo que cada equipo tenga instalado.
//
// Restringida a bucle local a propósito, y esto no es una formalidad: sin la
// restricción, una variable de entorno bastaría para desviar a un host remoto
// todo lo que el usuario cree que no sale de su máquina — prompts, documentos
// adjuntos y contexto RAG. El modo local es privado por definición y esta
// variable no puede ser la grieta por la que deje de serlo.
function resolverBaseOllama(valor) {
  if (!valor) return BASE_POR_DEFECTO;
  let url;
  try {
    url = new URL(valor);
  } catch (_) {
    throw new Error('MIKA5_OLLAMA_BASE no es una URL válida');
  }
  if (url.protocol !== 'http:') {
    throw new Error('MIKA5_OLLAMA_BASE debe usar http');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('MIKA5_OLLAMA_BASE sólo admite bucle local');
  }
  return `${url.protocol}//${url.host}`;
}

const BASE = resolverBaseOllama(process.env.MIKA5_OLLAMA_BASE);
const FETCH_TIMEOUT = 600000; // 10 minutos para modelos muy grandes

/** Plazo en texto legible, para que el mensaje describa lo que de verdad venció. */
function describirPlazo(ms) {
  if (ms >= 60000) {
    const minutos = ms / 60000;
    const cifra = Number.isInteger(minutos) ? minutos : minutos.toFixed(1);
    return `${cifra} ${minutos === 1 ? 'minuto' : 'minutos'}`;
  }
  if (ms >= 1000) {
    const segundos = ms / 1000;
    const cifra = Number.isInteger(segundos) ? segundos : segundos.toFixed(1);
    return `${cifra} ${segundos === 1 ? 'segundo' : 'segundos'}`;
  }
  return `${Math.round(ms)} ms`;
}

// Dynamic context window sizing
const CHARS_PER_TOKEN = 3.5;
const OUTPUT_TOKEN_RESERVE = 1024;
const MIN_CTX = 4096;
const MAX_CTX = 32768;
const CTX_ALIGN = 2048;

// Función fetch con control total de timeouts usando http nativo
function fetchWithTimeout(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const controller = new AbortController();
    const externalSignal = options.signal;
    let externalAborted = false;
    let settled = false;
    const abortFromUser = () => {
      externalAborted = true;
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal?.aborted) abortFromUser();
    else externalSignal?.addEventListener('abort', abortFromUser, { once: true });

    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromUser);
      fn();
    }

    // Timeout de seguridad total. El código va en el error, no sólo en el
    // texto: sin él `clasificarError()` no encuentra nada estructurado y un
    // plazo vencido acababa como PROVIDER_UNKNOWN_ERROR, indistinguible de un
    // fallo que nadie supo explicar.
    //
    // `options.timeoutMs` existe para poder provocar el vencimiento en una
    // prueba. Sin él, la única forma de ejercitar esta rama era construir el
    // error a mano, y eso comprueba que se clasifica bien, no que este camino
    // lo produzca; esperar diez minutos no es una opción. El valor por defecto
    // es el de siempre y es el único que se usa en producción.
    const plazoMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : FETCH_TIMEOUT;
    const timeoutId = setTimeout(() => {
      controller.abort();
      finish(() => {
        // El mensaje se compone del plazo QUE VENCIÓ, no de la constante. Decir
        // «excedió 10 minutos» tras un plazo de 300 ms describe otra cosa que
        // la que pasó, y un mensaje que no coincide con el hecho es peor que no
        // tenerlo. En producción `plazoMs` es `FETCH_TIMEOUT`, así que el texto
        // que ve el usuario no cambia.
        const vencido = new Error(`Timeout: La operación excedió ${describirPlazo(plazoMs)}`);
        vencido.code = 'PROVIDER_TIMEOUT';
        reject(vencido);
      });
    }, plazoMs);

    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        timeout: 0,
        signal: controller.signal
      },
      (res) => {
        let data = '';

        // Timeout entre chunks de datos (5 min para evitar stalls)
        res.setTimeout(300000, () => {
          req.destroy();
          finish(() => reject(new Error('Timeout: Ollama dejó de enviar datos (¿el modelo está cargando?)')));
        });

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          finish(() => {
            try {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve({
                  ok: true,
                  status: res.statusCode,
                  json: () => Promise.resolve(JSON.parse(data)),
                  text: () => Promise.resolve(data)
                });
              } else {
                resolve({
                  ok: false,
                  status: res.statusCode,
                  text: () => Promise.resolve(data)
                });
              }
            } catch (e) {
              reject(new Error(`Error parseando respuesta: ${e.message}`));
            }
          });
        });
      }
    );

    req.on('error', (error) => {
      finish(() => {
        if (error.code === 'ECONNREFUSED') {
          reject(new Error('Ollama no está ejecutándose. Inicia: ollama serve'));
        } else if (externalAborted) {
          const canceled = new Error('Solicitud cancelada por el usuario');
          canceled.name = 'AbortError';
          canceled.code = 'USER_CANCELED';
          reject(canceled);
        } else if (error.name === 'AbortError') {
          reject(new Error('Timeout: Ollama no respondió a tiempo'));
        } else {
          reject(error);
        }
      });
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function fetchJson(url, opts = {}) {
  try {
    const res = await fetchWithTimeout(url, opts);
    
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Detectar si el modelo no existe
      if (res.status === 404 || body.includes('not found')) {
        throw new Error('MODEL_NOT_FOUND');
      }
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    
    return await res.json();
  } catch (error) {
    // Si es error de modelo no encontrado, dar mensaje específico
    if (error.message === 'MODEL_NOT_FOUND' || error.message.includes('not found')) {
      throw new Error('MODEL_NOT_FOUND');
    }
    
    // Si es timeout específico de headers (el error original)
    if (error.message.includes('Timeout') && error.message.includes('headers')) {
      throw new Error('Timeout: Ollama está cargando el modelo en memoria. Esto puede tardar 1-3 minutos la primera vez. Intenta de nuevo en unos segundos.');
    }
    
    // Si es timeout general
    if (error.message.includes('Timeout')) {
      throw new Error('Timeout: Ollama tardó demasiado. Si es la primera vez que usas el modelo, espera 2-3 minutos a que se cargue.');
    }
    
    throw error;
  }
}

// `options.signal` es opcional en todos los métodos de lectura. `fetchWithTimeout`
// ya sabía distinguir una cancelación externa de su propio plazo; lo que faltaba
// era que estas tres funciones aceptasen la señal y la pasaran, porque sin eso
// el adaptador `local` no tenía forma de cancelar nada: no hace fetch propio.
// Las llamadas sin argumentos siguen funcionando igual.
const ollamaApi = {
  async status(options = {}) {
    try {
      await fetchJson(`${BASE}/api/tags`, { signal: options.signal });
      return { ok: true, base: BASE };
    } catch (e) {
      return { ok: false, base: BASE, error: String(e?.message || e) };
    }
  },

  async tags(options = {}) {
    return fetchJson(`${BASE}/api/tags`, { signal: options.signal });
  },

  async chat({ model, messages, signal }) {
    const m = (model || "").trim();
    if (!m) throw new Error("INVALID_MODEL");

    if (!Array.isArray(messages)) throw new Error("INVALID_MESSAGES");

    const totalChars = messages.reduce((sum, msg) => sum + (msg.content || '').length, 0);
    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    const minCtx = estimatedTokens + OUTPUT_TOKEN_RESERVE;
    const numCtx = Math.min(MAX_CTX, Math.max(MIN_CTX, Math.ceil(minCtx / CTX_ALIGN) * CTX_ALIGN));

    try {
      return await fetchJson(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: m,
          messages,
          stream: false,
          think: false,
          options: {
            num_ctx: numCtx,
            num_predict: 4096
          }
        }),
        signal
      });
    } catch (error) {
      console.error('Error en chat Ollama:', error.message);

      // Modelos :cloud son proxied por Ollama a servidores remotos (NVIDIA, etc.)
      // No confundir respuestas con "ollama.com" o "443" como errores de redirección
      if (error.message === 'MODEL_NOT_FOUND') {
        throw new Error(`El modelo "${m}" no fue encontrado. Ejecuta: ollama pull ${m}`);
      }

      throw error;
    }
  },

  async embed({ model, input, signal }) {
    const m = (model || "").trim();
    if (!m) throw new Error("INVALID_EMBED_MODEL");

    return fetchJson(`${BASE}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: m,
        input: input
      }),
      signal
    });
  },

  async show(model, options = {}) {
    const m = (model || "").trim();
    if (!m) throw new Error("INVALID_MODEL");
    return fetchJson(`${BASE}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: m }),
      signal: options.signal
    });
  },

  pull(model) {
    return new Promise((resolve) => {
      const m = (model || "").trim();
      if (!m) return resolve({ ok: false, error: "INVALID_MODEL" });

      const modelRe = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;
      if (m.length > 512 || !modelRe.test(m)) return resolve({ ok: false, error: "INVALID_MODEL" });

      const p = spawn("ollama", ["pull", m]);

      let out = "";
      let err = "";

      // Keep progress output bounded even for a long download.
      p.stdout.on("data", (d) => { out = (out + d.toString()).slice(-65536); });
      p.stderr.on("data", (d) => { err = (err + d.toString()).slice(-65536); });
      p.on('error', error => resolve({
        ok: false,
        error: error.code === 'ENOENT' ? 'OLLAMA_NOT_INSTALLED' : 'OLLAMA_PULL_FAILED'
      }));

      p.on("close", (code) => {
        if (code === 0) resolve({ ok: true, output: out });
        else resolve({ ok: false, error: err || out || `exit ${code}` });
      });
    });
  }
};

// `resolverBaseOllama` se exporta para poder probar la restricción a bucle
// local, que es la parte con consecuencias de seguridad. `BASE` no: quien la
// necesita la obtiene de `ollamaApi.status().base`, y exponer el valor ya
// resuelto sólo añade superficie que después hay que mantener.
module.exports = { ollamaApi, fetchWithTimeout, resolverBaseOllama, describirPlazo };
