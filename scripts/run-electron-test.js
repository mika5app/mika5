#!/usr/bin/env node
'use strict';

// Lanzador de pruebas Electron con perfil aislado.
//
//   node scripts/run-electron-test.js <archivo-de-prueba> [args-de-electron...]
//
// Por qué existe: los scripts `electron test/*.js` arrancaban con el perfil por
// defecto, que en esta app es el userData REAL (%APPDATA%/mika5-desktop en
// Windows). Una prueba lanzada a mano escribía caché, Preferences y
// almacenamiento local del usuario. Ocurrió.
//
// Aquí el aislamiento no es opcional: cada ejecución recibe un directorio nuevo
// bajo os.tmpdir() y quien llama no puede sustituirlo — un `--user-data-dir`
// externo se descarta antes de construir la línea de comandos.
//
// Sin npx, sin `npm exec`, sin nada descargable: el binario sale de
// require('electron'), es decir, del Electron ya instalado en node_modules.
//
// El módulo no importa Electron ni lanza procesos al requerirse: todo el
// trabajo vive en funciones inyectables para poder probarlas.

const child_process = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_DATA_FLAG = '--user-data-dir';
const PROFILE_PREFIX = 'mika5-electron-test-';

/**
 * Descarta cualquier --user-data-dir que venga de fuera, en sus dos formas:
 * `--user-data-dir=RUTA` y `--user-data-dir RUTA`. El aislamiento lo decide
 * este lanzador, no quien lo invoca.
 */
function stripUserDataDir(args = []) {
  const limpio = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === USER_DATA_FLAG) {
      // Forma separada: descarta también su valor, si lo tiene.
      if (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i++;
      continue;
    }
    if (arg.startsWith(`${USER_DATA_FLAG}=`)) continue;
    limpio.push(arg);
  }
  return limpio;
}

/** El perfil aislado va primero: ningún argumento posterior puede desplazarlo. */
function buildElectronArgs({ testFile, profileDir, extraArgs = [] }) {
  if (!testFile) throw new Error('run-electron-test: falta el archivo de prueba');
  if (!profileDir) throw new Error('run-electron-test: falta el directorio de perfil');
  return [`${USER_DATA_FLAG}=${profileDir}`, ...stripUserDataDir(extraArgs), testFile];
}

/** Directorio único por ejecución; nunca uno reutilizado ni fijo. */
function createProfileDir({ mkdtemp = fs.mkdtempSync, tmpdir = os.tmpdir } = {}) {
  return mkdtemp(path.join(tmpdir(), PROFILE_PREFIX));
}

/**
 * Sólo el Electron local. `require('electron')` devuelve la ruta del binario
 * cuando se resuelve desde Node (no desde el proceso Electron).
 */
function resolveElectronBinary({ requireFn = require } = {}) {
  const binario = requireFn('electron');
  if (typeof binario !== 'string' || !binario) {
    throw new Error('run-electron-test: electron local no resuelto; ejecuta npm install');
  }
  return binario;
}

/** Espera síncrona sin dependencias, para los reintentos de borrado. */
function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/**
 * En Windows el proceso puede soltar los ficheros del perfil un instante
 * después de salir: un único intento de borrado falla con EBUSY/EPERM. Se
 * reintenta un número acotado de veces y, si aun así no se puede, se avisa sin
 * tumbar el resultado de la prueba.
 */
function removeProfileDir(dir, { rm = fs.rmSync, sleep = sleepSync, attempts = 5, delayMs = 120, log = console.warn } = {}) {
  if (!dir) return false;
  for (let intento = 1; intento <= attempts; intento++) {
    try {
      rm(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (intento === attempts) {
        log(`run-electron-test: no se pudo borrar el perfil temporal ${dir}: ${err.message}`);
        return false;
      }
      sleep(delayMs);
    }
  }
  return false;
}

/**
 * Devuelve el código de salida del hijo. Un error de spawn o una señal cuentan
 * como fallo: nunca se traducen a 0.
 */
function runElectronTest(testFile, extraArgs = [], deps = {}) {
  const {
    spawn = child_process.spawnSync,
    mkdtemp,
    tmpdir,
    rm,
    sleep,
    requireFn,
    log = console.warn,
    stdio = 'inherit',
    env = process.env
  } = deps;

  const binario = resolveElectronBinary({ requireFn });
  const profileDir = createProfileDir({ mkdtemp, tmpdir });

  try {
    const args = buildElectronArgs({ testFile, profileDir, extraArgs });
    const resultado = spawn(binario, args, { stdio, env });
    if (resultado && resultado.error) {
      log(`run-electron-test: no se pudo lanzar electron: ${resultado.error.message}`);
      return 1;
    }
    if (resultado && resultado.signal) {
      log(`run-electron-test: electron terminó por señal ${resultado.signal}`);
      return 1;
    }
    return typeof resultado?.status === 'number' ? resultado.status : 1;
  } finally {
    removeProfileDir(profileDir, { rm, sleep, log });
  }
}

function main(argv = process.argv.slice(2)) {
  const [testFile, ...extraArgs] = argv;
  if (!testFile) {
    console.error('uso: node scripts/run-electron-test.js <archivo-de-prueba> [args-de-electron...]');
    return 2;
  }
  return runElectronTest(testFile, extraArgs);
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  USER_DATA_FLAG,
  PROFILE_PREFIX,
  stripUserDataDir,
  buildElectronArgs,
  createProfileDir,
  resolveElectronBinary,
  removeProfileDir,
  runElectronTest,
  main
};
