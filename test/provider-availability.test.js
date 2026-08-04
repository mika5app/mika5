'use strict';

// Modelo de disponibilidad de proveedores.
//
// Historia de lo que estas pruebas impiden, en capas:
//
//   1. `status()` respondía `ok: !!apiKey` para todo proveedor cloud, y el
//      renderer poblaba el selector con ese único booleano.
//   2. El siguiente intento infería `reachable` y `authenticated` del hecho de
//      que `listModels()` devolviera modelos. Falso: un catálogo puede estar
//      declarado en el propio adaptador y devolverse con el servidor apagado.
//   3. Y clasificaba los fallos con una expresión regular sobre el texto del
//      error, que cualquier traducción rompía.
//
// Ahora la evidencia viene de dos fuentes explícitas y de ninguna más: la
// sonda `status()` y el objeto `probe` que devuelve `listModels()`. La
// ausencia de evidencia se llama `null` y nunca se presenta como conexión.
//
// Los escenarios de red se ejercen contra un servidor HTTP sintético en un
// puerto efímero, invocando los MÉTODOS REALES de los adaptadores. No se
// sustituye `listModels()` por un doble: se le cambia la `baseUrl`.
//
//   npm run test:provider-availability

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  AIProviderManager, PROVIDERS, UI_STATE, resolverUiState
} = require('../src/main/ai-providers');
const {
  KINDS, ProviderError, describirError, sanearMensaje, errorDeRespuesta
} = require('../src/main/provider-errors');

let comprobaciones = 0;
function check(condicion, mensaje) {
  assert(condicion, mensaje);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje}`);
}

// El proceso principal registra los fallos por consola. Aquí sólo estorban.
const warnOriginal = console.warn;
console.warn = (...args) => {
  if (String(args[0] || '').startsWith('[provider:')) return;
  warnOriginal(...args);
};

function baseFalsa(filas = []) {
  const almacen = new Map(filas.map(f => [f.key, f.value]));
  return {
    prepare(sql) {
      if (/^SELECT key, value FROM app_state/i.test(sql)) {
        return { all: (...claves) => claves.filter(k => almacen.has(k)).map(k => ({ key: k, value: almacen.get(k) })) };
      }
      if (/^INSERT OR REPLACE INTO app_state/i.test(sql)) {
        return { run: (k, v) => { almacen.set(k, v); } };
      }
      return { all: () => [], get: () => undefined, run: () => {} };
    }
  };
}
const gestor = (filas) => new AIProviderManager(baseFalsa(filas));

/** Sustituye campos de un adaptador REAL y los restaura al terminar. */
async function conAdaptador(providerId, parches, fn) {
  const config = PROVIDERS[providerId];
  const AUSENTE = Symbol.for('ausente');
  const originales = {};
  for (const [clave, valor] of Object.entries(parches)) {
    if (valor === undefined) continue;
    originales[clave] = Object.prototype.hasOwnProperty.call(config, clave) ? config[clave] : AUSENTE;
    config[clave] = valor;
  }
  try {
    return await fn();
  } finally {
    for (const [clave, valor] of Object.entries(originales)) {
      if (valor === AUSENTE) delete config[clave];
      else config[clave] = valor;
    }
  }
}

// --- Servidor HTTP sintético ------------------------------------------------

function crearServidor() {
  let guion = { status: 200, cuerpo: { data: [] }, retrasoMs: 0 };
  const servidor = http.createServer((req, res) => {
    const responder = () => {
      if (guion.cortar) { req.destroy(); return; }
      const json = JSON.stringify(guion.cuerpo);
      res.writeHead(guion.status, { 'Content-Type': 'application/json' });
      res.end(json);
    };
    if (guion.retrasoMs) setTimeout(responder, guion.retrasoMs);
    else responder();
  });
  return {
    escuchar: () => new Promise(r => servidor.listen(0, '127.0.0.1', () => r(servidor.address().port))),
    cerrar: () => new Promise(r => servidor.close(() => r())),
    guionizar: (nuevo) => { guion = { status: 200, cuerpo: { data: [] }, retrasoMs: 0, ...nuevo }; },
    servidor
  };
}

const MODELOS_HTTP = { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] };

(async () => {

const srv = crearServidor();
const puerto = await srv.escuchar();
const BASE_SINTETICA = `http://127.0.0.1:${puerto}/v1`;
// Puerto cerrado deliberadamente: el sistema devuelve ECONNREFUSED.
const cerradoSrv = crearServidor();
const puertoCerrado = await cerradoSrv.escuchar();
await cerradoSrv.cerrar();
const BASE_CERRADA = `http://127.0.0.1:${puertoCerrado}/v1`;
// Dominio reservado por la RFC 6761: nunca resuelve.
const BASE_DNS_ROTO = 'http://no-existe.invalid/v1';

console.log('\n=== 1. Servidor sintético contra el listModels REAL de openai ===');
{
  const casos = [
    ['200 con modelos', { status: 200, cuerpo: MODELOS_HTTP }, { reachable: true, authenticated: true, modelos: 2, errorCode: null }],
    ['200 vacío', { status: 200, cuerpo: { data: [] } }, { reachable: true, authenticated: true, modelos: 0, errorCode: 'PROVIDER_CATALOG_EMPTY' }],
    ['401', { status: 401, cuerpo: {} }, { reachable: true, authenticated: false, modelos: 0, errorCode: 'PROVIDER_AUTH_REJECTED' }],
    ['403', { status: 403, cuerpo: {} }, { reachable: true, authenticated: null, modelos: 0, errorCode: 'PROVIDER_FORBIDDEN' }],
    ['404', { status: 404, cuerpo: {} }, { reachable: true, authenticated: null, modelos: 0, errorCode: 'PROVIDER_HTTP_404' }],
    ['429', { status: 429, cuerpo: {} }, { reachable: true, authenticated: null, modelos: 0, errorCode: 'PROVIDER_RATE_LIMITED' }],
    ['500', { status: 500, cuerpo: {} }, { reachable: true, authenticated: null, modelos: 0, errorCode: 'PROVIDER_HTTP_500' }]
  ];

  for (const [nombre, guion, esperado] of casos) {
    srv.guionizar(guion);
    const m = gestor();
    m.apiKeys.openai = 'clave-de-prueba';
    const d = await conAdaptador('openai', { baseUrl: BASE_SINTETICA }, () => m.getAvailability('openai'));

    check(d.reachable === esperado.reachable,
      `${nombre}: reachable=${String(d.reachable)} (el servidor contestó de verdad)`);
    check(d.authenticated === esperado.authenticated,
      `${nombre}: authenticated=${String(d.authenticated)}`);
    check(d.modelsAvailable === esperado.modelos, `${nombre}: ${d.modelsAvailable} modelos`);
    check(d.errorCode === esperado.errorCode, `${nombre}: errorCode=${d.errorCode}`);
  }

  // El caso que el modelo anterior no podía expresar.
  srv.guionizar({ status: 200, cuerpo: { data: [] } });
  const m = gestor();
  m.apiKeys.openai = 'clave';
  const d = await conAdaptador('openai', { baseUrl: BASE_SINTETICA }, () => m.getAvailability('openai'));
  check(d.reachable === true && d.authenticated === true && d.modelsAvailable === 0 && d.ready === false,
    'un 200 con catálogo vacío prueba red y credencial, y aun así no deja nada utilizable');
  check(d.uiState === UI_STATE.CONNECTED, 'y el estado es «conectado», porque lo está');
}

console.log('\n=== 2. Fallos de transporte contra los métodos reales ===');
{
  const m = gestor();
  m.apiKeys.openai = 'clave';

  const rechazado = await conAdaptador('openai', { baseUrl: BASE_CERRADA }, () => m.getAvailability('openai'));
  check(rechazado.reachable === false, 'ECONNREFUSED: el servidor no responde');
  check(rechazado.errorCode === 'PROVIDER_TRANSPORT_UNREACHABLE', `ECONNREFUSED: ${rechazado.errorCode}`);
  check(rechazado.uiState === UI_STATE.OFFLINE, 'ECONNREFUSED: estado offline');

  const dns = await conAdaptador('openai', { baseUrl: BASE_DNS_ROTO }, () => m.getAvailability('openai'));
  check(dns.reachable === false, 'error de DNS: el servidor no responde');
  check(dns.errorCode === 'PROVIDER_TRANSPORT_UNREACHABLE', `error de DNS: ${dns.errorCode}`);
}

console.log('\n=== 3. Timeout y abort contra el listModels real de llamacpp ===');
{
  // `llamacpp.listModels()` lleva su propio AbortSignal.timeout(3000).
  srv.guionizar({ status: 200, cuerpo: MODELOS_HTTP, retrasoMs: 4000 });
  const m = gestor();
  const d = await conAdaptador('llamacpp', {
    baseUrl: BASE_SINTETICA,
    status: async () => ({ ok: true })
  }, () => m.getAvailability('llamacpp'));
  check(d.errorCode === 'PROVIDER_TIMEOUT' || d.errorCode === 'PROVIDER_ABORTED',
    `un servidor que no contesta a tiempo produce ${d.errorCode}`);
  check(d.ready === false, 'y no deja el proveedor listo');
  srv.guionizar({ status: 200, cuerpo: MODELOS_HTTP });
}
{
  const abortado = describirError(Object.assign(new Error('x'), { name: 'AbortError' }));
  check(abortado.errorCode === 'PROVIDER_ABORTED' && abortado.reachable === null,
    'un abort no prueba nada sobre el servidor: reachable queda en null');
}

console.log('\n=== 4. La evidencia sólo viene de la sonda declarada ===');
{
  // Un adaptador que devuelve catálogo SIN sonda no prueba nada, por muchos
  // modelos que traiga. Es lo que hacen los catálogos declarados.
  const m = gestor();
  m.apiKeys.openai = 'clave';
  const d = await conAdaptador('openai', {
    listModels: async () => ({ models: [{ name: 'a' }, { name: 'b' }] })
  }, () => m.getAvailability('openai'));
  check(d.modelsAvailable === 2, 'devuelve dos modelos');
  check(d.reachable === null && d.authenticated === null,
    'sin `probe` no se infiere conectividad ni credencial, por muchos modelos que haya');
  check(d.ready === false, 'y por tanto NO está verificado como listo');
  check(d.canAttempt === true, 'pero sí está configurado para intentarlo');
  check(d.uiState === UI_STATE.UNKNOWN, `se presenta como sin verificar (${d.uiState})`);

  // El código no puede volver a mirar el tamaño del catálogo.
  const fuente = fs.readFileSync(path.join(__dirname, '../src/main/ai-providers.js'), 'utf8');
  const cuerpo = fuente.slice(fuente.indexOf('async getAvailability('), fuente.indexOf('  getAllProviders()'));
  assert(!/catalogSource/.test(cuerpo),
    'getAvailability() no puede volver a deducir evidencia del tipo de catálogo');
  assert(!/models\.length > 0\s*\)\s*\{[\s\S]{0,120}reachable = true/.test(cuerpo),
    'getAvailability() no puede deducir conectividad del tamaño del catálogo');
  check(true, 'la inferencia por catalogSource y por tamaño de catálogo ha desaparecido del código');
  assert(!/catalogSource/.test(fuente), 'catalogSource ya no existe en ningún adaptador');
  check(true, 'ningún adaptador declara ya catalogSource');
}

console.log('\n=== 5. ready es estricto; canAttempt es «configurado para intentar» ===');
{
  const m = gestor();
  m.apiKeys.alibaba = 'clave-estatica-sin-verificar';
  const d = await m.getAvailability('alibaba');
  check(d.modelsAvailable > 0, `Alibaba ofrece su catálogo declarado (${d.modelsAvailable})`);
  check(d.reachable === null && d.authenticated === null,
    'sin haber hablado con el servidor no hay evidencia de nada');
  check(d.ready === false,
    'una clave meramente presente y un catálogo declarado NO son «listo»');
  check(d.canAttempt === true,
    'pero sí «configurado para intentar»: hay con qué probar');
  check(d.uiState === UI_STATE.UNKNOWN, `y el estado lo dice (${d.uiState})`);

  srv.guionizar({ status: 200, cuerpo: MODELOS_HTTP });
  const n = gestor();
  n.apiKeys.openai = 'clave';
  const v = await conAdaptador('openai', { baseUrl: BASE_SINTETICA }, () => n.getAvailability('openai'));
  check(v.ready === true, 'con evidencia de que el servidor contestó, ready sí puede ser true');
  check(v.canAttempt === true, 'y canAttempt también');
}

console.log('\n=== 6. 401 y 403 son estados distintos ===');
{
  check(resolverUiState({ configured: true, reachable: true, authenticated: false, errorCode: 'PROVIDER_AUTH_REJECTED' })
    === UI_STATE.AUTHENTICATION_REJECTED, '401 lleva a authentication-rejected');
  check(resolverUiState({ configured: true, reachable: true, authenticated: null, errorCode: 'PROVIDER_FORBIDDEN' })
    === UI_STATE.AUTHORIZATION_FORBIDDEN, '403 lleva a authorization-forbidden, que es otro estado');
  check(UI_STATE.AUTHENTICATION_REJECTED !== UI_STATE.AUTHORIZATION_FORBIDDEN,
    'los dos estados son distintos y no se confunden');
  check(describirError(errorDeRespuesta(401)).kind === KINDS.AUTH
     && describirError(errorDeRespuesta(403)).kind === KINDS.FORBIDDEN,
    'la taxonomía los separa desde el origen: auth y forbidden');
  check(describirError(errorDeRespuesta(403)).authenticated === null,
    'un 403 no afirma que la credencial sea válida ni que no lo sea');
}

console.log('\n=== 7. 404, 429 y 500 no se presentan como conectado ===');
{
  const casos = [
    ['PROVIDER_HTTP_404', UI_STATE.PROVIDER_ERROR],
    ['PROVIDER_HTTP_500', UI_STATE.PROVIDER_ERROR],
    ['PROVIDER_UNKNOWN_ERROR', UI_STATE.PROVIDER_ERROR],
    ['PROVIDER_RATE_LIMITED', UI_STATE.RATE_LIMITED]
  ];
  for (const [errorCode, esperado] of casos) {
    const estado = resolverUiState({ configured: true, reachable: true, authenticated: null, errorCode });
    check(estado === esperado, `${errorCode}: estado ${estado}, no «connected»`);
    check(estado !== UI_STATE.CONNECTED, `${errorCode}: nunca se pinta como conectado`);
  }
  check(Object.values(UI_STATE).length === 8,
    `hay ocho estados de interfaz (${Object.values(UI_STATE).join(', ')})`);

  // Y el efecto de punta a punta: un 500 con el servidor vivo.
  srv.guionizar({ status: 500, cuerpo: {} });
  const m = gestor();
  m.apiKeys.openai = 'clave';
  const d = await conAdaptador('openai', { baseUrl: BASE_SINTETICA }, () => m.getAvailability('openai'));
  check(d.reachable === true && d.uiState === UI_STATE.PROVIDER_ERROR,
    'servidor alcanzable con servicio caído: alcanzable sí, conectado no');
  check(d.ready === false && d.canAttempt === false,
    'y ni verificado ni intentable mientras el proveedor devuelva error');

  // El caso que de verdad ejercita la barrera: un adaptador que DEGRADA a su
  // catálogo declarado cuando el endpoint falla. Groq devuelve cinco modelos
  // con un 429 encima. Sin la barrera, ese respaldo dejaría el proveedor como
  // utilizable justo después de que el servicio dijera que no.
  for (const [status, codigo, estado] of [
    [429, 'PROVIDER_RATE_LIMITED', UI_STATE.RATE_LIMITED],
    [500, 'PROVIDER_HTTP_500', UI_STATE.PROVIDER_ERROR],
    [403, 'PROVIDER_FORBIDDEN', UI_STATE.AUTHORIZATION_FORBIDDEN]
  ]) {
    srv.guionizar({ status, cuerpo: {} });
    const g = gestor();
    g.apiKeys.groq = 'clave';
    const r = await conAdaptador('groq', { baseUrl: BASE_SINTETICA }, () => g.getAvailability('groq'));
    check(r.modelsAvailable > 0,
      `groq/${status}: el adaptador degrada a su catálogo declarado (${r.modelsAvailable} modelos)`);
    check(r.errorCode === codigo, `groq/${status}: la sonda conserva el fallo real (${r.errorCode})`);
    check(r.canAttempt === false,
      `groq/${status}: tener catálogo de respaldo NO lo vuelve utilizable`);
    check(r.ready === false, `groq/${status}: ni verificado`);
    check(r.uiState === estado, `groq/${status}: estado ${r.uiState}`);
  }
  srv.guionizar({ status: 200, cuerpo: MODELOS_HTTP });
}

console.log('\n=== 8. reachable === null nunca es conectado ===');
{
  for (const reachable of [null, undefined]) {
    check(resolverUiState({ configured: true, reachable, authenticated: null }) === UI_STATE.UNKNOWN,
      `sin evidencia (${String(reachable)}) el estado es «unknown»`);
  }
  check(resolverUiState({ configured: true, reachable: true, authenticated: null }) === UI_STATE.CONNECTED,
    'sólo con evidencia positiva se dice «connected»');
  check(resolverUiState({ configured: false, reachable: true, authenticated: null }) === UI_STATE.CONFIGURATION_REQUIRED,
    'lo que el usuario debe resolver primero manda sobre la conectividad');
}

console.log('\n=== 9. Ningún mensaje técnico ni secreto cruza al renderer ===');
{
  const m = gestor();
  m.apiKeys.openai = 'clave';
  const d = await conAdaptador('openai', {
    listModels: async () => { throw new Error('falló https://u:secreto@api.example/v1/models con Bearer sk-abcdefgh12345'); }
  }, () => m.getAvailability('openai'));

  const serializado = JSON.stringify(d);
  check(!('message' in d) && !('detail' in d) && !('logMessage' in d),
    'la respuesta no lleva ningún campo de mensaje libre');
  check(!/secreto/.test(serializado), 'ninguna contraseña viaja al renderer');
  check(!/api\.example/.test(serializado), 'ninguna URL del proveedor viaja al renderer');
  check(!/sk-abcdefgh12345/.test(serializado), 'ninguna clave viaja al renderer');
  const permitidas = ['providerId', 'configured', 'reachable', 'authenticated',
    'modelsAvailable', 'models', 'canAttempt', 'ready', 'uiState', 'errorCode', 'httpStatus'];
  check(Object.keys(d).every(k => permitidas.includes(k)),
    `la respuesta se limita a la lista permitida (${Object.keys(d).join(', ')})`);
  check(typeof d.errorCode === 'string' && d.errorCode.startsWith('PROVIDER_'),
    `el contrato es el código estable (${d.errorCode})`);
  check(d.httpStatus === null || Number.isInteger(d.httpStatus),
    'httpStatus es el único metadato numérico y es un entero o null');

  // El saneado sigue existiendo, pero para el log del proceso principal.
  check(sanearMensaje('Authorization: Bearer abc123xyz').includes('[oculto]')
     && !/abc123xyz/.test(sanearMensaje('Authorization: Bearer abc123xyz')),
    'el saneado de logs oculta el token completo');
  check(sanearMensaje('en https://u:clave@h/x') === 'en [endpoint]',
    'el saneado de logs retira la URL con credenciales');
}

console.log('\n=== 10. El renderer traduce desde el código, no desde el proveedor ===');
{
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const inicio = app.indexOf('function describirEstadoProveedor');
  const fin = app.indexOf('// --- AI provider helpers ---');
  const bloque = app.slice(inicio, fin);
  const codigo = bloque.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  assert(!/disp\.message|disp\.detail|disp\.logMessage/.test(codigo),
    'el renderer no puede leer ningún mensaje técnico del proveedor');
  check(true, 'el renderer no lee mensajes técnicos: no existen en el contrato');
  check(/provider\.error\.\$\{/.test(codigo) || codigo.includes('provider.error.'),
    'el tooltip se compone desde provider.error.<codigo>');
  assert(/statusEl\.title = rotuloError/.test(codigo),
    'el title del estado sale del rótulo localizado');
  assert(/const rotuloError = describirEstadoProveedor\(disp\);/.test(app),
    'el rótulo lo compone describirEstadoProveedor(), no una expresión ad hoc');
  check(true, 'el title del elemento de estado es texto localizado, nunca un error crudo');

  // Se ejecuta la función real del renderer con un `t()` de prueba: si alguien
  // la sustituye por el código crudo, esto lo caza aunque la línea del `title`
  // siga igual.
  const { readRendererSource } = require('./helpers/renderer-source');
  const renderer = readRendererSource(path.join(__dirname, '../src/renderer/app.js'));
  const describir = new Function('t', `
    ${renderer.slice('describirEstadoProveedor')}
    return describirEstadoProveedor;
  `)((clave) => (clave === 'provider.error.PROVIDER_FORBIDDEN' ? 'Sin permiso para esta operación'
    : clave === 'provider.state.provider-error' ? 'Error del proveedor' : clave));

  check(describir({ errorCode: 'PROVIDER_FORBIDDEN', uiState: 'authorization-forbidden' })
    === 'Sin permiso para esta operación',
    'un código con texto propio se traduce');
  const sinTexto = describir({ errorCode: 'PROVIDER_HTTP_503', uiState: 'provider-error', httpStatus: 503 });
  check(!/PROVIDER_/.test(sinTexto),
    `un código sin texto propio nunca se enseña crudo ("${sinTexto}")`);
  check(sinTexto.includes('503'), `pero sí conserva el metadato permitido ("${sinTexto}")`);
  check(describir({ errorCode: null }) === '', 'sin error no hay tooltip');

  for (const literal of ['Proveedor no disponible', 'Sin modelos (descarga uno o configura Cloud)',
    'Falta la API Key de este proveedor', 'API Key rechazada por el proveedor']) {
    assert(!codigo.includes(literal), `loadRuntime() ya no puede llevar el literal "${literal}"`);
  }
  check(true, 'loadRuntime() no conserva ningún texto de estado escrito a mano');
}

console.log('\n=== 11. Consumidores de dataset.runtime ===');
{
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

  assert(!/dataset\.runtime/.test(app), 'ya no queda ningún productor de dataset.runtime');
  assert(!/data-runtime/.test(html), 'ya no queda ningún consumidor CSS de data-runtime');
  check(true, 'el booleano dataset.runtime ha desaparecido de productor y consumidores');

  check(/dataset\.providerState = uiState/.test(app),
    'el disparador lleva ahora el estado explícito completo');
  for (const estado of Object.values(UI_STATE)) {
    check(html.includes(`[data-provider-state="${estado}"]`),
      `el CSS del punto cubre el estado ${estado}`);
  }
  // Lo que este cambio impide: marcar en rojo algo que sólo está sin verificar.
  const colorDe = (estado) => {
    const m = html.match(new RegExp(`\\[data-provider-state="${estado}"\\]::after\\s*\\{[^}]*background:\\s*(#[0-9a-fA-F]{3,8})`));
    return m ? m[1].toLowerCase() : null;
  };
  const reglaUnknown = [colorDe('unknown')];
  const reglaOffline = [colorDe('offline')];
  check(reglaUnknown[0] && reglaOffline[0] && reglaUnknown[0] !== reglaOffline[0],
    `«sin verificar» y «sin conexión» no comparten color (${reglaUnknown[0]} vs ${reglaOffline[0]})`);
  check(colorDe('connected') !== colorDe('rate-limited')
     && colorDe('connected') !== colorDe('provider-error'),
    'un servicio degradado tampoco comparte color con uno conectado');
}

console.log('\n=== 12. Alibaba: ready, uiState y estado del punto ===');
{
  check(typeof PROVIDERS.alibaba.validateConfig === 'function',
    'el adaptador con configuración editable declara validateConfig()');

  const sinClave = await gestor().getAvailability('alibaba');
  check(sinClave.configured === false && sinClave.ready === false && sinClave.canAttempt === false,
    'Alibaba sin clave: ni configurado, ni listo, ni intentable');
  check(sinClave.uiState === UI_STATE.CONFIGURATION_REQUIRED,
    `Alibaba sin clave se presenta como «falta configurar» (${sinClave.uiState})`);

  const m = gestor();
  m.apiKeys.alibaba = 'clave-invalida-nunca-verificada';
  const conClave = await m.getAvailability('alibaba');
  check(conClave.canAttempt === true && conClave.modelsAvailable > 0,
    `Alibaba con clave sigue ofreciendo sus preajustes (${conClave.modelsAvailable})`);
  check(conClave.ready === false,
    'una clave estática que nadie ha verificado NO deja el proveedor listo');
  check(conClave.uiState === UI_STATE.UNKNOWN,
    'y su punto de estado será gris de «sin verificar», no verde ni rojo');
  check(conClave.reachable === null && conClave.authenticated === null,
    'porque no hay una sola prueba de que el servidor exista');

  const roto = await conAdaptador('alibaba', {
    validateConfig: () => ({ ok: false, errorCode: 'PROVIDER_ENDPOINT_REQUIRED' })
  }, () => m.getAvailability('alibaba'));
  check(roto.configured === false && roto.errorCode === 'PROVIDER_ENDPOINT_REQUIRED',
    'validateConfig() puede declarar que falta configuración aunque haya credencial');

  const lanza = await conAdaptador('alibaba', {
    validateConfig: () => { throw new Error('configuración ilegible'); }
  }, () => m.getAvailability('alibaba'));
  check(lanza.configured === false && lanza.errorCode === 'PROVIDER_CONFIG_INVALID',
    'un validateConfig() que lanza no rompe la disponibilidad');
}

console.log('\n=== 13. Contrato uniforme y sin casos especiales ===');
{
  const m = gestor();
  const CLAVES = ['providerId', 'configured', 'reachable', 'authenticated',
    'modelsAvailable', 'models', 'canAttempt', 'ready', 'uiState', 'errorCode', 'httpStatus'];
  for (const id of Object.keys(PROVIDERS)) {
    const d = await conAdaptador(id, {
      status: PROVIDERS[id].status ? async () => ({ ok: true }) : undefined,
      listModels: async () => ({ models: [{ name: 'x' }], probe: { attempted: true, reachable: true, authenticated: null, httpStatus: 200, errorCode: null } })
    }, () => m.getAvailability(id));
    for (const clave of CLAVES) {
      assert(Object.prototype.hasOwnProperty.call(d, clave), `${id}: falta ${clave}`);
    }
    check(Object.values(UI_STATE).includes(d.uiState),
      `${id}: declara un uiState del conjunto cerrado (${d.uiState})`);
  }

  const fuente = fs.readFileSync(path.join(__dirname, '../src/main/ai-providers.js'), 'utf8');
  const cuerpo = fuente.slice(fuente.indexOf('async getAvailability('), fuente.indexOf('  getAllProviders()'));
  for (const id of Object.keys(PROVIDERS)) {
    assert(!new RegExp(`['"\`]${id}['"\`]`).test(cuerpo),
      `getAvailability() no puede nombrar al proveedor ${id}`);
  }
  check(true, 'getAvailability() no nombra a ningún proveedor');
  assert(!/\.test\(mensaje\)|\.test\(String\(error/.test(cuerpo),
    'getAvailability() no puede clasificar por el texto del mensaje');
  check(true, 'getAvailability() no aplica ninguna expresión regular al texto de los errores');

  const d = await m.getAvailability('proveedor-que-no-existe');
  check(d.ready === false && d.errorCode === 'PROVIDER_UNKNOWN',
    'un proveedor desconocido no está listo y lo dice con código estable');
}

console.log('\n=== 14. Textos ES/EN de estados y códigos ===');
{
  const i18n = fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8');
  const bloques = i18n.split(/^  (?:es|en): \{$/m);
  check(bloques.length >= 3, 'el diccionario declara los dos idiomas');
  const [, es, en] = bloques;

  for (const estado of Object.values(UI_STATE)) {
    for (const prefijo of ['provider.state', 'provider.selectEmpty']) {
      check(es.includes(`'${prefijo}.${estado}'`) && en.includes(`'${prefijo}.${estado}'`),
        `${prefijo}.${estado} existe en ES y EN`);
    }
  }

  const CODIGOS = ['PROVIDER_CREDENTIAL_REQUIRED', 'PROVIDER_CONFIG_REQUIRED', 'PROVIDER_CONFIG_INVALID',
    'PROVIDER_ENDPOINT_REQUIRED', 'PROVIDER_CATALOG_REQUIRED', 'PROVIDER_CATALOG_EMPTY',
    'PROVIDER_AUTH_REJECTED', 'PROVIDER_FORBIDDEN', 'PROVIDER_RATE_LIMITED',
    'PROVIDER_TRANSPORT_UNREACHABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_ABORTED',
    'PROVIDER_UNKNOWN_ERROR', 'PROVIDER_UNAVAILABLE', 'PROVIDER_UNKNOWN'];
  for (const codigo of CODIGOS) {
    check(es.includes(`'provider.error.${codigo}'`) && en.includes(`'provider.error.${codigo}'`),
      `provider.error.${codigo} existe en ES y EN`);
  }

  const valor = (bloque, clave) => {
    const m = bloque.match(new RegExp(`'${clave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'([^']*)'`));
    return m ? m[1] : null;
  };
  for (const estado of Object.values(UI_STATE)) {
    const a = valor(es, `provider.selectEmpty.${estado}`);
    const b = valor(en, `provider.selectEmpty.${estado}`);
    check(a && b && a !== b, `provider.selectEmpty.${estado} está traducido de verdad`);
  }
  for (const codigo of ['PROVIDER_AUTH_REJECTED', 'PROVIDER_FORBIDDEN', 'PROVIDER_RATE_LIMITED']) {
    const a = valor(es, `provider.error.${codigo}`);
    const b = valor(en, `provider.error.${codigo}`);
    check(a && b && a !== b, `provider.error.${codigo} está traducido de verdad`);
  }
  // Ningún texto de interfaz puede filtrar un código interno al usuario.
  for (const estado of Object.values(UI_STATE)) {
    const a = valor(es, `provider.state.${estado}`);
    check(a && !/PROVIDER_/.test(a), `provider.state.${estado} no enseña códigos internos ("${a}")`);
  }
}

console.log('\n=== 15. Compatibilidad de status() ===');
{
  const m = gestor();
  m.apiKeys.alibaba = 'clave';
  const st = await m.status();
  check(typeof st.ok === 'boolean', 'status() sigue existiendo y conserva su forma');
}

await srv.cerrar();
console.warn = warnOriginal;
console.log(`\nProvider availability tests passed (${comprobaciones} comprobaciones)`);
})().catch(error => {
  console.warn = warnOriginal;
  console.error(error);
  process.exit(1);
});
