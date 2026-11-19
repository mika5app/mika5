'use strict';

// Preparación de proveedores y ciclo de vida de los motores locales.
//
// Tres niveles, y cada comprobación dice a cuál pertenece:
//
//   [unidad]      lógica pura, con sistema de ficheros, red y `spawn` falsos.
//   [simulada]    el gestor real y los adaptadores reales contra un proceso
//                 hijo de verdad: un doble de `llama-server` que habla su
//                 protocolo, 503 incluido. Hay proceso, puerto y HTTP reales;
//                 lo que no hay es llama.cpp.
//   [estática]    lectura del código fuente, para lo que no debe volver.
//
// Nada de esto prueba un motor real. Que llama.cpp, BitNet u Ollama arranquen
// en una máquina concreta sólo lo demuestra ejecutarlos ahí.
//
//   npm run test:provider-readiness

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('events');

let comprobaciones = 0;
function check(condicion, mensaje) {
  assert(condicion, mensaje);
  comprobaciones += 1;
  console.log(`  ✓ ${mensaje}`);
}

const warnOriginal = console.warn;
console.warn = (...args) => {
  if (String(args[0] || '').startsWith('[provider:')) return;
  if (String(args[0] || '').startsWith('Ollama no disponible')) return;
  warnOriginal(...args);
};

const leer = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();
    servidor.once('error', reject);
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address();
      servidor.close(() => resolve(port));
    });
  });
}

function baseFalsa(filas = []) {
  const almacen = new Map(filas.map(f => [f.key, f.value]));
  return {
    almacen,
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

/** Sistema de ficheros falso: existe lo que se le dice, y nada más. */
function fsFalso(ficheros = [], otros = []) {
  const conjunto = new Set(ficheros);
  const existentes = new Set([...ficheros, ...otros]);
  return {
    statSync(ruta) {
      if (!conjunto.has(ruta)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
    existsSync: (ruta) => existentes.has(ruta),
    realpathSync: (ruta) => ruta,
    // Ningún directorio que recorrer: lo descubierto sale sólo de `ficheros`.
    readdirSync: () => [],
    // Cabecera GGUF sólo para lo que termina en .gguf.
    openSync(ruta) {
      if (!conjunto.has(ruta)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return ruta;
    },
    readSync(fd, buffer) {
      if (!/\.gguf$/i.test(fd)) return 0;
      buffer.write('GGUF', 0, 'latin1');
      return 4;
    },
    closeSync() {}
  };
}

/** Red falsa: decide si «hay alguien» en el puerto. */
function netFalsa(ocupado = false) {
  return {
    connect() {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      setImmediate(() => socket.emit(ocupado ? 'connect' : 'error', new Error('ECONNREFUSED')));
      return socket;
    }
  };
}

/** `spawn` falso: anota la llamada y devuelve un hijo que no hace nada. */
function spawnFalso() {
  const llamadas = [];
  const spawn = (cmd, args, opciones) => {
    const hijo = new EventEmitter();
    hijo.pid = 4000 + llamadas.length;
    hijo.matado = false;
    hijo.kill = () => { hijo.matado = true; setImmediate(() => hijo.emit('exit', null, 'SIGTERM')); return true; };
    llamadas.push({ cmd, args, opciones, hijo });
    return hijo;
  };
  return { spawn, llamadas };
}

const EXE = '/opt/motores/llama-server';
const MODELO = '/modelos/prueba.gguf';

async function main() {
  // Ollama se apunta a un puerto sin nadie ANTES de cargar los módulos: así
  // ninguna comprobación toca el Ollama real de la máquina, y de paso el
  // adaptador declara que no es arrancable con una base que no es la suya.
  const puertoOllama = await puertoLibre();
  process.env.MIKA5_OLLAMA_BASE = `http://127.0.0.1:${puertoOllama}`;

  const {
    AIProviderManager, PROVIDERS, registroDeProveedores, UI_STATE,
    READINESS, READINESS_ACTION, resolverReadiness
  } = require('../src/main/ai-providers');
  const {
    EJECUTABLES_PERMITIDOS, ESTADO_MOTOR, GestorDeMotores, nombreLogico, validarRutaDeMotor
  } = require('../src/main/local-engines');

  const specLlama = PROVIDERS.llamacpp.engine;
  // Un modelo servido por un motor se identifica como «motor · modelo».
  const nombreEn = (proveedor, nombre) => `${proveedor === 'bitnet' ? 'BitNet' : 'llama.cpp'} · ${nombre}`;
  const L = (nombre) => nombreEn('llamacpp', nombre);
  // El alias que recibe el proceso del motor es sólo ASCII.
  const aliasDe = (id) => id.replace(/[^\x20-\x7E]+/g, '-');
  // Aprobación del ejecutable de prueba, tal y como la daría el usuario: ruta
  // real y huella del contenido. Sin ella no se arranca nada.
  const aprobar = (ruta) => {
    const identidad = new GestorDeMotores({ fs: fsFalso([ruta]) }).identidad(ruta);
    return { path: identidad.path, sha256: identidad.sha256 };
  };
  const APROBACION = aprobar(EXE);
  const CONFIG = { model: MODELO, approval: APROBACION };
  const VALORES = new Set(Object.values(READINESS));

  // ---------------------------------------------------------------------
  console.log('\n=== 1. Inventario: cada proveedor declara qué es [unidad] ===');
  // ---------------------------------------------------------------------
  const ids = registroDeProveedores.ids();
  check(ids.length === 8, `el registro sigue teniendo ocho proveedores (${ids.join(', ')})`);
  check(PROVIDERS.local.engine.tipo === 'external-service', 'Ollama se declara servicio local externo');
  check(specLlama.tipo === 'managed' && PROVIDERS.bitnet.engine.tipo === 'managed',
    'llama.cpp y BitNet se declaran motores gestionables');
  for (const id of ['openai', 'anthropic', 'groq', 'moonshot', 'alibaba']) {
    check(PROVIDERS[id].engine === undefined && PROVIDERS[id].privacy === 'cloud',
      `${id} es una API remota: no declara motor local`);
  }
  for (const id of ['local', 'llamacpp', 'bitnet']) {
    check(EJECUTABLES_PERMITIDOS.includes(PROVIDERS[id].engine.ejecutable),
      `el ejecutable de ${id} está en la lista cerrada`);
  }
  check(PROVIDERS.bitnet.engine.baseUrl() !== specLlama.baseUrl(),
    'llama.cpp y BitNet no comparten dirección: cada uno arranca en la suya');

  // ---------------------------------------------------------------------
  console.log('\n=== 2. De disponibilidad a preparación [unidad] ===');
  // ---------------------------------------------------------------------
  const disp = (extra) => ({
    configured: true, reachable: null, authenticated: null, modelsAvailable: 0,
    canAttempt: false, ready: false, uiState: UI_STATE.UNKNOWN, errorCode: null, httpStatus: null, ...extra
  });
  const motor = (extra) => ({ tipo: 'managed', state: ESTADO_MOTOR.IDLE, errorCode: null, diagnostico: null, ...extra });
  const es = (resultado, readiness, action = null) =>
    resultado.readiness === readiness && resultado.action === action;

  check(es(resolverReadiness(disp({ ready: true, canAttempt: true, reachable: true, uiState: UI_STATE.CONNECTED })),
    READINESS.READY), 'verificado utilizable → READY, sin acción');
  check(es(resolverReadiness(disp({ canAttempt: true })), READINESS.AVAILABLE),
    'se puede intentar pero nadie lo verificó → AVAILABLE');
  check(es(resolverReadiness(disp({ configured: false, uiState: UI_STATE.CONFIGURATION_REQUIRED, errorCode: 'PROVIDER_CREDENTIAL_REQUIRED' })),
    READINESS.NEEDS_SETUP, READINESS_ACTION.CONFIGURE_KEY), 'nube sin clave → NEEDS_SETUP, configurar clave');
  check(es(resolverReadiness(disp({ configured: false, uiState: UI_STATE.CONFIGURATION_REQUIRED, errorCode: 'PROVIDER_ENDPOINT_REQUIRED' })),
    READINESS.NEEDS_SETUP, READINESS_ACTION.CONFIGURE_PROVIDER), 'configuración incompleta → NEEDS_SETUP, completar configuración');
  check(es(resolverReadiness(disp({ authenticated: false, uiState: UI_STATE.AUTHENTICATION_REJECTED })),
    READINESS.NEEDS_SETUP, READINESS_ACTION.CONFIGURE_KEY), 'clave rechazada → NEEDS_SETUP, configurar clave');
  check(es(resolverReadiness(disp({ uiState: UI_STATE.AUTHORIZATION_FORBIDDEN })),
    READINESS.NEEDS_SETUP, READINESS_ACTION.CONFIGURE_KEY), 'clave sin permiso → NEEDS_SETUP, configurar clave');
  check(es(resolverReadiness(disp({ uiState: UI_STATE.RATE_LIMITED })),
    READINESS.UNAVAILABLE, READINESS_ACTION.RETRY), 'límite alcanzado → UNAVAILABLE, reintentar');
  check(es(resolverReadiness(disp({ uiState: UI_STATE.PROVIDER_ERROR, httpStatus: 500 })),
    READINESS.ERROR, READINESS_ACTION.RETRY), 'error del proveedor → ERROR, reintentar');
  check(es(resolverReadiness(disp({ reachable: false, uiState: UI_STATE.OFFLINE })),
    READINESS.UNAVAILABLE, READINESS_ACTION.RETRY), 'nube sin conexión → UNAVAILABLE, reintentar');

  const caido = disp({ reachable: false, uiState: UI_STATE.OFFLINE });
  check(es(resolverReadiness(caido, motor({ state: ESTADO_MOTOR.STARTING })), READINESS.STARTING),
    'motor arrancando y servidor sin contestar → STARTING');
  check(es(resolverReadiness(disp({ reachable: true, httpStatus: 503, uiState: UI_STATE.PROVIDER_ERROR }), motor()),
    READINESS.LOADING_MODEL), 'motor que contesta 503 → LOADING_MODEL, no error');
  check(es(resolverReadiness(disp({ reachable: true, httpStatus: 503, uiState: UI_STATE.PROVIDER_ERROR })),
    READINESS.ERROR, READINESS_ACTION.RETRY), 'un 503 de una API remota sigue siendo ERROR');
  check(es(resolverReadiness(caido, motor()), READINESS.UNAVAILABLE, READINESS_ACTION.START_ENGINE),
    'motor parado y arrancable → UNAVAILABLE, iniciar motor');
  check(es(resolverReadiness(caido, motor({ diagnostico: 'ENGINE_NOT_INSTALLED' })),
    READINESS.NEEDS_SETUP, READINESS_ACTION.CONFIGURE_ENGINE), 'motor gestionable sin ejecutable → configurar motor');
  check(es(resolverReadiness(caido, motor({ tipo: 'external-service', diagnostico: 'ENGINE_NOT_INSTALLED' })),
    READINESS.NEEDS_SETUP, READINESS_ACTION.INSTALL_ENGINE), 'servicio externo sin instalar → NEEDS_SETUP, sin descarga automática');
  check(es(resolverReadiness(caido, motor({ diagnostico: 'ENGINE_MODEL_REQUIRED' })),
    READINESS.NEEDS_SETUP, READINESS_ACTION.CONFIGURE_ENGINE), 'motor sin modelo → configurar motor');
  check(es(resolverReadiness(caido, motor({ tipo: 'external-service', diagnostico: 'ENGINE_SERVICE_MANAGED' })),
    READINESS.UNAVAILABLE, READINESS_ACTION.START_SERVICE), 'servicio del sistema parado → no se arranca por fuera');
  for (const codigo of ['ENGINE_PORT_IN_USE', 'ENGINE_EXITED', 'ENGINE_SPAWN_FAILED', 'ENGINE_START_TIMEOUT']) {
    check(es(resolverReadiness(caido, motor({ state: ESTADO_MOTOR.FAILED, errorCode: codigo })),
      READINESS.ERROR, READINESS_ACTION.START_ENGINE), `arranque fallido (${codigo}) → ERROR, reintento manual`);
  }
  check(es(resolverReadiness(disp({ reachable: true, uiState: UI_STATE.CONNECTED }), motor({ tipo: 'external-service' })),
    READINESS.NEEDS_SETUP, READINESS_ACTION.DOWNLOAD_MODEL), 'Ollama vivo sin modelos → descargar un modelo');

  // ---------------------------------------------------------------------
  console.log('\n=== 3. Qué se puede arrancar [unidad] ===');
  // ---------------------------------------------------------------------
  const entorno = { PATH: '/usr/local/bin:/opt/motores' };
  const gestorCon = (extra = {}) => new GestorDeMotores({
    spawn: () => { throw new Error('no debe arrancar nada'); },
    fs: fsFalso([EXE, MODELO]), net: netFalsa(false), env: entorno, platform: 'linux', ...extra
  });

  check(nombreLogico('C:\\x\\Llama-Server.EXE', 'win32') === 'llama-server'
    && nombreLogico('/x/llama-server', 'linux') === 'llama-server',
    'el nombre lógico ignora directorio, mayúsculas y .exe');
  check(gestorCon().localizar(specLlama) === EXE, 'el ejecutable se encuentra en el PATH');
  check(gestorCon({ env: { PATH: '/sin/nada' } }).localizar(specLlama) === null,
    'un motor que no está instalado no se inventa');
  check(gestorCon({ env: { PATH: 'relativo:.' }, fs: fsFalso(['relativo/llama-server', './llama-server']) })
    .localizar(specLlama) === null, 'un directorio relativo del PATH no se usa para arrancar nada');
  check(gestorCon().localizar({ ...specLlama, ejecutable: 'powershell' }) === null,
    'un ejecutable fuera de la lista cerrada no se localiza');

  const ctx = { fs: fsFalso([EXE, MODELO, '/opt/motores/otra-cosa', '/modelos/prueba.bin']), platform: 'linux' };
  const codigoDe = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  check(codigoDe(() => validarRutaDeMotor('executable', '/opt/motores/otra-cosa', specLlama, ctx)) === 'ENGINE_EXECUTABLE_NOT_ALLOWED',
    'un programa con otro nombre se rechaza aunque exista');
  check(codigoDe(() => validarRutaDeMotor('executable', 'llama-server', specLlama, ctx)) === 'ENGINE_PATH_INVALID',
    'una ruta relativa se rechaza');
  check(codigoDe(() => validarRutaDeMotor('executable', '/no/existe/llama-server', specLlama, ctx)) === 'ENGINE_PATH_INVALID',
    'un ejecutable que no existe se rechaza');
  check(codigoDe(() => validarRutaDeMotor('model', '/modelos/prueba.bin', specLlama, ctx)) === 'ENGINE_MODEL_INVALID',
    'un fichero sin cabecera GGUF se rechaza, se llame como se llame');
  check(validarRutaDeMotor('model', MODELO, specLlama, ctx) === MODELO, 'un GGUF existente se acepta');

  check(gestorCon().diagnosticar(specLlama, { approval: APROBACION }).errorCode === 'ENGINE_MODEL_REQUIRED',
    'sin modelo elegido no hay plan de arranque');
  check(gestorCon().diagnosticar(specLlama, { model: '/modelos/borrado.gguf', approval: APROBACION }).errorCode === 'ENGINE_MODEL_MISSING',
    'un modelo que ya no está se detecta antes de arrancar');
  check(gestorCon({ env: { PATH: '/sin/nada' } }).diagnosticar(specLlama, CONFIG).errorCode === 'ENGINE_NOT_INSTALLED',
    'sin ejecutable el diagnóstico es «no instalado»');
  check(gestorCon({ env: { ...entorno, MIKA5_ENGINE_AUTOSTART: '0' } }).diagnosticar(specLlama, CONFIG).errorCode === 'ENGINE_AUTOSTART_DISABLED',
    'el arranque automático se puede apagar entero');
  check(gestorCon().diagnosticar({ ...specLlama, baseUrl: () => 'http://192.168.1.20:8080/v1' }, CONFIG).errorCode === 'ENGINE_ENDPOINT_INVALID',
    'nunca se arranca un motor fuera de bucle local');

  const plan = gestorCon().diagnosticar(specLlama, CONFIG);
  check(plan.ok && plan.ejecutable === EXE, 'con ejecutable y modelo hay plan');
  check(JSON.stringify(plan.args) === JSON.stringify(['-m', MODELO, '-c', '16384', '-np', '1', '--host', '127.0.0.1', '--port', '8080']),
    `los argumentos van separados y atan el servidor a bucle local (${plan.args.join(' ')})`);
  const conBitnet = () => gestorCon({ fs: fsFalso([EXE, MODELO, '/opt/motores/run_inference_server.py']) });
  const planBitnet = conBitnet().diagnosticar(PROVIDERS.bitnet.engine, CONFIG);
  check(gestorCon().diagnosticar(PROVIDERS.bitnet.engine, CONFIG).errorCode === 'ENGINE_NOT_INSTALLED'
    && gestorCon().localizar(PROVIDERS.bitnet.engine, { executable: EXE }) === null,
    'un llama-server que no está en un clon de bitnet.cpp no es el motor de BitNet, ni descubierto ni elegido a mano');
  check(gestorCon().diagnosticar(specLlama, { model: MODELO }).errorCode === 'ENGINE_APPROVAL_REQUIRED',
    'un ejecutable encontrado pero no aprobado por el usuario no tiene plan de arranque');
  check(gestorCon().diagnosticar(specLlama, { model: MODELO, approval: { ...APROBACION, sha256: 'f'.repeat(64) } }).errorCode === 'ENGINE_APPROVAL_REQUIRED',
    'una aprobación dada a otro contenido no vale para este fichero');
  check(gestorCon().diagnosticar(specLlama, { model: MODELO, approval: { ...APROBACION, path: '/otro/llama-server' } }).errorCode === 'ENGINE_APPROVAL_REQUIRED',
    'una aprobación dada a otra ruta no vale para este fichero');
  check(planBitnet.ok && planBitnet.port === 8081, 'BitNet arranca en su propio puerto, no en el de llama.cpp');

  const specOllama = PROVIDERS.local.engine;
  check(gestorCon({ fs: fsFalso(['/usr/local/bin/ollama']), env: { PATH: '/usr/local/bin', MIKA5_OLLAMA_BASE: 'x' } })
    .diagnosticar(specOllama).errorCode === 'ENGINE_EXTERNALLY_CONFIGURED',
    'Ollama con una base que no es la suya no se arranca');
  check(gestorCon({ fs: fsFalso(['/usr/local/bin/ollama']), env: { PATH: '/usr/local/bin', OLLAMA_HOST: '0.0.0.0' } })
    .diagnosticar(specOllama).errorCode === 'ENGINE_EXTERNALLY_CONFIGURED',
    'Ollama con OLLAMA_HOST propio no se arranca: podría quedar expuesto a la red');
  const { ollamaHostEsElPorDefecto } = require('../src/main/ollama');
  for (const valor of [undefined, '', '127.0.0.1', '127.0.0.1:11434', 'localhost:11434', 'http://127.0.0.1:11434', ':11434', '[::1]:11434']) {
    check(ollamaHostEsElPorDefecto(valor) === true, `OLLAMA_HOST=${JSON.stringify(valor)} sigue siendo bucle local en el puerto de siempre`);
  }
  for (const valor of ['0.0.0.0', '0.0.0.0:11434', '192.168.1.5', '127.0.0.1:8000', ':8000', 'http://127.0.0.1', 'https://127.0.0.1', 'http://ejemplo.test:11434', 'no es una url %%']) {
    check(ollamaHostEsElPorDefecto(valor) === false, `OLLAMA_HOST=${JSON.stringify(valor)} no se arranca desde MIKA5`);
  }
  check(gestorCon({ fs: fsFalso(['/usr/local/bin/ollama'], ['/etc/systemd/system/ollama.service']), env: { PATH: '/usr/local/bin' } })
    .diagnosticar(specOllama).errorCode === 'ENGINE_SERVICE_MANAGED',
    'Ollama administrado por systemd no se arranca por fuera');

  // ---------------------------------------------------------------------
  console.log('\n=== 4. Arranque, duplicados y parada [unidad] ===');
  // ---------------------------------------------------------------------
  {
    const { spawn, llamadas } = spawnFalso();
    const g = gestorCon({ spawn });
    const [a, b] = await Promise.all([
      g.iniciar('llamacpp', specLlama, CONFIG),
      g.iniciar('llamacpp', specLlama, CONFIG)
    ]);
    check(llamadas.length === 1, 'dos arranques simultáneos lanzan un solo proceso');
    check(a.state === ESTADO_MOTOR.STARTING && b.state === ESTADO_MOTOR.STARTING, 'los dos ven el mismo arranque');
    check(llamadas[0].cmd === EXE && llamadas[0].opciones.shell === false,
      'spawn recibe el ejecutable y shell:false');
    await g.iniciar('llamacpp', specLlama, CONFIG);
    check(llamadas.length === 1, 'un tercer arranque con el motor en marcha no duplica el proceso');
    g.marcarVivo('llamacpp');
    check(g.estado('llamacpp').state === ESTADO_MOTOR.RUNNING && g.estado('llamacpp').owned,
      'cuando el servidor contesta el motor pasa a vivo, y es de MIKA5');
    g.detenerTodos();
    check(llamadas[0].hijo.matado, 'al cerrar se detiene el proceso que MIKA5 arrancó');
    check(g.estado('llamacpp').state === ESTADO_MOTOR.IDLE, 'tras detenerlo no queda estado');
  }
  {
    const { spawn, llamadas } = spawnFalso();
    const g = gestorCon({ spawn, net: netFalsa(true) });
    const r = await g.iniciar('llamacpp', specLlama, CONFIG);
    check(llamadas.length === 0 && r.state === ESTADO_MOTOR.FAILED && r.errorCode === 'ENGINE_PORT_IN_USE',
      'con el puerto ocupado por otro proceso no se arranca nada');
    g.detenerTodos();
    check(llamadas.length === 0, 'y al cerrar no se toca nada que MIKA5 no arrancara');
  }
  {
    const { spawn, llamadas } = spawnFalso();
    const g = gestorCon({ spawn });
    await g.iniciar('llamacpp', specLlama, CONFIG);
    llamadas[0].hijo.emit('exit', 1, null);
    check(llamadas.length === 2 && g.estado('llamacpp').state === ESTADO_MOTOR.STARTING
      && llamadas[1].args.join(' ').includes('-c 8192') && !llamadas[1].args.includes('-ngl'),
      'si el motor se cierra al cargar, se reintenta solo con menos contexto');
    llamadas[1].hijo.emit('exit', 1, null);
    check(llamadas.length === 3 && llamadas[2].args.join(' ').includes('-ngl 0'),
      'y si vuelve a cerrarse, sólo con CPU');
    llamadas[2].hijo.emit('exit', 1, null);
    check(llamadas.length === 3 && g.estado('llamacpp').state === ESTADO_MOTOR.FAILED
      && g.estado('llamacpp').errorCode === 'ENGINE_EXITED',
      'agotadas las formas de arrancar queda como fallo, no como «iniciando» ni en un bucle');
    g.reiniciarFallo('llamacpp');
    check(g.estado('llamacpp').state === ESTADO_MOTOR.IDLE, 'el fallo se olvida sólo cuando el usuario reintenta');
  }
  {
    const g = gestorCon({ spawn: () => { throw new Error('EACCES'); } });
    const r = await g.iniciar('llamacpp', specLlama, CONFIG);
    check(r.state === ESTADO_MOTOR.FAILED && r.errorCode === 'ENGINE_SPAWN_FAILED',
      'un spawn que lanza no rompe la aplicación: queda como fallo');
  }
  {
    const { spawn, llamadas } = spawnFalso();
    const g = gestorCon({ spawn, plazoDeArranqueMs: 30 });
    await g.iniciar('llamacpp', specLlama, CONFIG);
    await esperar(80);
    check(g.estado('llamacpp').errorCode === 'ENGINE_START_TIMEOUT' && llamadas[0].hijo.matado,
      'un motor que nunca contesta se retira al vencer el plazo');
  }
  {
    const { spawn, llamadas } = spawnFalso();
    const g = new GestorDeMotores({
      spawn, fs: fsFalso(['C:\\motores\\llama-server.exe', 'C:\\modelos\\m.gguf']), net: netFalsa(false),
      env: { Path: 'C:\\motores', SystemRoot: 'C:\\Windows' }, platform: 'win32'
    });
    await g.iniciar('llamacpp', specLlama, { model: 'C:\\modelos\\m.gguf', approval: aprobar('C:\\motores\\llama-server.exe') });
    g.detenerTodos();
    const taskkill = llamadas[1];
    check(taskkill && taskkill.cmd === 'C:\\Windows\\System32\\taskkill.exe'
      && JSON.stringify(taskkill.args) === JSON.stringify(['/pid', String(llamadas[0].hijo.pid), '/T', '/F'])
      && taskkill.opciones.shell === false,
      'en Windows se retira el árbol del proceso propio, por PID y sin shell');
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 5. Los ocho proveedores, sin configurar nada [unidad] ===');
  // ---------------------------------------------------------------------
  {
    const { spawn, llamadas } = spawnFalso();
    const motores = new GestorDeMotores({
      spawn, fs: fsFalso([]), net: netFalsa(false), platform: 'linux',
      env: { PATH: '', MIKA5_OLLAMA_BASE: process.env.MIKA5_OLLAMA_BASE }
    });
    const m = new AIProviderManager(baseFalsa(), { motores });
    const sinOllama = await new AIProviderManager(baseFalsa(), {
      motores: new GestorDeMotores({ spawn, fs: fsFalso([]), net: netFalsa(false), env: { PATH: '' }, platform: 'linux' })
    }).getReadiness('local', { autoStart: true });
    check(sinOllama.readiness === READINESS.NEEDS_SETUP && sinOllama.action === READINESS_ACTION.INSTALL_ENGINE,
      'Ollama sin instalar: falta instalarlo, y MIKA5 no lo descarga');
    for (const id of ids) {
      const r = await m.getReadiness(id, { autoStart: true });
      check(VALORES.has(r.readiness) && typeof r.uiState === 'string' && Array.isArray(r.models),
        `${id}: preparación ${r.readiness}${r.action ? ` → ${r.action}` : ''} (disponibilidad ${r.uiState} intacta)`);
    }
    for (const id of ['openai', 'anthropic', 'groq', 'moonshot']) {
      const r = await m.getReadiness(id);
      check(r.readiness === READINESS.NEEDS_SETUP && r.action === READINESS_ACTION.CONFIGURE_KEY && r.engine === null,
        `${id} sin credencial: pide la clave y no hay motor que arrancar`);
    }
    const local = await m.getReadiness('local', { autoStart: true });
    check(local.readiness === READINESS.UNAVAILABLE && local.action === READINESS_ACTION.START_SERVICE,
      'Ollama parado con base ajena: no disponible, sin arranque');
    const llama = await m.getReadiness('llamacpp', { autoStart: true });
    check(llama.readiness === READINESS.NEEDS_SETUP && llama.action === READINESS_ACTION.CONFIGURE_ENGINE
      && llama.engine.errorCode === 'ENGINE_NOT_INSTALLED',
      'llama.cpp sin instalar: pide configurar el motor');
    check(llamadas.length === 0, 'consultar los ocho con arranque automático no lanzó ningún proceso');
    check(m.currentProvider === 'local', 'consultar la preparación de otro proveedor no cambia el seleccionado');
    check((await m.getReadiness('no-existe')).readiness === READINESS.ERROR,
      'un proveedor desconocido es un error, no una invitación a configurarlo');
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 6. Credenciales cloud contra un servidor sintético [simulada] ===');
  // ---------------------------------------------------------------------
  {
    let guion = { status: 200, cuerpo: { data: [{ id: 'gpt-4o' }] } };
    const peticiones = [];
    const servidor = http.createServer((req, res) => {
      peticiones.push(`${req.method} ${req.url}`);
      res.writeHead(guion.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(guion.cuerpo));
    });
    await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
    const baseOriginal = PROVIDERS.openai.baseUrl;
    PROVIDERS.openai.baseUrl = `http://127.0.0.1:${servidor.address().port}`;
    try {
      const m = new AIProviderManager(baseFalsa(), { motores: new GestorDeMotores({ spawn: spawnFalso().spawn }) });
      m.apiKeys.openai = 'sk-clave-de-prueba';
      const ok = await m.getReadiness('openai');
      check(ok.readiness === READINESS.READY && ok.action === null, 'clave aceptada y catálogo → READY');
      check(peticiones.every(p => p === 'GET /models'),
        `la verificación sólo consulta el catálogo, sin inferencia facturable (${[...new Set(peticiones)].join(', ')})`);
      guion = { status: 401, cuerpo: { error: { message: 'Incorrect API key provided: sk-clave-de-prueba' } } };
      const rechazada = await m.getReadiness('openai');
      check(rechazada.readiness === READINESS.NEEDS_SETUP && rechazada.action === READINESS_ACTION.CONFIGURE_KEY,
        'clave rechazada (401) → NEEDS_SETUP, configurar clave');
      check(!JSON.stringify(rechazada).includes('sk-clave-de-prueba'),
        'la clave no viaja en el resultado que cruza al renderer');
      guion = { status: 429, cuerpo: { error: { message: 'insufficient_quota' } } };
      const sinCredito = await m.getReadiness('openai');
      check(sinCredito.readiness === READINESS.UNAVAILABLE && sinCredito.uiState === UI_STATE.RATE_LIMITED,
        'límite o crédito agotado (429) → UNAVAILABLE');
    } finally {
      PROVIDERS.openai.baseUrl = baseOriginal;
      await new Promise(resolve => servidor.close(resolve));
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 7. Motor gestionado de principio a fin [simulada] ===');
  // ---------------------------------------------------------------------
  const DOBLE = path.join(__dirname, 'helpers', 'fake-llama-server.js');
  for (const id of ['llamacpp', 'bitnet']) {
    const puerto = await puertoLibre();
    const baseOriginal = PROVIDERS[id].baseUrl;
    PROVIDERS[id].baseUrl = `http://127.0.0.1:${puerto}/v1`;
    const lanzados = [];
    // El gestor cree que arranca `llama-server`; lo que corre es el doble, con
    // los MISMOS argumentos que habría recibido el real.
    const spawn = (cmd, args, opciones) => {
      if (/taskkill\.exe$/i.test(cmd)) return childProcess.spawn(cmd, args, opciones);
      lanzados.push({ cmd, args, opciones });
      return childProcess.spawn(process.execPath, [DOBLE, ...args], {
        stdio: 'ignore', windowsHide: true, env: { ...process.env, FAKE_LLAMA_LOAD_MS: '700' }
      });
    };
    const motores = new GestorDeMotores({
      spawn, fs: fsFalso([EXE, MODELO]), env: { ...process.env, PATH: '/sin/nada', Path: '/sin/nada' },
      platform: process.platform === 'win32' ? 'win32' : 'linux'
    });
    // En Windows las rutas de prueba tienen que ser absolutas para win32.
    const exe = process.platform === 'win32' ? 'C:\\motores\\llama-server.exe' : EXE;
    const modelo = process.platform === 'win32' ? 'C:\\modelos\\prueba.gguf' : MODELO;
    // BitNet sólo reconoce como suyo un motor dentro de un clon de bitnet.cpp.
    const marca = process.platform === 'win32' ? 'C:\\motores\\run_inference_server.py' : '/opt/motores/run_inference_server.py';
    motores._fs = fsFalso([exe, modelo, marca]);
    const db = baseFalsa();
    const m = new AIProviderManager(db, { motores });
    try {
      check((await m.getReadiness(id, { autoStart: true })).action === READINESS_ACTION.CONFIGURE_ENGINE,
        `${id}: sin configurar pide el motor y no arranca nada`);
      check(lanzados.length === 0, `${id}: ningún proceso antes de que el usuario elija ejecutable y modelo`);

      m.setEngineFile(id, 'executable', exe);
      m.setEngineFile(id, 'model', modelo);
      const sinAprobar = await m.getReadiness(id, { autoStart: true });
      check(sinAprobar.readiness === READINESS.NEEDS_SETUP && sinAprobar.action === READINESS_ACTION.APPROVE_ENGINE
        && sinAprobar.models.length === 0 && lanzados.length === 0,
        `${id}: con ejecutable y modelo pero sin aprobación no se arranca nada ni se ofrecen modelos`);
      const descrito = m.approveEngine(id, m.engineIdentity(id).sha256);
      check(descrito.canStart && descrito.executable === exe && descrito.model === nombreEn(id, 'prueba'),
        `${id}: con ejecutable y modelo elegidos el motor queda arrancable`);
      check(JSON.parse(db.almacen.get(`engine_${id}`)).model === modelo,
        `${id}: la elección se guarda en app_state`);
      check(new AIProviderManager(db, { motores }).getEngineConfig(id).executable === exe,
        `${id}: y sobrevive a un reinicio de la aplicación`);

      const sinArranque = await m.getReadiness(id);
      check(sinArranque.readiness === READINESS.AVAILABLE && sinArranque.canAttempt
        && sinArranque.models.map(x => x.name).join() === nombreEn(id, 'prueba')
        && lanzados.length === 0, `${id}: parado ofrece su modelo en el selector, y consultar no arranca nada`);

      const [uno, dos] = await Promise.all([
        m.getReadiness(id, { autoStart: true }), m.getReadiness(id, { autoStart: true })
      ]);
      check(lanzados.length === 1, `${id}: dos selecciones simultáneas arrancan un solo motor`);
      check([uno.readiness, dos.readiness].every(r => r === READINESS.STARTING || r === READINESS.LOADING_MODEL),
        `${id}: recién lanzado se presenta como en camino (${uno.readiness}, ${dos.readiness})`);
      check(lanzados[0].cmd === exe && lanzados[0].opciones.shell === false
        // Cada motor con sus argumentos: BitNet usa los de su lanzador oficial
        // (sólo CPU, batching continuo); llama.cpp, contexto acotado y una ranura.
        && lanzados[0].args.join(' ') === (id === 'bitnet'
          ? `-m ${modelo} --alias ${aliasDe(nombreEn(id, 'prueba'))} -c 4096 -b 32 -ngl 0 -cb --host 127.0.0.1 --port ${puerto}`
          : `-m ${modelo} --alias ${aliasDe(nombreEn(id, 'prueba'))} -c 16384 -np 1 --host 127.0.0.1 --port ${puerto}`),
        `${id}: se lanza el ejecutable elegido, sin shell, en bucle local y en el puerto del adaptador`);

      const vistos = new Set([uno.readiness]);
      let ultimo = uno;
      for (let i = 0; i < 100 && ultimo.readiness !== READINESS.READY; i += 1) {
        await esperar(100);
        ultimo = await m.getReadiness(id, { autoStart: true });
        vistos.add(ultimo.readiness);
      }
      check(ultimo.readiness === READINESS.READY && ultimo.models[0].name === nombreEn(id, 'prueba')
        && ultimo.engine.selectedModel === nombreEn(id, 'prueba'),
        `${id}: el motor acaba listo y con catálogo (${[...vistos].join(' → ')})`);
      check(vistos.has(READINESS.LOADING_MODEL), `${id}: mientras cargaba el modelo se vio LOADING_MODEL, no un error`);
      check(lanzados.length === 1 && ultimo.engine.owned && ultimo.engine.state === ESTADO_MOTOR.RUNNING,
        `${id}: el sondeo no relanzó el motor, y consta como propio`);

      const respuesta = await m.chat({
        providerId: id, model: 'modelo-de-prueba',
        messages: [{ role: 'system', content: 'INSTRUCCION-7f' }, { role: 'user', content: 'hola' }]
      });
      check(String(respuesta.content || respuesta.message?.content || '').includes('INSTRUCCION-7f'),
        `${id}: el chat llega al motor arrancado con las instrucciones del sistema`);

      m.setProvider(id === 'llamacpp' ? 'bitnet' : 'llamacpp');
      check((await m.getReadiness(id)).readiness === READINESS.READY,
        `${id}: cambiar de proveedor no detiene el motor ni corta lo que esté en curso`);

      m.stopEngines();
      let caidoTrasCerrar = null;
      for (let i = 0; i < 50; i += 1) {
        await esperar(100);
        caidoTrasCerrar = await m.getReadiness(id);
        if (caidoTrasCerrar.reachable === false) break;
      }
      check(caidoTrasCerrar.reachable === false, `${id}: al cerrar MIKA5 el motor propio se detiene`);
    } finally {
      motores.detenerTodos();
      PROVIDERS[id].baseUrl = baseOriginal;
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 8. Servidor externo y fallo de carga [simulada] ===');
  // ---------------------------------------------------------------------
  {
    // Un llama-server que el usuario lanzó a mano: se reutiliza y no se toca.
    const externo = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'modelo-externo' }] }));
    });
    await new Promise(resolve => externo.listen(0, '127.0.0.1', resolve));
    const baseOriginal = PROVIDERS.llamacpp.baseUrl;
    PROVIDERS.llamacpp.baseUrl = `http://127.0.0.1:${externo.address().port}/v1`;
    const { spawn, llamadas } = spawnFalso();
    const motores = new GestorDeMotores({ spawn, fs: fsFalso([EXE, MODELO]), env: { PATH: '/opt/motores' }, platform: 'linux' });
    const m = new AIProviderManager(baseFalsa([
      { key: 'engine_llamacpp', value: JSON.stringify({ executable: EXE, model: MODELO, approval: APROBACION }) }
    ]), { motores });
    try {
      const r = await m.getReadiness('llamacpp', { autoStart: true });
      check(r.readiness === READINESS.READY && llamadas.length === 0 && r.engine.owned === false,
        'un servidor externo ya en marcha se reutiliza: ni se duplica ni consta como propio');
      const forzado = await m.startEngine('llamacpp');
      check(forzado.readiness === READINESS.READY && llamadas.length === 0,
        '«iniciar motor» con el servidor ya vivo tampoco lanza un segundo proceso');
      m.stopEngines();
      check((await m.getReadiness('llamacpp')).readiness === READINESS.READY,
        'cerrar MIKA5 no detiene el servidor externo');
    } finally {
      PROVIDERS.llamacpp.baseUrl = baseOriginal;
      await new Promise(resolve => externo.close(resolve));
    }
  }
  {
    // El motor sale nada más arrancar: modelo corrupto, binario incompatible.
    const puerto = await puertoLibre();
    const baseOriginal = PROVIDERS.llamacpp.baseUrl;
    PROVIDERS.llamacpp.baseUrl = `http://127.0.0.1:${puerto}/v1`;
    let lanzados = 0;
    const spawn = (cmd, args, opciones) => {
      if (/taskkill\.exe$/i.test(cmd)) return childProcess.spawn(cmd, args, opciones);
      lanzados += 1;
      return childProcess.spawn(process.execPath, [DOBLE, ...args], {
        stdio: 'ignore', windowsHide: true, env: { ...process.env, FAKE_LLAMA_EXIT_IMMEDIATELY: '1' }
      });
    };
    const esWin = process.platform === 'win32';
    const exe = esWin ? 'C:\\motores\\llama-server.exe' : EXE;
    const modelo = esWin ? 'C:\\modelos\\prueba.gguf' : MODELO;
    const motores = new GestorDeMotores({
      spawn, fs: fsFalso([exe, modelo]), env: { ...process.env }, platform: esWin ? 'win32' : 'linux'
    });
    const m = new AIProviderManager(baseFalsa([
      { key: 'engine_llamacpp', value: JSON.stringify({ executable: exe, model: modelo, approval: aprobar(exe) }) }
    ]), { motores });
    try {
      let r = await m.getReadiness('llamacpp', { autoStart: true });
      for (let i = 0; i < 50 && r.readiness === READINESS.STARTING; i += 1) {
        await esperar(100);
        r = await m.getReadiness('llamacpp', { autoStart: true });
      }
      check(r.readiness === READINESS.ERROR && r.engine.errorCode === 'ENGINE_EXITED' && r.action === READINESS_ACTION.START_ENGINE,
        'un motor que no logra cargar queda en ERROR con acción de reintento');
      await m.getReadiness('llamacpp', { autoStart: true });
      const trasFallo = await m.getReadiness('llamacpp', { autoStart: true });
      check(lanzados === 3, 'se probaron las tres formas de arrancar y el sondeo no relanza nada más');
      check(!(m.getEngineConfig('llamacpp').verified || {})[modelo]
        && trasFallo.models.some(x => x.name === L('prueba')),
        'un cierre sin causa conocida no demuestra nada: el modelo no se marca incompatible y se sigue ofreciendo');
      await m.startEngine('llamacpp');
      check(lanzados > 3, 'el reintento sólo ocurre cuando el usuario lo pide');
    } finally {
      motores.detenerTodos();
      PROVIDERS.llamacpp.baseUrl = baseOriginal;
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 8 ter. El motor se cierra al cargar: memoria, modelo no soportado [simulada] ===');
  // ---------------------------------------------------------------------
  // Caso real, medido en Windows con una gráfica integrada: llama-server
  // reservaba el contexto máximo del modelo, la memoria gráfica no alcanzaba y
  // el proceso salía a los pocos segundos con «ErrorOutOfDeviceMemory».
  {
    const { clasificarSalida } = require('../src/main/local-engines');
    check(clasificarSalida('ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory') === 'ENGINE_OUT_OF_MEMORY'
      && clasificarSalida('failed to allocate Vulkan0 buffer of size 1031798784') === 'ENGINE_OUT_OF_MEMORY',
      'quedarse sin memoria se reconoce por lo que escribe el motor');
    check(clasificarSalida("unknown model architecture: 'rara'") === 'ENGINE_MODEL_UNSUPPORTED',
      'un modelo que el motor no entiende se reconoce aparte');
    check(clasificarSalida('') === 'ENGINE_EXITED' && clasificarSalida('otra cosa') === 'ENGINE_EXITED',
      'lo que no se reconoce queda como cierre sin más, sin inventar la causa');

    const esWin = process.platform === 'win32';
    const exe = esWin ? 'C:\\motores\\llama-server.exe' : EXE;
    const modelo = esWin ? 'C:\\modelos\\prueba.gguf' : MODELO;
    const escenario = async (entorno, cuerpo) => {
      const puerto = await puertoLibre();
      const baseOriginal = PROVIDERS.llamacpp.baseUrl;
      PROVIDERS.llamacpp.baseUrl = `http://127.0.0.1:${puerto}/v1`;
      const lanzados = [];
      const spawn = (cmd, args, opciones) => {
        if (/taskkill\.exe$/i.test(cmd)) return childProcess.spawn(cmd, args, opciones);
        lanzados.push(args.join(' '));
        return childProcess.spawn(process.execPath, [DOBLE, ...args], {
          stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ...entorno }
        });
      };
      const motores = new GestorDeMotores({ spawn, fs: fsFalso([exe, modelo]), env: { ...process.env }, platform: esWin ? 'win32' : 'linux' });
      const db = baseFalsa([{ key: 'engine_llamacpp', value: JSON.stringify({ executable: exe, model: modelo, modelId: 'prueba', approval: aprobar(exe) }) }]);
      const m = new AIProviderManager(db, { motores });
      const hasta = async (fin) => {
        let r = await m.getReadiness('llamacpp', { autoStart: true });
        for (let i = 0; i < 120 && !fin(r); i += 1) { await esperar(100); r = await m.getReadiness('llamacpp', { autoStart: true }); }
        return r;
      };
      try {
        await cuerpo({ m, db, motores, lanzados, hasta });
      } finally {
        await motores.detener('llamacpp');
        PROVIDERS.llamacpp.baseUrl = baseOriginal;
      }
    };

    await escenario({ FAKE_LLAMA_FAIL_CTX_ABOVE: '8192' }, async ({ m, db, motores, lanzados, hasta }) => {
      const r = await hasta(x => x.readiness === READINESS.READY || x.readiness === READINESS.ERROR);
      check(r.readiness === READINESS.READY && lanzados.length === 2
        && lanzados[0].includes('-c 16384') && lanzados[1].includes('-c 8192'),
        'sin memoria para el contexto grande, MIKA5 reintenta solo con uno menor y el motor queda listo');
      check(JSON.parse(db.almacen.get('engine_llamacpp')).launch[modelo] === 1
        && r.models.find(x => x.name === L('prueba')).compatibility === 'compatible',
        'se recuerda qué arranque funcionó, y el modelo queda como compatible');
      await motores.detener('llamacpp');
      const antes = lanzados.length;
      await m.selectEngineModel('llamacpp', L('prueba'));
      check(lanzados.length === antes + 1 && lanzados[antes].includes('-c 8192'),
        'la próxima vez arranca directamente con lo que funcionó, sin repetir el intento fallido');
    });

    await escenario({ FAKE_LLAMA_REQUIRE_CPU: '1' }, async ({ lanzados, hasta }) => {
      const r = await hasta(x => x.readiness === READINESS.READY || x.readiness === READINESS.ERROR);
      check(r.readiness === READINESS.READY && lanzados.length === 3 && lanzados[2].includes('-ngl 0'),
        'si la gráfica no puede, el último intento es sólo con CPU, y funciona');
    });

    await escenario({ FAKE_LLAMA_FAIL_CTX_ABOVE: '1' }, async ({ m, lanzados, hasta }) => {
      const r = await hasta(x => x.readiness === READINESS.ERROR);
      check(r.readiness === READINESS.ERROR && r.engine.errorCode === 'ENGINE_OUT_OF_MEMORY' && lanzados.length === 3,
        'si ninguna forma cabe en memoria, se dice que falta memoria, no que el motor «se cerró»');
      check(!(m.getEngineConfig('llamacpp').verified || {})[modelo] && r.models.some(x => x.name === L('prueba')),
        'quedarse sin memoria no marca el modelo como incompatible: es un límite del equipo');
      let mensaje = '';
      try { await m.chat({ providerId: 'llamacpp', model: L('prueba'), messages: [{ role: 'user', content: 'x' }] }); } catch (e) { mensaje = e.message; }
      check(/memoria suficiente/.test(mensaje), 'al escribir, el error dice qué pasa y qué hacer, sin esperar minutos');
    });

    await escenario({ FAKE_LLAMA_UNSUPPORTED: '1' }, async ({ m, lanzados, hasta }) => {
      const r = await hasta(x => x.readiness === READINESS.ERROR);
      check(r.engine.errorCode === 'ENGINE_MODEL_UNSUPPORTED' && lanzados.length === 1,
        'un modelo que el motor no entiende no se reintenta de tres formas: no va a cargar');
      const despues = await m.getReadiness('llamacpp');
      check(m.getEngineConfig('llamacpp').verified[modelo] === 'incompatible' && !despues.models.some(x => x.name === L('prueba')),
        'y deja de ofrecerse');
    });

    // Listar el modelo no es poder generar con él: READY exige una inferencia.
    await escenario({ FAKE_LLAMA_CHAT_FAILS: '1' }, async ({ m, lanzados, hasta }) => {
      const vistos = new Set();
      const r = await hasta(x => { vistos.add(x.engine.status); return x.readiness === READINESS.ERROR; });
      check(r.engine.errorCode === 'ENGINE_INFERENCE_FAILED' && !vistos.has('ready') && r.readiness !== READINESS.READY,
        'un motor que lista el modelo pero no genera nunca se da por listo');
      check(lanzados.length === 1 && !(m.getEngineConfig('llamacpp').verified || {})[modelo],
        'y no se relanza solo ni se marca el modelo sin saber la causa');
    });

    // Estados del motor, uno por situación. «Sin conexión» no es ninguno.
    await escenario({ FAKE_LLAMA_LOAD_MS: '900' }, async ({ m, motores, hasta }) => {
      const { ENGINE_STATUS } = require('../src/main/ai-providers');
      const parado = await m.getReadiness('llamacpp');
      check(parado.engine.status === ENGINE_STATUS.STOPPED && parado.uiState === 'offline'
        && parado.readiness === READINESS.AVAILABLE,
        'motor instalado, autorizado y con modelo, sin arrancar: STOPPED, no «sin conexión»');
      check(parado.engine.label === 'llama.cpp' && parado.engine.selectedModel === L('prueba')
        && parado.engine.modelOrigin === 'manual' && parado.models[0].label === 'prueba' && parado.models[0].origin === 'manual',
        'motor, modelo y origen del fichero viajan por separado');
      const vistos = [];
      const listo = await hasta(x => { if (vistos.at(-1) !== x.engine.status) vistos.push(x.engine.status); return x.engine.status === ENGINE_STATUS.READY; });
      check(vistos.join(' → ').endsWith('loading → ready') && vistos.includes('starting') || vistos.join(' → ').endsWith('loading → ready'),
        `el arranque pasa por cargando antes de listo (${vistos.join(' → ')})`);
      check(listo.readiness === READINESS.READY && listo.ready === true, 'READY llega con la inferencia confirmada');
      // El proceso muere estando listo: deja de estar listo.
      const hijo = motores._motores.get('llamacpp').child;
      hijo.kill();
      // En cuanto deja de contestar ya no figura como listo; cuando el sistema
      // confirma que el proceso salió, queda como error. Entre medias puede
      // verse «detenido»: el proceso ha muerto y el aviso de salida aún no llegó.
      const alCaer = await hasta(x => x.engine.status !== ENGINE_STATUS.READY);
      check([ENGINE_STATUS.STOPPED, ENGINE_STATUS.ERROR].includes(alCaer.engine.status) && alCaer.readiness !== READINESS.READY,
        `si el motor se cierra deja de ofrecerse como listo (${alCaer.engine.status})`);
      const muerto = await hasta(x => x.engine.status === ENGINE_STATUS.ERROR);
      check(muerto.engine.status === ENGINE_STATUS.ERROR && muerto.engine.errorCode === 'ENGINE_EXITED',
        'y queda como error del motor, con su causa');
    });

    {
      const { ENGINE_STATUS } = require('../src/main/ai-providers');
      const sinNada = new AIProviderManager(baseFalsa(), {
        motores: new GestorDeMotores({ spawn: spawnFalso().spawn, fs: fsFalso([]), net: netFalsa(false), env: { PATH: '' }, platform: 'linux' })
      });
      check((await sinNada.getReadiness('llamacpp')).engine.status === ENGINE_STATUS.NOT_INSTALLED,
        'sin ejecutable: NOT_INSTALLED');
      const sinAprobar = new AIProviderManager(baseFalsa(), {
        motores: new GestorDeMotores({ spawn: spawnFalso().spawn, fs: fsFalso([EXE]), net: netFalsa(false), env: { PATH: '/opt/motores' }, platform: 'linux' })
      });
      check((await sinAprobar.getReadiness('llamacpp')).engine.status === ENGINE_STATUS.NEEDS_APPROVAL,
        'ejecutable encontrado sin autorizar: NEEDS_APPROVAL');
      const sinModelo = new AIProviderManager(baseFalsa([
        { key: 'engine_llamacpp', value: JSON.stringify({ approval: APROBACION }) }
      ]), { motores: new GestorDeMotores({ spawn: spawnFalso().spawn, fs: fsFalso([EXE]), net: netFalsa(false), env: { PATH: '/opt/motores' }, platform: 'linux' }) });
      const r = await sinModelo.getReadiness('llamacpp', { autoStart: true });
      check(r.engine.status === ENGINE_STATUS.NEEDS_MODEL && r.readiness === READINESS.NEEDS_SETUP && r.models.length === 0,
        'motor autorizado sin ningún modelo: NEEDS_MODEL, y no se ofrece ninguno');

      // BitNet sin motor propio, con el llama-server de llama.cpp instalado.
      const winget = '/home/u/.local/bin/llama-server';
      const conLlama = new AIProviderManager(baseFalsa([
        // Aprobación antigua del binario de llama.cpp para BitNet: ya no vale.
        { key: 'engine_bitnet', value: JSON.stringify({ approval: aprobar(winget) }) }
      ]), { motores: new GestorDeMotores({ spawn: spawnFalso().spawn, fs: fsFalso([winget]), net: netFalsa(false), env: { PATH: '/home/u/.local/bin' }, platform: 'linux' }) });
      const bitnet = await conLlama.getReadiness('bitnet', { autoStart: true });
      const descrito = conLlama.describeEngine('bitnet');
      check(bitnet.engine.status === ENGINE_STATUS.NOT_INSTALLED && bitnet.readiness === READINESS.NEEDS_SETUP
        && descrito.executable === null && descrito.executables.length === 0,
        'BitNet no toma el llama-server de llama.cpp aunque esté instalado y antes se hubiese autorizado');
      check(descrito.installKind === 'source' && descrito.canInstall === false && Boolean(descrito.guideUrl),
        'BitNet no finge un instalador: declara que se compila y ofrece su guía oficial');
      check((await conLlama.getReadiness('llamacpp')).engine.status === ENGINE_STATUS.NEEDS_APPROVAL,
        'ese mismo ejecutable sí es el motor de llama.cpp');

      // BitNet se compila: se dice qué herramientas hay y cuáles faltan.
      {
        const { comprobarRequisitos } = require('../src/main/engine-discovery');
        const vs = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools';
        const cmakeVs = `${vs}\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe`;
        const clangVs = `${vs}\\VC\\Tools\\Llvm\\x64\\bin\\clang.exe`;
        const entorno = { Path: 'C:\\Git\\cmd;C:\\Py', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' };
        const disco = (ficheros) => ({
          ...fsFalso(ficheros),
          readdirSync: (dir) => (dir === 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022'
            ? [{ name: 'BuildTools', isDirectory: () => true }] : [])
        });
        const sinClang = comprobarRequisitos(['git', 'python', 'cmake', 'clang'], {
          fs: disco(['C:\\Git\\cmd\\git.exe', 'C:\\Py\\python.exe', cmakeVs]), env: entorno, platform: 'win32'
        });
        check(sinClang.map(r => `${r.id}:${r.found}`).join() === 'git:true,python:true,cmake:true,clang:false',
          'con Visual Studio sin el componente Clang: se detecta CMake de Visual Studio y se dice que falta Clang');
        const completo = comprobarRequisitos(['git', 'python', 'cmake', 'clang'], {
          fs: disco(['C:\\Git\\cmd\\git.exe', 'C:\\Py\\python.exe', cmakeVs, clangVs]), env: entorno, platform: 'win32'
        });
        check(completo.every(r => r.found), 'con el componente Clang de Visual Studio instalado, no falta nada');
        const linux = comprobarRequisitos(['git', 'python', 'cmake', 'clang'], {
          fs: fsFalso(['/usr/bin/git', '/usr/bin/python3', '/usr/bin/clang']), env: { PATH: '/usr/bin' }, platform: 'linux'
        });
        check(linux.map(r => `${r.id}:${r.found}`).join() === 'git:true,python:true,cmake:false,clang:true',
          'en Linux se buscan en el PATH, y python3 cuenta como Python');
        check(JSON.stringify(PROVIDERS.bitnet.engine.requisitos) === JSON.stringify(['git', 'python', 'cmake', 'clang'])
          && PROVIDERS.llamacpp.engine.requisitos.length === 0,
          'BitNet declara lo que pide su README; llama.cpp, que tiene instalador, no pide nada');
        check(descrito.requirements.length === 4 && descrito.requirements.every(r => typeof r.found === 'boolean'),
          'la configuración de BitNet recibe la lista de requisitos con su estado');
        const fuente = leer('src/main/engine-discovery.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        check(!/spawn|exec\(|execFile/.test(fuente), 'comprobar requisitos no ejecuta ninguna herramienta');
      }

      // Veredictos guardados con el criterio anterior.
      const rutaA = '/m/a.gguf';
      const rutaB = '/m/b.gguf';
      const antiguo = new AIProviderManager(baseFalsa([{ key: 'engine_llamacpp', value: JSON.stringify({
        approval: APROBACION, verified: { [rutaA]: 'incompatible', [rutaB]: 'compatible' }
      }) }]), { motores: new GestorDeMotores({ spawn: spawnFalso().spawn, fs: fsFalso([EXE]), net: netFalsa(false), env: { PATH: '/opt/motores' }, platform: 'linux' }) });
      const veredictos = antiguo.getEngineConfig('llamacpp').verified;
      check(veredictos[rutaA] === undefined && veredictos[rutaB] === 'compatible',
        'un «incompatible» guardado con el criterio antiguo se descarta; un «compatible» se conserva');
      const vigente = new AIProviderManager(baseFalsa([{ key: 'engine_llamacpp', value: JSON.stringify({
        approval: APROBACION, verdicts: 2, verified: { [rutaA]: 'incompatible' }
      }) }]), { motores: new GestorDeMotores({ spawn: spawnFalso().spawn, fs: fsFalso([EXE]), net: netFalsa(false), env: { PATH: '/opt/motores' }, platform: 'linux' }) });
      check(vigente.getEngineConfig('llamacpp').verified[rutaA] === 'incompatible',
        'un «incompatible» guardado con el criterio vigente sí se respeta');
      check(PROVIDERS.llamacpp.engine.compatibilidad({ source: 'Ollama', architecture: 'nomic-bert' }) === 'incompatible'
        && PROVIDERS.llamacpp.engine.compatibilidad({ source: 'Ollama', architecture: 'llama' }) === 'unverified',
        'un modelo de embeddings no se ofrece para conversar; un GGUF de Ollama no se descarta por su origen');
    }

    // El registro no repite la misma línea en cada consulta de estado.
    {
      const lineas = [];
      const previo = console.warn;
      console.warn = (...args) => { lineas.push(String(args[0])); };
      try {
        const m = new AIProviderManager(baseFalsa(), { motores: new GestorDeMotores({ spawn: spawnFalso().spawn, fs: fsFalso([]), net: netFalsa(false), env: { PATH: '' }, platform: 'linux' }) });
        for (let i = 0; i < 12; i += 1) await m.getReadiness('bitnet');
      } finally {
        console.warn = previo;
      }
      check(lineas.filter(l => l.startsWith('[provider:bitnet] status')).length === 1,
        'doce consultas seguidas con el motor caído dejan una línea en el registro, no doce');
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 8 bis. Descubrimiento en disco real [simulada] ===');
  // ---------------------------------------------------------------------
  {
    const os = require('os');
    const { descubrirEjecutables, descubrirModelos } = require('../src/main/engine-discovery');
    const { HF_REPO_RE } = require('../src/main/ai-providers');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-descubrir-'));
    const esWin = process.platform === 'win32';
    const escribir = (rel, contenido) => {
      const ruta = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fs.writeFileSync(ruta, contenido);
      return ruta;
    };
    const GGUF = Buffer.concat([Buffer.from('GGUF', 'latin1'), Buffer.alloc(64)]);
    // GGUF mínimo con la clave `general.architecture`, como la escribe un
    // conversor real: versión, contadores y un par clave/valor de tipo cadena.
    const ggufDe = (arquitectura) => {
      const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
      const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
      const clave = Buffer.from('general.architecture', 'latin1');
      const valor = Buffer.from(arquitectura, 'utf8');
      return Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(1),
        u64(clave.length), clave, u32(8), u64(valor.length), valor, Buffer.alloc(32)]);
    };
    const exeNombre = esWin ? 'llama-server.exe' : 'llama-server';
    const exeA = escribir(path.join('bin', exeNombre), '');
    const exeB = escribir(path.join('llama.cpp', 'build', 'bin', exeNombre), '');
    const enHf = escribir(path.join('.cache', 'huggingface', 'hub', 'models--org--repo', 'snapshots', 'abc', 'qwen-q4.gguf'), ggufDe('qwen2'));
    escribir(path.join('.cache', 'huggingface', 'hub', 'models--org--repo', 'snapshots', 'abc', 'mmproj-qwen.gguf'), GGUF);
    escribir(path.join('.cache', 'huggingface', 'hub', 'falso.gguf'), 'esto no es un modelo');
    escribir(path.join('.lmstudio', 'models', 'pub', 'phi', 'phi-3.gguf'), ggufDe('phi3'));
    escribir(path.join('.lmstudio', 'models', 'pub', 'raro', 'sin-metadatos.gguf'), GGUF);
    const enBitnet = escribir(path.join('BitNet', 'models', 'BitNet-b1.58-2B-4T', 'ggml-model-i2_s.gguf'), ggufDe('bitnet-b1.58'));
    const digest = 'a'.repeat(64);
    const blob = escribir(path.join('.ollama', 'models', 'blobs', `sha256-${digest}`), ggufDe('llama'));
    escribir(path.join('.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'llama3', 'latest'),
      JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${digest}` }] }));
    escribir(path.join('.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'nube', 'cloud'),
      JSON.stringify({ layers: [] }));
    const env = { HOME: tmp, USERPROFILE: tmp, PATH: path.join(tmp, 'bin'), Path: path.join(tmp, 'bin') };
    const contexto = { fs, env, platform: process.platform };
    try {
      const ejecutables = descubrirEjecutables('llama-server', contexto);
      check(ejecutables[0] === exeA && ejecutables.includes(exeB),
        `se encuentran el ejecutable del PATH y el compilado en la carpeta personal (${ejecutables.length})`);
      const modelos = descubrirModelos(contexto);
      const ids = modelos.map(x => x.id);
      check(ids.includes('qwen-q4') && ids.includes('phi-3') && ids.includes('ggml-model-i2_s'),
        `se descubren los GGUF de Hugging Face, LM Studio y BitNet (${ids.join(', ')})`);
      check(modelos.find(x => x.id === 'llama3:latest' && x.source === 'Ollama')?.path === blob,
        'un modelo que Ollama ya descargó se ofrece sin descargar nada');
      check(!ids.some(i => /mmproj|falso|nube/.test(i)),
        'ni proyectores, ni ficheros sin cabecera GGUF, ni modelos cloud de Ollama se listan');
      check(modelos.every(x => path.isAbsolute(x.path) && x.size > 0), 'cada modelo lleva su ruta absoluta y su tamaño');
      const arquitecturaDe = (id) => modelos.find(x => x.id === id).architecture;
      check(arquitecturaDe('ggml-model-i2_s') === 'bitnet-b1.58' && arquitecturaDe('llama3:latest') === 'llama'
        && arquitecturaDe('sin-metadatos') === null,
        'de cada GGUF se lee la arquitectura que declara, y null si no declara ninguna');

      // Compatibilidad: BitNet no ofrece lo que no es de BitNet.
      {
        const { COMPATIBILITY } = require('../src/main/ai-providers');
        const soloLectura = new AIProviderManager(baseFalsa(), {
          motores: new GestorDeMotores({ spawn: () => { throw new Error('no'); }, env, platform: process.platform })
        });
        const deBitnet = soloLectura._modelosDeMotor('bitnet');
        check(deBitnet.map(x => `${x.label}=${x.compatibility}`).sort().join() === 'ggml-model-i2_s=compatible,sin-metadatos=unverified'
          && deBitnet.every(x => x.id === nombreEn('bitnet', x.label)),
          `BitNet ofrece sólo su modelo y lo que no se puede descartar (${deBitnet.map(x => x.label).join(', ')})`);
        check(!deBitnet.some(x => x.source === 'Ollama' || /qwen|phi/.test(x.label)),
          'los GGUF de Ollama y de otras arquitecturas no se presentan como compatibles con BitNet');
        const deLlama = soloLectura._modelosDeMotor('llamacpp');
        check(deLlama.length === modelos.length - 1 && deLlama.every(x => x.compatibility === COMPATIBILITY.UNVERIFIED)
          && !deLlama.some(x => x.label === 'ggml-model-i2_s'),
          'llama.cpp ofrece los demás como «sin verificar» y no ofrece el modelo de BitNet');
      }

      // El gestor entero sobre ese disco: elegir modelo arranca, cambiar reinicia.
      const puerto = await puertoLibre();
      const baseOriginal = PROVIDERS.llamacpp.baseUrl;
      PROVIDERS.llamacpp.baseUrl = `http://127.0.0.1:${puerto}/v1`;
      const lanzados = [];
      const spawn = (cmd, args, opciones) => {
        if (/taskkill\.exe$/i.test(cmd)) return childProcess.spawn(cmd, args, opciones);
        lanzados.push({ cmd, args });
        return childProcess.spawn(process.execPath, [DOBLE, ...args], { stdio: 'ignore', windowsHide: true });
      };
      const motores = new GestorDeMotores({ spawn, env: { ...env, SystemRoot: process.env.SystemRoot }, platform: process.platform });
      const m = new AIProviderManager(baseFalsa(), { motores });
      const esperarListo = async () => {
        let r = await m.getReadiness('llamacpp');
        for (let i = 0; i < 100 && r.readiness !== READINESS.READY; i += 1) {
          await esperar(100);
          r = await m.getReadiness('llamacpp');
        }
        return r;
      };
      try {
        // Seguridad: descubrir un ejecutable no autoriza a ejecutarlo.
        const descubierto = await m.getReadiness('llamacpp', { autoStart: true });
        check(descubierto.readiness === READINESS.NEEDS_SETUP && descubierto.action === READINESS_ACTION.APPROVE_ENGINE
          && descubierto.models.length === 0 && lanzados.length === 0,
          'un llama-server descubierto en una carpeta del usuario no se ejecuta sin aprobación');
        let sinPermiso = null;
        try { await m.selectEngineModel('llamacpp', L('qwen-q4')); } catch (e) { sinPermiso = e.message; }
        await m.chat({ providerId: 'llamacpp', model: L('qwen-q4'), messages: [{ role: 'user', content: 'x' }] }).catch(() => {});
        check(sinPermiso === 'ENGINE_APPROVAL_REQUIRED' && lanzados.length === 0,
          'ni elegir un modelo ni escribir arrancan un ejecutable sin aprobar');
        let huellaAjena = null;
        try { m.approveEngine('llamacpp', '0'.repeat(64)); } catch (e) { huellaAjena = e.message; }
        check(huellaAjena === 'ENGINE_APPROVAL_REQUIRED', 'no se puede aprobar una huella distinta de la del fichero real');
        const identidad = m.engineIdentity('llamacpp');
        check(identidad.path === fs.realpathSync(exeA) && /^[0-9a-f]{64}$/.test(identidad.sha256) && !identidad.approved,
          'la identidad que se enseña es la ruta real y el SHA-256 del contenido');
        m.approveEngine('llamacpp', identidad.sha256);
        m.motores.reiniciarFallo('llamacpp');
        const inicial = await m.getReadiness('llamacpp', { autoStart: true });
        check(inicial.readiness === READINESS.AVAILABLE && inicial.action === null && inicial.canAttempt
          && inicial.models.length === modelos.length - 1 && lanzados.length === 0
          && !inicial.models.some(x => x.label === 'ggml-model-i2_s'),
          `el selector ofrece los modelos descubiertos menos el de BitNet, y nada arranca solo`);
        check(inicial.models.every(x => !('path' in x)) && !JSON.stringify(m.describeEngine('llamacpp').models).includes(tmp),
          'al renderer va el nombre del modelo, nunca su ruta');

        await m.selectEngineModel('llamacpp', L('qwen-q4'));
        check(/^[\x20-\x7E]+$/.test(aliasDe(L('qwen-q4'))) && aliasDe(L('qwen-q4')) === 'llama.cpp - qwen-q4',
          'el alias que se pasa al proceso del motor no lleva caracteres fuera de ASCII');
        check(lanzados.length === 1 && lanzados[0].cmd === fs.realpathSync(exeA)
          && lanzados[0].args.join(' ') === `-m ${enHf} --alias ${aliasDe(L('qwen-q4'))} -c 16384 -np 1 --host 127.0.0.1 --port ${puerto}`,
          'elegir un modelo arranca el motor descubierto con ese modelo');
        const listo = await esperarListo();
        check(listo.readiness === READINESS.READY && listo.engine.selectedModel === L('qwen-q4')
          && listo.models.length === modelos.length - 1,
          'con el motor en marcha el selector sigue ofreciendo todos los modelos');

        await m.selectEngineModel('llamacpp', L('qwen-q4'));
        check(listo.models.find(x => x.name === L('qwen-q4')).compatibility === 'compatible'
          && listo.models.filter(x => x.compatibility === 'compatible').length === 1,
          'un modelo que el motor cargó y sirve pasa a «compatible»: es la única prueba real');
        check(lanzados.length === 1, 'volver a elegir el mismo modelo no reinicia el motor');
        await m.selectEngineModel('llamacpp', L('phi-3'));
        check(lanzados.length === 2 && /phi-3\.gguf$/.test(lanzados[1].args[1]),
          'elegir otro modelo detiene el motor propio y lo arranca con el nuevo');
        check((await esperarListo()).engine.selectedModel === L('phi-3'), 'y el motor queda listo con el nuevo modelo');
        let ajeno = null;
        try { await m.selectEngineModel('llamacpp', L('ggml-model-i2_s')); } catch (e) { ajeno = e.message; }
        check(ajeno === 'ENGINE_MODEL_MISSING' && lanzados.length === 2 && Boolean(enBitnet),
          'un modelo de BitNet no se puede elegir en llama.cpp');

        const respuesta = await m.chat({
          providerId: 'llamacpp', model: L('sin-metadatos'), messages: [{ role: 'user', content: 'hola' }]
        });
        check(lanzados.length === 3 && /eco:/.test(respuesta.message?.content || ''),
          'escribir con otro modelo elegido basta: el chat cambia el motor y espera a que conteste');

        let rechazo = null;
        try { await m.selectEngineModel('llamacpp', '../../etc/passwd'); } catch (e) { rechazo = e.message; }
        check(rechazo === 'ENGINE_MODEL_MISSING' && lanzados.length === 3, 'un modelo que no se descubrió no se puede elegir');
        rechazo = null;
        try { m.selectEngineExecutable('llamacpp', path.join(tmp, 'bin', 'otro')); } catch (e) { rechazo = e.message; }
        check(rechazo === 'ENGINE_EXECUTABLE_NOT_ALLOWED', 'un ejecutable que no se descubrió no se puede elegir');
        // El fichero aprobado cambia de contenido: la aprobación deja de valer.
        await motores.detener('llamacpp');
        fs.writeFileSync(exeA, 'contenido sustituido');
        const sustituido = await m.getReadiness('llamacpp', { autoStart: true });
        const antesDeSustituido = lanzados.length;
        await m.chat({ providerId: 'llamacpp', model: L('qwen-q4'), messages: [{ role: 'user', content: 'x' }] }).catch(() => {});
        check(sustituido.action === READINESS_ACTION.APPROVE_ENGINE && lanzados.length === antesDeSustituido,
          'si el ejecutable aprobado cambia, MIKA5 deja de ejecutarlo y vuelve a pedir aprobación');
        const elegido = m.selectEngineExecutable('llamacpp', exeB);
        check(elegido.executable === exeB && elegido.executableApproved === false,
          'elegir otro motor descubierto no hereda la aprobación del anterior');
      } finally {
        await motores.detener('llamacpp');
        PROVIDERS.llamacpp.baseUrl = baseOriginal;
      }

      // Instalación y descarga: sólo la orden, con el gestor oficial.
      for (const repo of ['bartowski/Qwen2.5-7B-Instruct-GGUF', 'org/modelo-GGUF:Q4_K_M']) {
        check(HF_REPO_RE.test(repo), `${repo} es un repositorio válido`);
      }
      for (const repo of ['', 'sin-barra', 'a/b c', 'a/b;rm -rf', '--flag/x', 'a/b/c', 'https://x/y']) {
        check(!HF_REPO_RE.test(repo), `${JSON.stringify(repo)} no se acepta como repositorio`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  {
    const { spawn, llamadas } = spawnFalso();
    const winget = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe';
    const g = new GestorDeMotores({
      spawn, fs: fsFalso([winget]), net: netFalsa(false), platform: 'win32',
      env: { Path: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
    });
    const plan = g.planDeInstalacion(specLlama);
    check(plan && plan.gestor === 'winget' && plan.ejecutable === winget
      && plan.args.slice(0, 4).join(' ') === 'install --id ggml.llamacpp -e',
      'en Windows la instalación de llama.cpp es el paquete oficial de winget');
    check(g.planDeInstalacion(PROVIDERS.bitnet.engine) === null && Boolean(PROVIDERS.bitnet.engine.guia),
      'BitNet no tiene paquete: se ofrece su guía oficial, no una instalación inventada');
    check(llamadas.length === 0, 'calcular el plan de instalación no ejecuta nada');
    const instalando = g.instalar(specLlama);
    llamadas[0].hijo.emit('exit', 0, null);
    check((await instalando).ok === true && llamadas[0].opciones.shell === false, 'la instalación autorizada corre sin shell y espera a terminar');
    const fallando = g.instalar(specLlama);
    llamadas[1].hijo.emit('exit', 1, null);
    check((await fallando).errorCode === 'ENGINE_INSTALL_FAILED', 'una instalación que falla se informa como fallo');
    check((await gestorCon().instalar(specLlama)).errorCode === 'ENGINE_INSTALLER_UNAVAILABLE',
      'sin gestor de paquetes no se intenta instalar nada');

    const descarga = gestorCon({ spawn, plazoDeArranqueMs: 20 });
    const antes = llamadas.length;
    await descarga.iniciar('llamacpp', specLlama, { hf: 'org/modelo-GGUF', modelId: 'org/modelo-GGUF', approval: APROBACION }, { sinPlazo: true });
    check(llamadas[antes].args.join(' ') === '-hf org/modelo-GGUF --alias org/modelo-GGUF -c 16384 -np 1 --host 127.0.0.1 --port 8080',
      'la descarga la hace el propio llama-server con -hf, en bucle local');
    await esperar(60);
    check(descarga.estado('llamacpp').state === ESTADO_MOTOR.STARTING, 'una descarga autorizada no se corta por el plazo de arranque');
    check(conBitnet().diagnosticar(PROVIDERS.bitnet.engine, { hf: 'org/modelo-GGUF', approval: APROBACION }).errorCode === 'ENGINE_MODEL_REQUIRED',
      'BitNet no declara descarga: -hf no se le pasa nunca');
    descarga.detenerTodos();
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 9. Lo que no debe volver [estática] ===');
  // ---------------------------------------------------------------------
  const motoresSrc = leer('src/main/local-engines.js');
  const sinComentarios = motoresSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(!/shell:\s*true/.test(sinComentarios), 'local-engines.js nunca usa shell:true');
  check(!/\bexec(Sync|File|FileSync)?\s*\(/.test(sinComentarios), 'local-engines.js no usa exec: sólo spawn con argumentos separados');
  check(!/https?:\/\/(?!127\.0\.0\.1)/.test(sinComentarios) && !/download|fetch\(/i.test(sinComentarios),
    'local-engines.js no descarga ni instala nada');

  const mainSrc = leer('src/main/main.js');
  check(/autoStart:\s*opciones\?\.autoStart === true/.test(mainSrc),
    'el canal de preparación sólo arranca con autoStart estrictamente true');
  const canalEleccion = mainSrc.slice(mainSrc.indexOf("'ai:choose-engine-file'"), mainSrc.indexOf("'ai:choose-engine-file'") + 1400);
  check(/dialog\.showOpenDialog/.test(canalEleccion) && /\(_e, providerId, tipo\)/.test(canalEleccion),
    'la ruta de un motor la elige el usuario en un diálogo nativo: el renderer no la envía');
  check(/app\.on\("will-quit"[\s\S]{0,120}stopEngines\(\)/.test(mainSrc), 'los motores propios se detienen al salir');

  const preloadSrc = leer('src/main/preload.js');
  for (const canal of ['ai:install-engine', 'ai:download-engine-model', 'ai:download-catalog-model']) {
    const cuerpo = mainSrc.slice(mainSrc.indexOf(`ipcMain.handle('${canal}'`));
    const hasta = cuerpo.indexOf('\n});');
    const autoriza = cuerpo.indexOf('await autorizar(');
    const actua = cuerpo.search(/aiManager\.(installEngine|downloadEngineModel|downloadCatalogModel)\(/);
    check(autoriza > 0 && actua > autoriza && actua < hasta && /if \(!autorizado\) return/.test(cuerpo.slice(autoriza, actua)),
      `${canal} pide autorización en un diálogo nativo antes de hacer nada`);
  }
  const descubrimientoSrc = leer('src/main/engine-discovery.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(!/spawn|exec\(|fetch\(|https?:\/\/|writeFile|unlink|rmSync|mkdir/.test(descubrimientoSrc),
    'el descubrimiento sólo lee el disco: no ejecuta, no descarga, no escribe');
  for (const canal of ['ai:get-readiness', 'ai:start-engine', 'ai:describe-engine', 'ai:choose-engine-file',
    'ai:select-engine-model', 'ai:select-engine-executable', 'ai:approve-engine', 'ai:install-engine',
    'ai:download-catalog-model', 'ai:model-download-status', 'ai:cancel-model-download',
    'ai:download-engine-model']) {
    check(preloadSrc.includes(`'${canal}'`) && mainSrc.includes(`ipcMain.handle('${canal}'`),
      `${canal} está expuesto en preload y tiene handler`);
  }

  const appSrc = leer('src/renderer/app.js');
  const sondeo = appSrc.slice(appSrc.indexOf('function programarSondeoDePreparacion'), appSrc.indexOf('function renderProviderAction'));
  check(/clearTimeout\(readinessPollTimer\)/.test(sondeo) && /currentProvider !== proveedor/.test(sondeo),
    'el sondeo de arranque es único y se abandona si el usuario cambia de proveedor');
  check(/readinessPollEnCurso\) return;/.test(sondeo) && /finally \{\s*readinessPollEnCurso = false;/.test(sondeo),
    'una consulta de estado no se apila sobre otra que aún no ha vuelto');
  check(/< 30000 \? 2000 : 5000/.test(sondeo), 'el sondeo se espacia cuando la carga se alarga');
  check(/getReadiness\(undefined, \{ autoStart: true \}\)/.test(appSrc),
    'la interfaz sólo pide arranque automático para el proveedor seleccionado');

  const indexSrc = leer('src/renderer/index.html');
  const descripciones = [...indexSrc.matchAll(/<div class="provider-desc">([^<]*)<\/div>/g)].map(m => m[1]);
  check(descripciones.length === 8 && descripciones.every(d => !/--port|\b80\d\d\b|\.py\b|llama-server/.test(d)),
    'el selector de proveedores no enseña puertos ni órdenes de consola');

  const i18nSrc = leer('src/renderer/i18n.js');
  const bloqueEs = i18nSrc.slice(i18nSrc.indexOf('  es: {'), i18nSrc.indexOf('  en: {'));
  const bloqueEn = i18nSrc.slice(i18nSrc.indexOf('  en: {'));
  for (const accion of Object.values(READINESS_ACTION)) {
    check(bloqueEs.includes(`'provider.action.${accion}'`) && bloqueEn.includes(`'provider.action.${accion}'`),
      `la acción ${accion} tiene texto en español y en inglés`);
  }
  const codigosDeMotor = [...new Set([...motoresSrc.matchAll(/'(ENGINE_[A-Z_]+)'/g)].map(m => m[1]))]
    .filter(c => c !== 'ENGINE_NOT_MANAGED');
  check(codigosDeMotor.length >= 10 && codigosDeMotor.every(c =>
    bloqueEs.includes(`'provider.error.${c}'`) && bloqueEn.includes(`'provider.error.${c}'`)),
    `los ${codigosDeMotor.length} códigos de motor tienen mensaje comprensible en los dos idiomas`);
  for (const estado of [READINESS.STARTING, READINESS.LOADING_MODEL]) {
    check(bloqueEs.includes(`'provider.readiness.${estado}'`) && bloqueEn.includes(`'provider.readiness.${estado}'`),
      `el estado ${estado} tiene etiqueta en los dos idiomas`);
  }

  console.log('\n=== Ventana pequeña: lo que no cabe no se envía, y el motor caído se dice ===');
  {
    const http = require('http');
    const vistos = [];
    let ventanaDelServidor = 4096;
    let cortar = false;
    // Servidor mínimo con las tres rutas que usa el adaptador. Cuenta un token
    // por cada cuatro caracteres, como referencia fija para las cuentas.
    const servidor = http.createServer((req, res) => {
      let cuerpo = '';
      req.on('data', (parte) => { cuerpo += parte; });
      req.on('end', () => {
        const json = (estado, dato) => { res.writeHead(estado, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(dato)); };
        if (req.url === '/tokenize') return json(200, { tokens: Array.from({ length: Math.ceil(JSON.parse(cuerpo).content.length / 4) }, (_, i) => i) });
        if (req.url === '/props') return json(200, { default_generation_settings: { n_ctx: ventanaDelServidor } });
        if (req.url === '/v1/chat/completions') {
          vistos.push(JSON.parse(cuerpo));
          if (cortar) return req.socket.destroy();
          return json(200, { model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} });
        }
        return json(404, {});
      });
    });
    await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
    const raiz = `http://127.0.0.1:${servidor.address().port}`;
    const bitnet = PROVIDERS.bitnet;
    const llamacpp = PROVIDERS.llamacpp;
    const [baseBitnet, baseLlama] = [bitnet.baseUrl, llamacpp.baseUrl];
    bitnet.baseUrl = `${raiz}/v1`;
    llamacpp.baseUrl = `${raiz}/v1`;
    const charla = (caracteres) => [{ role: 'user', content: 'x'.repeat(caracteres) }];
    try {
      check(bitnet.engine.contexto && bitnet.engine.contexto.tokens === 4096 && llamacpp.engine.contexto === null,
        'BitNet declara su ventana de 4 096 tokens; llama.cpp no declara ninguna');

      await bitnet.chat({ model: 'm', messages: charla(4000) });
      // 4000 caracteres + «user: » = 1002 tokens, más 16 de plantilla.
      check(vistos.length === 1 && vistos[0].max_tokens === 4096 - 1018,
        `BitNet: la respuesta se limita a lo que queda de ventana (${vistos[0] && vistos[0].max_tokens} tokens)`);

      let error = null;
      try { await bitnet.chat({ model: 'm', messages: charla(15000) }); } catch (e) { error = e; }
      check(error && error.code === 'PROVIDER_CONTEXT_EXCEEDED' && vistos.length === 1
        && /no cabe en la ventana/.test(error.message) && /base de conocimiento/.test(error.message),
        'BitNet: un texto que no cabe se rechaza con un mensaje que dice qué hacer, y no llega al motor');

      // El motor arrancó con la variante de menos contexto: manda su ventana real.
      ventanaDelServidor = 2048;
      error = null;
      try { await bitnet.chat({ model: 'm', messages: charla(7000) }); } catch (e) { error = e; }
      check(error && error.code === 'PROVIDER_CONTEXT_EXCEEDED' && vistos.length === 1,
        'BitNet: la ventana que cuenta es la del servidor en marcha, no sólo la declarada');
      ventanaDelServidor = 4096;

      await llamacpp.chat({ model: 'm', messages: charla(15000) });
      check(vistos.length === 2 && vistos[1].max_tokens === 4096,
        'llama.cpp: sin ventana declarada nada cambia; mismo tope de respuesta de siempre');

      cortar = true;
      error = null;
      try { await bitnet.chat({ model: 'm', messages: charla(100) }); } catch (e) { error = e; }
      check(error && error.code === 'ENGINE_CLOSED_DURING_REQUEST' && /se cerró mientras respondía/.test(error.message),
        'si el motor corta la conexión a mitad de la respuesta, el error lo dice');
    } finally {
      bitnet.baseUrl = baseBitnet;
      llamacpp.baseUrl = baseLlama;
      await new Promise(resolve => servidor.close(resolve));
    }
  }

  console.log(`\nprovider-readiness: ${comprobaciones} comprobaciones OK`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
