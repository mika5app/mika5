'use strict';

// Modelo de disponibilidad de proveedores.
//
// Historia de lo que estas pruebas impiden, en tres capas:
//
//   1. `status()` respondía `ok: !!apiKey` para todo proveedor cloud, y el
//      renderer poblaba el selector con ese único booleano. Cuatro preguntas
//      distintas colapsadas en una: configurado, alcanzable, autenticado y con
//      catálogo.
//   2. El primer intento de arreglarlo infería `reachable` y `authenticated`
//      del hecho de que `listModels()` devolviera modelos. Falso: `anthropic`,
//      `moonshot`, `groq` y `alibaba` sirven catálogos declarados en el propio
//      adaptador, que se devuelven igual con el servidor apagado.
//   3. Ese mismo intento clasificaba los fallos con una expresión regular sobre
//      el texto del error. Un adaptador que traduzca su mensaje cambiaba la
//      clasificación sin tocar una línea de lógica.
//
// Ahora la evidencia es estructurada y la ausencia de evidencia se llama
// `null`, que nunca se presenta como «Conectado».
//
//   npm run test:provider-availability

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

// Base de datos falsa: `AIProviderManager` sólo la usa para leer y escribir
// `app_state`. Así la suite corre con node, sin Electron y sin tocar disco.
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

// Sustituye métodos de un adaptador REAL y los restaura al terminar. El
// adaptador es la frontera de transporte: por debajo hay red, por encima está
// la lógica que se quiere probar. No se sustituye el adaptador entero, así que
// `requiresKey`, `catalogSource` y `validateConfig()` siguen siendo los suyos.
async function conAdaptador(providerId, parches, fn) {
  const config = PROVIDERS[providerId];
  const originales = {};
  for (const [clave, valor] of Object.entries(parches)) {
    if (valor === undefined) continue;
    originales[clave] = Object.prototype.hasOwnProperty.call(config, clave) ? config[clave] : Symbol.for('ausente');
    config[clave] = valor;
  }
  try {
    return await fn();
  } finally {
    for (const [clave, valor] of Object.entries(originales)) {
      if (valor === Symbol.for('ausente')) delete config[clave];
      else config[clave] = valor;
    }
  }
}

const gestor = (filas) => new AIProviderManager(baseFalsa(filas));
const MODELOS = { models: [{ name: 'modelo-uno' }, { name: 'modelo-dos' }] };

/** Error de red al estilo de los que produce `fetch`: el código va en la causa. */
function errorDeRed(code) {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error(code), { code });
  return e;
}

(async () => {

console.log('\n=== 1. Proveedor cloud sin credencial ===');
{
  const m = gestor();
  let consultado = false;
  const d = await conAdaptador('openai', {
    listModels: async () => { consultado = true; return MODELOS; }
  }, () => m.getAvailability('openai'));

  check(d.configured === false, 'sin clave el proveedor no está configurado');
  check(d.ready === false, 'sin clave no está listo');
  check(d.authenticated === null, 'sin clave la autenticación no se ha intentado: null, no false');
  check(d.reachable === null, 'sin clave tampoco se sabe si el servidor responde');
  check(d.uiState === UI_STATE.CONFIGURATION_REQUIRED, `el estado de interfaz es explícito (${d.uiState})`);
  check(d.errorCode === 'PROVIDER_CREDENTIAL_REQUIRED', `errorCode estable (${d.errorCode})`);
  check(consultado === false, 'sin clave no se consulta el catálogo: ninguna petición inútil');
}

console.log('\n=== 2. Credencial rechazada, por código y no por texto ===');
for (const status of [401, 403]) {
  const m = gestor();
  m.apiKeys.openai = 'clave-de-prueba';
  const d = await conAdaptador('openai', {
    listModels: async () => { throw errorDeRespuesta(status, 'catálogo'); }
  }, () => m.getAvailability('openai'));

  check(d.reachable === true, `HTTP ${status}: el servidor contestó, luego es alcanzable`);
  check(d.authenticated === false, `HTTP ${status}: la credencial fue rechazada`);
  check(d.ready === false, `HTTP ${status}: no está listo`);
  check(d.uiState === UI_STATE.AUTHENTICATION_REJECTED, `HTTP ${status}: estado ${d.uiState}`);
  check(d.errorCode === 'PROVIDER_AUTH_REJECTED', `HTTP ${status}: errorCode ${d.errorCode}`);
}

console.log('\n=== 3. Runtime local sin credencial ===');
{
  const m = gestor();
  check(PROVIDERS.local.requiresKey === false, 'el adaptador local declara que no requiere clave');

  const d = await conAdaptador('local', {
    status: async () => ({ ok: true }),
    listModels: async () => MODELOS
  }, () => m.getAvailability('local'));

  check(d.configured === true, 'un runtime sin credencial está configurado de partida');
  check(d.reachable === true, 'su sonda propia confirma que responde');
  check(d.authenticated === null, 'no se autentica nada: null, no false');
  check(d.modelsAvailable === 2, 'anuncia su catálogo');
  check(d.ready === true, 'está listo sin ninguna credencial');
  check(d.uiState === UI_STATE.CONNECTED, 'con evidencia de red sí se dice «conectado»');
}
{
  const m = gestor();
  const d = await conAdaptador('llamacpp', {
    status: async () => ({ ok: true }),
    listModels: async () => MODELOS
  }, () => m.getAvailability('llamacpp'));
  check(d.ready === true && d.authenticated === null && d.uiState === UI_STATE.CONNECTED,
    'el segundo runtime local se comporta igual, sin caso especial');
}

console.log('\n=== 4. Servidor inaccesible ===');
{
  const m = gestor();
  let consultado = false;
  const d = await conAdaptador('local', {
    status: async () => ({ ok: false, error: errorDeRed('ECONNREFUSED') }),
    listModels: async () => { consultado = true; return MODELOS; }
  }, () => m.getAvailability('local'));

  check(d.configured === true, 'seguir configurado no implica estar accesible');
  check(d.reachable === false, 'la sonda detecta que el servidor no responde');
  check(d.ready === false, 'un servidor caído no deja el proveedor listo');
  check(d.uiState === UI_STATE.OFFLINE, `estado ${d.uiState}`);
  check(d.errorCode === 'PROVIDER_TRANSPORT_UNREACHABLE', `errorCode ${d.errorCode}`);
  check(consultado === false, 'con el servidor caído no se insiste pidiendo el catálogo');
}

console.log('\n=== 5. Catálogo vacío ===');
{
  const m = gestor();
  const d = await conAdaptador('local', {
    status: async () => ({ ok: true }),
    listModels: async () => ({ models: [] })
  }, () => m.getAvailability('local'));

  check(d.configured === true && d.reachable === true, 'servidor accesible y configurado');
  check(d.modelsAvailable === 0, 'no hay modelos que ofrecer');
  check(d.ready === false, 'sin catálogo no se puede trabajar, aunque todo lo demás esté bien');
  check(d.errorCode === 'PROVIDER_CATALOG_EMPTY', `errorCode ${d.errorCode}`);
  check(d.uiState === UI_STATE.CONNECTED,
    'un catálogo vacío no contradice la conexión: son ejes distintos');
}
{
  // Un adaptador de red SIN sonda propia que devuelve la lista vacía: varios
  // capturan el fallo de red y devuelven `{ models: [] }`, así que un resultado
  // vacío es indistinguible de «el servidor no tiene modelos». No prueba
  // conectividad y no puede afirmarla.
  const m = gestor();
  m.apiKeys.openai = 'clave';
  check(PROVIDERS.openai.catalogSource === 'network' && typeof PROVIDERS.openai.status !== 'function',
    'openai es de red y no trae sonda propia: su catálogo es la única señal');
  const d = await conAdaptador('openai', {
    listModels: async () => ({ models: [] })
  }, () => m.getAvailability('openai'));
  check(d.reachable === null,
    'un catálogo vacío de un adaptador de red NO prueba que el servidor responda');
  check(d.authenticated === null,
    'ni que la credencial haya sido aceptada');
  check(d.uiState === UI_STATE.UNKNOWN, `se presenta como sin verificar (${d.uiState})`);
  check(d.ready === false, 'y sin modelos no está listo');
}

console.log('\n=== 6. Catálogo disponible por red ===');
{
  const m = gestor();
  m.apiKeys.openai = 'clave-valida';
  const d = await conAdaptador('openai', {
    listModels: async () => MODELOS
  }, () => m.getAvailability('openai'));

  check(d.configured === true, 'configurado');
  check(d.reachable === true, 'un catálogo obtenido por red sí prueba conectividad');
  check(d.authenticated === true, 'y prueba que la credencial fue aceptada');
  check(d.modelsAvailable === 2 && d.ready === true, 'listo con dos modelos');
  check(d.uiState === UI_STATE.CONNECTED, 'estado conectado');
  check(Array.isArray(d.models) && d.models.length === 2,
    'el catálogo viaja con la disponibilidad y no hay que volver a pedirlo');
}

console.log('\n=== 7. Un catálogo estático no prueba nada (adaptadores reales) ===');
{
  // Alibaba sirve su catálogo desde la configuración: se devolvería idéntico
  // con el servidor apagado y con la clave caducada.
  check(PROVIDERS.alibaba.catalogSource === 'static',
    'el adaptador de Alibaba declara que su catálogo es estático');
  const m = gestor();
  m.apiKeys.alibaba = 'clave';
  const d = await m.getAvailability('alibaba');

  check(d.modelsAvailable > 0, `devuelve catálogo (${d.modelsAvailable} modelos)`);
  check(d.reachable === null, 'y NO afirma que el servidor sea alcanzable');
  check(d.authenticated === null, 'ni que la credencial haya sido aceptada');
  check(d.uiState === UI_STATE.UNKNOWN, `se presenta como sin verificar (${d.uiState})`);
  check(d.ready === true,
    'pero sigue siendo utilizable: «listo» y «conectado» son ejes distintos');
}
for (const id of ['anthropic', 'moonshot', 'groq']) {
  check(PROVIDERS[id].catalogSource === 'static',
    `${id} declara catálogo estático: su lista no depende de la red`);
  const m = gestor();
  m.apiKeys[id] = 'clave';
  const d = await m.getAvailability(id);
  check(d.reachable === null && d.authenticated === null,
    `${id} con catálogo estático no inventa evidencia de red ni de credencial`);
}

console.log('\n=== 8. reachable === null nunca se presenta como conectado ===');
{
  for (const reachable of [null, undefined]) {
    const estado = resolverUiState({ configured: true, reachable, authenticated: null });
    check(estado === UI_STATE.UNKNOWN,
      `sin evidencia de conectividad (${String(reachable)}) el estado es «${estado}», no «connected»`);
  }
  check(resolverUiState({ configured: true, reachable: true, authenticated: null }) === UI_STATE.CONNECTED,
    'sólo con evidencia positiva se dice «connected»');
  check(resolverUiState({ configured: false, reachable: true, authenticated: null }) === UI_STATE.CONFIGURATION_REQUIRED,
    'lo que el usuario debe resolver primero manda sobre la conectividad');
  check(resolverUiState({ configured: true, reachable: true, authenticated: false }) === UI_STATE.AUTHENTICATION_REJECTED,
    'una credencial rechazada no se presenta como conectado');
  check(Object.values(UI_STATE).length === 5,
    `hay cinco estados de interfaz declarados (${Object.values(UI_STATE).join(', ')})`);
}

console.log('\n=== 9. Taxonomía de fallos: sólo campos estructurados ===');
{
  const casos = [
    [errorDeRespuesta(401), KINDS.AUTH, true, false, 'PROVIDER_AUTH_REJECTED'],
    [errorDeRespuesta(403), KINDS.AUTH, true, false, 'PROVIDER_AUTH_REJECTED'],
    [errorDeRespuesta(404), KINDS.HTTP, true, null, 'PROVIDER_HTTP_404'],
    [errorDeRespuesta(429), KINDS.RATE_LIMIT, true, null, 'PROVIDER_RATE_LIMITED'],
    [errorDeRespuesta(500), KINDS.HTTP, true, null, 'PROVIDER_HTTP_500'],
    [errorDeRed('ECONNREFUSED'), KINDS.TRANSPORT, false, null, 'PROVIDER_TRANSPORT_UNREACHABLE'],
    [errorDeRed('ENOTFOUND'), KINDS.TRANSPORT, false, null, 'PROVIDER_TRANSPORT_UNREACHABLE'],
    [errorDeRed('ETIMEDOUT'), KINDS.TIMEOUT, null, null, 'PROVIDER_TIMEOUT'],
    [Object.assign(new Error('x'), { name: 'AbortError' }), KINDS.ABORTED, null, null, 'PROVIDER_ABORTED']
  ];
  for (const [error, kind, reachable, authenticated, errorCode] of casos) {
    const d = describirError(error);
    check(d.kind === kind && d.errorCode === errorCode,
      `${errorCode}: clasificado como ${kind}`);
    check(d.reachable === reachable && d.authenticated === authenticated,
      `${errorCode}: evidencia reachable=${String(reachable)} authenticated=${String(authenticated)}`);
  }

  check(describirError(errorDeRespuesta(404)).reachable === true
     && describirError(errorDeRed('ECONNREFUSED')).reachable === false,
    'un 404 prueba que el servidor está vivo; un ECONNREFUSED prueba lo contrario');
  check(describirError(errorDeRed('ETIMEDOUT')).reachable === null,
    'un timeout no prueba que esté caído: puede estar lento, y eso es null');

  // El texto no puede alterar la clasificación: es el fallo que se corrige.
  const enganoso = new Error('no se pudo resolver https://api.example/v1/api-key/401');
  check(describirError(enganoso).kind === KINDS.UNKNOWN,
    'un mensaje que menciona 401 y api-key NO se clasifica como credencial rechazada');
  const traducido = new ProviderError(KINDS.AUTH, { status: 401, message: 'Schlüssel abgelehnt' });
  check(describirError(traducido).authenticated === false,
    'un error ya clasificado se respeta aunque su mensaje esté en otro idioma');
}

console.log('\n=== 10. errorCode estable y mensaje saneado ===');
{
  check(sanearMensaje('fallo en https://usuario:secreto@api.example/v1/models') === 'fallo en [endpoint]',
    'una URL con credenciales incrustadas no llega al renderer');
  check(!/secreto/.test(sanearMensaje('https://u:secreto@h/x')), 'la contraseña desaparece');
  check(sanearMensaje('Authorization: Bearer abc123xyz').includes('[oculto]'),
    'una cabecera de autorización se oculta');
  check(!/abc123xyz/.test(sanearMensaje('Authorization: Bearer abc123xyz')),
    'el token no sobrevive al saneado');
  check(!/sk-vivalavida0000/.test(sanearMensaje('clave sk-vivalavida0000 rechazada')),
    'una clave con prefijo sk- se oculta');
  check(sanearMensaje('x'.repeat(400)).length <= 160, 'el mensaje se acota');
  check(sanearMensaje(null) === '' && sanearMensaje(undefined) === '',
    'un mensaje ausente no produce "null" ni "undefined"');

  const m = gestor();
  m.apiKeys.openai = 'clave';
  const d = await conAdaptador('openai', {
    listModels: async () => { throw new Error('falló https://u:secreto@api.example/v1/models'); }
  }, () => m.getAvailability('openai'));
  check(!/secreto/.test(JSON.stringify(d)), 'ningún secreto viaja en la respuesta de disponibilidad');
  check(!/api\.example/.test(JSON.stringify(d)), 'ninguna URL del proveedor viaja al renderer');
  check(typeof d.errorCode === 'string' && d.errorCode.startsWith('PROVIDER_'),
    `el contrato es el código, no el texto (${d.errorCode})`);
}

console.log('\n=== 11. configured puede venir de validateConfig() ===');
{
  check(typeof PROVIDERS.alibaba.validateConfig === 'function',
    'el adaptador con configuración editable declara validateConfig()');

  const m = gestor();
  m.apiKeys.alibaba = 'clave';
  // Configuración sin catálogo: hay credencial, pero no es utilizable.
  const d = await conAdaptador('alibaba', {
    validateConfig: () => ({ ok: false, errorCode: 'PROVIDER_ENDPOINT_REQUIRED' })
  }, () => m.getAvailability('alibaba'));
  check(d.configured === false,
    'con credencial presente, validateConfig() puede seguir declarando que falta configuración');
  check(d.errorCode === 'PROVIDER_ENDPOINT_REQUIRED', `su código llega intacto (${d.errorCode})`);
  check(d.uiState === UI_STATE.CONFIGURATION_REQUIRED, 'y el estado lo refleja');

  const roto = await conAdaptador('alibaba', {
    validateConfig: () => { throw new Error('configuración ilegible'); }
  }, () => m.getAvailability('alibaba'));
  check(roto.configured === false && roto.errorCode === 'PROVIDER_CONFIG_INVALID',
    'un validateConfig() que lanza no rompe la disponibilidad');

  const sinValidador = await conAdaptador('openai', {
    listModels: async () => MODELOS
  }, () => gestor().getAvailability('openai'));
  check(sinValidador.configured === false,
    'sin validateConfig() se cae al criterio mínimo: la credencial declarada');
}

console.log('\n=== 12. Sin casos especiales por identificador ===');
{
  const m = gestor();
  const CLAVES = ['providerId', 'configured', 'reachable', 'authenticated',
    'modelsAvailable', 'models', 'ready', 'uiState', 'errorCode', 'message'];
  for (const id of Object.keys(PROVIDERS)) {
    const d = await conAdaptador(id, {
      status: PROVIDERS[id].status ? async () => ({ ok: true }) : undefined,
      listModels: async () => MODELOS
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
      `getAvailability() no puede nombrar al proveedor ${id}: sería un caso especial`);
  }
  check(true, 'getAvailability() no nombra a ningún proveedor: todo sale de rasgos declarados');
  assert(!/\.test\(mensaje\)|\.test\(String\(error/.test(cuerpo),
    'getAvailability() no puede clasificar fallos por el texto del mensaje');
  check(true, 'getAvailability() no aplica ninguna expresión regular al texto de los errores');

  const d = await m.getAvailability('proveedor-que-no-existe');
  check(d.ready === false && d.errorCode === 'PROVIDER_UNKNOWN',
    'un proveedor desconocido no está listo y lo dice con código estable');
}

console.log('\n=== 13. Textos ES/EN de los cinco estados ===');
{
  const i18n = fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8');
  const bloques = i18n.split(/^  (?:es|en): \{$/m);
  check(bloques.length >= 3, 'el diccionario declara los dos idiomas');
  const [, es, en] = bloques;

  for (const estado of Object.values(UI_STATE)) {
    for (const prefijo of ['provider.state', 'provider.selectEmpty']) {
      const clave = `'${prefijo}.${estado}'`;
      check(es.includes(clave), `ES define ${prefijo}.${estado}`);
      check(en.includes(clave), `EN define ${prefijo}.${estado}`);
    }
  }

  const valor = (bloque, clave) => {
    const m = bloque.match(new RegExp(`'${clave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'([^']*)'`));
    return m ? m[1] : null;
  };
  for (const estado of Object.values(UI_STATE)) {
    const a = valor(es, `provider.selectEmpty.${estado}`);
    const b = valor(en, `provider.selectEmpty.${estado}`);
    check(a && b && a !== b,
      `provider.selectEmpty.${estado} está traducido de verdad ("${a}" / "${b}")`);
  }

  // El renderer no puede volver a escribir estos textos a mano.
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const loadRuntime = app.slice(app.indexOf('async function loadRuntime()'), app.indexOf('// --- AI provider helpers ---'));
  // Se miran las líneas de CÓDIGO: los comentarios pueden —y deben— seguir
  // citando los textos antiguos para explicar por qué desaparecieron.
  const codigo = loadRuntime
    .split('\n')
    .filter(linea => !/^\s*(\/\/|\*|\/\*)/.test(linea))
    .join('\n');
  for (const literal of ['Proveedor no disponible', 'Sin modelos (descarga uno o configura Cloud)',
    'Falta la API Key de este proveedor', 'API Key rechazada por el proveedor']) {
    assert(!codigo.includes(literal),
      `loadRuntime() ya no puede llevar el literal "${literal}": va por i18n`);
  }
  check(true, 'loadRuntime() no conserva ningún texto de estado escrito a mano');
  check(/provider\.state\.\$\{uiState\}|provider\.state\.`/.test(loadRuntime)
     || loadRuntime.includes('provider.state.'),
    'loadRuntime() toma el rótulo del estado desde i18n');
}

console.log('\n=== 14. Compatibilidad: la semántica vigente no cambia ===');
{
  check(PROVIDERS.alibaba.requiresKey === true, 'Alibaba sigue declarando que requiere clave');
  const sinClave = await gestor().getAvailability('alibaba');
  check(sinClave.configured === false && sinClave.ready === false,
    'Alibaba sin clave sigue sin estar listo, igual que antes');

  const m = gestor();
  m.apiKeys.alibaba = 'clave';
  const conClave = await m.getAvailability('alibaba');
  check(conClave.ready === true && conClave.modelsAvailable > 0,
    `Alibaba con clave sigue ofreciendo sus preajustes (${conClave.modelsAvailable})`);

  const st = await m.status();
  check(typeof st.ok === 'boolean', 'status() sigue existiendo y conserva su forma');
}

console.log(`\nProvider availability tests passed (${comprobaciones} comprobaciones)`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
