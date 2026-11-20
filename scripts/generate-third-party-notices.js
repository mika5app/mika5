#!/usr/bin/env node
'use strict';

// Genera THIRD_PARTY_NOTICES.md a partir de package-lock.json.
//
// Lista las dependencias de PRODUCCIÓN —las que viajan dentro de la aplicación
// distribuida— con su versión, su licencia declarada y, cuando el paquete lo
// trae, el texto de su licencia. Las licencias MIT, BSD, ISC y Apache piden
// conservar ese aviso al redistribuir.
//
//   node scripts/generate-third-party-notices.js          escribe el fichero
//   node scripts/generate-third-party-notices.js --check  falla si está desfasado

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DESTINO = path.join(RAIZ, 'THIRD_PARTY_NOTICES.md');
const NOMBRES_DE_LICENCIA = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

function textoDeLicencia(dir) {
  let entradas;
  try {
    entradas = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const fichero = entradas.filter(nombre => NOMBRES_DE_LICENCIA.test(nombre)).sort()[0];
  if (!fichero) return null;
  try {
    return fs.readFileSync(path.join(dir, fichero), 'utf8').replace(/\r\n?/g, '\n').trim();
  } catch (_) {
    return null;
  }
}

function generar() {
  const lock = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package-lock.json'), 'utf8'));
  const paquetes = Object.entries(lock.packages || {})
    .filter(([ruta, datos]) => ruta && !datos.dev)
    .map(([ruta, datos]) => ({
      nombre: ruta.replace(/^.*node_modules\//, ''),
      version: datos.version || '',
      licencia: typeof datos.license === 'string' ? datos.license : 'UNKNOWN',
      texto: textoDeLicencia(path.join(RAIZ, ruta))
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre) || a.version.localeCompare(b.version));

  const lineas = [
    '# Third-party notices',
    '',
    'MIKA5 Community is licensed under AGPL-3.0 (see `LICENSE`). It includes the',
    'third-party software listed below, each under its own license. This file is',
    'generated from `package-lock.json` by `scripts/generate-third-party-notices.js`;',
    'do not edit it by hand.',
    '',
    'Packaged builds also ship Electron and Chromium, whose notices are included in',
    'the application as `LICENSE.electron.txt` and `LICENSES.chromium.html`.',
    '',
    `Production dependencies: ${paquetes.length}.`,
    '',
    '| Package | Version | License |',
    '|---|---|---|',
    ...paquetes.map(p => `| ${p.nombre} | ${p.version} | ${p.licencia} |`),
    ''
  ];
  for (const p of paquetes) {
    lineas.push(`## ${p.nombre} ${p.version}`, '', `License: ${p.licencia}`, '');
    if (p.texto) lineas.push('```text', p.texto.replace(/```/g, "'''"), '```', '');
    else lineas.push('The package does not ship a license file; see its repository for the full text.', '');
  }
  return `${lineas.join('\n').replace(/\n+$/, '')}\n`;
}

// Lo que se exige que coincida es la lista —paquete, versión, licencia—, que
// sale entera de package-lock.json y es igual en cualquier máquina. Los textos
// de licencia dependen de qué paquetes opcionales instala cada sistema
// operativo, así que compararlos haría fallar la comprobación fuera de la
// plataforma donde se generó el fichero.
const listaDe = (texto) => texto.split('\n## ')[0];

const contenido = generar();
if (process.argv.includes('--check')) {
  const actual = fs.existsSync(DESTINO) ? fs.readFileSync(DESTINO, 'utf8').replace(/\r\n?/g, '\n') : '';
  if (listaDe(actual) !== listaDe(contenido)) {
    console.error('THIRD_PARTY_NOTICES.md está desfasado: ejecuta `node scripts/generate-third-party-notices.js`.');
    process.exit(1);
  }
  console.log('THIRD_PARTY_NOTICES.md está al día.');
} else {
  fs.writeFileSync(DESTINO, contenido);
  console.log(`THIRD_PARTY_NOTICES.md generado (${contenido.length} bytes).`);
}
