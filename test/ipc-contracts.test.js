// test/ipc-contracts.test.js — Cada canal invoke tiene su handler.
// Run: node test/ipc-contracts.test.js
//
// Existe porque ya pasó: al reorganizar main.js se perdió el registro de
// `app:printToPDF` mientras preload.js seguía exponiéndolo y el renderer
// seguía llamándolo. Ningún gate lo vio. La exportación a PDF caía en silencio
// al camino de HTML.
//
// No usa red, no abre Electron y no toca userData.

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

const normalizeEol = s => String(s).replace(/\r\n?/g, '\n');

function listarJs(dir) {
  const salida = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...listarJs(completo));
    else if (entrada.name.endsWith('.js')) salida.push(completo);
  }
  return salida;
}

const ARCHIVOS_MAIN = listarJs(path.join(ROOT, 'src/main'));
const PRELOADS = ARCHIVOS_MAIN.filter(f => path.basename(f) === 'preload.js');

const fuente = new Map();
for (const f of ARCHIVOS_MAIN) fuente.set(f, normalizeEol(fs.readFileSync(f, 'utf8')));

// Un canal literal es una cadena simple. Una plantilla o una variable es un
// canal dinámico y se cuenta aparte: ignorarlo en silencio sería justo el
// agujero que esta prueba cierra.
const LITERAL = /["']([^"'`\n]+)["']/;

function extraer(texto, api, metodo) {
  const literales = [];
  let dinamicos = 0;
  const patron = new RegExp(`${api}\\.${metodo}\\(\\s*([^,)]+)`, 'g');
  for (const m of texto.matchAll(patron)) {
    const argumento = m[1].trim();
    const literal = argumento.match(LITERAL);
    if (literal && (argumento.startsWith('"') || argumento.startsWith("'"))) literales.push(literal[1]);
    else dinamicos += 1;
  }
  return { literales, dinamicos };
}

function acumular(archivos, api, metodo) {
  const literales = [];
  let dinamicos = 0;
  for (const f of archivos) {
    const r = extraer(fuente.get(f), api, metodo);
    literales.push(...r.literales);
    dinamicos += r.dinamicos;
  }
  return { literales, dinamicos };
}

const handlers = acumular(ARCHIVOS_MAIN, 'ipcMain', 'handle');
const invokes = acumular(PRELOADS, 'ipcRenderer', 'invoke');
// send/on son un contrato distinto: no exigen un handler que devuelva valor.
const escuchas = acumular(ARCHIVOS_MAIN, 'ipcMain', 'on');
const envios = acumular(PRELOADS, 'ipcRenderer', 'send');

console.log(`\narchivos main: ${ARCHIVOS_MAIN.length} | preloads: ${PRELOADS.length}`);
console.log(`handle: ${handlers.literales.length} | invoke: ${invokes.literales.length}` +
            ` | on: ${escuchas.literales.length} | send: ${envios.literales.length}`);

// =====================================================================
console.log('\n=== Ningún canal se escapa del análisis ===');
// =====================================================================

check(ARCHIVOS_MAIN.length > 0, 'se encontraron archivos en src/main');
check(PRELOADS.length >= 1, 'existe al menos un preload versionado');
check(handlers.dinamicos === 0,
  `ningún ipcMain.handle usa un canal dinámico (${handlers.dinamicos})`);
check(invokes.dinamicos === 0,
  `ningún ipcRenderer.invoke usa un canal dinámico (${invokes.dinamicos})`);

// =====================================================================
console.log('\n=== Cada invoke tiene exactamente un handler ===');
// =====================================================================

const cuentaHandlers = new Map();
for (const canal of handlers.literales) {
  cuentaHandlers.set(canal, (cuentaHandlers.get(canal) || 0) + 1);
}

const duplicados = [...cuentaHandlers.entries()].filter(([, n]) => n > 1).map(([c]) => c);
check(duplicados.length === 0,
  `ningún canal se registra dos veces (${duplicados.join(', ') || 'ninguno'})`);

// Excepción única y preexistente: `debug:ragState` se expone en preload.js
// desde antes de esta rama — está así en `main` —, nunca tuvo handler y nadie
// lo llama. Es un canal muerto que hay que retirar en su propio commit, no
// aquí. Se anota para que quede contado, no para tolerarlo indefinidamente.
const EXCEPCIONES = Object.freeze(['debug:ragState']);

const huerfanos = [...new Set(invokes.literales)].filter(c => !cuentaHandlers.has(c));
const inesperados = huerfanos.filter(c => !EXCEPCIONES.includes(c));
check(inesperados.length === 0,
  `todo canal invocado desde preload tiene handler (huérfanos: ${inesperados.join(', ') || 'ninguno'})`);

// La lista no puede crecer ni quedarse obsoleta: cada excepción debe seguir
// siendo un huérfano real, y ninguna puede dejar de estar expuesta.
for (const canal of EXCEPCIONES) {
  check(invokes.literales.includes(canal),
    `la excepción ${canal} sigue expuesta en preload (si ya no, retírala de la lista)`);
  check(!cuentaHandlers.has(canal),
    `la excepción ${canal} sigue sin handler (si ya lo tiene, retírala de la lista)`);
}
check(EXCEPCIONES.length <= 1,
  `la lista de excepciones no crece (${EXCEPCIONES.length})`);

// El sentido inverso no es un error: un handler puede existir para uso
// interno o para un preload futuro. Se informa, no se exige.
const sinInvoke = [...cuentaHandlers.keys()].filter(c => !invokes.literales.includes(c));
console.log(`  · handlers sin invoke en preload (informativo): ${sinInvoke.length}`);

// Los canales send/on no se mezclan con invoke/handle.
const cruce = escuchas.literales.filter(c => cuentaHandlers.has(c));
check(cruce.length === 0,
  `ningún canal se registra a la vez con handle y con on (${cruce.join(', ') || 'ninguno'})`);

// =====================================================================
console.log('\n=== app:printToPDF, el canal que se perdió ===');
// =====================================================================

const CANAL_PDF = 'app:printToPDF';
check(invokes.literales.includes(CANAL_PDF),
  `preload expone ${CANAL_PDF}`);
check(cuentaHandlers.get(CANAL_PDF) === 1,
  `main registra ${CANAL_PDF} exactamente una vez`);

const mainSrc = fuente.get(path.join(ROOT, 'src/main/main.js'));
check(/ipcMain\.handle\(\s*\n?\s*["']app:printToPDF["'],\s*\n?\s*createPrintExport\(/.test(mainSrc),
  'main.js registra app:printToPDF con createPrintExport');
check(/require\(["']\.\/print-export["']\)/.test(mainSrc),
  'main.js carga print-export desde su ruta canónica');

// El canal de impresión no puede ampararse en la lista de excepciones.
check(!EXCEPCIONES.includes(CANAL_PDF),
  `${CANAL_PDF} no figura en la lista de excepciones`);

console.log(`\n${'='.repeat(40)}`);
console.log(`IPC contract tests passed (${passed} comprobaciones)`);
console.log(`${'='.repeat(40)}`);
