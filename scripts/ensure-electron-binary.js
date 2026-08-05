#!/usr/bin/env node
'use strict';

// Deja utilizable el binario de Electron después de `npm ci` / `npm install`.
//
// Por qué existe: en esta máquina `npm ci` terminaba con código 0 y sin
// binario. El postinstall de electron llama a `@electron/get`, que acierta en
// la caché, y luego extrae con `extract-zip@2.0.1` -> `yauzl@2.10.0`. Con
// Node 24 ese yauzl recorre el zip de Electron, se detiene en la entrada 73
// (`locales/fil.pak`) y emite `end` como si el archivo hubiese terminado: sin
// error, sin excepción y sin binario. El zip está bien —`Expand-Archive` lo
// extrae entero—; el extractor no. Una instalación rota que sale 0 es peor que
// una que falla, porque el fallo aparece mucho después y en otro sitio.
//
// Este paso es idempotente y no descarga nada: si el binario ya está, no hace
// nada; si falta, extrae el zip que `@electron/get` dejó en la caché.
//
// SEGURIDAD: el zip se verifica contra `checksums.json` del propio paquete
// electron ANTES de extraerlo. `@electron/get` sólo comprueba el hash cuando
// descarga: si acierta en la caché se fía de ella. Extraer sin comprobar
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
  const zip = buscarZipEnCache(nombreZip);
  if (!zip) {
    throw new Error(
      `falta el binario de Electron ${version} y no hay ${nombreZip} en la caché.\n`
      + '  Ejecuta: node node_modules/electron/install.js\n'
      + '  Si eso termina sin crear node_modules/electron/dist/'
      + `${rutaBinario(plataforma)}, es el fallo de yauzl con Node ${process.versions.node}.`
    );
  }

  const esperado = (() => {
    try {
      return require(path.join(DIR_ELECTRON, 'checksums.json'))[nombreZip];
    } catch (_) {
      return null;
    }
  })();
  if (!esperado) {
    throw new Error(`checksums.json no declara ${nombreZip}: no se extrae nada sin poder verificarlo`);
  }
  const obtenido = sha256(zip);
  if (obtenido !== String(esperado).toLowerCase()) {
    throw new Error(
      `el zip en caché no coincide con el hash declarado por electron.\n`
      + `  archivo:  ${zip}\n  esperado: ${esperado}\n  obtenido: ${obtenido}\n`
      + '  Bórralo y vuelve a instalar; no se extrae un artefacto sin verificar.'
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

module.exports = { rutaBinario, yaInstalado, buscarZipEnCache, sha256 };
