// test/knowledge-scope-cli.test.js — Contrato de argumentos de la herramienta
// de mantenimiento de alcance de conocimiento.
// Run: node test/knowledge-scope-cli.test.js
//
// Módulo puro: no abre bases, no toca disco, no requiere Electron.

const path = require('path');
const { parseArgs, samePath, selectRepairState, CONFIRM_TOKEN, ARG_ERRORS } =
  require('../scripts/knowledge-scope-args');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertEq(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++; console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg} — esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  }
}

const REHEARSAL = path.join('C:', 'tmp', 'working-rehearsal');
const ORIGIN = path.join('C:', 'tmp', 'origen');
const REAL = path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'mika5-desktop');

console.log('\n=== --user-data es obligatorio siempre ===');
assertEq(parseArgs([]).error, ARG_ERRORS.MISSING_USER_DATA,
  'sin argumentos se rechaza');
assertEq(parseArgs(['--execute', '--confirm', CONFIRM_TOKEN]).error, ARG_ERRORS.MISSING_USER_DATA,
  'reparar sin --user-data se rechaza');
assertEq(parseArgs(['--user-data']).error, ARG_ERRORS.MISSING_VALUE,
  '--user-data sin valor se rechaza');
assertEq(parseArgs(['--user-data', '--execute']).error, ARG_ERRORS.MISSING_VALUE,
  '--user-data seguido de otra bandera no consume la bandera como valor');
assertEq(parseArgs(['--que-es-esto']).error, ARG_ERRORS.UNKNOWN_FLAG,
  'una bandera desconocida se rechaza en vez de ignorarse');

console.log('\n=== Inspección: sólo --user-data ===');
const inspect = parseArgs(['--user-data', REHEARSAL]);
assert(inspect.ok, 'inspeccionar sólo necesita --user-data');
assertEq(inspect.options.execute, false, 'sin --execute no se modifica nada');
assertEq(inspect.options.confirm, null, 'inspeccionar no exige --confirm');

console.log('\n=== Ejecución: exige --execute Y --confirm ===');
assertEq(parseArgs(['--user-data', REHEARSAL, '--execute']).error, ARG_ERRORS.MISSING_CONFIRM,
  '--execute sin --confirm se rechaza');
assertEq(parseArgs(['--user-data', REHEARSAL, '--execute', '--confirm', 'si']).error,
  ARG_ERRORS.BAD_CONFIRM, 'un --confirm con el texto equivocado se rechaza');
const exec = parseArgs(['--user-data', REHEARSAL, '--execute', '--confirm', CONFIRM_TOKEN]);
assert(exec.ok, 'con --execute y el --confirm exacto se acepta');
assertEq(exec.options.execute, true, 'la opción execute queda activa');

// --confirm por sí solo no habilita nada.
const soloConfirm = parseArgs(['--user-data', REHEARSAL, '--confirm', CONFIRM_TOKEN]);
assert(soloConfirm.ok && soloConfirm.options.execute === false,
  '--confirm sin --execute deja la herramienta en modo inspección');

console.log('\n=== userData real: exige --allow-real-user-data ===');
assertEq(parseArgs(['--user-data', REAL], REAL).error, ARG_ERRORS.REAL_USER_DATA_NOT_ALLOWED,
  'apuntar al userData real se rechaza incluso para inspeccionar');
assertEq(parseArgs(['--user-data', REAL.toUpperCase()], REAL).error,
  ARG_ERRORS.REAL_USER_DATA_NOT_ALLOWED,
  'cambiar mayúsculas no esquiva la comprobación en Windows');
assertEq(parseArgs(['--user-data', REAL + path.sep], REAL).error,
  ARG_ERRORS.REAL_USER_DATA_NOT_ALLOWED,
  'una barra final tampoco la esquiva');
assert(parseArgs(['--user-data', REAL, '--allow-real-user-data'], REAL).ok,
  'con la bandera explícita se permite');
assert(parseArgs(['--user-data', REHEARSAL], REAL).ok,
  'un userData de ensayo no necesita la bandera');

console.log('\n=== Rebase ===');
const rebased = parseArgs(['--user-data', REHEARSAL, '--rebase-from-user-data', ORIGIN]);
assert(rebased.ok, 'se acepta --rebase-from-user-data');
assertEq(rebased.options.rebaseFromUserData, ORIGIN, 'el origen se conserva tal cual');
assertEq(parseArgs(['--user-data', REHEARSAL, '--rebase-from-user-data', REHEARSAL]).error,
  ARG_ERRORS.REBASE_EQUALS_USER_DATA,
  'rebasar sobre el propio userData se rechaza: no sería un ensayo');

console.log('\n=== samePath ===');
assert(samePath(REHEARSAL, REHEARSAL + path.sep), 'la barra final no cambia la ruta');
assert(!samePath(REHEARSAL, ORIGIN), 'rutas distintas no se confunden');
assert(!samePath(null, REHEARSAL), 'null nunca coincide con una ruta');

console.log('\n=== Estado final: cleanupFailures no se confunde con reversión ===');
const limpio = selectRepairState({ ok: true, cleanupFailures: 0 });
assertEq(limpio.name, 'REPAIR_COMPLETE', 'reparación limpia');
assertEq(limpio.exit, 0, 'y sale con 0');

const sucio = selectRepairState({ ok: true, cleanupFailures: 2 });
assertEq(sucio.name, 'REPAIR_COMMITTED_CLEANUP_INCOMPLETE',
  'con residuo en disco el estado es propio, no REPAIR_COMPLETE');
assert(sucio.exit !== 0, 'y sale con código distinto de cero');
assert(sucio.name.includes('COMMITTED'),
  'el nombre dice que SQLite confirmó: no se afirma una reversión que no ocurrió');
assert(!sucio.name.includes('NOT_COMMITTED'),
  'y no se confunde con el caso en que no se tocó la base');

const noCommit = selectRepairState({ ok: false, cleanupFailures: 0 });
assertEq(noCommit.name, 'REPAIR_NOT_COMMITTED', 'una reparación abortada no confirmó nada');
assert(noCommit.exit !== 0, 'y también sale con código distinto de cero');
assertEq(selectRepairState({ ok: false, cleanupFailures: 5 }).name, 'REPAIR_NOT_COMMITTED',
  'si no hubo commit, el residuo no cambia el estado');
assertEq(selectRepairState(null).name, 'REPAIR_NOT_COMMITTED',
  'sin resultado se asume que no se confirmó');

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);
