// test/palette.test.js — La paleta base es un contrato compartido.
// Run: node test/palette.test.js
//
// El fondo, el borde y los estados hover viven en tres sitios: la hoja de
// estilos, los `style.cssText` inline del renderer y las variables CSS del
// documento. Cambiar uno y olvidar otro deja superficies con el tono anterior
// y nadie se entera hasta verlo en pantalla.
//
// Esta prueba sólo mira valores de color. No inspecciona lógica de producto,
// no abre Electron, no usa red y no toca userData.

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

const leer = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const stylesCss = leer('src/renderer/styles.css');
const appJs = leer('src/renderer/app.js');
const indexHtml = leer('src/renderer/index.html');
const SUPERFICIES = { 'styles.css': stylesCss, 'app.js': appJs, 'index.html': indexHtml };

// Tonos retirados por el oscurecimiento de la paleta. Ninguno puede sobrevivir
// en las superficies compartidas: una sola aparición delata una sustitución a
// medias.
const RETIRADOS = ['#070b16', '#1b2a55', '#152044', '#0f1629', '#101a33', '#17213d'];

// =====================================================================
console.log('\n=== Ningún tono retirado sobrevive ===');
// =====================================================================

for (const viejo of RETIRADOS) {
  for (const [archivo, contenido] of Object.entries(SUPERFICIES)) {
    const apariciones = contenido.toLowerCase().split(viejo.toLowerCase()).length - 1;
    check(apariciones === 0,
      `${archivo} no conserva ${viejo} (${apariciones} apariciones)`);
  }
}

// =====================================================================
console.log('\n=== Los tonos acordados están presentes donde toca ===');
// =====================================================================

// [token, archivos donde debe aparecer al menos una vez]
const ESPERADOS = [
  ['#04070F', ['styles.css', 'app.js', 'index.html']],
  ['#14213F', ['styles.css', 'app.js', 'index.html']],
  ['#0D1630', ['styles.css', 'app.js', 'index.html']],
  ['#000208', ['styles.css', 'app.js', 'index.html']],
  ['#070C1A', ['app.js', 'index.html']]
];

for (const [token, archivos] of ESPERADOS) {
  for (const archivo of archivos) {
    check(SUPERFICIES[archivo].toUpperCase().includes(token.toUpperCase()),
      `${archivo} usa ${token}`);
  }
}

// =====================================================================
console.log('\n=== Estados distinguibles entre sí ===');
// =====================================================================

// Reposo y hover no pueden colapsar en el mismo tono: el botón dejaría de dar
// respuesta visible al puntero.
check(!appJs.includes("var(--bg-hover,#04070F)"),
  'el hover no reutiliza el tono de reposo');
check(appJs.includes("var(--bg-hover,#0D1630)") && appJs.includes("var(--bg-base,#04070F)"),
  'reposo y hover conservan tonos distintos en los botones inline');

// =====================================================================
console.log('\n=== Contraste de texto sobre los fondos nuevos ===');
// =====================================================================

function luminancia(hex) {
  const v = hex.replace('#', '');
  const canales = [0, 2, 4]
    .map(i => parseInt(v.slice(i, i + 2), 16) / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * canales[0] + 0.7152 * canales[1] + 0.0722 * canales[2];
}
function contraste(a, b) {
  const [alto, bajo] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (alto + 0.05) / (bajo + 0.05);
}

const TEXTO_PRINCIPAL = '#eef3ff';
const TEXTO_ATENUADO = '#a9b4d0';
const FONDOS_NUEVOS = ['#04070F', '#000208', '#0D1630', '#070C1A'];

for (const fondo of FONDOS_NUEVOS) {
  const principal = contraste(TEXTO_PRINCIPAL, fondo);
  const atenuado = contraste(TEXTO_ATENUADO, fondo);
  check(principal >= 4.5,
    `texto principal sobre ${fondo}: ${principal.toFixed(2)}:1 (AA exige 4.5)`);
  check(atenuado >= 4.5,
    `texto atenuado sobre ${fondo}: ${atenuado.toFixed(2)}:1 (AA exige 4.5)`);
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Palette tests passed (${passed} comprobaciones)`);
console.log(`${'='.repeat(40)}`);
