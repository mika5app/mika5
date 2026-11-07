#!/usr/bin/env node
'use strict';

// Deja utilizable el binario de Electron después de `npm ci` / `npm install`.
//
// Por qué existe: desde Electron 43 el paquete npm **no declara ningún script**.
// No hay `postinstall` que traiga el binario. El descargador viaja dentro del
// paquete —`install.js`, expuesto también como bin `install-electron`— y el
// consumidor tiene que invocarlo. Mientras la caché de `@electron/get` tuviera
// ya el zip, esto pasaba desapercibido; con una caché fría, `npm ci` terminaba
// en rojo con el binario ausente. Depender de una caché caliente es un
// requisito oculto, y aguanta hasta el primer runner limpio de CI.
//
// Qué NO hace esto, a propósito:
//
//   · No descarga. No extrae. No comprueba checksums. No mira dentro de la
//     caché. Todo eso lo hace `@electron/get@5`, que valida el artefacto contra
//     `checksums.json` TANTO al descargarlo COMO al encontrarlo en caché: si un
//     zip cacheado no cuadra, lo descarta y vuelve a descargar
//     (`dist/index.js`, "Artifact in cache didn't match checksums" → "falling
//     back to re-download"). Una versión anterior de este script duplicaba esa
//     comprobación creyendo que un acierto de caché se aceptaba sin verificar.
//     Era falso, y el código sobraba.
//
//   · No decide plataforma ni arquitectura. El instalador oficial resuelve esa
//     precedencia —`ELECTRON_INSTALL_PLATFORM`, `ELECTRON_INSTALL_ARCH`,
//     `npm_config_platform`, `npm_config_arch`, y por último las del proceso—,
//     y reproducirla a medias sólo crea discrepancias. Aquí se lee el resultado:
//     `path.txt`, que `install.js` escribe apuntando al ejecutable que acaba de
//     instalar.
//
// Lo que sí hace: invocar al instalador oficial y comprobar, de forma
// fail-closed, que dejó una instalación utilizable.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DIR_ELECTRON = path.join(RAIZ, 'node_modules', 'electron');

function log(mensaje) {
  console.log(`ensure-electron-binary: ${mensaje}`);
}

/**
 * Comprueba que hay una instalación utilizable, con los mismos criterios que
 * `isInstalled()` de `install.js`: la versión declarada en `dist/version`, un
 * `path.txt` con contenido, y el ejecutable al que ese `path.txt` apunta.
 *
 * Devuelve `{ ok: false, motivo }` en vez de lanzar, para que el llamador
 * distinga "todavía no está" de "el instalador falló".
 */
function inspeccionarInstalacion(dirElectron, versionEsperada) {
  const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(dirElectron, 'dist');

  const rutaVersion = path.join(dist, 'version');
  let version;
  try {
    version = fs.readFileSync(rutaVersion, 'utf8').replace(/^v/, '').trim();
  } catch (_) {
    return { ok: false, motivo: `no hay ${rutaVersion}` };
  }
  if (version !== versionEsperada) {
    return {
      ok: false,
      motivo: `dist/version dice ${version} y el paquete electron del checkout declara ${versionEsperada}`
    };
  }

  const rutaPathTxt = path.join(dirElectron, 'path.txt');
  let relativo;
  try {
    relativo = fs.readFileSync(rutaPathTxt, 'utf8').trim();
  } catch (_) {
    return { ok: false, motivo: `no hay ${rutaPathTxt}` };
  }
  if (!relativo) {
    return { ok: false, motivo: `${rutaPathTxt} está vacío` };
  }
  // `path.txt` es una ruta RELATIVA dentro de `dist`. Una absoluta o con `..`
  // apuntaría fuera del paquete, y eso no lo escribe el instalador oficial.
  if (path.isAbsolute(relativo) || relativo.split(/[\\/]/).includes('..')) {
    return { ok: false, motivo: `path.txt no es una ruta relativa dentro de dist: ${relativo}` };
  }

  const binario = path.join(dist, relativo);
  if (!fs.existsSync(binario)) {
    return { ok: false, motivo: `path.txt apunta a ${relativo}, que no existe en ${dist}` };
  }

  return { ok: true, version, relativo, binario };
}

/**
 * Ejecuta el descargador que trae el propio paquete electron.
 *
 * Un código de salida distinto de cero es un fallo real y se propaga como tal,
 * conservando la causa original en `cause`. Una versión anterior lo capturaba y
 * devolvía `false`, y el llamador no miraba ese valor: una descarga fallida que
 * dejara un `dist` de otra versión —o a medio escribir— se declaraba correcta.
 * El fallo no desaparecía, sólo se posponía hasta el primer arranque.
 */
function descargarConInstaladorOficial({ dirElectron = DIR_ELECTRON, ejecutar = execFileSync } = {}) {
  const instalador = path.join(dirElectron, 'install.js');
  if (!fs.existsSync(instalador)) {
    throw new Error(
      `el paquete electron no trae install.js (${instalador}): no hay descargador oficial que invocar`
    );
  }
  try {
    ejecutar(process.execPath, [instalador], { stdio: 'inherit', cwd: dirElectron });
  } catch (error) {
    // `execFileSync` adjunta `status` y `signal`; el stderr del hijo ya salió
    // por la consola porque se hereda. Aquí se añade el contexto que falta.
    const detalle = error.signal
      ? `terminado por señal ${error.signal}`
      : `código de salida ${error.status === undefined ? '(desconocido)' : error.status}`;
    const fallo = new Error(`el descargador oficial de electron falló: ${detalle} — ${error.message}`);
    fallo.cause = error;
    throw fallo;
  }
}

/**
 * Las dependencias se inyectan para poder probar el flujo sin red y sin tocar
 * `node_modules`: la suite monta un paquete electron de mentira en un temporal.
 */
function principal({
  dirElectron = DIR_ELECTRON,
  descargar = descargarConInstaladorOficial,
  registrar = log
} = {}) {
  if (!fs.existsSync(dirElectron)) {
    // `npm ci --omit=dev` no instala electron. No hay nada que asegurar y no es
    // un error.
    return;
  }

  const version = JSON.parse(fs.readFileSync(path.join(dirElectron, 'package.json'), 'utf8')).version;

  const previa = inspeccionarInstalacion(dirElectron, version);
  if (previa.ok) {
    registrar(`binario ${version} ya presente (${previa.relativo})`);
    return;
  }

  registrar(`binario ${version} no utilizable (${previa.motivo}): se invoca el descargador oficial`);

  // Un fallo aquí sube tal cual. No se mira qué quedó en `dist`: una descarga
  // que terminó en error no autoriza a declarar la instalación correcta, deje
  // los ficheros que deje por el camino.
  descargar({ dirElectron });

  const resultado = inspeccionarInstalacion(dirElectron, version);
  if (!resultado.ok) {
    throw new Error(
      `el descargador oficial terminó sin error pero no dejó utilizable Electron ${version}: ${resultado.motivo}\n`
      + '  Comprueba red, proxy o ELECTRON_MIRROR y reintenta:\n'
      + '    node node_modules/electron/install.js'
    );
  }

  registrar(`binario ${version} listo (${resultado.relativo}, descargador oficial)`);
}

if (require.main === module) {
  try {
    principal();
  } catch (error) {
    console.error(`ensure-electron-binary: ${error.message}`);
    if (error.cause && error.cause.stack) console.error(error.cause.stack);
    process.exit(1);
  }
}

module.exports = {
  inspeccionarInstalacion,
  descargarConInstaladorOficial,
  principal
};
