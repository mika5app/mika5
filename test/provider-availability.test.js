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

// Fuente que implementa un adaptador. llamacpp y bitnet son instancias de la
// misma fábrica (`llama-server.js`): sus módulos sólo la configuran, así que
// las comprobaciones de código miran la fábrica, y aquí se exige que el
// módulo del adaptador de verdad la use para no comprobar un fichero ajeno.
const FABRICA_DE = { llamacpp: 'llama-server', bitnet: 'llama-server' };
function fuenteDelAdaptador(id) {
  const dir = path.join(__dirname, '../src/main/providers');
  const propio = fs.readFileSync(path.join(dir, `${id}.js`), 'utf8');
  const fabrica = FABRICA_DE[id];
  if (!fabrica) return propio;
  assert(propio.includes(`require('./${fabrica}')`), `${id}.js debe construirse con ${fabrica}.js`);
  return fs.readFileSync(path.join(dir, `${fabrica}.js`), 'utf8');
}

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
      // `crudo` permite devolver un cuerpo que NO es JSON válido.
      const json = typeof guion.crudo === 'string' ? guion.crudo : JSON.stringify(guion.cuerpo);
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

  // Cancelación REAL atravesando listModels() de un adaptador de red. Antes
  // esto no se podía probar: ningún adaptador aceptaba señal externa y
  // `PROVIDER_ABORTED` era inalcanzable por esa vía.
  // `local` está aquí desde que `ollamaApi` acepta señal: antes no podía
  // estarlo porque no hace fetch propio y la señal moría en la frontera del
  // módulo. Su cadena completa se ejercita en test/ollama-cancellation.test.js.
  const CON_SENAL = ['openai', 'groq', 'llamacpp', 'bitnet', 'local'];
  for (const id of CON_SENAL) {
    const firma = String(PROVIDERS[id].listModels);
    check(/options\s*=\s*\{\}/.test(firma.slice(0, firma.indexOf(')') + 1)),
      `${id}: listModels() acepta un tercer parámetro de opciones`);
  }
  for (const id of ['anthropic', 'moonshot', 'alibaba']) {
    const firma = String(PROVIDERS[id].listModels);
    check(!/options/.test(firma.slice(0, firma.indexOf(')') + 1)),
      `${id}: no se le añade una señal ficticia, porque no hace red`);
  }

  // Cancelación externa: el servidor tarda, se aborta desde fuera.
  srv.guionizar({ status: 200, cuerpo: MODELOS_HTTP, retrasoMs: 5000 });
  {
    const control = new AbortController();
    setTimeout(() => control.abort(), 150);
    const inicio = Date.now();
    const r = await conAdaptador('openai', { baseUrl: BASE_SINTETICA }, () =>
      PROVIDERS.openai.listModels('clave', undefined, { signal: control.signal }));
    check(r.probe.errorCode === 'PROVIDER_ABORTED',
      `cancelar desde fuera atraviesa listModels() y da ${r.probe.errorCode}`);
    check(r.probe.reachable === null,
      'una cancelación no prueba nada sobre el servidor');
    check(Date.now() - inicio < 3000,
      'y corta de verdad, sin esperar a que el servidor responda');
  }

  // Plazo interno: nadie cancela, el servidor no contesta a tiempo.
  {
    const inicio = Date.now();
    const r = await conAdaptador('llamacpp', { baseUrl: BASE_SINTETICA }, () =>
      PROVIDERS.llamacpp.listModels(undefined, undefined, {}));
    check(r.probe.errorCode === 'PROVIDER_TIMEOUT',
      `el plazo interno da ${r.probe.errorCode}, distinto de una cancelación`);
    check(Date.now() - inicio < 4500, 'y vence en su propio plazo, no en el del servidor');
  }

  // La distinción es el punto: mismo camino, dos códigos según quién corte.
  {
    const control = new AbortController();
    setTimeout(() => control.abort(), 100);
    const cancelado = await conAdaptador('llamacpp', { baseUrl: BASE_SINTETICA }, () =>
      PROVIDERS.llamacpp.listModels(undefined, undefined, { signal: control.signal }));
    check(cancelado.probe.errorCode === 'PROVIDER_ABORTED',
      'el mismo adaptador da ABORTED cuando corta el usuario y TIMEOUT cuando vence el plazo');
  }

  // Una señal ya abortada corta antes de salir a la red.
  {
    const yaAbortada = AbortSignal.abort();
    const r = await conAdaptador('openai', { baseUrl: BASE_SINTETICA }, () =>
      PROVIDERS.openai.listModels('clave', undefined, { signal: yaAbortada }));
    check(r.probe.errorCode === 'PROVIDER_ABORTED',
      'una señal ya abortada no llega a hacer la petición');
  }

  // Retrocompatibilidad: las llamadas de dos argumentos siguen funcionando.
  srv.guionizar({ status: 200, cuerpo: MODELOS_HTTP });
  for (const id of CON_SENAL) {
    const r = await conAdaptador(id, { baseUrl: BASE_SINTETICA }, () =>
      PROVIDERS[id].listModels(PROVIDERS[id].requiresKey ? 'clave' : undefined));
    check(r && Array.isArray(r.models) && r.probe,
      `${id}: la llamada sin tercer argumento sigue devolviendo { models, probe }`);
  }

  // Sin AbortSignal.any en ninguno: el combinador es `createAbortContext()`,
  // que ya existía y está probado.
  for (const id of CON_SENAL) {
    const modulo = fuenteDelAdaptador(id);
    // Sólo líneas de código: los comentarios pueden nombrar lo que se evitó.
    const codigo = modulo.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/AbortSignal\.any/.test(codigo),
      `${id}: no puede depender de AbortSignal.any sin comprobar su disponibilidad`);
    // Quien crea un contexto tiene que liberarlo. `local` no crea ninguno: se
    // limita a pasar la señal a `ollamaApi`, que es lo que hay que hacer para
    // no imponerle al catálogo un plazo que v0.2.0 no tenía.
    if (/createAbortContext\(/.test(codigo)) {
      assert(/abortContext\.cleanup\(\)/.test(modulo),
        `${id}: crea un contexto de cancelación y debe liberarlo en cleanup()`);
    } else {
      assert(/options\.signal|\{ signal/.test(codigo),
        `${id}: si no crea contexto, tiene que propagar la señal que recibe`);
    }
  }
  check(true, 'ningún adaptador usa AbortSignal.any, y quien crea un contexto lo libera');
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

console.log('\n=== 10 bis. loadRuntime() sólo puebla el selector con canAttempt ===');
{
  // Alcance de esta prueba, para no venderla por más de lo que es: se extrae
  // el CUERPO real de `loadRuntime()` de app.js y se ejecuta con `new Function`
  // contra un DOM simulado. El código es el de producción y la decisión que se
  // mide es la suya, pero el entorno no lo es: no hay Chromium, ni maquetación,
  // ni IPC. Que el desplegable se vea y se pueda pulsar se comprueba en
  // test/provider-selector.test.js, que sí corre en Electron.
  //
  // La regresión concreta: la condición era
  //   `disp.canAttempt || (disp.configured && disp.reachable !== false
  //                        && disp.authenticated !== false)`
  // y esa segunda mitad reconstruía `canAttempt` a partir de sus ingredientes
  // olvidando el que importa — que no haya un error que impida usar el
  // proveedor. Con 429, 403 o 500 la clave es válida y el servidor contesta,
  // así que daba verde: la píldora decía «límite alcanzado» y el desplegable
  // ofrecía modelos con los que ninguna petición podía salir.
  const { readRendererSource } = require('./helpers/renderer-source');
  const renderer = readRendererSource(path.join(__dirname, '../src/renderer/app.js'));

  const construirEntorno = (disp) => {
    const nodos = new Map();
    const nodo = (id) => {
      if (!nodos.has(id)) {
        nodos.set(id, {
          id, innerHTML: '', textContent: '', disabled: false, hijos: [],
          dataset: {}, style: {}, className: '', title: undefined,
          appendChild(h) { this.hijos.push(h); },
          removeAttribute() { this.title = undefined; }
        });
      }
      return nodos.get(id);
    };
    // `t()` devuelve el diccionario español de verdad, no la clave: si no, la
    // comprobación del texto mostrado sólo verificaría que se llamó a t(), que
    // es exactamente lo que no vale como evidencia.
    const diccionario = require('./helpers/renderer-source') && (() => {
      const fuenteI18n = fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8');
      // `i18n.js` llama a `detectLanguage()` al cargarse, y ahí lee
      // `navigator.language`. En el renderer de Electron ese global existe
      // siempre; en Node no está garantizado (20 no lo expone, 21+ sí), así que
      // evaluar el módulo dependía de una casualidad de la versión del proceso y
      // los gates fallaban con `ReferenceError: navigator is not defined`.
      //
      // Se inyecta como PARÁMETRO explícito de la evaluación, no como global del
      // proceso: la dependencia queda declarada en el harness y no toca ni
      // `i18n.js` ni el comportamiento productivo. El valor es fijo para que el
      // idioma detectado no dependa de la máquina; aquí sólo se consume el
      // diccionario `es`, que es lo que este bloque compara.
      const NAVIGATOR_SINTETICO = Object.freeze({ language: 'es-ES', userLanguage: 'es-ES' });
      const traducciones = new Function('navigator', `${fuenteI18n}\nreturn MIKA5_TRANSLATIONS;`)(NAVIGATOR_SINTETICO);
      return traducciones.es;
    })();
    return {
      nodos,
      diccionario,
      globales: {
        el: nodo,
        t: (clave) => {
          const texto = diccionario[clave];
          if (texto === undefined) throw new Error(`clave sin traducción: ${clave}`);
          return texto;
        },
        document: {
          createElement: () => ({
            value: '', textContent: '', dataset: {}, appendChild() {}
          })
        },
        window: {
          mika5: {
            ai: { getAvailability: async () => disp },
            getAppState: async () => null
          }
        },
        currentProvider: 'openai',
        AUTOMATIC_MODEL_ID: '__automatic__',
        formatBytesRenderer: () => '1 GB',
        syncModelDropdown: () => {},
        describirEstadoProveedor: () => ''
      }
    };
  };

  const ejecutarLoadRuntime = async (disp) => {
    const { nodos, globales, diccionario } = construirEntorno(disp);
    const nombres = Object.keys(globales);
    const cuerpo = renderer.slice('loadRuntime');
    const fabrica = new Function(...nombres, `${cuerpo}\nreturn loadRuntime;`);
    await fabrica(...nombres.map(n => globales[n]))();
    const select = nodos.get('modelSelect');
    const pill = nodos.get('rtStatus');
    return {
      opciones: select.hijos.length,
      valores: select.hijos.map(h => h.value),
      textos: select.hijos.map(h => h.textContent),
      deshabilitado: select.disabled === true,
      estadoPill: pill.dataset.providerState,
      textoPill: pill.textContent,
      diccionario
    };
  };

  const modelos = [{ name: 'gpt-4o', taskType: 'chat' }, { name: 'gpt-4o-mini', taskType: 'chat' }];

  // Con `canAttempt` los modelos se ofrecen y el selector queda utilizable.
  const intentable = await ejecutarLoadRuntime({
    configured: true, reachable: true, authenticated: true, modelsAvailable: 2,
    models: modelos, canAttempt: true, ready: true, uiState: 'connected',
    errorCode: null, httpStatus: null
  });
  check(intentable.opciones === 2 && !intentable.deshabilitado,
    `canAttempt ofrece el catálogo y deja elegir (${intentable.opciones} opciones, deshabilitado=${intentable.deshabilitado})`);

  // LOS OCHO estados del contrato, no una muestra. Cada uno declara si puede
  // intentarse, y de ahí sale lo que ve el usuario.
  const OCHO_ESTADOS = [
    { uiState: 'connected', canAttempt: true, errorCode: null, httpStatus: null,
      configured: true, reachable: true, authenticated: true },
    { uiState: 'unknown', canAttempt: true, errorCode: null, httpStatus: null,
      configured: true, reachable: null, authenticated: null },
    { uiState: 'offline', canAttempt: false, errorCode: 'PROVIDER_TRANSPORT_UNREACHABLE', httpStatus: null,
      configured: true, reachable: false, authenticated: null },
    { uiState: 'configuration-required', canAttempt: false, errorCode: 'PROVIDER_NOT_CONFIGURED', httpStatus: null,
      configured: false, reachable: null, authenticated: null },
    { uiState: 'authentication-rejected', canAttempt: false, errorCode: 'PROVIDER_UNAUTHORIZED', httpStatus: 401,
      configured: true, reachable: true, authenticated: false },
    { uiState: 'authorization-forbidden', canAttempt: false, errorCode: 'PROVIDER_FORBIDDEN', httpStatus: 403,
      configured: true, reachable: true, authenticated: true },
    { uiState: 'rate-limited', canAttempt: false, errorCode: 'PROVIDER_RATE_LIMIT', httpStatus: 429,
      configured: true, reachable: true, authenticated: true },
    { uiState: 'provider-error', canAttempt: false, errorCode: 'PROVIDER_HTTP_500', httpStatus: 500,
      configured: true, reachable: true, authenticated: true }
  ];
  check(OCHO_ESTADOS.length === Object.values(UI_STATE).length
    && OCHO_ESTADOS.every(c => Object.values(UI_STATE).includes(c.uiState)),
    `se recorren los ${Object.values(UI_STATE).length} estados del contrato, no una muestra`);

  for (const caso of OCHO_ESTADOS) {
    const r = await ejecutarLoadRuntime({
      modelsAvailable: modelos.length, models: modelos, ready: caso.uiState === 'connected', ...caso
    });

    if (caso.canAttempt) {
      check(r.opciones === modelos.length && !r.deshabilitado,
        `${caso.uiState}: se puede intentar, así que se ofrecen los modelos (${r.opciones})`);
    } else {
      check(r.opciones === 1 && r.valores[0] === '',
        `${caso.uiState}: no ofrece ningún modelo utilizable (${r.opciones} opciones)`);
      check(r.deshabilitado, `${caso.uiState}: el selector queda deshabilitado`);
      // El TEXTO MOSTRADO, no la clave ni la existencia de t(): es lo que
      // separa «no hay modelos» de «te han limitado», y es lo único que el
      // usuario llega a leer.
      const esperado = r.diccionario[`provider.selectEmpty.${caso.uiState}`];
      check(typeof esperado === 'string' && esperado.length > 0 && r.textos[0] === esperado,
        `${caso.uiState}: la opción dice "${r.textos[0]}"`);
      // Y dos estados distintos no pueden leerse igual: si todos compartiesen
      // texto, el usuario no sabría cuál de los ocho le ha tocado.
      check(r.textos[0] !== r.diccionario['provider.selectEmpty.connected'],
        `${caso.uiState}: su texto no se confunde con el de «sin modelos»`);
    }

    // La píldora tiene que contar el mismo estado que el selector.
    check(r.estadoPill === caso.uiState,
      `${caso.uiState}: la píldora lleva el mismo estado (${r.estadoPill})`);
    const textoEstado = r.diccionario[`provider.state.${caso.uiState}`];
    check(r.textoPill === textoEstado,
      `${caso.uiState}: la píldora muestra "${r.textoPill}"`);
    check(!/PROVIDER_|HTTP_|\bsk-/.test(r.textoPill + r.textos.join(' ')),
      `${caso.uiState}: nada de lo que se enseña lleva códigos internos ni credenciales`);
  }

  const codigoLoadRuntime = renderer.slice('loadRuntime')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check(/provider\.selectEmpty\.\$\{uiState\}/.test(codigoLoadRuntime),
    'el selector vacío se rotula con el estado concreto, no con un texto único');
  check(!/disp\.configured\s*&&/.test(codigoLoadRuntime),
    'no queda ninguna vía que rodee canAttempt reconstruyéndolo a mano');
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

console.log('\n=== 12b. La extracción a módulos no cambió el conjunto ===');
{
  // Los ocho adaptadores viven ahora en src/main/providers/<id>.js y
  // ai-providers.js los compone. Esto fija el resultado observable de esa
  // extracción: los mismos identificadores, en el mismo orden, con la misma
  // forma. Un módulo que se olvide de registrarse, o que se registre con otro
  // nombre o en otra posición, cae aquí.
  const IDS_ESPERADOS = ['local', 'openai', 'anthropic', 'groq', 'moonshot', 'alibaba', 'llamacpp', 'bitnet'];
  check(JSON.stringify(Object.keys(PROVIDERS)) === JSON.stringify(IDS_ESPERADOS),
    `el registro expone los ocho adaptadores en su orden observable (${Object.keys(PROVIDERS).join(', ')})`);

  const dir = path.join(__dirname, '../src/main/providers');
  // Módulos del directorio que NO son adaptadores. La lista es explícita: un
  // fichero nuevo sin declarar aquí hace fallar la comprobación, que es lo que
  // impide que se cuele un adaptador sin registrar.
  const NO_ADAPTADORES = ['alibaba-config', 'llama-server'];
  const modulos = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, '')).sort();
  const adaptadores = modulos.filter(m => !NO_ADAPTADORES.includes(m));
  check(JSON.stringify(adaptadores) === JSON.stringify([...IDS_ESPERADOS].sort()),
    `hay un módulo por adaptador y ninguno de más (${adaptadores.join(', ')})`);
  check(NO_ADAPTADORES.every(m => modulos.includes(m)),
    `los módulos auxiliares declarados existen (${NO_ADAPTADORES.join(', ')})`);

  // Cada módulo tiene que poder cargarse por sí solo: si dependiera de un
  // identificador que sólo existe dentro de ai-providers.js, la extracción
  // estaría a medias y fallaría en cuanto alguien lo importase suelto.
  for (const id of IDS_ESPERADOS) {
    let cargado = null;
    try {
      cargado = require(path.join(dir, `${id}.js`));
    } catch (error) {
      assert.fail(`el módulo ${id}.js no carga por sí solo: ${error.message}`);
    }
    const exportado = Object.keys(cargado);
    check(exportado.length === 1,
      `${id}.js exporta exactamente una cosa (${exportado.join(', ')})`);
  }

  // Ningún módulo de adaptador puede volver a importar ai-providers.js: sería
  // el ciclo que la extracción existe para evitar.
  for (const id of IDS_ESPERADOS) {
    const src = fs.readFileSync(path.join(dir, `${id}.js`), 'utf8');
    assert(!/require\(['"]\.\.\/ai-providers['"]\)/.test(src),
      `${id}.js no puede importar ai-providers.js: sería una dependencia circular`);
  }
  check(true, 'ningún adaptador importa el módulo que lo compone');

  // Y la forma de cada adaptador, congelada: propiedades y aridad de funciones.
  const FORMA = {
    local: { requiresKey: false, privacy: 'private', metodos: ['chat', 'listModels', 'status'] },
    openai: { requiresKey: true, privacy: 'cloud', metodos: ['chat', 'listModels'] },
    anthropic: { requiresKey: true, privacy: 'cloud', metodos: ['chat', 'listModels'] },
    groq: { requiresKey: true, privacy: 'cloud', metodos: ['chat', 'listModels'] },
    moonshot: { requiresKey: true, privacy: 'cloud', metodos: ['chat', 'listModels'] },
    alibaba: { requiresKey: true, privacy: 'cloud', metodos: ['chat', 'listModels', 'validateConfig', 'generateImage'] },
    llamacpp: { requiresKey: false, privacy: 'private', metodos: ['chat', 'listModels', 'status'] },
    bitnet: { requiresKey: false, privacy: 'private', metodos: ['chat', 'listModels', 'status'] }
  };
  for (const [id, esperado] of Object.entries(FORMA)) {
    const c = PROVIDERS[id];
    check(c.requiresKey === esperado.requiresKey && c.privacy === esperado.privacy,
      `${id}: conserva requiresKey=${esperado.requiresKey} y privacy=${esperado.privacy}`);
    const metodos = ['chat', 'listModels', 'status', 'validateConfig', 'generateImage']
      .filter(m => typeof c[m] === 'function').sort();
    check(JSON.stringify(metodos) === JSON.stringify([...esperado.metodos].sort()),
      `${id}: conserva sus funciones (${metodos.join(', ')})`);
  }
}

console.log('\n=== 12c. Alibaba conserva sus preajustes y su fallback ===');
{
  // La configuración de Alibaba se extrajo a su propio módulo. Estas
  // comprobaciones fijan los dos comportamientos documentados que la
  // extracción NO podía «arreglar» de paso, porque son deliberados.
  const cfg = require('../src/main/providers/alibaba-config');

  check(cfg.ALIBABA_DEFAULT_CONFIG.models.length === 11,
    `el catálogo de preajustes conserva sus once modelos (${cfg.ALIBABA_DEFAULT_CONFIG.models.length})`);
  check(cfg.ALIBABA_TOKEN_PLAN_ENDPOINT.startsWith('https://'),
    'el endpoint del plan de tokens sigue siendo https');
  check(cfg.ALIBABA_DEFAULT_MAX_TOKENS === 8192 && cfg.ALIBABA_LEGACY_MAX_TOKENS === 1024,
    'los dos límites de tokens conservan su valor: la migración depende de distinguirlos');

  // `normalizeAlibabaConfig()` reinyecta siempre los preajustes. Es la razón
  // por la que `deleteProviderModel()` no puede retirarlos, y está documentado.
  const vacio = cfg.normalizeAlibabaConfig({ models: [] });
  check(vacio.models.length === 11,
    `normalizar una configuración sin modelos reinyecta los preajustes (${vacio.models.length})`);
  const conExtra = cfg.normalizeAlibabaConfig({
    models: [{ id: 'modelo-propio', displayName: 'Propio', taskType: 'chat' }]
  });
  check(conExtra.models.some(m => m.id === 'modelo-propio'),
    'un modelo añadido por el usuario sobrevive a la normalización');
  check(conExtra.models.length === 12,
    `y convive con los once preajustes, no los sustituye (${conExtra.models.length})`);

  // El catálogo es estático: no toca la red y por tanto no aporta evidencia.
  const alibaba = PROVIDERS.alibaba;
  const listado = await alibaba.listModels('clave', undefined);
  check(listado.probe && listado.probe.attempted === false,
    'el catálogo de Alibaba sigue declarando que no intentó ninguna consulta de red');
  check(listado.probe.reachable === null && listado.probe.authenticated === null,
    'y por tanto no afirma conectividad ni credencial aceptada');
  check(listado.models.length > 0,
    `pero sigue ofreciendo modelos utilizables (${listado.models.length})`);
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

console.log('\n=== 15. Un 2xx ilegible conserva la evidencia del 2xx ===');
{
  // Que el cuerpo no se entienda no borra lo que el código de estado demostró:
  // el servidor respondió y, si el proveedor exige credencial, la aceptó. La
  // versión anterior lo trataba como fallo genérico y devolvía reachable=null,
  // justo lo contrario de lo que acababa de probarse.
  const casos = [
    ['JSON malformado', { status: 200, crudo: '{"data": [' }],
    ['JSON válido con estructura inválida', { status: 200, cuerpo: { objeto: 'sin data' } }],
    ['data que no es un array', { status: 200, cuerpo: { data: 'no soy un array' } }],
    ['cuerpo vacío', { status: 200, crudo: '' }]
  ];

  for (const [nombre, guion] of casos) {
    srv.guionizar(guion);
    const m = gestor();
    m.apiKeys.openai = 'clave';
    const d = await conAdaptador('openai', { baseUrl: BASE_SINTETICA }, () => m.getAvailability('openai'));

    check(d.reachable === true, `openai/${nombre}: reachable sigue siendo true`);
    check(d.authenticated === true, `openai/${nombre}: authenticated sigue siendo true`);
    check(d.httpStatus === 200, `openai/${nombre}: httpStatus conserva el código recibido (${d.httpStatus})`);
    check(d.errorCode === 'PROVIDER_RESPONSE_INVALID', `openai/${nombre}: ${d.errorCode}`);
    check(d.ready === false, `openai/${nombre}: no está listo`);
    check(d.canAttempt === false, `openai/${nombre}: ni intentable`);
    check(d.uiState === UI_STATE.PROVIDER_ERROR, `openai/${nombre}: estado ${d.uiState}`);
  }

  // llama.cpp es local: no hay credencial que aceptar, así que `authenticated`
  // se queda en null. La conectividad sí queda demostrada.
  for (const [nombre, guion] of [
    ['JSON malformado', { status: 200, crudo: 'no soy json' }],
    ['estructura inválida', { status: 200, cuerpo: { modelos: [] } }]
  ]) {
    srv.guionizar(guion);
    const m = gestor();
    const d = await conAdaptador('llamacpp', {
      baseUrl: BASE_SINTETICA,
      status: async () => ({ ok: true })
    }, () => m.getAvailability('llamacpp'));
    check(d.reachable === true, `llamacpp/${nombre}: reachable=true`);
    check(d.authenticated === null, `llamacpp/${nombre}: authenticated=null, no hay credencial que validar`);
    check(d.httpStatus === 200, `llamacpp/${nombre}: httpStatus=200`);
    check(d.errorCode === 'PROVIDER_RESPONSE_INVALID', `llamacpp/${nombre}: ${d.errorCode}`);
    check(d.ready === false && d.canAttempt === false, `llamacpp/${nombre}: ni listo ni intentable`);
  }

  // Groq degrada a su lista fija: el respaldo no puede convertir una respuesta
  // ilegible en un proveedor utilizable.
  srv.guionizar({ status: 200, crudo: '{{{' });
  const g = gestor();
  g.apiKeys.groq = 'clave';
  const r = await conAdaptador('groq', { baseUrl: BASE_SINTETICA }, () => g.getAvailability('groq'));
  check(r.modelsAvailable > 0, `groq: degrada a su catálogo declarado (${r.modelsAvailable})`);
  check(r.errorCode === 'PROVIDER_RESPONSE_INVALID', `groq: conserva el motivo real (${r.errorCode})`);
  check(r.reachable === true && r.authenticated === true, 'groq: la evidencia del 2xx sobrevive');
  check(r.canAttempt === false, 'groq: el respaldo no lo vuelve utilizable');

  // El contrato se aplica a los tres adaptadores que analizan JSON de red.
  // Cada adaptador vive en su propio módulo desde la extracción.
  const conParseo = ['openai', 'groq', 'llamacpp', 'bitnet'];
  for (const id of conParseo) {
    const modulo = fuenteDelAdaptador(id);
    assert(modulo.includes('probeDeRespuestaInvalida'),
      `${id} analiza JSON de red y debe declarar la sonda de respuesta inválida`);
  }
  check(true, `los adaptadores que analizan JSON de red aplican el mismo contrato (${conParseo.join(', ')})`);

  const i18n = fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8');
  const bloques = i18n.split(/^  (?:es|en): \{$/m);
  const claveInvalida = "'provider.error.PROVIDER_RESPONSE_INVALID'";
  check(bloques[1].includes(claveInvalida) && bloques[2].includes(claveInvalida),
    'PROVIDER_RESPONSE_INVALID tiene texto en ES y EN');

  srv.guionizar({ status: 200, cuerpo: MODELOS_HTTP });
}

console.log('\n=== 16. status() conserva su comportamiento, no sólo su forma ===');
{
  // Comprobar `typeof st.ok === 'boolean'` no demostraba nada: cualquier
  // función que devolviera `{ ok: false }` habría pasado. Aquí se comprueba
  // que sigue delegando en el adaptador cuando éste tiene sonda, y que sigue
  // reflejando la presencia de credencial cuando no la tiene.

  // Runtime local: delega en la sonda del adaptador, en los dos sentidos.
  for (const [id, ok] of [['local', true], ['local', false], ['llamacpp', true], ['llamacpp', false],
    ['bitnet', true], ['bitnet', false]]) {
    const m = gestor();
    m.currentProvider = id;
    let invocada = false;
    const st = await conAdaptador(id, {
      status: async () => { invocada = true; return { ok, message: ok ? 'activo' : 'caído' }; }
    }, () => m.status());
    check(invocada === true, `status() de ${id} delega en la sonda del adaptador`);
    check(st.ok === ok, `status() de ${id} propaga ok=${ok} sin alterarlo`);
    check(st.message === (ok ? 'activo' : 'caído'),
      `status() de ${id} conserva el mensaje del adaptador ("${st.message}")`);
  }

  // Proveedor cloud: refleja la presencia de credencial y nada más. Ninguna
  // sonda del adaptador debe invocarse por este camino.
  for (const id of ['openai', 'anthropic', 'groq', 'moonshot', 'alibaba']) {
    const sin = gestor();
    sin.currentProvider = id;
    let tocado = false;
    const stSin = await conAdaptador(id, {
      listModels: async () => { tocado = true; return { models: [] }; }
    }, () => sin.status());
    check(stSin.ok === false, `${id} sin credencial: status().ok es false`);
    check(typeof stSin.message === 'string' && stSin.message.length > 0,
      `${id} sin credencial: status() explica por qué ("${stSin.message}")`);
    check(tocado === false, `${id}: status() no consulta el catálogo ni gasta red`);

    const con = gestor();
    con.currentProvider = id;
    con.apiKeys[id] = 'clave';
    const stCon = await con.status();
    check(stCon.ok === true, `${id} con credencial: status().ok es true`);
  }

  // Y la separación que motivó todo: `status().ok` NO implica utilizable.
  const m = gestor();
  m.currentProvider = 'alibaba';
  m.apiKeys.alibaba = 'clave-sin-verificar';
  const st = await m.status();
  const disp = await m.getAvailability('alibaba');
  check(st.ok === true && disp.ready === false,
    'status().ok puede ser true mientras la disponibilidad dice que no está verificado');
  check(disp.uiState === UI_STATE.UNKNOWN,
    'que es exactamente la distinción que el modelo antiguo no podía expresar');
}

await srv.cerrar();
console.warn = warnOriginal;
console.log(`\nProvider availability tests passed (${comprobaciones} comprobaciones)`);
})().catch(error => {
  console.warn = warnOriginal;
  console.error(error);
  process.exit(1);
});
