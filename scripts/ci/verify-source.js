#!/usr/bin/env node
'use strict';

// Validación de la fuente Community, portable y sin efectos.
//
//   node scripts/ci/verify-source.js
//
// Traslada a JavaScript los controles que hoy viven duplicados en dos pasos de
// shell: `Validate release metadata` de build.yml y `Validate Community
// metadata` + `ELECTRON_OVERRIDE_DIST_PATH must be absent` de
// security-validation.yml. Son el mismo contrato escrito dos veces, con la
// diferencia de que sólo uno de los dos comprueba la variable de entorno y sólo
// el otro comprueba la correspondencia entre el tag y la versión. Aquí están los
// dos, una sola vez, y ejecutables en la máquina de quien desarrolla.
//
// No traslada nada que sea infraestructura del runner. En concreto NO comprueba
// el aislamiento de la caché de Electron: ese paso lee `RUNNER_TEMP` y escribe en
// `GITHUB_ENV`, que sólo existen dentro de Actions, y un script local no puede
// demostrar que la caché de un runner que todavía no arrancó esté vacía. Ese
// control se queda donde está y pasará al workflow canónico.
//
// Qué comprueba:
//
//   1. ELECTRON_OVERRIDE_DIST_PATH ausente del entorno
//   2. package.json declara una versión X.Y.Z
//   3. Los cinco documentos legales existen y no están vacíos
//   4. Si se ejecuta sobre un tag, que el tag y la versión coincidan
//
// No hace red, no escribe ficheros, no instala nada y no modifica el entorno.

const fs = require('fs');
const path = require('path');

// Desde scripts/ci/ hasta la raíz. No depende del directorio de trabajo: da
// igual desde dónde se invoque.
const RAIZ = path.join(__dirname, '..', '..');

// Los mismos cinco que exigen los dos workflows, en el mismo orden.
const DOCUMENTOS_LEGALES = [
  'LICENSE',
  'BUILDING.md',
  'COMMUNITY.md',
  'TRADEMARK.md',
  'SECURITY.md'
];

const VERSION_VALIDA = /^\d+\.\d+\.\d+$/;
const TAG_VALIDO = /^v\d+\.\d+\.\d+$/;

let fallos = 0;

function check(condicion, mensaje) {
  console.log(`${condicion ? '  OK  ' : '  FAIL'} ${mensaje}`);
  if (!condicion) fallos += 1;
  return condicion;
}

/**
 * `ELECTRON_OVERRIDE_DIST_PATH` redirige dist/, de modo que lo instalado, lo
 * empaquetado y lo verificado dejan de ser necesariamente lo mismo. No se limpia
 * en silencio: encontrarla es un fallo, y el valor no se imprime.
 */
function verificarEntorno(entorno) {
  const valor = entorno.ELECTRON_OVERRIDE_DIST_PATH;
  const definida = typeof valor === 'string' && valor !== '';
  return check(!definida,
    definida
      ? 'ELECTRON_OVERRIDE_DIST_PATH está definida: redirige dist/ y rompe la correspondencia entre lo instalado, lo empaquetado y lo verificado'
      : 'ELECTRON_OVERRIDE_DIST_PATH ausente');
}

function verificarVersion(raiz) {
  let paquete;
  try {
    paquete = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
  } catch (error) {
    check(false, `package.json no se puede leer: ${error.code || error.name}`);
    return null;
  }
  const version = paquete.version;
  const valida = typeof version === 'string' && VERSION_VALIDA.test(version);
  check(valida, valida
    ? `package.json declara la versión ${version}`
    : `versión de paquete inválida: ${JSON.stringify(version)}`);
  return valida ? version : null;
}

function verificarDocumentos(raiz) {
  for (const nombre of DOCUMENTOS_LEGALES) {
    let tam = -1;
    try {
      const info = fs.statSync(path.join(raiz, nombre));
      tam = info.isFile() ? info.size : -1;
    } catch (_) { /* ausente: tam se queda en -1 */ }
    check(tam > 0, tam > 0
      ? `${nombre} existe y no está vacío (${tam} bytes)`
      : `${nombre} falta o está vacío`);
  }
}

/**
 * La comprobación del tag sólo aplica cuando la ejecución corresponde a uno.
 * Fuera de ese caso no hay nada que comparar y no se inventa un requisito.
 */
function verificarTag(entorno, version) {
  if (entorno.GITHUB_REF_TYPE !== 'tag') {
    console.log('  --   no se ejecuta sobre un tag: no hay correspondencia que comprobar');
    return;
  }
  const tag = entorno.GITHUB_REF_NAME;
  if (!check(typeof tag === 'string' && TAG_VALIDO.test(tag),
    TAG_VALIDO.test(String(tag)) ? `tag con formato válido: ${tag}` : `tag de release inválido: ${tag}`)) {
    return;
  }
  if (version === null) return;
  check(tag.slice(1) === version,
    tag.slice(1) === version
      ? `el tag ${tag} coincide con la versión ${version}`
      : `el tag ${tag} no coincide con la versión ${version} de package.json`);
}

function verificarFuente(opciones) {
  const raiz = (opciones && opciones.raiz) || RAIZ;
  const entorno = (opciones && opciones.entorno) || process.env;

  fallos = 0;
  console.log(`node ${process.version}`);
  console.log(`raíz ${raiz}`);
  console.log('');

  verificarEntorno(entorno);
  const version = verificarVersion(raiz);
  verificarDocumentos(raiz);
  verificarTag(entorno, version);

  console.log('');
  console.log(fallos === 0
    ? 'Fuente Community válida'
    : `Fuente Community inválida: ${fallos} comprobación(es) en rojo`);
  return fallos;
}

module.exports = { verificarFuente, DOCUMENTOS_LEGALES };

if (require.main === module) {
  process.exit(verificarFuente({}) === 0 ? 0 : 1);
}
