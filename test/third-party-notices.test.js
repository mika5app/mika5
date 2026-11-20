'use strict';

// Los avisos de terceros no pueden quedarse atrás respecto a las dependencias.
//
// THIRD_PARTY_NOTICES.md se genera desde package-lock.json. Si alguien añade o
// actualiza una dependencia de producción sin regenerarlo, la aplicación se
// distribuiría con una lista de licencias que ya no es cierta.
//
//   npm run test:third-party-notices

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const raiz = path.join(__dirname, '..');
const resultado = spawnSync(process.execPath, [path.join(raiz, 'scripts/generate-third-party-notices.js'), '--check'], {
  cwd: raiz, encoding: 'utf8'
});
assert.strictEqual(resultado.status, 0, `THIRD_PARTY_NOTICES.md desfasado:\n${resultado.stderr || resultado.stdout}`);

const avisos = fs.readFileSync(path.join(raiz, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const lock = JSON.parse(fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8'));
const produccion = Object.entries(lock.packages).filter(([ruta, datos]) => ruta && !datos.dev);
for (const [ruta, datos] of produccion) {
  const nombre = ruta.replace(/^.*node_modules\//, '');
  assert(avisos.includes(`| ${nombre} | ${datos.version} |`), `falta ${nombre} ${datos.version} en los avisos`);
}
assert(!/\| UNKNOWN \|/.test(avisos), 'ninguna dependencia de producción queda sin licencia declarada');
const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
assert.strictEqual(pkg.license, 'AGPL-3.0', 'MIKA5 Community se declara AGPL-3.0');
assert(/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/.test(fs.readFileSync(path.join(raiz, 'LICENSE'), 'utf8')),
  'LICENSE es el texto de la AGPL versión 3');
for (const doc of ['README.md', 'COMMUNITY.md', 'CONTRIBUTING.md', 'BUILDING.md']) {
  assert(fs.existsSync(path.join(raiz, doc)), `${doc} existe`);
}
const contribuir = fs.readFileSync(path.join(raiz, 'CONTRIBUTING.md'), 'utf8');
// El repositorio de código es público desde noviembre de 2026: las incidencias
// del código van ahí, y contribuir es hacer un fork de ESE repositorio. Antes
// esta prueba exigía lo contrario, porque el fork que se describía era de un
// repositorio que no existía en público.
assert(contribuir.includes('https://github.com/mika5app/mika5/issues'),
  'CONTRIBUTING.md dice dónde abrir incidencias');
assert(/git clone https:\/\/github\.com\/<your-username>\/mika5\.git/.test(contribuir)
  && !/github\.com\/<your-username>\/MIKA5\.git/.test(contribuir),
  'CONTRIBUTING.md describe el fork del repositorio público, con su nombre real');

console.log(`Third-party notices tests passed (${produccion.length} dependencias de producción)`);
