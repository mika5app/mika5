'use strict';

// Utilidades compartidas por los adaptadores de proveedor.
//
// Vivían dentro de `ai-providers.js`, entre el registro y la clase gestora. Se
// extraen sin cambiarlas para que cada adaptador pueda estar en su propio
// módulo sin depender de `ai-providers.js`, que es quien los compone: esa
// dependencia sería circular.
//
// `ai-providers.js` las sigue reexportando, porque hay pruebas que las
// importan desde ahí.

const { ollamaApi } = require('./ollama');

// Sanitización básica de PII antes de enviar a cloud
function sanitizeForCloud(text) {
  if (!text) return text;
  return text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE]')
    .replace(/\b\d{8,}\b/g, '[ID]');
}

// --- Helpers locales ---
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Etiquetas cosméticas del selector de modelos. La visión NO se decide aquí:
// el badge 👁️ lo añade únicamente la sonda real en listModels(). Un nombre nunca
// es evidencia de capacidad — ese fue el origen de AUD-006.
function detectCapabilities(name) {
  const caps = [];
  if (!name) return caps;
  const n = name.toLowerCase();
  if (n.includes('code') || n.includes('codex')) caps.push('💻 Código');
  if (n.includes('embed') || n.includes('embedding')) caps.push('🔢 Embeddings');
  return caps;
}

function createAbortContext(externalSignal, timeoutMs, providerLabel) {
  const controller = new AbortController();
  let abortKind = null;
  const abortFromUser = () => {
    if (abortKind) return;
    abortKind = 'user';
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromUser();
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromUser, { once: true });
  }
  const timeoutId = setTimeout(() => {
    if (abortKind) return;
    abortKind = 'timeout';
    controller.abort();
  }, Math.max(1, Number(timeoutMs) || 1));

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromUser);
    },
    normalize(error) {
      if (abortKind === 'user') {
        const canceled = new Error('Solicitud cancelada por el usuario');
        canceled.name = 'AbortError';
        canceled.code = 'USER_CANCELED';
        return canceled;
      }
      if (abortKind === 'timeout') {
        const timeout = new Error(`Timeout: ${providerLabel} tardó demasiado`);
        timeout.code = 'PROVIDER_TIMEOUT';
        return timeout;
      }
      return error;
    }
  };
}

// Fuente única de verdad para la visión en Ollama: lo que /api/show declara.
// Los modelos locales de visión exponen claves .vision.* o image_token en
// model_info; los más nuevos lo publican en el array capabilities.
// Devuelve false ante cualquier fallo: no se asume visión por el nombre.
//
// Con `options.signal` una cancelación se propaga en vez de tragarse. El
// `catch` que devuelve false vale para «el modelo no declara visión», no para
// «el usuario canceló»: confundirlos haría que un catálogo cancelado a medias
// se presentase como un catálogo válido sin visión.
async function probeOllamaVision(modelName, options = {}) {
  if (!modelName) return false;
  try {
    const info = await ollamaApi.show(modelName, { signal: options.signal });
    const infoKeys = Object.keys(info?.model_info || {});
    const ollamaCaps = Array.isArray(info?.capabilities) ? info.capabilities : [];
    return infoKeys.some(key => key.includes('.vision.') || key.includes('image_token'))
      || ollamaCaps.includes('vision');
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'PROVIDER_TIMEOUT')) throw error;
    return false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

// Predicado genérico de fallo de red. Su único consumidor hoy es el reintento
// de Alibaba, pero no tiene nada de específico suyo: distingue un problema de
// transporte de una cancelación o de una respuesta con error.
function isProviderNetworkError(error) {
  if (!error || error.name === 'AbortError') return false;
  const details = [
    error.name,
    error.code,
    error.message,
    error.cause?.name,
    error.cause?.code,
    error.cause?.message
  ].filter(Boolean).join(' ');
  return /fetch failed|UND_ERR_CONNECT_TIMEOUT|ConnectTimeoutError|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(details);
}

function normalizeProviderNetworkError(_error, providerLabel = 'el proveedor') {
  return `No se pudo conectar con ${providerLabel}. Revisa conexión, VPN, endpoint o vuelve a intentar.`;
}

module.exports = {
  sanitizeForCloud,
  formatBytes,
  detectCapabilities,
  createAbortContext,
  probeOllamaVision,
  isProviderNetworkError,
  delay,
  normalizeProviderNetworkError
};
