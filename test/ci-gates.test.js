// test/ci-gates.test.js — La batería de gates se protege a sí misma.
// Run: node test/ci-gates.test.js
//
// Cubre tres fallos que ya ocurrieron o que no tendrían quien los detectase:
//
//   1. El parser del código del renderer dependía de un LF literal y rompía en
//      checkouts Windows con CRLF. Pasó dos veces.
//   2. Nada impedía que una suite desapareciera del gate canónico o de la
//      cadena `npm test`: el conjunto habría seguido en verde con menos
//      cobertura.
//   3. Nada impedía que el empaquetado dejara de depender de los gates y se
//      publicara sobre pruebas en rojo.
//
// No usa red, no lee credenciales y no toca userData.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeEol, sliceFunction, readRendererSource } = require('./helpers/renderer-source');

const ROOT = path.join(__dirname, '..');
let passed = 0;

function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

// =====================================================================
console.log('\n=== Parser del renderer: LF y CRLF equivalentes ===');
// =====================================================================

const FUENTE_LF = [
  'const antes = 1;',
  '',
  'async function ejemplo(a, b) {',
  '  if (a) {',
  '    return b;',
  '  }',
  '  return null;',
  '}',
  '',
  'const despues = 2;',
  ''
].join('\n');
const FUENTE_CRLF = FUENTE_LF.replace(/\n/g, '\r\n');

const desdeLf = sliceFunction(FUENTE_LF, 'ejemplo');
const desdeCrlf = sliceFunction(FUENTE_CRLF, 'ejemplo');

check(desdeLf === desdeCrlf,
  'LF y CRLF producen exactamente el mismo bloque');
check(desdeLf.startsWith('async function ejemplo('),
  'conserva el prefijo async: sin él un await del cuerpo no compilaría');
check(desdeLf.endsWith('\n}'),
  'el bloque termina en el cierre de columna 0');
check(!desdeCrlf.includes('\r'),
  'el resultado nunca devuelve CR, sea cual sea el checkout');
check(desdeLf.includes('return b;') && desdeLf.includes('return null;'),
  'el cuerpo llega completo, no truncado en la primera llave');

// Una llave interna en columna 0 dentro de una plantilla no debe cortar antes
// de tiempo en el caso simple; se comprueba que el bloque incluye ambos returns.
check(normalizeEol('a\r\nb\rc\nd') === 'a\nb\nc\nd',
  'normalizeEol convierte CRLF y CR sueltos');

// =====================================================================
console.log('\n=== Parser: fallos explícitos, nunca silenciosos ===');
// =====================================================================

assert.throws(() => sliceFunction(FUENTE_LF, 'noExiste'),
  /no se encontró function noExiste/,
  'una función inexistente lanza, no devuelve vacío');
passed++; console.log('  ✓ función inexistente lanza error explícito');

const INCOMPLETA = 'function truncada() {\n  const x = 1;\n';
assert.throws(() => sliceFunction(INCOMPLETA, 'truncada'),
  /sin cierre en columna 0/,
  'un bloque sin cierre lanza, no devuelve un fragmento parcial');
passed++; console.log('  ✓ bloque incompleto lanza error explícito');

assert.throws(() => sliceFunction(normalizeEol(INCOMPLETA).replace(/\n/g, '\r\n'), 'truncada'),
  /sin cierre en columna 0/);
passed++; console.log('  ✓ bloque incompleto también falla en CRLF');

// =====================================================================
console.log('\n=== Parser contra el renderer real ===');
// =====================================================================

const rendererPath = path.join(ROOT, 'src/renderer/app.js');
const renderer = readRendererSource(rendererPath);

check(!renderer.text.includes('\r'),
  'la fuente leída queda normalizada, aunque el checkout sea CRLF');

// Las funciones que test/alibaba-provider.test.js inspecciona de verdad.
for (const nombre of ['send', 'handlePendingVisualActionReply', 'snapshotMessageAttachments']) {
  const bloque = renderer.slice(nombre);
  check(bloque.length > 0 && bloque.endsWith('\n}'),
    `${nombre}() se localiza y cierra en columna 0`);
}

// El mismo archivo materializado con CRLF debe dar idéntico resultado. Se
// simula en memoria: el archivo del checkout no se toca.
const crudo = fs.readFileSync(rendererPath, 'utf8');
const comoCrlf = normalizeEol(crudo).replace(/\n/g, '\r\n');
for (const nombre of ['send', 'handlePendingVisualActionReply']) {
  check(sliceFunction(comoCrlf, nombre) === renderer.slice(nombre),
    `${nombre}() da el mismo bloque con el archivo materializado en CRLF`);
}

// =====================================================================
console.log('\n=== Manifiesto de gates: ninguna suite puede desaparecer ===');
// =====================================================================

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Suites que llegan encadenadas dentro de `npm test`, en un solo proceso.
const EN_NPM_TEST = [
  'test/rag.test.js',
  'test/vision.test.js',
  'test:alibaba',
  'test:provider-capabilities',
  'test:request-context',
  'test:provider-cancellation',
  'test:cloud-consent',
  'test:network-security',
  'test:knowledge-cli',
  'test:ci-gates',
  'test:palette'
];
for (const suite of EN_NPM_TEST) {
  check(pkg.scripts.test.includes(suite),
    `npm test encadena ${suite}`);
}

// Scripts que deben existir, se invoquen desde el gate canónico o a mano.
const SCRIPTS_REQUERIDOS = [
  'test', 'test:all', 'test:db', 'test:rag', 'test:vision', 'test:alibaba',
  'test:provider-capabilities', 'test:request-context', 'test:provider-cancellation',
  'test:cloud-consent', 'test:network-security', 'test:knowledge-scope',
  'test:knowledge-cli', 'test:ci-gates', 'test:palette', 'test:electron-renderer',
  'test:electron-security', 'test:image-download-electron',
  'knowledge:preflight', 'knowledge:repair'
];
for (const nombre of SCRIPTS_REQUERIDOS) {
  check(typeof pkg.scripts[nombre] === 'string' && pkg.scripts[nombre].length > 0,
    `package.json conserva el script ${nombre}`);
}

// Cada script test:* debe apuntar a un archivo que exista.
for (const [nombre, comando] of Object.entries(pkg.scripts)) {
  if (!nombre.startsWith('test:') && !nombre.startsWith('knowledge:')) continue;
  const referido = comando.match(/(?:test|scripts)\/[\w.-]+\.js/);
  if (!referido) continue;
  check(fs.existsSync(path.join(ROOT, referido[0])),
    `${nombre} apunta a un archivo existente (${referido[0]})`);
}

// Gate canónico local.
const gateScript = normalizeEol(
  fs.readFileSync(path.join(ROOT, 'scripts/run-stage0a-gates.sh'), 'utf8'));
const GATES_CANONICOS = [
  'npm-test', 'db', 'knowledge-scope',
  'electron-security', 'electron-renderer-integration', 'image-download-electron'
];
const bloqueNames = gateScript.slice(gateScript.indexOf('NAMES=('), gateScript.indexOf(')', gateScript.indexOf('NAMES=(')));
for (const gate of GATES_CANONICOS) {
  check(bloqueNames.includes(`"${gate}"`),
    `run-stage0a-gates.sh incluye el gate ${gate}`);
}
check(!/continue-on-error|allow[-_]failure|\|\|\s*true/.test(gateScript),
  'el gate canónico no tolera fallos');
check(gateScript.includes('exit $FAILED'),
  'el gate canónico propaga un exit code distinto de cero');

// =====================================================================
console.log('\n=== Workflow: el empaquetado depende de los gates ===');
// =====================================================================

const workflowPath = path.join(ROOT, '.github/workflows/build.yml');
const workflowRaw = normalizeEol(fs.readFileSync(workflowPath, 'utf8'));

let workflow = null;
try {
  workflow = require('js-yaml').load(workflowRaw);
  console.log('  · YAML parseado con js-yaml');
} catch (error) {
  console.log(`  · js-yaml no disponible (${error.code || 'error'}): se valida la estructura sin parser`);
}

if (workflow) {
  check(typeof workflow.jobs === 'object' && workflow.jobs !== null,
    'el workflow declara jobs');
  check(Boolean(workflow.on && workflow.on.pull_request),
    'el workflow se ejecuta en pull_request');
  check(workflow.permissions && workflow.permissions.contents === 'read',
    'permisos mínimos: contents: read');

  const qg = workflow.jobs['quality-gates'];
  check(Boolean(qg), 'existe el job quality-gates');
  const os = qg && qg.strategy && qg.strategy.matrix && qg.strategy.matrix.os;
  check(Array.isArray(os) && os.includes('ubuntu-latest') && os.includes('windows-latest'),
    'quality-gates cubre ubuntu-latest y windows-latest');

  const dependeDeGates = nombre => {
    const necesita = workflow.jobs[nombre] && workflow.jobs[nombre].needs;
    const lista = Array.isArray(necesita) ? necesita : (necesita ? [necesita] : []);
    if (lista.includes('quality-gates')) return true;
    return lista.some(dependeDeGates);
  };
  for (const trabajo of ['build-windows', 'build-macos', 'build-linux']) {
    check(dependeDeGates(trabajo),
      `${trabajo} depende de quality-gates (directa o transitivamente)`);
  }

  const texto = JSON.stringify(workflow);
  check(!texto.includes('continue-on-error'),
    'ningún job usa continue-on-error');

  // Ningún paso de los gates puede leer secretos.
  const pasosGates = JSON.stringify(qg || {});
  check(!pasosGates.includes('secrets.'),
    'quality-gates no lee ningún secreto');
} else {
  check(/^\s*quality-gates:/m.test(workflowRaw), 'existe el job quality-gates');
  check(/needs:[\s\S]{0,200}quality-gates/.test(workflowRaw),
    'algún job depende de quality-gates');
  check(!workflowRaw.includes('continue-on-error'), 'ningún job usa continue-on-error');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`CI gates tests passed (${passed} comprobaciones)`);
console.log(`${'='.repeat(40)}`);
