'use strict';

// Taxonomía estructurada de fallos de proveedor.
//
// Clasifica mirando SÓLO campos estructurados: `kind` si el adaptador ya lo
// declaró, `status` HTTP, códigos de Node (`ECONNREFUSED`, `ENOTFOUND`,
// `ETIMEDOUT`) o el `name` de un abort. Nunca el texto del mensaje: un
// adaptador que traduzca su redacción no puede cambiar la clasificación.
//
// Dos distinciones que la versión anterior colapsaba:
//
//   401 y 403 no son lo mismo. Un 401 dice que la credencial no vale; un 403
//   dice que el servidor la reconoce pero no autoriza la operación. Exigen
//   respuestas distintas del usuario y no pueden compartir estado.
//
//   «El servidor contestó» no es «el servicio funciona». Un 404, un 429 o un
//   500 prueban que hay alguien al otro lado, y ninguno de los tres significa
//   que el proveedor pueda usarse. Presentarlos en verde como «Conectado» era
//   una afirmación falsa.

/** Clases de fallo. Cerradas: cualquier otra cosa es `unknown`. */
const KINDS = Object.freeze({
  TRANSPORT: 'transport',
  TIMEOUT: 'timeout',
  AUTH: 'auth',
  FORBIDDEN: 'forbidden',
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

/** Error de proveedor con clasificación explícita. */
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
  if (status === 401) return KINDS.AUTH;
  if (status === 403) return KINDS.FORBIDDEN;
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

/** Clasifica un fallo cualquiera usando sólo campos estructurados. */
function clasificarError(error) {
  if (!error || typeof error !== 'object') {
    return { kind: KINDS.UNKNOWN, status: null, code: null };
  }

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
 * Un timeout no prueba que el servidor esté caído: puede estar lento. Un 403
 * no prueba que la credencial sea válida ni que no lo sea: el servidor puede
 * reconocerla y aun así negar la operación, o rechazarla con ese código.
 */
function evidenciaDe(kind) {
  switch (kind) {
    case KINDS.AUTH:        return { reachable: true,  authenticated: false };
    case KINDS.FORBIDDEN:   return { reachable: true,  authenticated: null };
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
    case KINDS.FORBIDDEN:  return 'PROVIDER_FORBIDDEN';
    case KINDS.RATE_LIMIT: return 'PROVIDER_RATE_LIMITED';
    case KINDS.TRANSPORT:  return 'PROVIDER_TRANSPORT_UNREACHABLE';
    case KINDS.TIMEOUT:    return 'PROVIDER_TIMEOUT';
    case KINDS.ABORTED:    return 'PROVIDER_ABORTED';
    case KINDS.HTTP:       return Number.isInteger(status) ? `PROVIDER_HTTP_${status}` : 'PROVIDER_HTTP_ERROR';
    default:               return 'PROVIDER_UNKNOWN_ERROR';
  }
}

// El mensaje de un error puede arrastrar la URL completa del endpoint, con
// credenciales incrustadas, o el propio token. Nada de eso sale del proceso
// principal: el saneado existe para los logs, no como contrato con el renderer.
const PATRONES_SENSIBLES = [
  // El grupo opcional `bearer` importa: sin él, en «Authorization: Bearer xyz»
  // el comodín se comía la palabra «Bearer» y dejaba el token a la vista.
  [/\b(bearer|token|apikey|api[_-]?key|authorization)\b\s*[:=]?\s*(?:bearer\s+)?\S+/gi, '$1 [oculto]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[clave oculta]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[endpoint]']
];

/**
 * Mensaje apto para un log del proceso principal: sin credenciales, sin tokens
 * y sin URLs. NO viaja al renderer, que sólo recibe `errorCode` y metadatos de
 * una lista permitida.
 */
function sanearMensaje(texto, maximo = 160) {
  let salida = String(texto == null ? '' : texto);
  for (const [patron, reemplazo] of PATRONES_SENSIBLES) {
    salida = salida.replace(patron, reemplazo);
  }
  salida = salida.replace(/\s+/g, ' ').trim();
  return salida.length > maximo ? salida.slice(0, maximo - 1) + '…' : salida;
}

/**
 * Clasificación completa de un fallo.
 *
 * `logMessage` está saneado y es para el proceso principal. El contrato que
 * cruza al renderer son `errorCode` y `httpStatus`, nada más.
 */
function describirError(error) {
  const { kind, status, code } = clasificarError(error);
  return {
    kind,
    httpStatus: Number.isInteger(status) ? status : null,
    code,
    errorCode: errorCodeDe(kind, status),
    logMessage: sanearMensaje(error && error.message),
    ...evidenciaDe(kind)
  };
}

/**
 * Sonda a partir de un fallo, en la forma que declaran los adaptadores.
 * `attempted: true` porque hubo intento real: el fallo lo demuestra.
 */
function probeDeError(error) {
  const d = describirError(error);
  return {
    attempted: true,
    reachable: d.reachable,
    authenticated: d.authenticated,
    httpStatus: d.httpStatus,
    errorCode: d.errorCode,
    logMessage: d.logMessage
  };
}

/** Sonda de un intento con éxito. Un 200 prueba red y credencial aceptada. */
function probeDeExito({ httpStatus = 200, authenticated = null } = {}) {
  return {
    attempted: true,
    reachable: true,
    authenticated,
    httpStatus,
    errorCode: null,
    logMessage: ''
  };
}

/**
 * Sonda de una respuesta que llegó bien y no se pudo interpretar: un 2xx cuyo
 * cuerpo no es JSON válido, o lo es y no tiene la forma esperada.
 *
 * La evidencia se CONSERVA. El servidor contestó —hubo código de estado— y, si
 * el proveedor exige credencial, la aceptó: un 200 no se emite tras rechazar
 * una clave. Tratar esto como un fallo genérico borraba las dos cosas y dejaba
 * `reachable` en null, que es justo lo contrario de lo que acababa de
 * demostrarse.
 */
function probeDeRespuestaInvalida({ httpStatus = 200, authenticated = null } = {}) {
  return {
    attempted: true,
    reachable: true,
    authenticated,
    httpStatus,
    errorCode: 'PROVIDER_RESPONSE_INVALID',
    logMessage: ''
  };
}

/** Sonda de un adaptador que no intentó nada: catálogo declarado en el código. */
function probeNoIntentada() {
  return {
    attempted: false,
    reachable: null,
    authenticated: null,
    httpStatus: null,
    errorCode: null,
    logMessage: ''
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
  sanearMensaje,
  probeDeError,
  probeDeExito,
  probeDeRespuestaInvalida,
  probeNoIntentada
};
