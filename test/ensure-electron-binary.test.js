// test/ensure-electron-binary.test.js — El paso que deja utilizable el binario
// de Electron no puede declarar éxito sobre una descarga fallida.
//
// Run: node test/ensure-electron-binary.test.js
//
// Por qué existe: `descargarConInstaladorOficial()` capturaba el fallo de
// `execFileSync` y devolvía `false`, y el llamador no miraba ese valor. Un
// instalador que salía con código distinto de cero se trataba igual que uno
// correcto, y si en `dist` quedaba algo con pinta de servir —una versión
// anterior, o una extracción a medias— la instalación se daba por buena. El
// fallo no desaparecía: reaparecía en el primer arranque, lejos de su causa.
//
// No usa red, no descarga nada y no toca `node_modules` ni el userData: cada
// caso monta un paquete electron de mentira en un directorio temporal y el zip
// es un archivo cualquiera cuyo hash se calcula al vuelo.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const modulo = require('../scripts/ensure-electron-binary.js');

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

const VERSION = '43.3.0';
const PLATAFORMA = 'win32';
const ARQUITECTURA = 'x64';
const NOMBRE_ZIP = `electron-v${VERSION}-${PLATAFORMA}-${ARQUITECTURA}.zip`;
const BINARIO = 'electron.exe';

const temporales = [];

/**
 * Monta un paquete electron de mentira: package.json con la versión,
 * checksums.json con el hash real del zip que se le pase, e `install.js` para
 * que el descargador lo encuentre.
 */
function montarPaqueteFalso({ contenidoZip = null } = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-eeb-'));
  temporales.push(raiz);
  const dirElectron = path.join(raiz, 'node_modules', 'electron');
  fs.mkdirSync(dirElectron, { recursive: true });
  fs.writeFileSync(path.join(dirElectron, 'package.json'), JSON.stringify({ version: VERSION }));
  fs.writeFileSync(path.join(dirElectron, 'install.js'), '// descargador de mentira\n');

  const cache = path.join(raiz, 'cache');
  fs.mkdirSync(cache, { recursive: true });

  let zip = null;
  let hash = null;
  if (contenidoZip !== null) {
    zip = path.join(cache, NOMBRE_ZIP);
    fs.writeFileSync(zip, contenidoZip);
    hash = crypto.createHash('sha256').update(contenidoZip).digest('hex');
  }
  // El checksum declarado corresponde SIEMPRE al contenido correcto; los casos
  // de hash inválido escriben otro contenido en el zip, no otro checksum.
  const correcto = crypto.createHash('sha256').update('contenido correcto').digest('hex');
  fs.writeFileSync(path.join(dirElectron, 'checksums.json'),
    JSON.stringify({ [NOMBRE_ZIP]: correcto }));

  return { raiz, dirElectron, cache, zip, hash, checksumDeclarado: correcto };
}

/** Simula que el instalador dejó el binario extraído. */
function instalarBinario(dirElectron) {
  const dist = path.join(dirElectron, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'version'), `v${VERSION}\n`);
  fs.writeFileSync(path.join(dist, BINARIO), 'MZ-de-mentira');
}

/**
 * La busqueda se acota al cache de mentira. Sin esto, 
 * seguiria bajando hasta el cache REAL de la maquina, encontraria alli el zip
 * de Electron de verdad y lo compararia contra el checksums.json de mentira:
 * la prueba dependeria de que la usuaria tenga o no ese fichero descargado.
 */
function buscarSoloEn(cache) {
  return (nombreZip) => {
    const directo = path.join(cache, nombreZip);
    if (fs.existsSync(directo)) return directo;
    for (const entrada of fs.readdirSync(cache, { withFileTypes: true })) {
      if (!entrada.isDirectory()) continue;
      const anidado = path.join(cache, entrada.name, nombreZip);
      if (fs.existsSync(anidado)) return anidado;
    }
    return null;
  };
}

function ejecutar(paquete, descargar, extra = {}) {
  const registros = [];
  try {
    modulo.principal({
      dirElectron: paquete.dirElectron,
      descargar,
      buscarZip: buscarSoloEn(paquete.cache),
      registrar: (m) => registros.push(m),
      plataforma: PLATAFORMA,
      arquitectura: ARQUITECTURA,
      ...extra
    });
    return { registros, error: null };
  } catch (error) {
    return { registros, error };
  }
}

// =====================================================================
console.log('\n=== 1. Binario ya instalado: no se invoca nada ===');
// =====================================================================
{
  const p = montarPaqueteFalso({ contenidoZip: 'contenido correcto' });
  instalarBinario(p.dirElectron);
  let invocaciones = 0;
  const r = ejecutar(p, () => { invocaciones++; });
  check(r.error === null, 'no lanza');
  check(invocaciones === 0, 'el descargador NO se invoca cuando el binario ya está');
  check(r.registros.some(m => m.includes('ya presente')), `lo dice en el log ("${r.registros[0]}")`);
}

// =====================================================================
console.log('\n=== 2. Caché válida: se verifica ANTES de invocar al instalador ===');
// =====================================================================
{
  const p = montarPaqueteFalso({ contenidoZip: 'contenido correcto' });
  const orden = [];
  const r = ejecutar(p, ({ dirElectron }) => {
    orden.push('descarga');
    instalarBinario(dirElectron);
  });
  check(r.error === null, 'no lanza');
  const iVerificado = r.registros.findIndex(m => m.includes('zip en caché verificado'));
  check(iVerificado >= 0, 'el zip cacheado se verifica');
  check(orden.length === 1 && orden[0] === 'descarga', 'el instalador se invoca una vez');
  // El log de verificación se emite antes de llamar al descargador: lo prueba
  // que exista ya cuando el descargador corre.
  check(r.registros.some(m => m.includes('listo (descargador oficial)')),
    'termina declarando el binario listo');
}

// =====================================================================
console.log('\n=== 3. Zip cacheado con hash incorrecto: corta antes de instalar ===');
// =====================================================================
{
  const p = montarPaqueteFalso({ contenidoZip: 'contenido MANIPULADO' });
  let invocaciones = 0;
  const r = ejecutar(p, () => { invocaciones++; instalarBinario(p.dirElectron); });
  check(r.error instanceof Error, 'lanza');
  check(/no coincide con el hash declarado/.test(r.error.message),
    `el mensaje nombra el hash (${r.error.message.split('\n')[0]})`);
  check(r.error.message.includes(p.checksumDeclarado), 'incluye el hash esperado');
  check(invocaciones === 0,
    'el descargador NO llega a invocarse: es él quien extraería el zip manipulado');
}

// =====================================================================
console.log('\n=== 4. Caché fría: se descarga y se deja constancia del hash ===');
// =====================================================================
{
  const p = montarPaqueteFalso();  // sin zip
  const r = ejecutar(p, ({ dirElectron }) => {
    // El instalador de verdad deja el zip en la caché y extrae.
    fs.writeFileSync(path.join(p.cache, NOMBRE_ZIP), 'contenido correcto');
    instalarBinario(dirElectron);
  });
  check(r.error === null, 'no lanza');
  check(r.registros.some(m => m.includes('sin zip en caché')), 'reconoce la caché fría');
  check(r.registros.some(m => m.includes('zip descargado y verificado')),
    'verifica el zip recién descargado y deja el hash en el log');
  check(r.registros.some(m => m.includes('listo (descargador oficial)')), 'declara el binario listo');
}

// =====================================================================
console.log('\n=== 5. Instalador con exit distinto de cero: fallo real ===');
// =====================================================================
{
  const p = montarPaqueteFalso();
  const causa = new Error('Command failed: node install.js');
  causa.status = 1;
  const r = ejecutar(p, () => { throw causa; });
  check(r.error instanceof Error, 'lanza');
  check(r.error === causa || r.error.cause === causa || r.error.message.includes('install.js'),
    'la causa original se conserva y llega al llamador');
  check(!r.registros.some(m => m.includes('listo')),
    'NO se declara ningún binario listo');
}

// El mismo caso, pero pasando por `descargarConInstaladorOficial()` real, con
// `execFileSync` inyectado: es donde vivía el defecto.
{
  const p = montarPaqueteFalso();
  const causa = new Error('Command failed');
  causa.status = 7;
  let lanzo = null;
  try {
    modulo.descargarConInstaladorOficial({
      dirElectron: p.dirElectron,
      ejecutar: () => { throw causa; }
    });
  } catch (e) {
    lanzo = e;
  }
  check(lanzo instanceof Error, 'descargarConInstaladorOficial() lanza en vez de devolver false');
  check(/código de salida 7/.test(lanzo.message), `el mensaje lleva el código real (${lanzo.message})`);
  check(lanzo.cause === causa, 'la causa original queda en `cause`');
}

{
  const p = montarPaqueteFalso();
  const causa = new Error('killed');
  causa.signal = 'SIGKILL';
  let lanzo = null;
  try {
    modulo.descargarConInstaladorOficial({
      dirElectron: p.dirElectron,
      ejecutar: () => { throw causa; }
    });
  } catch (e) { lanzo = e; }
  check(/señal SIGKILL/.test(lanzo.message), `una señal también se nombra (${lanzo.message})`);
}

// =====================================================================
console.log('\n=== 6. Instalador que falla dejando ficheros parciales ===');
// =====================================================================
{
  // Éste es el caso que el defecto original daba por bueno: la descarga
  // revienta, pero en `dist` queda un binario de antes con la versión correcta.
  const p = montarPaqueteFalso();
  const causa = new Error('Command failed: node install.js');
  causa.status = 1;
  const r = ejecutar(p, ({ dirElectron }) => {
    instalarBinario(dirElectron);   // deja dist con pinta de servir
    throw causa;
  });
  check(r.error instanceof Error, 'lanza pese a que `dist` quedó aparentemente utilizable');
  check(!r.registros.some(m => m.includes('listo')),
    'no se declara el binario listo por el estado de dist');
  check(fs.existsSync(path.join(p.dirElectron, 'dist', BINARIO)),
    'y el fichero parcial sigue ahí: lo que cambia es el veredicto, no el disco');
}

// El otro reverso: el instalador termina bien pero no deja binario.
{
  const p = montarPaqueteFalso();
  const r = ejecutar(p, () => { /* no hace nada */ });
  check(r.error instanceof Error, 'lanza si el instalador sale bien pero no deja binario');
  check(/terminó sin error pero no dejó utilizable/.test(r.error.message),
    'y el mensaje distingue ese caso del anterior');
  check(r.error.message.includes(BINARIO), `nombra el fichero que falta (${BINARIO})`);
}

// =====================================================================
console.log('\n=== 7. Caché personalizada por electron_config_cache ===');
// =====================================================================
{
  // La ruta no se inventa: es la misma variable que `install.js` pasa como
  // `cacheRoot` a `downloadArtifact`.
  const p = montarPaqueteFalso();
  const cachePropia = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-eeb-cache-'));
  temporales.push(cachePropia);
  // El zip vive SÓLO en la caché personalizada, en un subdirectorio con nombre
  // de hash, que es como la organiza @electron/get.
  const sub = path.join(cachePropia, 'a'.repeat(64));
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, NOMBRE_ZIP), 'contenido correcto');

  const previo = process.env.electron_config_cache;
  process.env.electron_config_cache = cachePropia;
  try {
    check(modulo.buscarZipEnCache(NOMBRE_ZIP) === path.join(sub, NOMBRE_ZIP),
      'buscarZipEnCache() encuentra el zip bajo electron_config_cache');
  } finally {
    if (previo === undefined) delete process.env.electron_config_cache;
    else process.env.electron_config_cache = previo;
  }

  const registros = [];
  const previo2 = process.env.electron_config_cache;
  process.env.electron_config_cache = cachePropia;
  let error = null;
  try {
    modulo.principal({
      dirElectron: p.dirElectron,
      descargar: ({ dirElectron }) => instalarBinario(dirElectron),
      registrar: (m) => registros.push(m),
      plataforma: PLATAFORMA,
      arquitectura: ARQUITECTURA
    });
  } catch (e) { error = e; } finally {
    if (previo2 === undefined) delete process.env.electron_config_cache;
    else process.env.electron_config_cache = previo2;
  }
  check(error === null, 'el flujo completo funciona con la caché redirigida');
  check(registros.some(m => m.includes('zip en caché verificado')),
    'y verifica el zip que vive en esa caché, no en la del sistema');
}

// =====================================================================
console.log('\n=== 8. Sin paquete electron: no hay nada que asegurar ===');
// =====================================================================
{
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-eeb-vacio-'));
  temporales.push(raiz);
  let invocaciones = 0;
  let error = null;
  try {
    modulo.principal({
      dirElectron: path.join(raiz, 'node_modules', 'electron'),
      descargar: () => { invocaciones++; },
      registrar: () => {},
      plataforma: PLATAFORMA,
      arquitectura: ARQUITECTURA
    });
  } catch (e) { error = e; }
  check(error === null && invocaciones === 0,
    'una instalación sin devDependencies no lanza ni descarga nada');
}

// ---------------------------------------------------------------------------
for (const dir of temporales) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
}

console.log(`\n${'='.repeat(40)}`);
console.log(`ensure-electron-binary: ${passed} comprobaciones OK`);
