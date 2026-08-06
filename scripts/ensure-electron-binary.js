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
// SEGURIDAD. El zip se comprueba contra el `checksums.json` que trae el propio
// paquete electron, pero el valor de esa comprobación no es el mismo en los dos
// casos, y conviene no confundirlos:
//
//   · CACHÉ EXISTENTE — la comprobación es la que importa, y por eso ocurre
//     ANTES de invocar al instalador. `@electron/get` verifica el hash cuando
//     descarga; si acierta en la caché, se fía de ella y extrae. Extraer un zip
//     sin comprobar convertiría cualquier escritura en el directorio de caché
//     del usuario en ejecución de código: lo que sale de ahí es el ejecutable
//     que después corre la aplicación entera.
//
//   · CACHÉ FRÍA — `@electron/get` ya verifica durante la descarga, contra el
//     mismo `checksums.json`. La comprobación local posterior no añade
//     seguridad: es evidencia, deja constancia del hash en el log de
//     instalación.

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
 *
 * `electron_config_cache` va primero a propósito, y no es una ruta inventada: es
 * la misma variable que `install.js` pasa como `cacheRoot` a `downloadArtifact`.
 * Si quien instala la redirige, aquí se mira donde el instalador va a escribir.
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
function verificarZip(zip, nombreZip, dirElectron = DIR_ELECTRON) {
  const esperado = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dirElectron, 'checksums.json'), 'utf8'))[nombreZip];
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
 * Un código de salida distinto de cero es un fallo real y se propaga como tal,
 * conservando la causa original en `cause`. La versión anterior lo capturaba y
 * devolvía `false`, y el llamador no miraba ese valor: una descarga fallida que
 * dejara un `dist` de una versión anterior —o a medio escribir— se declaraba
 * correcta. El fallo no desaparecía, sólo se posponía hasta el primer arranque.
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
  buscarZip = buscarZipEnCache,
  registrar = log,
  plataforma = process.env.npm_config_platform || process.platform,
  arquitectura = process.env.npm_config_arch || process.arch
} = {}) {
  if (!fs.existsSync(dirElectron)) {
    // Instalación sin devDependencies: no hay nada que asegurar.
    return;
  }

  const version = JSON.parse(fs.readFileSync(path.join(dirElectron, 'package.json'), 'utf8')).version;
  const dist = path.join(dirElectron, 'dist');

  if (yaInstalado(dist, version, plataforma)) {
    registrar(`binario ${version} ya presente`);
    return;
  }

  const nombreZip = `electron-v${version}-${plataforma}-${arquitectura}.zip`;

  // Caché existente: se verifica ANTES, porque es el instalador quien extrae.
  // Un hash que no cuadra corta aquí, sin llegar a invocarlo.
  const zipPrevio = buscarZip(nombreZip);
  if (zipPrevio) {
    registrar(`zip en caché verificado (sha256 ${verificarZip(zipPrevio, nombreZip, dirElectron).slice(0, 16)}…)`);
  } else {
    registrar('binario ausente y sin zip en caché: se invoca el descargador oficial de electron');
  }

  // Un fallo aquí sube tal cual. No se mira si `dist` quedó con pinta de servir:
  // una descarga que terminó en error no autoriza a declarar la instalación
  // correcta, por muchos ficheros que haya dejado por el camino.
  descargar({ dirElectron });

  // Caché fría: `@electron/get` ya verificó al descargar contra este mismo
  // `checksums.json`. Repetirlo no añade seguridad; deja el hash en el log.
  if (!zipPrevio) {
    const zipNuevo = buscarZip(nombreZip);
    if (zipNuevo) {
      registrar(`zip descargado y verificado (sha256 ${verificarZip(zipNuevo, nombreZip, dirElectron).slice(0, 16)}…)`);
    }
  }

  if (!yaInstalado(dist, version, plataforma)) {
    throw new Error(
      `el descargador oficial terminó sin error pero no dejó utilizable el binario de Electron ${version}.\n`
      + `  falta: ${path.join(dist, rutaBinario(plataforma))}\n`
      + '  Comprueba red, proxy o ELECTRON_MIRROR y reintenta:\n'
      + '    node node_modules/electron/install.js'
    );
  }

  registrar(`binario ${version} listo (descargador oficial)`);
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
  rutaBinario,
  yaInstalado,
  buscarZipEnCache,
  sha256,
  verificarZip,
  descargarConInstaladorOficial,
  principal
};
