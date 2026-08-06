#!/usr/bin/env node
'use strict';

// Deja utilizable el binario de Electron después de `npm ci` / `npm install`.
//
// Dos motivos, y conviene no confundirlos.
//
// 1. DESCARGA. Desde Electron 43 el paquete npm **no declara ningún script**:
//    no hay `postinstall` que traiga el binario. El descargador oficial viaja
//    dentro del paquete —`install.js`, expuesto también como bin
//    `install-electron`— y hay que invocarlo. Mientras la caché de
//    `@electron/get` tuviera ya el zip, esto pasaba desapercibido; con una
//    caché fría, `npm ci` terminaba en rojo con el binario ausente. Depender de
//    una caché caliente es un requisito oculto, así que aquí se invoca el
//    mecanismo oficial cuando hace falta.
//
// 2. EXTRACCIÓN. Cuando el descargador oficial acierta en la caché, extrae con
//    `extract-zip` -> `yauzl@2.10.0`. Con Node 24 ese yauzl recorre el zip de
//    Electron, se detiene en la entrada 73 (`locales/fil.pak`) y emite `end`
//    como si el archivo hubiese terminado: sin error, sin excepción y sin
//    binario. El zip está bien —`Expand-Archive` lo extrae entero—; el
//    extractor no. Una instalación rota que sale 0 es peor que una que falla,
//    porque el fallo aparece mucho después y en otro sitio. Por eso queda el
//    respaldo de extraer con la herramienta del sistema.
//
// El paso es idempotente: si el binario ya está en la versión correcta, no hace
// nada.
//
// SEGURIDAD: el zip se verifica contra `checksums.json` del propio paquete
// electron SIEMPRE que esté en la caché, venga de una descarga de ahora o de
// una anterior, y ANTES de extraerlo. `@electron/get` sólo comprueba el hash
// cuando descarga: si acierta en la caché se fía de ella. Extraer sin comprobar
// convertiría cualquier escritura en el directorio de caché del usuario en
// ejecución de código, porque lo que se extrae es el ejecutable que después
// corre la aplicación entera.

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

/**
 * Extracción con la herramienta del sistema, que es justamente la que no falla
 * donde falla yauzl. No se usa ninguna dependencia nueva.
 */
function extraer(zip, destino) {
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(destino)} -Force`
    ], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', '-o', zip, '-d', destino], { stdio: 'inherit' });
  }
}

/**
 * Invoca el descargador que trae el propio paquete electron.
 *
 * No se reimplementa la descarga ni se inventa una URL: se ejecuta `install.js`,
 * que es el mismo punto de entrada que el bin `install-electron` del paquete y
 * que resuelve mirror, proxy y checksum a través de `@electron/get`.
 *
 * Un fallo aquí no se propaga: puede que el zip ya esté en otra raíz de caché, y
 * quien decide si hay binario utilizable es la comprobación posterior, no ésta.
 */
function descargarConInstaladorOficial() {
  const instalador = path.join(DIR_ELECTRON, 'install.js');
  if (!fs.existsSync(instalador)) {
    log('el paquete electron no trae install.js: no hay descargador oficial que invocar');
    return false;
  }
  log('binario ausente y sin zip en caché: se invoca el descargador oficial de electron');
  try {
    execFileSync(process.execPath, [instalador], { stdio: 'inherit', cwd: DIR_ELECTRON });
    return true;
  } catch (error) {
    log(`el descargador oficial terminó con error: ${error.message}`);
    return false;
  }
}

/** Comprueba el zip contra `checksums.json` del propio paquete electron. */
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
      `el zip no coincide con el hash declarado por electron.\n`
      + `  archivo:  ${zip}\n  esperado: ${esperado}\n  obtenido: ${obtenido}\n`
      + '  Bórralo y vuelve a instalar; no se acepta un artefacto sin verificar.'
    );
  }
  return obtenido;
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
  let zip = buscarZipEnCache(nombreZip);

  // Caché fría: el paquete electron ya no descarga solo. Se le pide que lo haga.
  if (!zip) {
    descargarConInstaladorOficial();
    zip = buscarZipEnCache(nombreZip);
  }

  // El hash se comprueba siempre que haya zip, tanto si lo acaba de traer el
  // descargador oficial como si llevaba meses en la caché del usuario.
  if (zip) {
    const hash = verificarZip(zip, nombreZip);
    log(`zip verificado (sha256 ${hash.slice(0, 16)}…)`);
  }

  // El descargador oficial puede haber dejado ya el binario extraído. En ese
  // caso no hay nada más que hacer: el zip, si estaba, ya quedó verificado.
  if (yaInstalado(dist, version, plataforma)) {
    log(`binario ${version} listo (descargador oficial)`);
    return;
  }

  if (!zip) {
    throw new Error(
      `falta el binario de Electron ${version} y no hay ${nombreZip} en la caché`
      + ' tras invocar el descargador oficial.\n'
      + '  Comprueba la red, el proxy o ELECTRON_MIRROR y reintenta:\n'
      + '    node node_modules/electron/install.js'
    );
  }

  log(`extrayendo ${nombreZip} (sha256 verificado)`);
  extraer(zip, dist);

  if (!fs.existsSync(path.join(dist, rutaBinario(plataforma)))) {
    throw new Error(`la extracción no produjo ${rutaBinario(plataforma)} en ${dist}`);
  }
  fs.writeFileSync(path.join(DIR_ELECTRON, 'path.txt'), rutaBinario(plataforma));
  log(`binario ${version} listo`);
}

if (require.main === module) {
  try {
    principal();
  } catch (error) {
    console.error(`ensure-electron-binary: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { rutaBinario, yaInstalado, buscarZipEnCache, sha256, verificarZip, descargarConInstaladorOficial };
