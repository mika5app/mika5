// test/electron-test-isolation.test.js — Ninguna prueba Electron puede arrancar
// con el perfil por defecto.
//
// Run: node test/electron-test-isolation.test.js
//
// Por qué existe: los scripts `electron test/*.js` usaban el userData por
// defecto, que en esta aplicación es el real (%APPDATA%/mika5-desktop). Una
// ejecución suelta escribió caché y Preferences del usuario. El lanzador
// scripts/run-electron-test.js impone un perfil temporal por ejecución; esta
// suite comprueba que nadie pueda saltárselo: ni un argumento externo, ni un
// script nuevo en package.json, ni el gate canónico volviendo a `npx electron`.
//
// No abre Electron, no usa red, no instala dependencias y no toca userData: el
// lanzador se ejerce con dependencias inyectadas.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeEol } = require('./helpers/renderer-source');

const ROOT = path.join(__dirname, '..');
let passed = 0;

function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

// =====================================================================
console.log('\n=== El módulo no hace nada al importarse ===');
// =====================================================================

// Requerir el lanzador no puede abrir Electron ni lanzar procesos: si lo
// hiciera, cualquier prueba que lo importe arrancaría un navegador.
const spawnReal = require('child_process').spawnSync;
let spawnsDuranteImport = 0;
require('child_process').spawnSync = (...args) => { spawnsDuranteImport++; return spawnReal(...args); };
const tmpAntes = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('mika5-electron-test-')).length;
const launcher = require('../scripts/run-electron-test.js');
require('child_process').spawnSync = spawnReal;
const tmpDespues = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('mika5-electron-test-')).length;

check(spawnsDuranteImport === 0, 'importar el lanzador no lanza ningún proceso');
check(tmpDespues === tmpAntes, 'importar el lanzador no crea directorios de perfil');
check(typeof launcher.runElectronTest === 'function' && typeof launcher.buildElectronArgs === 'function',
  'el lanzador exporta funciones inyectables para poder probarlo');
const fuenteLanzador = normalizeEol(fs.readFileSync(path.join(ROOT, 'scripts/run-electron-test.js'), 'utf8'));
check(fuenteLanzador.includes('if (require.main === module)'),
  'el lanzador sólo se ejecuta cuando es el módulo principal');
check(!/^const .*require\('electron'\)/m.test(fuenteLanzador),
  'electron no se importa en la carga del módulo');

// =====================================================================
console.log('\n=== Perfil temporal único y obligatorio ===');
// =====================================================================

const perfiles = [];
const depsBase = () => ({
  requireFn: () => '/ruta/falsa/electron',
  mkdtemp: prefijo => {
    const dir = `${prefijo}${perfiles.length}`;
    perfiles.push(dir);
    return dir;
  },
  tmpdir: () => '/tmp-falso',
  rm: () => {},
  sleep: () => {},
  log: () => {}
});

{
  const llamadas = [];
  const deps = Object.assign(depsBase(), {
    spawn: (bin, args) => { llamadas.push({ bin, args }); return { status: 0 }; }
  });
  launcher.runElectronTest('test/uno.test.js', [], deps);
  launcher.runElectronTest('test/dos.test.js', [], deps);

  check(llamadas.length === 2, 'cada ejecución lanza Electron una vez');
  const perfil = arg => (arg.find(a => a.startsWith('--user-data-dir=')) || '').split('=')[1];
  check(llamadas.every(l => Boolean(perfil(l.args))),
    'toda invocación incluye --user-data-dir');
  check(perfil(llamadas[0].args) !== perfil(llamadas[1].args),
    'cada ejecución recibe un directorio distinto');
  check(perfil(llamadas[0].args).includes('mika5-electron-test-'),
    `el perfil vive bajo el temporal del sistema (${perfil(llamadas[0].args)})`);
  check(llamadas[0].args[0].startsWith('--user-data-dir='),
    'el perfil va primero: ningún argumento posterior lo desplaza');
  check(llamadas[0].args[llamadas[0].args.length - 1] === 'test/uno.test.js',
    'el archivo de prueba queda como aplicación a ejecutar');
  check(llamadas[0].bin === '/ruta/falsa/electron',
    'se usa el binario resuelto por require("electron")');
}

// Un --user-data-dir externo no puede sustituir al aislado, ni pegado ni suelto.
{
  const externos = [
    ['--user-data-dir=C:/Users/alguien/AppData/Roaming/mika5-desktop'],
    ['--user-data-dir', 'C:/Users/alguien/AppData/Roaming/mika5-desktop'],
    ['--no-sandbox', '--user-data-dir=/real', '--disable-gpu']
  ];
  for (const extra of externos) {
    const llamadas = [];
    const deps = Object.assign(depsBase(), {
      spawn: (bin, args) => { llamadas.push(args); return { status: 0 }; }
    });
    launcher.runElectronTest('test/uno.test.js', extra, deps);
    const args = llamadas[0];
    const perfilesEnArgs = args.filter(a => a === '--user-data-dir' || a.startsWith('--user-data-dir='));
    check(perfilesEnArgs.length === 1 && perfilesEnArgs[0].includes('mika5-electron-test-'),
      `un --user-data-dir externo se descarta (${extra.join(' ')})`);
    check(!args.some(a => String(a).includes('mika5-desktop')) && !args.includes('/real'),
      'la ruta externa no sobrevive en ninguna forma');
  }
  check(launcher.stripUserDataDir(['--no-sandbox', '--user-data-dir', '/x', '--lang=es']).join(' ')
    === '--no-sandbox --lang=es',
    'stripUserDataDir conserva el resto de argumentos legítimos');
  check(launcher.buildElectronArgs({ testFile: 't.js', profileDir: '/p', extraArgs: ['--no-sandbox'] }).join(' ')
    === '--user-data-dir=/p --no-sandbox t.js',
    'los argumentos legítimos se preservan en su orden');
}

// =====================================================================
console.log('\n=== Códigos de salida y limpieza ===');
// =====================================================================

function ejecutar({ spawn, rmFalla = false }) {
  const borrados = [];
  const deps = Object.assign(depsBase(), {
    spawn,
    rm: dir => {
      borrados.push(dir);
      if (rmFalla && borrados.length < 3) throw new Error('EBUSY');
    }
  });
  let lanzado = null;
  let codigo;
  try {
    codigo = launcher.runElectronTest('test/uno.test.js', [], deps);
  } catch (err) {
    lanzado = err;
  }
  return { codigo, borrados, lanzado };
}

{
  const ok = ejecutar({ spawn: () => ({ status: 0 }) });
  check(ok.codigo === 0, 'un exit 0 del hijo se propaga tal cual');
  check(ok.borrados.length === 1, 'el perfil se borra tras una ejecución correcta');

  const fallo = ejecutar({ spawn: () => ({ status: 3 }) });
  check(fallo.codigo === 3, 'un exit distinto de cero se propaga sin traducirse');
  check(fallo.borrados.length === 1, 'el perfil se borra también cuando la prueba falla');

  const senal = ejecutar({ spawn: () => ({ status: null, signal: 'SIGTERM' }) });
  check(senal.codigo !== 0, `una señal cuenta como fallo (código ${senal.codigo})`);
  check(senal.borrados.length === 1, 'el perfil se borra tras una señal');

  const errorSpawn = ejecutar({ spawn: () => ({ error: new Error('ENOENT') }) });
  check(errorSpawn.codigo !== 0, 'un error de spawn cuenta como fallo');
  check(errorSpawn.borrados.length === 1, 'el perfil se borra tras un error de spawn');

  const excepcion = ejecutar({ spawn: () => { throw new Error('spawn explotó'); } });
  check(excepcion.lanzado instanceof Error, 'una excepción de spawn se propaga');
  check(excepcion.borrados.length === 1, 'el perfil se borra aunque spawn lance');

  const conReintentos = ejecutar({ spawn: () => ({ status: 0 }), rmFalla: true });
  check(conReintentos.borrados.length === 3,
    `el borrado reintenta cuando Windows retiene el perfil (${conReintentos.borrados.length} intentos)`);
  check(conReintentos.codigo === 0, 'los reintentos de borrado no alteran el resultado de la prueba');
}

{
  // Si el borrado nunca funciona, avisa pero no convierte una prueba verde en roja.
  const avisos = [];
  const ok = launcher.removeProfileDir('/p', {
    rm: () => { throw new Error('EPERM'); },
    sleep: () => {},
    attempts: 3,
    delayMs: 0,
    log: msg => avisos.push(msg)
  });
  check(ok === false && avisos.length === 1, 'un borrado imposible se reporta una sola vez');
}

// =====================================================================
console.log('\n=== Ningún camino vuelve al perfil por defecto ===');
// =====================================================================

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SUITES_ELECTRON = [
  'test:db', 'test:knowledge-scope', 'test:electron-renderer',
  'test:electron-security', 'test:image-download-electron', 'test:print-pdf-electron'
];
for (const nombre of SUITES_ELECTRON) {
  const comando = pkg.scripts[nombre];
  check(typeof comando === 'string' && comando.startsWith('node scripts/run-electron-test.js '),
    `${nombre} pasa por el lanzador (${comando})`);
}

// Cualquier script de prueba que invoque electron a pelo vuelve a abrir el
// agujero: se prohíbe la forma, no sólo los nombres conocidos.
for (const [nombre, comando] of Object.entries(pkg.scripts)) {
  if (!nombre.startsWith('test:')) continue;
  check(!/(^|\s|&&\s*)(npx\s+)?electron\s/.test(comando),
    `${nombre} no invoca electron directamente`);
  check(!/npm\s+exec/.test(comando), `${nombre} no usa npm exec`);
}
check(!/--user-data-dir/.test(JSON.stringify(pkg.scripts)),
  'ningún script de package.json fija un user-data-dir a mano');

const gateScript = normalizeEol(fs.readFileSync(path.join(ROOT, 'scripts/run-stage0a-gates.sh'), 'utf8'));
check(!/npx\s+electron/.test(gateScript), 'el gate canónico ya no usa npx electron');
const bloqueCmds = gateScript.slice(gateScript.indexOf('CMDS=('), gateScript.indexOf(')', gateScript.indexOf('CMDS=(')));
// El comentario que documenta la restricción sí nombra el flag; lo que no puede
// aparecer es un --user-data-dir en los comandos que se ejecutan.
check(!/--user-data-dir/.test(bloqueCmds), 'ningún comando del gate fija un user-data-dir propio');
const comandosElectron = (bloqueCmds.match(/scripts\/run-electron-test\.js/g) || []).length;
check(comandosElectron === 8, `los ocho gates de Electron pasan por el lanzador (${comandosElectron})`);
// El comentario puede partirse en varias líneas: se comprueba el contenido, no
// una frase exacta.
const comentarioArgs = gateScript
  .slice(0, gateScript.indexOf('NAMES=('))
  .split('\n')
  .map(linea => linea.replace(/^#\s?/, ''))
  .join(' ');
check(/MIKA5_ELECTRON_ARGS/.test(comentarioArgs)
  && /no puede suministrar --user-data-dir/i.test(comentarioArgs)
  && /run-electron-test\.js/.test(comentarioArgs),
  'la restricción de MIKA5_ELECTRON_ARGS queda documentada en el gate');

const bloqueNames = gateScript.slice(gateScript.indexOf('NAMES=('), gateScript.indexOf(')', gateScript.indexOf('NAMES=(')));
const nombresDeclarados = (bloqueNames.match(/"[^"]+"/g) || []).length;
const comandosDeclarados = (bloqueCmds.match(/"[^"]+"/g) || []).length;
check(nombresDeclarados === 9 && comandosDeclarados === 9,
  `el gate canónico sigue siendo 9/9 (${nombresDeclarados} nombres, ${comandosDeclarados} comandos)`);

check(fs.existsSync(path.join(ROOT, 'scripts/run-electron-test.js')),
  'el lanzador existe en la ruta que declaran los scripts');

// =====================================================================
console.log('\n=== La limpieza sólo alcanza a los procesos de esta ejecución ===');
// =====================================================================

// Una prueba que agota su plazo deja Electron vivos, y esos huérfanos hunden
// las corridas siguientes. Barrer por nombre lo arregla y mata de paso el
// Electron de cualquier otra aplicación del usuario, MIKA5 abierta de verdad
// incluida. El perfil temporal es único por ejecución: identifica exactamente
// los procesos propios y ningún otro.
// Aquí sólo se comprueba la FORMA de la selección. Que mate de verdad al
// superviviente propio y respete al ajeno se comprueba con procesos reales en
// test/kill-survivors.test.js: un doble de `exec` que siempre devuelve "2"
// verifica el texto del comando y nada más — y con la primera versión, que
// incrustaba la ruta con JSON.stringify y no casaba nunca, ese doble pasaba
// mientras la limpieza no mataba nada.
{
  const llamadas = [];
  const execFalso = (comando, args, opciones) => {
    llamadas.push({ comando, args, opciones });
    return '2';
  };

  const perfilPropio = path.join(os.tmpdir(), 'mika5-electron-test-abc123');
  const matados = launcher.killSurvivors(perfilPropio, { exec: execFalso, log: () => {} });
  check(matados === 2, `informa de los procesos terminados (${matados})`);

  const orden = llamadas.flatMap(l => l.args).join(' ');
  const entorno = llamadas.map(l => (l.opciones && l.opciones.env) || {});
  check(entorno.some(e => e.MIKA5_TEST_PROFILE_DIR === perfilPropio),
    'la ruta viaja por entorno, sin escapado que pueda romperla');
  check(!orden.includes(perfilPropio),
    'y no se incrusta en el script, donde JSON.stringify duplicaba las barras');
  check(!/Name\s*=\s*.?electron/i.test(orden),
    'no se selecciona por nombre de proceso, que alcanzaría a aplicaciones ajenas');
  check(/Stop-Process -Id|pkill/.test(orden),
    'se termina por identificador de proceso resuelto, no por patrón suelto');
  check(/ProcessId -ne \$PID/.test(orden),
    'el PowerShell ejecutor queda excluido: matarse a sí mismo ocultaría el resultado');

  // Sin un perfil reconocible no se mata nada: un patrón corto o vacío podría
  // coincidir con cualquier cosa.
  for (const invalido of ['', null, undefined, path.join(os.tmpdir(), 'otra-cosa'), '/']) {
    llamadas.length = 0;
    const r = launcher.killSurvivors(invalido, { exec: execFalso, log: () => {} });
    check(r === 0 && llamadas.length === 0,
      `un perfil no reconocible (${JSON.stringify(invalido)}) no dispara ninguna terminación`);
  }

  check(fs.existsSync(path.join(ROOT, 'test/kill-survivors.test.js')),
    'existe la prueba con procesos reales, que es la que demuestra que mata');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Electron test isolation tests passed (${passed} comprobaciones)`);
console.log(`${'='.repeat(40)}`);
