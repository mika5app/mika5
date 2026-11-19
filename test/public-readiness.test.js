// test/public-readiness.test.js — Lo que el repositorio promete al hacerse
// publico y al pedir firma de codigo tiene que seguir siendo verdad.
//
// Run: node test/public-readiness.test.js
//
// Por que existe: son documentos y reglas faciles de romper sin que ninguna
// otra suite lo note. Una politica de firma que diga que los binarios estan
// firmados cuando no lo estan, o un flujo que entregue un secreto a un pull
// request de fuera, no hace fallar ninguna prueba de la aplicacion.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const leer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

console.log('\n=== 1. Documentos que un repositorio Community publico necesita ===');
for (const archivo of ['LICENSE', 'README.md', 'BUILDING.md', 'CONTRIBUTING.md', 'COMMUNITY.md', 'SECURITY.md',
  'CODE_OF_CONDUCT.md', 'TRADEMARK.md', 'PRIVACY.md', 'CODE_SIGNING_POLICY.md', '.github/CODEOWNERS']) {
  check(fs.existsSync(path.join(ROOT, archivo)) && leer(archivo).trim().length > 40, `${archivo} existe`);
}
check(/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s*\n\s*Version 3,/.test(leer('LICENSE')), 'LICENSE es el texto de AGPL-3.0');
const pkg = JSON.parse(leer('package.json'));
check(pkg.license === 'AGPL-3.0', 'package.json declara AGPL-3.0');
check(/Developer Certificate of Origin/.test(leer('CONTRIBUTING.md')) && !/contributor licen[cs]e agreement/i.test(leer('CONTRIBUTING.md')),
  'las contribuciones entran con DCO, sin un acuerdo que permita relicenciarlas');

console.log('\n=== 2. Privacidad ===');
const DECLARACION = 'This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.';
check(leer('PRIVACY.md').includes(DECLARACION), 'PRIVACY.md lleva la declaracion de no transferencia');
check(leer('CODE_SIGNING_POLICY.md').includes(DECLARACION) && /\(PRIVACY\.md\)/.test(leer('CODE_SIGNING_POLICY.md')),
  'la politica de firma repite la declaracion y enlaza la de privacidad');

console.log('\n=== 3. Politica de firma: no afirma lo que no es ===');
const firma = leer('CODE_SIGNING_POLICY.md');
check(/^# Code signing policy/m.test(firma), 'usa el termino «Code signing policy»');
const flujos = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter(f => /\.ya?ml$/.test(f));
const usaSignPath = flujos.some(f => /signpath/i.test(leer(`.github/workflows/${f}`)));
check(usaSignPath || /are not code-signed yet/.test(firma),
  'mientras ningun flujo firme, la politica dice que los binarios no estan firmados');
check(usaSignPath || /not code-signed yet/.test(leer('README.md')), 'y el README tambien');
for (const rol of ['Authors', 'Reviewers', 'Approvers']) {
  check(new RegExp(`\\| ${rol}[^|]*\\| \\[@[A-Za-z0-9-]+\\]\\(https://github\\.com/`).test(firma), `nombra quien tiene el rol ${rol}`);
}
check(/SignPath\.io/.test(firma) && /SignPath Foundation/.test(firma), 'nombra a SignPath.io y a SignPath Foundation');
check(/^\* @[A-Za-z0-9-]+$/m.test(leer('.github/CODEOWNERS')), 'CODEOWNERS asigna revisor a todo cambio');

console.log('\n=== 4. Los secretos no llegan a codigo no confiable ===');
check(flujos.length >= 4, `se revisan los ${flujos.length} flujos de trabajo`);
for (const archivo of flujos) {
  const texto = leer(`.github/workflows/${archivo}`);
  check(!/pull_request_target/.test(texto), `${archivo}: no usa pull_request_target`);
  if (!/secrets\./.test(texto)) continue;
  const disparaConPr = /^\s{2}pull_request:/m.test(texto);
  // Un flujo que tambien corre en pull requests solo puede leer secretos en
  // trabajos condicionados a una etiqueta de version.
  if (disparaConPr) {
    const trabajos = texto.split(/\n(?=  [a-z][a-z0-9_-]*:\n)/).filter(t => /secrets\./.test(t));
    check(trabajos.length > 0 && trabajos.every(t => /\n    if: github\.ref_type == 'tag'/.test(t)),
      `${archivo}: todo trabajo que lee un secreto exige una etiqueta de version`);
  } else {
    check(/^\s{2}(push|workflow_dispatch):/m.test(texto), `${archivo}: lee secretos y no se dispara con pull requests`);
  }
}

console.log('\n=== 5. Nada personal en lo que se publica ===');
const ignorar = new Set(['.git', 'node_modules', 'dist', 'vendor', 'package-lock.json']);
const personales = [];
(function recorrer(dir) {
  for (const nombre of fs.readdirSync(dir)) {
    if (ignorar.has(nombre)) continue;
    const ruta = path.join(dir, nombre);
    const st = fs.statSync(ruta);
    if (st.isDirectory()) { recorrer(ruta); continue; }
    if (st.size > 2 * 1024 * 1024 || !/\.(js|json|md|html|yml|yaml|txt|sh|css|xml)$/.test(nombre)) continue;
    const texto = fs.readFileSync(ruta, 'utf8');
    // Rutas de perfil de una persona concreta y buzones personales. Los avisos
    // de terceros llevan los correos de sus autores: no son nuestros.
    if (/[A-Za-z]:\\Users\\(?!runneradmin|Public|<)[A-Za-z0-9._-]+\\/.test(texto)
      || (/[A-Za-z0-9._%+-]+@(hotmail|outlook|live)\.[a-z.]+/.test(texto) && !/THIRD_PARTY_NOTICES/.test(nombre))) {
      personales.push(path.relative(ROOT, ruta));
    }
  }
})(ROOT);
check(personales.length === 0, `ningun fichero lleva rutas de perfil ni buzones personales (${personales.join(', ') || 'ninguno'})`);

console.log(`\n${'='.repeat(46)}`);
console.log(`Public readiness tests passed (${passed} comprobaciones)`);
console.log(`${'='.repeat(46)}`);
