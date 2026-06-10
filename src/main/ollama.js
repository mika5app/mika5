// src/main/ollama.js
const { spawn } = require("child_process");
const http = require("http");

const BASE = "http://127.0.0.1:11434";
const FETCH_TIMEOUT = 600000; // 10 minutos para modelos muy grandes

// Cambia esto según el contexto
const MODELS = {
  simple: 'phi3-mini',        // Respuestas rápidas <1 min
  standard: 'qwen3-coder:14b',    // Desarrollo regular
  complex: process.env.VPS_MODEL_URL ? 'deepseek-coder:v2' : 'qwen3.5:35b', // Análisis profundo
};

async function getSmartModel(taskType = 'standard') {
  return MODELS[taskType] || MODELS.standard;
}

// Función fetch con control total de timeouts usando http nativo
function fetchWithTimeout(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const controller = new AbortController();
    
    // Timeout de seguridad total
    const timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('Timeout: La operación excedió 10 minutos'));
    }, FETCH_TIMEOUT);

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
        timeout: 0, // Sin timeout de socket — el FETCH_TIMEOUT global (10 min) protege
        signal: controller.signal
      },
      (res) => {
        let data = '';
        
        // Timeout entre chunks de datos (para evitar stalls)
        res.setTimeout(300000, () => {
          req.destroy();
          clearTimeout(timeoutId);
          reject(new Error('Timeout: Ollama dejó de enviar datos (¿el modelo está cargando?)'));
        });

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          clearTimeout(timeoutId);
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
      }
    );

    req.on('error', (error) => {
      clearTimeout(timeoutId);
      if (error.code === 'ECONNREFUSED') {
        reject(new Error('Ollama no está ejecutándose. Inicia: ollama serve'));
      } else if (error.name === 'AbortError') {
        reject(new Error('Timeout: Ollama no respondió a tiempo'));
      } else {
        reject(error);
      }
    });

    // No socket timeout handler — FETCH_TIMEOUT (10 min) handles safety

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
      throw new Error('El modelo no está descargado. Ejecuta: ollama pull <nombre-modelo>');
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

const ollamaApi = {
  async status() {
    try {
      await fetchJson(`${BASE}/api/tags`);
      return { ok: true, base: BASE };
    } catch (e) {
      return { ok: false, base: BASE, error: String(e?.message || e) };
    }
  },

  async tags() {
    return fetchJson(`${BASE}/api/tags`);
  },

  async chat({ model, messages }) {
    const m = (model || "").trim();
    if (!m) throw new Error("INVALID_MODEL");

    if (!Array.isArray(messages)) throw new Error("INVALID_MESSAGES");

    console.log('Enviando a Ollama local:', { model: m, messagesCount: messages.length });

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
            num_ctx: 4096
          }
        })
      });
    } catch (error) {
      console.error('Error en chat Ollama:', error.message);
      throw error;
    }
  },

  async embed({ model, input }) {
    const m = (model || "").trim();
    if (!m) throw new Error("INVALID_EMBED_MODEL");

    return fetchJson(`${BASE}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: m,
        input: input
      })
    });
  },

  pull(model) {
    return new Promise((resolve) => {
      const m = (model || "").trim();
      if (!m) return resolve({ ok: false, error: "INVALID_MODEL" });

      const modelRe = /^[a-zA-Z0-9._-]+(:[a-zA-Z0-9._-]+)?$/;
      if (!modelRe.test(m)) return resolve({ ok: false, error: "INVALID_MODEL" });

      const p = spawn("ollama", ["pull", m], { shell: true });

      let out = "";
      let err = "";

      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (err += d.toString()));

      p.on("close", (code) => {
        if (code === 0) resolve({ ok: true, output: out });
        else resolve({ ok: false, error: err || out || `exit ${code}` });
      });
    });
  }
};

module.exports = { ollamaApi };