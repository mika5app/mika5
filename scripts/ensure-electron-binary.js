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
// Aquí no se reimplementa la descarga ni se inventa ninguna URL: se ejecuta el
// punto de entrada oficial, que resuelve mirror, proxy, caché y checksum a
// través de `@electron/get` y extrae con `@electron-internal/extract-zip`.
//
// El paso es idempotente: si el binario ya está en la versión correcta, no hace
// nada.
//
// SEGURIDAD: el zip se verifica contra el `checksums.json` que trae el propio
// paquete electron, y se verifica ANTES de invocar al instalador, porque es el
// instalador quien lo extrae. `@electron/get` comprueba el hash cuando descarga,
// pero si acierta en la caché se fía de ella. Extraer un zip sin comprobar
// convertiría cualquier escritura en el directorio de caché del usuario en
// ejecución de código: lo que sale de ahí es el ejecutable que después corre la
// aplicación entera.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DIR_ELECTRON = path.join(RAIZ, 'node_modules', 'electron');

function log(mensaje) {
  console.log(`ensure-electron-binary: ${mensaje}`);
}

/** Nombre del ejecutable dentro de `dist`, por plataforma. */
function rutaBinario(plataforma) {
  if (plataforma === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  if (plataforma === 'win32') return 'electron.exe';
  return 'electron';
}

function yaInstalado(dist, version, plataforma) {
  try {
    const declarada = fs.readFileSync(path.join(dist, 'version'), 'utf8').replace(/^v/, '').trim();
    if (declarada !== version) return false;
    return fs.existsSync(path.join(dist, rutaBinario(plataforma)));
  } catch (_) {
    return false;
  }
}

/**
 * Localiza el zip en la caché de `@electron/get`, que guarda cada artefacto en
 * un subdirectorio con nombre de hash. Se busca por nombre de archivo en vez de
 * recalcular ese hash: el esquema es interno de esa librería y puede cambiar.
 */
function buscarZipEnCache(nombreZip) {
  const raices = [
    process.env.electron_config_cache,
    process.env.ELECTRON_CACHE,
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
      : path.join(process.env.HOME || '', '.cache', 'electron')
  ].filter(Boolean);

  for (const raiz of raices) {
    if (!fs.existsSync(raiz)) continue;
    const candidatos = [path.join(raiz, nombreZip)];
    for (const entrada of fs.readdirSync(raiz, { withFileTypes: true })) {
      if (entrada.isDirectory()) candidatos.push(path.join(raiz, entrada.name, nombreZip));
    }
    for (const candidato of candidatos) {
      if (fs.existsSync(candidato)) return candidato;
    }
  }
  return null;
}

function sha256(archivo) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(archivo));
  return hash.digest('hex');
}

/** Comprueba un zip contra el `checksums.json` del propio paquete electron. */
function verificarZip(zip, nombreZip) {
  const esperado = (() => {
    try {
      return require(path.join(DIR_ELECTRON, 'checksums.json'))[nombreZip];
    } catch (_) {
      return null;
    }
  })();
  if (!esperado) {
    throw new Error(`checksums.json no declara ${nombreZip}: no se acepta nada sin poder verificarlo`);
  }
  const obtenido = sha256(zip);
  if (obtenido !== String(esperado).toLowerCase()) {
    throw new Error(
      'el zip no coincide con el hash declarado por electron.\n'
      + `  archivo:  ${zip}\n  esperado: ${esperado}\n  obtenido: ${obtenido}\n`
      + '  Bórralo y vuelve a instalar; no se acepta un artefacto sin verificar.'
    );
  }
  return obtenido;
}

/**
 * Ejecuta el descargador que trae el propio paquete electron.
 *
 * Un fallo aquí no se propaga como excepción: quien decide si hay binario
 * utilizable es la comprobación posterior, que da un error explícito. Así el
 * mensaje final describe el estado real y no una etapa intermedia.
 */
function descargarConInstaladorOficial() {
  const instalador = path.join(DIR_ELECTRON, 'install.js');
  if (!fs.existsSync(instalador)) {
    log('el paquete electron no trae install.js: no hay descargador oficial que invocar');
    return false;
  }
  try {
    execFileSync(process.execPath, [instalador], { stdio: 'inherit', cwd: DIR_ELECTRON });
    return true;
  } catch (error) {
    log(`el descargador oficial terminó con error: ${error.message}`);
    return false;
  }
}

function principal() {
  if (!fs.existsSync(DIR_ELECTRON)) {
    // Instalación sin devDependencies: no hay nada que asegurar.
    return;
  }

  const version = require(path.join(DIR_ELECTRON, 'package.json')).version;
  const plataforma = process.env.npm_config_platform || process.platform;
  const arquitectura = process.env.npm_config_arch || process.arch;
  const dist = path.join(DIR_ELECTRON, 'dist');

  if (yaInstalado(dist, version, plataforma)) {
    log(`binario ${version} ya presente`);
    return;
  }

  const nombreZip = `electron-v${version}-${plataforma}-${arquitectura}.zip`;

  // Si ya hay zip en caché, se verifica ANTES de que el instalador lo extraiga.
  const zipPrevio = buscarZipEnCache(nombreZip);
  if (zipPrevio) {
    log(`zip en caché verificado (sha256 ${verificarZip(zipPrevio, nombreZip).slice(0, 16)}…)`);
  } else {
    log('binario ausente y sin zip en caché: se invoca el descargador oficial de electron');
  }

  descargarConInstaladorOficial();

  // Si el zip no estaba y ahora sí, se verifica también: `@electron/get` sólo
  // comprueba el hash al descargar, y aquí queda constancia de que se comprobó.
  if (!zipPrevio) {
    const zipNuevo = buscarZipEnCache(nombreZip);
    if (zipNuevo) log(`zip descargado y verificado (sha256 ${verificarZip(zipNuevo, nombreZip).slice(0, 16)}…)`);
  }

  if (!yaInstalado(dist, version, plataforma)) {
    throw new Error(
      `el descargador oficial no dejó utilizable el binario de Electron ${version}.\n`
      + `  falta: ${path.join(dist, rutaBinario(plataforma))}\n`
      + '  Comprueba red, proxy o ELECTRON_MIRROR y reintenta:\n'
      + '    node node_modules/electron/install.js'
    );
  }

  log(`binario ${version} listo (descargador oficial)`);
}

if (require.main === module) {
  try {
    principal();
  } catch (error) {
    console.error(`ensure-electron-binary: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  rutaBinario,
  yaInstalado,
  buscarZipEnCache,
  sha256,
  verificarZip,
  descargarConInstaladorOficial
};
