'use strict';

// SheetJS vendorizado: procedencia, licencia y extracción real de XLS y XLSX.
//
// Por qué existe: el paquete `xlsx` del registro npm está congelado en 0.18.5
// —SheetJS dejó de publicar allí— con prototype pollution y ReDoS sin arreglo
// posible por esa vía. `npm audit fix` no podía corregirlo y nunca podrá.
//
// La dependencia se declara ahora como `file:vendor/xlsx-0.20.3.tgz`: el
// tarball vive en el repositorio, así que `npm ci` no depende del CDN de
// SheetJS ni de ninguna red. Lo que hay que vigilar es lo que eso implica —
// que el artefacto sea exactamente el aprobado y no otro— y que la
// funcionalidad que dependía de la versión vieja siga funcionando.
//
//   node test/xlsx-vendored.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const RAIZ = path.join(__dirname, '..');
let comprobaciones = 0;
const fallos = [];
function check(condicion, mensaje) {
  comprobaciones += 1;
  if (condicion) console.log(`  ✓ ${mensaje}`);
  else { fallos.push(mensaje); console.log(`  ✗ ${mensaje}`); }
}

/**
 * Nombres de las entradas de un .tgz, leídos en Node.
 *
 * Sin `tar` del sistema a propósito: en Windows, `tar -tzf C:\ruta` interpreta
 * `C:` como un host remoto y falla. El formato es de cabeceras fijas de 512
 * bytes y aquí sólo hacen falta los nombres.
 */
function listarTarball(ruta) {
  const datos = zlib.gunzipSync(fs.readFileSync(ruta));
  const nombres = [];
  for (let posicion = 0; posicion + 512 <= datos.length;) {
    const nombre = datos.subarray(posicion, posicion + 100).toString('utf8').replace(/\0.*$/, '');
    if (!nombre) break; // dos bloques nulos marcan el final
    const octal = datos.subarray(posicion + 124, posicion + 136).toString('utf8').replace(/\0.*$/, '').trim();
    const tamano = parseInt(octal, 8) || 0;
    nombres.push(nombre);
    posicion += 512 + Math.ceil(tamano / 512) * 512;
  }
  return nombres;
}

// Procedencia aprobada. Cambiar el tarball sin cambiar este valor no puede
// pasar en silencio: es la única barrera entre «vendorizado» y «alguien metió
// otro artefacto en vendor/».
const TARBALL = 'vendor/xlsx-0.20.3.tgz';
const SHA256_APROBADO = '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8';
const VERSION_APROBADA = '0.20.3';
const ORIGEN = 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz';

console.log('\n=== 1. El artefacto vendorizado es exactamente el aprobado ===');
{
  const ruta = path.join(RAIZ, TARBALL);
  check(fs.existsSync(ruta), `${TARBALL} está en el repositorio, no se descarga al instalar`);
  const obtenido = crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
  check(obtenido === SHA256_APROBADO,
    `su SHA-256 es el aprobado (${obtenido})`);
  console.log(`      origen: ${ORIGEN}`);
}

console.log('\n=== 2. Se declara e instala desde el repositorio ===');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  check(pkg.dependencies.xlsx === `file:${TARBALL}`,
    `package.json apunta al tarball local (${pkg.dependencies.xlsx})`);
  check(!/^https?:/.test(pkg.dependencies.xlsx),
    'la dependencia no es una URL: npm ci no sale a la red por ella');

  const lock = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package-lock.json'), 'utf8'));
  const entrada = lock.packages['node_modules/xlsx'];
  check(entrada && entrada.version === VERSION_APROBADA,
    `package-lock fija ${VERSION_APROBADA} (${entrada && entrada.version})`);
  check(entrada && entrada.resolved === `file:${TARBALL}`,
    `y lo resuelve desde el repositorio (${entrada && entrada.resolved})`);
  check(entrada && typeof entrada.integrity === 'string' && entrada.integrity.startsWith('sha512-'),
    'el lock registra su integridad');

  const instalado = JSON.parse(fs.readFileSync(path.join(RAIZ, 'node_modules/xlsx/package.json'), 'utf8'));
  check(instalado.version === VERSION_APROBADA,
    `la versión instalada es ${VERSION_APROBADA} y no la 0.18.5 del registro (${instalado.version})`);
}

console.log('\n=== 3. Licencia Apache-2.0 conservada ===');
{
  const licencia = fs.readFileSync(path.join(RAIZ, 'node_modules/xlsx/LICENSE'), 'utf8');
  check(/Apache License/.test(licencia) && /Version 2\.0/.test(licencia),
    'el paquete instalado conserva su LICENSE de Apache-2.0');
  const instalado = JSON.parse(fs.readFileSync(path.join(RAIZ, 'node_modules/xlsx/package.json'), 'utf8'));
  check(instalado.license === 'Apache-2.0', `y lo declara en package.json (${instalado.license})`);

  // Apache-2.0 §4(d) sólo obliga a propagar NOTICE si el original trae uno.
  // Se comprueba el hecho en vez de asumirlo: si una versión futura lo añade,
  // esto obliga a decidir dónde se propaga en lugar de perderlo.
  const entradas = listarTarball(path.join(RAIZ, TARBALL));
  const traeNotice = entradas.some(e => /^package\/NOTICE/i.test(e.trim()));
  check(!traeNotice,
    'el artefacto no incluye NOTICE, así que no hay aviso adicional que propagar');
  check(entradas.some(e => e.trim() === 'package/LICENSE'),
    'el tarball sí trae LICENSE, que es lo que Apache-2.0 obliga a conservar');
}

console.log('\n=== 4. Extracción real de XLSX ===');
{
  const XLSX = require('xlsx');

  // Se construye un libro y se recorre el mismo camino que `file:extractSpreadsheet`:
  // `XLSX.read(buffer)` y `sheet_to_csv` por hoja.
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro,
    XLSX.utils.aoa_to_sheet([['Concepto', 'Importe'], ['Café', 1.5], ['Té', 2]]), 'Ventas');
  XLSX.utils.book_append_sheet(libro,
    XLSX.utils.aoa_to_sheet([['Nota'], ['segunda hoja']]), 'Notas');

  const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
  check(Buffer.isBuffer(buffer) && buffer.length > 0, `se escribe un .xlsx (${buffer.length} bytes)`);

  const leido = XLSX.read(buffer, { type: 'buffer' });
  check(JSON.stringify(leido.SheetNames) === JSON.stringify(['Ventas', 'Notas']),
    `se leen las dos hojas (${leido.SheetNames.join(', ')})`);

  const hojas = leido.SheetNames
    .map(nombre => `--- ${nombre} ---\n${XLSX.utils.sheet_to_csv(leido.Sheets[nombre])}`)
    .filter(t => t.trim());
  const texto = hojas.join('\n\n');
  check(/Café/.test(texto) && /1\.5/.test(texto),
    'el contenido y los acentos sobreviven a la conversión a CSV');
  check(/segunda hoja/.test(texto), 'y la segunda hoja también se extrae');
}

console.log('\n=== 5. Extracción real de XLS (formato antiguo) ===');
{
  const XLSX = require('xlsx');
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro,
    XLSX.utils.aoa_to_sheet([['Columna'], ['valor xls'], [42]]), 'Hoja1');

  // BIFF8: el .xls de toda la vida. Retirarlo rompería documentos existentes
  // del usuario, así que se comprueba aparte del .xlsx.
  const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xls' });
  const leido = XLSX.read(buffer, { type: 'buffer' });
  const texto = XLSX.utils.sheet_to_csv(leido.Sheets[leido.SheetNames[0]]);
  check(/valor xls/.test(texto) && /42/.test(texto),
    `un .xls se sigue leyendo (${JSON.stringify(texto.trim().slice(0, 40))})`);
}

console.log('\n=== 6. El camino de la aplicación sigue en pie ===');
{
  // Retirar el soporte de hojas de cálculo era una de las salidas posibles y
  // no es la que se tomó: el handler y sus extensiones tienen que seguir ahí.
  const main = fs.readFileSync(path.join(RAIZ, 'src/main/main.js'), 'utf8');
  check(/ipcMain\.handle\(\s*["']file:extractSpreadsheet["']/.test(main),
    'file:extractSpreadsheet sigue registrado');
  check(/require\(['"]xlsx['"]\)/.test(main), 'y sigue usando el paquete xlsx');

  const app = fs.readFileSync(path.join(RAIZ, 'src/renderer/app.js'), 'utf8');
  check(/xls\b/.test(app) && /xlsx/.test(app),
    'el renderer sigue aceptando .xls y .xlsx');
}

console.log('\n=== 7. Ningún advisory se silencia ===');
{
  // Suprimir un aviso con overrides o audit-level lo esconde sin arreglarlo.
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  check(!pkg.overrides || !JSON.stringify(pkg.overrides).includes('xlsx'),
    'no hay override que enmascare la resolución de xlsx');
  const npmrc = path.join(RAIZ, '.npmrc');
  const contenido = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, 'utf8') : '';
  check(!/audit\s*=\s*false|audit-level/.test(contenido),
    '.npmrc no desactiva ni rebaja npm audit');
}

if (fallos.length) {
  console.error(`\nxlsx-vendored: ${fallos.length} de ${comprobaciones} comprobaciones fallaron`);
  for (const f of fallos) console.error('  FALLO: ' + f);
  process.exitCode = 1;
} else {
  console.log(`\nVendored xlsx tests passed (${comprobaciones} comprobaciones)`);
}
