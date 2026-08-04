'use strict';

// Taxonomía estructurada de fallos de proveedor.
//
// Antes la disponibilidad clasificaba los fallos aplicando una expresión
// regular al texto del error: `/401|api key|unauthorized/`. Eso es frágil por
// dos motivos independientes. Un adaptador que traduzca sus mensajes, o un
// proveedor que redacte «Forbidden» en vez de 403, cambia la clasificación sin
// tocar una línea de lógica. Y al revés: un error de red cuyo texto mencione
// una URL con «key» en la ruta se leería como credencial rechazada.
//
// Aquí la clasificación mira sólo campos ESTRUCTURADOS: `kind` si el adaptador
// ya lo declaró, `status` HTTP, y los códigos de Node (`ECONNREFUSED`,
// `ENOTFOUND`, `ETIMEDOUT`) o el `name` de un abort. Si no hay ninguno, el
// resultado es `unknown` y no se inventa evidencia.
//
// La distinción que importa para la disponibilidad: **un código HTTP prueba que
// el servidor contestó**. Un 404 o un 500 significan que está vivo. Un
// ECONNREFUSED o un ENOTFOUND significan que no se llegó a hablar con él.

/** Clases de fallo. Cerradas: cualquier otra cosa es `unknown`. */
const KINDS = Object.freeze({
  TRANSPORT: 'transport',
  TIMEOUT: 'timeout',
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  HTTP: 'http',
  ABORTED: 'aborted',
  UNKNOWN: 'unknown'
});

const CODIGOS_DE_TRANSPORTE = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EPROTO', 'UND_ERR_SOCKET'
]);

const CODIGOS_DE_TIMEOUT = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'
]);

/**
 * Error de proveedor con clasificación explícita. Los adaptadores lo lanzan en
 * vez de un `Error` pelado para que la evidencia no dependa de su redacción.
 */
class ProviderError extends Error {
  constructor(kind, { status = null, code = null, message = '', cause = null } = {}) {
    super(message || kind);
    this.name = 'ProviderError';
    this.kind = Object.values(KINDS).includes(kind) ? kind : KINDS.UNKNOWN;
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** Traduce un código HTTP a su clase, sin mirar el cuerpo ni el texto. */
function kindDeEstado(status) {
  if (status === 401 || status === 403) return KINDS.AUTH;
  if (status === 429) return KINDS.RATE_LIMIT;
  if (status === 408 || status === 504) return KINDS.TIMEOUT;
  if (Number.isInteger(status) && status >= 400) return KINDS.HTTP;
  return KINDS.UNKNOWN;
}

/** Error a partir de una respuesta HTTP. Lo usan los adaptadores que hacen red. */
function errorDeRespuesta(status, contexto = '') {
  return new ProviderError(kindDeEstado(status), {
    status,
    message: contexto ? `${contexto} (HTTP ${status})` : `HTTP ${status}`
  });
}

/**
 * Clasifica un fallo cualquiera usando sólo campos estructurados.
 * Nunca inspecciona el texto del mensaje.
 */
function clasificarError(error) {
  if (!error || typeof error !== 'object') {
    return { kind: KINDS.UNKNOWN, status: null, code: null };
  }

  // Ya viene clasificado por el adaptador: se respeta.
  if (typeof error.kind === 'string' && Object.values(KINDS).includes(error.kind)) {
    return { kind: error.kind, status: error.status ?? null, code: error.code ?? null };
  }

  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
    return { kind: KINDS.ABORTED, status: null, code: 'ABORT_ERR' };
  }
  if (error.name === 'TimeoutError') {
    return { kind: KINDS.TIMEOUT, status: null, code: error.code ?? null };
  }

  const status = error.status ?? error.statusCode ?? error.response?.status ?? null;
  if (Number.isInteger(status)) {
    return { kind: kindDeEstado(status), status, code: error.code ?? null };
  }

  // `fetch` envuelve el fallo real: el código vive en la causa.
  const code = error.code ?? error.cause?.code ?? null;
  if (code && CODIGOS_DE_TIMEOUT.has(code)) return { kind: KINDS.TIMEOUT, status: null, code };
  if (code && CODIGOS_DE_TRANSPORTE.has(code)) return { kind: KINDS.TRANSPORT, status: null, code };

  return { kind: KINDS.UNKNOWN, status: null, code };
}

/**
 * Qué prueba cada clase sobre el estado del proveedor.
 *
 *   reachable === true   el servidor contestó, aunque contestara mal
 *   reachable === false  no se llegó a hablar con él
 *   reachable === null   no hay evidencia en ningún sentido
 *
 * Un timeout no prueba que el servidor esté caído: puede estar sencillamente
 * lento o saturado. Por eso deja la alcanzabilidad indeterminada en vez de
 * declararla falsa.
 */
function evidenciaDe(kind) {
  switch (kind) {
    case KINDS.AUTH:        return { reachable: true,  authenticated: false };
    case KINDS.RATE_LIMIT:  return { reachable: true,  authenticated: null };
    case KINDS.HTTP:        return { reachable: true,  authenticated: null };
    case KINDS.TRANSPORT:   return { reachable: false, authenticated: null };
    case KINDS.TIMEOUT:     return { reachable: null,  authenticated: null };
    case KINDS.ABORTED:     return { reachable: null,  authenticated: null };
    default:                return { reachable: null,  authenticated: null };
  }
}

/** Código estable, apto como contrato entre procesos y como clave de i18n. */
function errorCodeDe(kind, status) {
  switch (kind) {
    case KINDS.AUTH:       return 'PROVIDER_AUTH_REJECTED';
    case KINDS.RATE_LIMIT: return 'PROVIDER_RATE_LIMITED';
    case KINDS.TRANSPORT:  return 'PROVIDER_TRANSPORT_UNREACHABLE';
    case KINDS.TIMEOUT:    return 'PROVIDER_TIMEOUT';
    case KINDS.ABORTED:    return 'PROVIDER_ABORTED';
    case KINDS.HTTP:       return Number.isInteger(status) ? `PROVIDER_HTTP_${status}` : 'PROVIDER_HTTP_ERROR';
    default:               return 'PROVIDER_UNKNOWN_ERROR';
  }
}

// Un mensaje de error puede arrastrar la URL completa del endpoint, con
// usuario y contraseña incrustados, o el propio token en una cabecera volcada.
// Nada de eso puede cruzar al renderer.
// El orden importa: los tokens se ocultan antes de que la regla de URL, más
// amplia, se lleve por delante el contexto que permitiría reconocerlos.
// Sustituir la URL entera cubre también las credenciales incrustadas en ella
// (`https://usuario:clave@host`), que desaparecen con el resto.
const PATRONES_SENSIBLES = [
  // El grupo opcional `bearer` importa: sin él, en «Authorization: Bearer xyz»
  // el comodín se comía la palabra «Bearer» y dejaba el token a la vista.
  [/\b(bearer|token|apikey|api[_-]?key|authorization)\b\s*[:=]?\s*(?:bearer\s+)?\S+/gi, '$1 [oculto]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[clave oculta]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[endpoint]']
];

/**
 * Mensaje apto para mostrar: sin credenciales, sin tokens y sin URLs.
 * Es informativo y opcional; el contrato es `errorCode`.
 */
function sanearMensaje(texto, maximo = 160) {
  let salida = String(texto == null ? '' : texto);
  for (const [patron, reemplazo] of PATRONES_SENSIBLES) {
    salida = salida.replace(patron, reemplazo);
  }
  salida = salida.replace(/\s+/g, ' ').trim();
  return salida.length > maximo ? salida.slice(0, maximo - 1) + '…' : salida;
}

/** Clasificación completa de un fallo: clase, evidencia, código y mensaje. */
function describirError(error) {
  const { kind, status, code } = clasificarError(error);
  return {
    kind,
    status,
    code,
    errorCode: errorCodeDe(kind, status),
    message: sanearMensaje(error && error.message),
    ...evidenciaDe(kind)
  };
}

module.exports = {
  KINDS,
  ProviderError,
  clasificarError,
  describirError,
  evidenciaDe,
  errorCodeDe,
  errorDeRespuesta,
  sanearMensaje
};
