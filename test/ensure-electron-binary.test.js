// test/ensure-electron-binary.test.js — El paso que deja utilizable el binario
// de Electron no puede declarar éxito sobre una descarga fallida.
//
// Run: node test/ensure-electron-binary.test.js
//
// Por qué existe: `descargarConInstaladorOficial()` capturaba el fallo de
// `execFileSync` y devolvía `false`, y el llamador no miraba ese valor. Un
// instalador que salía con código distinto de cero se trataba igual que uno
// correcto, y si en `dist` quedaba algo con pinta de servir —otra versión, o
// una extracción a medias— la instalación se daba por buena. El fallo no
// desaparecía: reaparecía en el primer arranque, lejos de su causa.
//
// QUÉ NO PRUEBA ESTO. No comprueba el checksum del zip ni el comportamiento de
// la caché: eso es de `@electron/get`, que valida el artefacto tanto al
// descargarlo como al encontrarlo en caché, y simularlo aquí sólo daría una
// falsa sensación de cobertura. Esa conducta se ejerce con el paquete real, en
// CI, corrompiendo un zip de una caché de prueba.
//
// Cada caso monta un paquete electron de mentira en un directorio temporal: sin
// red, sin tocar `node_modules` y sin usar artefactos reales de la usuaria.

'use strict';

const assert = require('assert');
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
const temporales = [];

/** Paquete electron de mentira: package.json con la versión e `install.js`. */
function montarPaquete({ conInstalador = true } = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-eeb-'));
  temporales.push(raiz);
  const dirElectron = path.join(raiz, 'node_modules', 'electron');
  fs.mkdirSync(dirElectron, { recursive: true });
  fs.writeFileSync(path.join(dirElectron, 'package.json'), JSON.stringify({ version: VERSION }));
  if (conInstalador) fs.writeFileSync(path.join(dirElectron, 'install.js'), '// descargador de mentira\n');
  return { raiz, dirElectron };
}

/**
 * Simula lo que deja `install.js`: `dist/version`, el ejecutable, y un
 * `path.txt` que apunta a él.
 */
function instalar(dirElectron, { version = VERSION, binario = 'electron.exe', pathTxt = binario } = {}) {
  const dist = path.join(dirElectron, 'dist');
  fs.mkdirSync(path.dirname(path.join(dist, binario)), { recursive: true });
  fs.writeFileSync(path.join(dist, 'version'), `v${version}\n`);
  fs.writeFileSync(path.join(dist, binario), 'MZ-de-mentira');
  if (pathTxt !== null) fs.writeFileSync(path.join(dirElectron, 'path.txt'), pathTxt);
}

function ejecutar(paquete, descargar) {
  const registros = [];
  try {
    modulo.principal({ dirElectron: paquete.dirElectron, descargar, registrar: (m) => registros.push(m) });
    return { registros, error: null };
  } catch (error) {
    return { registros, error };
  }
}

// =====================================================================
console.log('\n=== 1. Electron ausente: nada que asegurar ===');
// =====================================================================
{
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-eeb-sin-'));
  temporales.push(raiz);
  let invocaciones = 0;
  const r = ejecutar({ dirElectron: path.join(raiz, 'node_modules', 'electron') },
    () => { invocaciones++; });
  check(r.error === null, '`npm ci --omit=dev` no falla por no tener electron');
  check(invocaciones === 0, 'no se invoca al descargador');
}

// =====================================================================
console.log('\n=== 2. install.js ausente con el paquete presente ===');
// =====================================================================
{
  const p = montarPaquete({ conInstalador: false });
  let lanzo = null;
  try {
    modulo.descargarConInstaladorOficial({ dirElectron: p.dirElectron, ejecutar: () => {} });
  } catch (e) { lanzo = e; }
  check(lanzo instanceof Error, 'lanza en vez de continuar en silencio');
  check(/no trae install\.js/.test(lanzo.message), 'el mensaje lo dice');
}

// =====================================================================
console.log('\n=== 3. Instalación válida ===');
// =====================================================================
{
  const p = montarPaquete();
  const r = ejecutar(p, ({ dirElectron }) => instalar(dirElectron));
  check(r.error === null, 'no lanza');
  check(r.registros.some(m => m.includes('listo') && m.includes('electron.exe')),
    `declara el binario listo nombrando el ejecutable ("${r.registros[r.registros.length - 1]}")`);
}
{
  // Idempotente: si ya está, no se invoca al instalador.
  const p = montarPaquete();
  instalar(p.dirElectron);
  let invocaciones = 0;
  const r = ejecutar(p, () => { invocaciones++; });
  check(r.error === null && invocaciones === 0, 'con la instalación ya válida no se descarga nada');
  check(r.registros.some(m => m.includes('ya presente')), 'y lo dice el log');
}

// =====================================================================
console.log('\n=== 4. Instalador con exit distinto de cero ===');
// =====================================================================
{
  const p = montarPaquete();
  const causa = new Error('Command failed: node install.js');
  causa.status = 7;
  let lanzo = null;
  try {
    modulo.descargarConInstaladorOficial({ dirElectron: p.dirElectron, ejecutar: () => { throw causa; } });
  } catch (e) { lanzo = e; }
  check(lanzo instanceof Error, 'lanza en vez de devolver false');
  check(/código de salida 7/.test(lanzo.message), `el mensaje lleva el código real (${lanzo.message})`);
  check(lanzo.cause === causa, 'la causa original queda en `cause`');
}

// =====================================================================
console.log('\n=== 5. Instalador terminado por señal ===');
// =====================================================================
{
  const p = montarPaquete();
  const causa = new Error('killed');
  causa.signal = 'SIGKILL';
  let lanzo = null;
  try {
    modulo.descargarConInstaladorOficial({ dirElectron: p.dirElectron, ejecutar: () => { throw causa; } });
  } catch (e) { lanzo = e; }
  check(/señal SIGKILL/.test(lanzo.message), `la señal se nombra (${lanzo.message})`);
  check(lanzo.cause === causa, 'y la causa original se conserva');
}

// =====================================================================
console.log('\n=== 6. Fallo que deja dist parcial ===');
// =====================================================================
{
  // El caso que el defecto original daba por bueno: la descarga revienta pero
  // en dist queda una instalación con pinta de servir.
  const p = montarPaquete();
  const causa = new Error('Command failed');
  causa.status = 1;
  const r = ejecutar(p, ({ dirElectron }) => { instalar(dirElectron); throw causa; });
  check(r.error instanceof Error, 'lanza pese a que dist quedó aparentemente utilizable');
  check(!r.registros.some(m => m.includes('listo')), 'no se declara ningún binario listo');
  check(fs.existsSync(path.join(p.dirElectron, 'dist', 'electron.exe')),
    'el fichero parcial sigue en disco: lo que cambia es el veredicto, no el disco');
}

// =====================================================================
console.log('\n=== 7. Exit cero sin binario válido ===');
// =====================================================================
{
  const p = montarPaquete();
  const r = ejecutar(p, () => { /* termina bien y no instala nada */ });
  check(r.error instanceof Error, 'lanza');
  check(/terminó sin error pero no dejó utilizable/.test(r.error.message),
    'y distingue ese caso del instalador que falla');
  check(/no hay .*version/.test(r.error.message), 'nombra lo que falta');
}

// =====================================================================
console.log('\n=== 8. dist/version incorrecto ===');
// =====================================================================
{
  const p = montarPaquete();
  const r = ejecutar(p, ({ dirElectron }) => instalar(dirElectron, { version: '31.7.7' }));
  check(r.error instanceof Error, 'una versión distinta a la del paquete no se acepta');
  check(/dist\/version dice 31\.7\.7/.test(r.error.message) && r.error.message.includes(VERSION),
    'el mensaje contrasta ambas versiones');
}

// =====================================================================
console.log('\n=== 9. path.txt ausente o inválido ===');
// =====================================================================
{
  const p = montarPaquete();
  const r = ejecutar(p, ({ dirElectron }) => instalar(dirElectron, { pathTxt: null }));
  check(r.error instanceof Error && /no hay .*path\.txt/.test(r.error.message),
    'sin path.txt no hay instalación utilizable');
}
{
  const p = montarPaquete();
  const r = ejecutar(p, ({ dirElectron }) => instalar(dirElectron, { pathTxt: '   ' }));
  check(r.error instanceof Error && /está vacío/.test(r.error.message), 'un path.txt vacío se rechaza');
}
{
  const p = montarPaquete();
  const r = ejecutar(p, ({ dirElectron }) => instalar(dirElectron, { pathTxt: 'no-existe.exe' }));
  check(r.error instanceof Error && /apunta a no-existe\.exe/.test(r.error.message),
    'un path.txt que apunta a un fichero inexistente se rechaza');
}
{
  const p = montarPaquete();
  const r = ejecutar(p, ({ dirElectron }) => instalar(dirElectron, { pathTxt: '../../fuera.exe' }));
  check(r.error instanceof Error && /no es una ruta relativa dentro de dist/.test(r.error.message),
    'un path.txt que escapa de dist se rechaza');
}
{
  const p = montarPaquete();
  const absoluta = process.platform === 'win32' ? 'C:\\fuera.exe' : '/fuera.exe';
  const r = ejecutar(p, ({ dirElectron }) => instalar(dirElectron, { pathTxt: absoluta }));
  check(r.error instanceof Error && /no es una ruta relativa dentro de dist/.test(r.error.message),
    'un path.txt absoluto se rechaza');
}

// =====================================================================
console.log('\n=== 10. La plataforma la decide el instalador, no el wrapper ===');
// =====================================================================
//
// El wrapper no reproduce la precedencia de ELECTRON_INSTALL_PLATFORM /
// ELECTRON_INSTALL_ARCH / npm_config_* / proceso: lee `path.txt`, que es lo que
// `install.js` escribe con el resultado de esa decisión. Se comprueba que acepta
// la instalación resultante sea cual sea la plataforma elegida, y que no hay
// ninguna lógica propia de plataforma que pueda discrepar.
{
  const casos = [
    { clave: 'ELECTRON_INSTALL_PLATFORM', valor: 'darwin', binario: 'Electron.app/Contents/MacOS/Electron' },
    { clave: 'ELECTRON_INSTALL_PLATFORM', valor: 'linux', binario: 'electron' },
    { clave: 'ELECTRON_INSTALL_ARCH', valor: 'arm64', binario: 'electron.exe' }
  ];
  for (const caso of casos) {
    const previo = process.env[caso.clave];
    process.env[caso.clave] = caso.valor;
    try {
      const p = montarPaquete();
      const r = ejecutar(p, ({ dirElectron }) =>
        instalar(dirElectron, { binario: caso.binario, pathTxt: caso.binario }));
      check(r.error === null,
        `con ${caso.clave}=${caso.valor} acepta la instalación que dejó el instalador (${caso.binario})`);
    } finally {
      if (previo === undefined) delete process.env[caso.clave];
      else process.env[caso.clave] = previo;
    }
  }
}
{
  // Sólo el código: los comentarios SÍ nombran esas variables, precisamente
  // para explicar que quien las resuelve es el instalador oficial.
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ensure-electron-binary.js'), 'utf8')
    .split('\n')
    .filter(linea => !/^\s*(\/\/|\*|\/\*)/.test(linea))
    .join('\n');
  check(!/process\.platform/.test(codigo)
    && !/npm_config_platform/.test(codigo)
    && !/npm_config_arch/.test(codigo),
    'el wrapper no reimplementa la selección de plataforma ni arquitectura');
  check(!/createHash|sha256|checksums\.json/.test(codigo),
    'el wrapper no reimplementa checksums: eso es de @electron/get');
  check(!/Expand-Archive|unzip|yauzl|extract/i.test(codigo),
    'el wrapper no reimplementa la extracción');
}

// ---------------------------------------------------------------------------
for (const dir of temporales) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
}

console.log(`\n${'='.repeat(40)}`);
console.log(`ensure-electron-binary: ${passed} comprobaciones OK`);
