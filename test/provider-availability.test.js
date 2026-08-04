'use strict';

// Modelo de disponibilidad de proveedores.
//
// La regresión que estas pruebas impiden: `status()` respondía `ok: !!apiKey`
// para todo proveedor cloud, y el renderer poblaba el selector de modelos con
// ese único booleano. Cuatro preguntas distintas viajaban colapsadas en una:
//
//   ¿está configurado?  ¿responde su servidor?  ¿aceptó la credencial?
//   ¿tiene catálogo?
//
// Consecuencias reales: un proveedor con clave inválida se anunciaba como
// disponible y el selector aparecía vacío sin explicar por qué; la píldora de
// estado decía «Conectado» mientras el selector decía «Proveedor no
// disponible»; y un runtime que no pide credencial no podía estar disponible
// nunca, porque `ok` dependía de una clave que no existe.
//
// `getAvailability()` los separa y los deriva de rasgos DECLARADOS por cada
// adaptador —`requiresKey` y la presencia de `status()`—, nunca de su
// identificador. Aquí se comprueba que ningún proveedor recibe trato especial.
//
//   npm run test:provider-availability

const assert = require('assert');
const { AIProviderManager, PROVIDERS } = require('../src/main/ai-providers');

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
    },
    _almacen: almacen
  };
}

// Sustituye métodos de un adaptador real y los restaura al terminar. El
// adaptador es la frontera de transporte: por debajo hay red, por encima está
// la lógica que se quiere probar.
async function conAdaptador(providerId, parches, fn) {
  const config = PROVIDERS[providerId];
  const originales = {};
  for (const [clave, valor] of Object.entries(parches)) {
    originales[clave] = Object.prototype.hasOwnProperty.call(config, clave) ? config[clave] : undefined;
    config[clave] = valor;
  }
  try {
    return await fn();
  } finally {
    for (const [clave, valor] of Object.entries(originales)) {
      if (valor === undefined) delete config[clave];
      else config[clave] = valor;
    }
  }
}

const gestor = (filas) => new AIProviderManager(baseFalsa(filas));
const MODELOS = { models: [{ name: 'modelo-uno' }, { name: 'modelo-dos' }] };

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
  check(d.authenticated === null, 'sin clave la autenticación no se ha intentado (null, no false)');
  check(d.modelsAvailable === 0, 'sin clave no se anuncia ningún modelo');
  check(d.detail === 'CREDENCIAL_REQUERIDA', `el motivo es explícito (${d.detail})`);
  check(consultado === false, 'sin clave no se llega a consultar el catálogo: ninguna petición inútil');
}

console.log('\n=== 2. Proveedor cloud con credencial inválida ===');
{
  const m = gestor();
  m.apiKeys.openai = 'clave-de-prueba-invalida';
  const d = await conAdaptador('openai', {
    listModels: async () => { throw new Error('API Key inválida'); }
  }, () => m.getAvailability('openai'));

  check(d.configured === true, 'con clave presente el proveedor está configurado');
  check(d.reachable === true, 'un rechazo de credencial demuestra que el servidor responde');
  check(d.authenticated === false, 'la credencial fue rechazada');
  check(d.ready === false, 'una clave rechazada no deja el proveedor listo');
  check(d.detail === 'CREDENCIAL_RECHAZADA', `el motivo distingue clave inválida de servidor caído (${d.detail})`);
}

// Un 401 debe leerse igual aunque el adaptador redacte el mensaje de otra forma.
{
  const m = gestor();
  m.apiKeys.groq = 'otra-clave';
  for (const mensaje of ['401 Unauthorized', 'Request failed with status 403', 'invalid_api_key']) {
    const d = await conAdaptador('groq', {
      listModels: async () => { throw new Error(mensaje); }
    }, () => m.getAvailability('groq'));
    check(d.authenticated === false && d.reachable === true,
      `"${mensaje}" se clasifica como credencial rechazada, no como caída`);
  }
}

console.log('\n=== 3. Runtime local sin credencial ===');
{
  const m = gestor();
  // `local` no declara `requiresKey`: la disponibilidad no puede depender de
  // una clave que ese proveedor no usa. Es el caso que el modelo anterior
  // hacía imposible.
  check(PROVIDERS.local.requiresKey === false, 'el adaptador local declara que no requiere clave');

  const d = await conAdaptador('local', {
    status: async () => ({ ok: true }),
    listModels: async () => MODELOS
  }, () => m.getAvailability('local'));

  check(d.configured === true, 'un runtime sin credencial está configurado de partida');
  check(d.reachable === true, 'su sonda propia confirma que responde');
  check(d.authenticated === null, 'no se autentica nada: el estado es null, no false');
  check(d.modelsAvailable === 2, 'anuncia su catálogo');
  check(d.ready === true, 'está listo sin ninguna credencial');
}

// El mismo contrato para el otro runtime local, sin nombrarlo aparte.
{
  const m = gestor();
  const d = await conAdaptador('llamacpp', {
    status: async () => ({ ok: true }),
    listModels: async () => MODELOS
  }, () => m.getAvailability('llamacpp'));
  check(d.ready === true && d.authenticated === null,
    'el segundo runtime local se comporta igual sin caso especial');
}

console.log('\n=== 4. Servidor inaccesible ===');
{
  const m = gestor();
  let consultado = false;
  const d = await conAdaptador('local', {
    status: async () => ({ ok: false, error: 'ECONNREFUSED 127.0.0.1:11434' }),
    listModels: async () => { consultado = true; return MODELOS; }
  }, () => m.getAvailability('local'));

  check(d.configured === true, 'seguir configurado no implica estar accesible');
  check(d.reachable === false, 'la sonda detecta que el servidor no responde');
  check(d.ready === false, 'un servidor caído no deja el proveedor listo');
  check(/ECONNREFUSED/.test(d.detail || ''), `el motivo conserva el error real (${d.detail})`);
  check(consultado === false, 'con el servidor caído no se insiste pidiendo el catálogo');
}

// Un proveedor sin sonda propia sólo descubre la caída al pedir el catálogo.
{
  const m = gestor();
  m.apiKeys.moonshot = 'clave';
  const d = await conAdaptador('moonshot', {
    listModels: async () => { throw new Error('fetch failed: ENOTFOUND api.example'); }
  }, () => m.getAvailability('moonshot'));
  check(d.reachable === false && d.authenticated === null,
    'un fallo de red no se confunde con una credencial rechazada');
  check(d.ready === false, 'sin alcanzar el servidor no está listo');
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
  check(d.detail === 'CATALOGO_VACIO', `el motivo separa "vacío" de "caído" (${d.detail})`);
}

console.log('\n=== 6. Catálogo disponible ===');
{
  const m = gestor();
  m.apiKeys.openai = 'clave-valida';
  const d = await conAdaptador('openai', {
    listModels: async () => MODELOS
  }, () => m.getAvailability('openai'));

  check(d.configured === true, 'configurado');
  check(d.reachable === true, 'accesible');
  check(d.authenticated === true, 'credencial aceptada');
  check(d.modelsAvailable === 2, 'catálogo con dos modelos');
  check(d.ready === true, 'listo');
  check(Array.isArray(d.models) && d.models.length === 2,
    'el catálogo viaja con la disponibilidad y no hay que volver a pedirlo');
}

console.log('\n=== Forma del contrato y ausencia de casos especiales ===');
{
  const m = gestor();
  const CLAVES = ['providerId', 'configured', 'reachable', 'authenticated', 'modelsAvailable', 'models', 'ready', 'detail'];
  for (const id of Object.keys(PROVIDERS)) {
    const d = await conAdaptador(id, {
      status: PROVIDERS[id].status ? async () => ({ ok: true }) : undefined,
      listModels: async () => MODELOS
    }, () => m.getAvailability(id));
    for (const clave of CLAVES) {
      assert(Object.prototype.hasOwnProperty.call(d, clave), `${id}: falta ${clave}`);
    }
    check(typeof d.configured === 'boolean' && typeof d.ready === 'boolean',
      `${id}: declara los estados completos con el mismo contrato`);
  }

  const fuente = require('fs').readFileSync(require('path').join(__dirname, '../src/main/ai-providers.js'), 'utf8');
  const cuerpo = fuente.slice(fuente.indexOf('async getAvailability('), fuente.indexOf('getAllProviders()'));
  for (const id of Object.keys(PROVIDERS)) {
    assert(!new RegExp(`['"\`]${id}['"\`]`).test(cuerpo),
      `getAvailability() no puede nombrar al proveedor ${id}: sería un caso especial`);
  }
  check(true, 'getAvailability() no nombra a ningún proveedor: todo sale de rasgos declarados');

  const d = await m.getAvailability('proveedor-que-no-existe');
  check(d.ready === false && d.detail === 'PROVEEDOR_DESCONOCIDO',
    'un proveedor desconocido no está listo y lo dice');
}

console.log('\n=== Compatibilidad: la semántica vigente no cambia ===');
{
  // Alibaba sirve su catálogo configurado sin consultar la red, pero declara
  // `requiresKey`. Hoy sin clave no se puede usar, y eso se conserva: cambiarlo
  // exigiría una prueba que demostrase una regresión, y no la hay.
  check(PROVIDERS.alibaba.requiresKey === true, 'Alibaba sigue declarando que requiere clave');
  const sinClave = await gestor().getAvailability('alibaba');
  check(sinClave.configured === false && sinClave.ready === false,
    'Alibaba sin clave sigue sin estar listo, igual que antes de este cambio');

  const m = gestor();
  m.apiKeys.alibaba = 'clave';
  const conClave = await m.getAvailability('alibaba');
  check(conClave.ready === true && conClave.modelsAvailable > 0,
    `Alibaba con clave sigue ofreciendo su catálogo de preajustes (${conClave.modelsAvailable})`);

  // `status()` se conserva intacto: hay llamadas que siguen dependiendo de él.
  const st = await m.status();
  check(typeof st.ok === 'boolean', 'status() sigue existiendo y conserva su forma');
}

console.log(`\nProvider availability tests passed (${comprobaciones} comprobaciones)`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
