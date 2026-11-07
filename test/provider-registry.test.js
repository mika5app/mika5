'use strict';

// Registro interno de adaptadores de proveedor.
//
// Lo que estas pruebas protegen es que el registro falle CERRADO y que falle
// PRONTO. La regresión concreta que hay detrás ya ocurrió: un `ai_provider`
// persistido que no existía en el registro hacía que `getProvider()` leyese
// `undefined.privacy` y la rehidratación se cayera entera. Un adaptador mal
// formado tiene que rechazarse al registrarlo, cuando aún se sabe quién lo
// registró, y no tres capas más abajo.
//
// Protegen además la frontera: el registro no carga nada de disco, no descubre
// plugins y no acepta rutas. Si alguien añadiera esa capacidad, dejaría de ser
// una frontera técnica para convertirse en un vector de ejecución de código.
//
//   npm run test:provider-registry

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PROVIDER_API_VERSION, METODOS_OBLIGATORIOS, METODOS_OPCIONALES,
  ProviderRegistry, ProviderRegistryError, validarAdaptador
} = require('../src/main/provider-registry');
const { PROVIDERS, registroDeProveedores } = require('../src/main/ai-providers');

let comprobaciones = 0;
function check(condicion, mensaje) {
  assert(condicion, mensaje);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje}`);
}

/** Descriptor mínimo válido, para mutarlo en cada caso. */
const valido = (extra = {}) => ({
  apiVersion: PROVIDER_API_VERSION,
  id: 'demo',
  displayName: 'Proveedor de demostración',
  traits: { requiresKey: false, privacy: 'private' },
  adapter: { chat: async () => ({}), listModels: async () => ({ models: [] }) },
  ...extra
});

/** Comprueba que registrar lanza con el código esperado. */
function rechaza(descriptor, codigo, mensaje) {
  const r = new ProviderRegistry();
  let capturado = null;
  try {
    r.register(descriptor);
  } catch (error) {
    capturado = error;
  }
  assert(capturado, `debía rechazarse: ${mensaje}`);
  assert(capturado instanceof ProviderRegistryError,
    `el rechazo debe ser un ProviderRegistryError, fue ${capturado.name}`);
  assert.strictEqual(capturado.code, codigo,
    `${mensaje}: código ${capturado.code}, se esperaba ${codigo}`);
  assert.strictEqual(r.size, 0, `${mensaje}: nada puede quedar registrado tras el rechazo`);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje} (${codigo})`);
}

console.log('\n=== 1. Registro válido ===');
{
  const r = new ProviderRegistry();
  r.register(valido());
  check(r.size === 1, 'un adaptador válido queda registrado');
  check(r.has('demo') === true, 'has() lo encuentra');
  check(r.has('otro') === false, 'has() no inventa proveedores que no existen');
  check(r.get('demo').displayName === 'Proveedor de demostración', 'get() devuelve el descriptor');
  check(typeof r.getAdapter('demo').chat === 'function', 'getAdapter() devuelve la implementación');
  check(r.get('inexistente') === undefined, 'get() de algo ausente devuelve undefined, no lanza');
  check(r.getAdapter('inexistente') === undefined, 'getAdapter() de algo ausente tampoco lanza');
  check(JSON.stringify(r.ids()) === JSON.stringify(['demo']), 'ids() devuelve el orden de registro');

  const encadenado = new ProviderRegistry().register(valido()).register(valido({ id: 'demo2' }));
  check(encadenado.size === 2, 'register() encadena');
  check(JSON.stringify(encadenado.ids()) === JSON.stringify(['demo', 'demo2']),
    'y conserva el orden en que se registraron');
}

console.log('\n=== 2. Duplicados ===');
{
  const r = new ProviderRegistry();
  r.register(valido());
  let capturado = null;
  try { r.register(valido()); } catch (e) { capturado = e; }
  assert(capturado && capturado.code === 'ADAPTER_DUPLICATE', 'un id repetido debe rechazarse');
  check(r.size === 1, 'un registro duplicado se rechaza y no sustituye al primero');

  // Un segundo intento con OTRA implementación tampoco puede colarse: si
  // sobrescribiera, un módulo cargado dos veces cambiaría el comportamiento.
  let segundo = null;
  try { r.register(valido({ displayName: 'Impostor' })); } catch (e) { segundo = e; }
  check(segundo && segundo.code === 'ADAPTER_DUPLICATE',
    'ni siquiera con distinto contenido: el id ya está tomado');
  check(r.get('demo').displayName === 'Proveedor de demostración',
    'el descriptor original permanece intacto');
}

console.log('\n=== 3. Versión de API ===');
{
  check(PROVIDER_API_VERSION === 1, `la versión del contrato es ${PROVIDER_API_VERSION}`);
  rechaza(valido({ apiVersion: undefined }), 'ADAPTER_API_VERSION_MISSING', 'sin apiVersion');
  rechaza(valido({ apiVersion: null }), 'ADAPTER_API_VERSION_MISSING', 'apiVersion nula');
  rechaza(valido({ apiVersion: 0 }), 'ADAPTER_API_VERSION_UNSUPPORTED', 'apiVersion cero');
  rechaza(valido({ apiVersion: 2 }), 'ADAPTER_API_VERSION_UNSUPPORTED', 'apiVersion futura');
  rechaza(valido({ apiVersion: '1' }), 'ADAPTER_API_VERSION_UNSUPPORTED', 'apiVersion como texto');
}

console.log('\n=== 4. Identificador ===');
{
  rechaza(valido({ id: undefined }), 'ADAPTER_ID_INVALID', 'sin id');
  rechaza(valido({ id: '' }), 'ADAPTER_ID_INVALID', 'id vacío');
  rechaza(valido({ id: '   ' }), 'ADAPTER_ID_INVALID', 'id de sólo espacios');
  rechaza(valido({ id: ' demo' }), 'ADAPTER_ID_INVALID', 'id con espacio delante');
  rechaza(valido({ id: 'Demo' }), 'ADAPTER_ID_INVALID', 'id con mayúsculas');
  rechaza(valido({ id: '1demo' }), 'ADAPTER_ID_INVALID', 'id que empieza por dígito');
  rechaza(valido({ id: 'demo/../otro' }), 'ADAPTER_ID_INVALID', 'id con separadores de ruta');
  rechaza(valido({ id: 42 }), 'ADAPTER_ID_INVALID', 'id que no es texto');

  // `Map` y no objeto literal: un id que coincida con una propiedad heredada
  // no puede confundir a `has()`.
  const r = new ProviderRegistry();
  check(r.has('toString') === false && r.has('constructor') === false && r.has('__proto__') === false,
    'has() no confunde propiedades heredadas con proveedores registrados');
}

console.log('\n=== 5. traits ===');
{
  rechaza(valido({ traits: undefined }), 'ADAPTER_TRAITS_INVALID', 'sin traits');
  rechaza(valido({ traits: null }), 'ADAPTER_TRAITS_INVALID', 'traits nulos');
  rechaza(valido({ traits: [] }), 'ADAPTER_TRAITS_INVALID', 'traits como array');
  rechaza(valido({ traits: { privacy: 'private' } }), 'ADAPTER_TRAITS_INVALID', 'sin requiresKey');
  rechaza(valido({ traits: { requiresKey: 'sí', privacy: 'private' } }),
    'ADAPTER_TRAITS_INVALID', 'requiresKey que no es booleano');
  rechaza(valido({ traits: { requiresKey: false } }), 'ADAPTER_TRAITS_INVALID', 'sin privacy');
  rechaza(valido({ traits: { requiresKey: false, privacy: 'publica' } }),
    'ADAPTER_TRAITS_INVALID', 'privacy fuera del conjunto permitido');
  rechaza(valido({ traits: { requiresKey: false, privacy: 'private', visualCapabilities: 'sí' } }),
    'ADAPTER_TRAITS_INVALID', 'visualCapabilities que no es objeto');

  const r = new ProviderRegistry();
  r.register(valido({ traits: { requiresKey: true, privacy: 'cloud' } }));
  const traits = r.get('demo').traits;
  let mutado = false;
  try { traits.requiresKey = false; mutado = traits.requiresKey === false; } catch (_) {}
  check(!mutado, 'los traits registrados están congelados: no se pueden alterar desde fuera');
}

console.log('\n=== 6. Métodos obligatorios y opcionales ===');
{
  check(JSON.stringify(METODOS_OBLIGATORIOS) === JSON.stringify(['chat', 'listModels']),
    `los obligatorios son chat y listModels (${METODOS_OBLIGATORIOS.join(', ')})`);
  check(METODOS_OPCIONALES.includes('status'),
    'status() es opcional: su ausencia significa «no comprobado», no «caído»');

  rechaza(valido({ adapter: undefined }), 'ADAPTER_INVALID', 'sin implementación');
  rechaza(valido({ adapter: null }), 'ADAPTER_INVALID', 'implementación nula');
  rechaza(valido({ adapter: [] }), 'ADAPTER_INVALID', 'implementación como array');
  rechaza(valido({ adapter: { listModels: async () => ({}) } }),
    'ADAPTER_METHOD_MISSING', 'sin chat()');
  rechaza(valido({ adapter: { chat: async () => ({}) } }),
    'ADAPTER_METHOD_MISSING', 'sin listModels()');
  rechaza(valido({ adapter: { chat: 'no soy función', listModels: async () => ({}) } }),
    'ADAPTER_METHOD_MISSING', 'chat que no es función');

  for (const opcional of METODOS_OPCIONALES) {
    rechaza(valido({ adapter: { chat: async () => ({}), listModels: async () => ({}), [opcional]: 42 } }),
      'ADAPTER_METHOD_INVALID', `${opcional} declarado y no es función`);
  }
}

console.log('\n=== 7. status() es opcional de verdad ===');
{
  const r = new ProviderRegistry();
  r.register(valido());
  check(r.getAdapter('demo').status === undefined,
    'un adaptador sin status() se registra sin problema');
  check(r.size === 1, 'y queda utilizable');

  // No se fabrica una sonda para cumplir la interfaz: eso afirmaría una
  // conectividad que nadie comprobó.
  const fuente = fs.readFileSync(path.join(__dirname, '../src/main/provider-registry.js'), 'utf8');
  assert(!/status\s*[:=]\s*(?:async\s*)?\(\s*\)\s*=>/.test(fuente),
    'el registro no puede fabricar una sonda por defecto');
  check(true, 'el registro no inventa un status() para los adaptadores que no lo traen');
}

console.log('\n=== 8. list() no permite mutar el registro ===');
{
  const r = new ProviderRegistry();
  r.register(valido()).register(valido({ id: 'demo2' }));

  const lista = r.list();
  lista.push({ id: 'intruso' });
  lista.length = 0;
  check(r.size === 2 && !r.has('intruso'),
    'vaciar o ampliar el array devuelto no toca el registro');

  const otra = r.list();
  check(otra.length === 2, 'la siguiente llamada devuelve el contenido real');
  check(otra !== lista, 'cada llamada devuelve una copia nueva');

  const ids = r.ids();
  ids.push('intruso');
  check(r.ids().length === 2, 'ids() también devuelve una copia');

  let mutado = false;
  try { otra[0].id = 'otro'; mutado = otra[0].id === 'otro'; } catch (_) {}
  check(!mutado, 'los descriptores devueltos están congelados');
}

console.log('\n=== 9. Sin carga externa ===');
{
  // La frontera es técnica y tiene que seguir siéndolo: cargar módulos desde
  // una ruta suministrada, escanear directorios o evaluar texto convertiría el
  // registro en un vector de ejecución de código arbitrario.
  const fuente = fs.readFileSync(path.join(__dirname, '../src/main/provider-registry.js'), 'utf8');
  const prohibido = [
    [/\brequire\s*\(/, 'require()'],
    [/\bimport\s*\(/, 'import() dinámico'],
    [/\beval\s*\(/, 'eval()'],
    [/new\s+Function\s*\(/, 'new Function()'],
    [/readdirSync|readdir\b/, 'lectura de directorios'],
    [/readFileSync|createRequire/, 'lectura de ficheros']
  ];
  for (const [patron, nombre] of prohibido) {
    assert(!patron.test(fuente), `el registro no puede usar ${nombre}`);
  }
  check(true, 'el registro no carga módulos, no lee disco y no evalúa texto');
}

console.log('\n=== 10. Los siete incorporados están registrados ===');
{
  const IDS = ['local', 'openai', 'anthropic', 'groq', 'moonshot', 'alibaba', 'llamacpp'];
  check(JSON.stringify(registroDeProveedores.ids()) === JSON.stringify(IDS),
    `el registro real trae los siete en orden (${registroDeProveedores.ids().join(', ')})`);
  check(registroDeProveedores.size === 7, 'y ninguno más');

  for (const id of IDS) {
    const entrada = registroDeProveedores.get(id);
    check(entrada.apiVersion === PROVIDER_API_VERSION,
      `${id} declara la versión del contrato`);
    check(typeof entrada.displayName === 'string' && entrada.displayName.length > 0,
      `${id} declara displayName ("${entrada.displayName}")`);
    check(typeof entrada.traits.requiresKey === 'boolean'
      && ['private', 'cloud'].includes(entrada.traits.privacy),
      `${id} declara traits válidos (requiresKey=${entrada.traits.requiresKey}, privacy=${entrada.traits.privacy})`);
  }

  // `PROVIDERS` es una vista del registro, no una segunda fuente de verdad.
  check(JSON.stringify(Object.keys(PROVIDERS)) === JSON.stringify(registroDeProveedores.ids()),
    'PROVIDERS y el registro no pueden divergir: la primera se construye del segundo');
  for (const id of IDS) {
    check(PROVIDERS[id] === registroDeProveedores.getAdapter(id),
      `${id}: PROVIDERS y el registro apuntan al mismo objeto`);
  }

  // --- Equivalencia EXACTA campo a campo -----------------------------------
  //
  // La migración cambió de dónde salen los metadatos: `getProvider()` devolvía
  // `adapter.name`/`adapter.privacy`/`adapter.requiresKey` y ahora devuelve
  // `descriptor.displayName` y `descriptor.traits.*`. Que el registro se
  // construya del adaptador no basta como argumento: `requiresKey` se normaliza
  // con `=== true` al registrar, así que un adaptador que declarase `undefined`
  // o `1` daría un valor distinto por cada vía. Aquí se comparan los valores
  // reales, uno a uno, en vez de razonar sobre cómo se construyen.
  for (const id of IDS) {
    const adaptador = PROVIDERS[id];
    const descriptor = registroDeProveedores.get(id);

    check(descriptor.displayName === adaptador.name,
      `${id}: displayName es exactamente adapter.name (${JSON.stringify(descriptor.displayName)} === ${JSON.stringify(adaptador.name)})`);
    check(descriptor.traits.privacy === adaptador.privacy,
      `${id}: traits.privacy es exactamente adapter.privacy (${descriptor.traits.privacy} === ${adaptador.privacy})`);
    check(descriptor.traits.requiresKey === adaptador.requiresKey,
      `${id}: traits.requiresKey es exactamente adapter.requiresKey (${descriptor.traits.requiresKey} === ${adaptador.requiresKey})`);
    check(descriptor.traits.visualCapabilities === adaptador.visualCapabilities,
      `${id}: traits.visualCapabilities es el mismo objeto que el del adaptador`);

    // Y el tipo importa tanto como el valor: `requiresKey` se normaliza al
    // registrar, así que un adaptador que no lo declarase booleano rompería la
    // equivalencia sin que la comparación estricta de arriba lo dijese claro.
    check(typeof adaptador.requiresKey === 'boolean',
      `${id}: el adaptador declara requiresKey como booleano, no como valor coercible`);
  }

  // Lo que el usuario ve: `getProvider()` tiene que devolver, campo a campo, lo
  // mismo que devolvía leyendo el adaptador directamente.
  {
    const { AIProviderManager } = require('../src/main/ai-providers');
    const almacen = new Map();
    const dbFalsa = {
      prepare: (sql) => ({
        get: (clave) => (almacen.has(clave) ? { value: almacen.get(clave) } : undefined),
        all: () => [...almacen].map(([key, value]) => ({ key, value })),
        run: (clave, valor) => { almacen.set(clave, valor); }
      })
    };
    const gestor = new AIProviderManager(dbFalsa);
    for (const id of IDS) {
      gestor.setProvider(id);
      const visto = gestor.getProvider();
      const adaptador = PROVIDERS[id];
      check(visto.id === id && visto.name === adaptador.name
        && visto.privacy === adaptador.privacy
        && visto.requiresKey === adaptador.requiresKey,
        `${id}: getProvider() devuelve los mismos valores que el adaptador (${visto.name} / ${visto.privacy} / ${visto.requiresKey})`);
      check(visto.privacyLabel === (adaptador.privacy === 'private' ? 'Privado' : 'Cloud'),
        `${id}: la etiqueta de privacidad no cambió (${visto.privacyLabel})`);
      // `setProvider()` devuelve la privacidad por su cuenta: también tiene que
      // coincidir, porque es la que el renderer usa para pintar el indicador.
      const devuelto = gestor.setProvider(id);
      check(devuelto.privacy === adaptador.privacy,
        `${id}: setProvider() devuelve la misma privacidad (${devuelto.privacy})`);
    }

    // El cambio observable que sí hubo, declarado: antes `setApiKey()` con un
    // proveedor inexistente reventaba con TypeError al leer `.requiresKey` de
    // `undefined`; ahora rechaza con un error propio. Se comprueba para que
    // quede escrito, no por accidente.
    let fallo = null;
    try { gestor.setApiKey('proveedor-que-no-existe', 'x'); } catch (e) { fallo = e; }
    check(fallo instanceof Error && !(fallo instanceof TypeError)
      && /no válido/i.test(fallo.message),
      `setApiKey() con proveedor desconocido da un error propio, no un TypeError (${fallo && fallo.message})`);
  }
}

console.log('\n=== 11. validarAdaptador() es reutilizable y no muta ===');
{
  const descriptor = valido();
  const copia = JSON.parse(JSON.stringify({ ...descriptor, adapter: undefined }));
  validarAdaptador(descriptor);
  const despues = JSON.parse(JSON.stringify({ ...descriptor, adapter: undefined }));
  check(JSON.stringify(copia) === JSON.stringify(despues),
    'validar no altera el descriptor que recibe');

  let sinObjeto = null;
  try { validarAdaptador(null); } catch (e) { sinObjeto = e; }
  check(sinObjeto && sinObjeto.code === 'ADAPTER_INVALID',
    'validar null falla cerrado con código estable');
}

console.log('\n=== 12. El registro gobierna: nadie indexa PROVIDERS a mano ===');
{
  // Registrar los adaptadores y seguir accediendo por `PROVIDERS[id]` dejaba
  // el registro como decorado: validaba al arrancar y después no pasaba nada
  // por él, así que ninguna de sus garantías —identificador conocido, traits
  // validados, descriptor congelado— llegaba a aplicarse en ejecución. Esta
  // comprobación es lo que impide que vuelva a quedarse así.
  const fuente = fs.readFileSync(path.join(__dirname, '../src/main/ai-providers.js'), 'utf8');
  const lineasDeCodigo = fuente.split(/\r?\n/)
    .filter(linea => !/^\s*(\/\/|\*|\/\*)/.test(linea));

  const accesosDirectos = lineasDeCodigo.filter(linea => /PROVIDERS\s*\[/.test(linea));
  check(accesosDirectos.length === 0,
    `ai-providers.js no indexa PROVIDERS directamente (${accesosDirectos.length}: ${accesosDirectos.map(l => l.trim()).join(' | ')})`);

  // Y el registro tiene que usarse de verdad, no sólo existir: si alguien
  // borrase las consultas, la comprobación anterior seguiría pasando.
  const consultas = lineasDeCodigo
    .filter(linea => /registroDeProveedores\.(get|getAdapter|has)\(/.test(linea));
  check(consultas.length >= 8,
    `el acceso a proveedores pasa por el registro (${consultas.length} consultas)`);
}

console.log(`\nProvider registry tests passed (${comprobaciones} comprobaciones)`);
