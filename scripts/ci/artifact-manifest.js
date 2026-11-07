#!/usr/bin/env node
'use strict';

// El inventario de artefactos de empaquetado, declarado una vez.
//
//   node scripts/ci/artifact-manifest.js --help
//   node scripts/ci/artifact-manifest.js --manifest --commit=<40 hex>
//   node scripts/ci/artifact-manifest.js --proof --producer=<id> --dir=<ruta> \
//        --commit=<40 hex> [--detected-arch=x86_64,arm64]
//
// Hoy la lista de lo que una release debe contener vive dentro de un `EXPECTED=(
// … )` en un paso de shell de build.yml, y la comprobación efectiva es
// `test -s` sobre cada nombre. Eso demuestra que llegó un fichero con ese
// nombre, no que sea el que se construyó. Aquí el inventario es un dato, y cada
// productor acompaña sus ficheros con los SHA-256 que calculó al terminar.
//
// Alcance, para no vender más de lo que hay: los nueve binarios que producen los
// cuatro jobs de plataforma. Los otros cinco elementos con checksum de la
// release —el tar.gz de fuentes, LICENSE, BUILDING.md, COMMUNITY.md y
// BUILD-METADATA.json— los genera `finalize-release`, no un job de empaquetado,
// y su tratamiento no cambia en este commit.
//
// Y sobre la palabra «prueba»: un SHA-256 demuestra que el fichero recibido es
// byte a byte el que el productor hasheó. No es una firma. No acredita origen ni
// autenticidad frente a quien controle el propio flujo; para eso harían falta
// firma o atestación, que no están aquí.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');

const VERSION_ESQUEMA = 1;
// Identidad completa, no abreviada: dos artefactos distintos no pueden compartir
// la referencia al commit del que salieron.
const COMMIT_VALIDO = /^[0-9a-f]{40}$/;

// Los identificadores de productor son estables y no dependen del nombre visible
// de ningún job: un job puede renombrarse por estética y el contrato no debe
// moverse con él.
const PRODUCTORES = {
  'windows-x64': { platform: 'windows', arch: 'x64' },
  'macos-x64': { platform: 'macos', arch: 'x64' },
  'macos-arm64': { platform: 'macos', arch: 'arm64' },
  'linux-x64': { platform: 'linux', arch: 'x64' }
};

// Nombre de fichero -> productor, tal y como electron-builder los genera con los
// `artifactName` declarados. `${version}` es lo único variable.
//
// `architectureProofRequired` sólo es cierto donde hoy existe una comprobación
// real de la arquitectura del binario: `lipo -archs` en los dos jobs de macOS.
// Windows verifica su paquete con verify-packaged-windows.js, pero lo que ese
// script demuestra sobre arquitectura es indirecto —que viaja el prebuild
// win32-x64— y Linux no comprueba arquitectura en absoluto. Marcarlos como
// requeridos sería exigir una evidencia que nadie produce; el nombre del fichero
// no la sustituye.
const PLANTILLAS = [
  { patron: 'MIKA5-Setup-{version}-win-x64.exe', producer: 'windows-x64', kind: 'installer', architectureProofRequired: false },
  { patron: 'MIKA5-Portable-{version}-win-x64.exe', producer: 'windows-x64', kind: 'portable', architectureProofRequired: false },
  { patron: 'MIKA5-{version}-mac-x64.dmg', producer: 'macos-x64', kind: 'disk-image', architectureProofRequired: true },
  { patron: 'MIKA5-{version}-mac-x64.zip', producer: 'macos-x64', kind: 'archive', architectureProofRequired: true },
  { patron: 'MIKA5-{version}-mac-arm64.dmg', producer: 'macos-arm64', kind: 'disk-image', architectureProofRequired: true },
  { patron: 'MIKA5-{version}-mac-arm64.zip', producer: 'macos-arm64', kind: 'archive', architectureProofRequired: true },
  { patron: 'MIKA5-{version}-linux-x86_64.AppImage', producer: 'linux-x64', kind: 'appimage', architectureProofRequired: false },
  { patron: 'MIKA5-{version}-linux-amd64.deb', producer: 'linux-x64', kind: 'deb', architectureProofRequired: false },
  { patron: 'MIKA5-{version}-linux-x86_64.rpm', producer: 'linux-x64', kind: 'rpm', architectureProofRequired: false }
];

// Lo único que puede aparecer en el directorio de un productor sin ser un
// artefacto de release. Cualquier otra cosa es un extra desconocido y se
// rechaza: «cualquier JSON» no vale.
const METADATA_INTERNA = ['artifact-proof.json'];

// La arquitectura que `lipo -archs` nombra, que no coincide con la nuestra.
const ARQUITECTURA_NATIVA = { x64: 'x86_64', arm64: 'arm64' };

function traza(mensaje) {
  process.stderr.write(`${mensaje}\n`);
}

function leerVersion(raiz) {
  const paquete = JSON.parse(fs.readFileSync(path.join(raiz || RAIZ, 'package.json'), 'utf8'));
  const version = paquete.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    const error = new Error(`versión de paquete inválida: ${JSON.stringify(version)}`);
    error.code = 'VERSION_INVALIDA';
    throw error;
  }
  return version;
}

function exigirCommit(commit) {
  if (!COMMIT_VALIDO.test(String(commit || ''))) {
    const error = new Error(
      `commit inválido: ${JSON.stringify(commit)}. Se exigen 40 caracteres hexadecimales en minúscula; una forma abreviada no identifica un artefacto sin ambigüedad.`);
    error.code = 'COMMIT_INVALIDO';
    throw error;
  }
  return commit;
}

/**
 * Un nombre de artefacto es un nombre de fichero, nunca una ruta. Todo lo que
 * pueda salirse del directorio de su productor se rechaza aquí, antes de que
 * nadie lo abra.
 */
function nombreSeguro(nombre) {
  if (typeof nombre !== 'string' || nombre === '') return 'vacío o no es una cadena';
  if (nombre.includes('\0')) return 'contiene NUL';
  if (nombre.includes('/') || nombre.includes('\\')) return 'contiene separadores de ruta';
  if (nombre === '.' || nombre === '..') return 'es una referencia a directorio';
  if (path.isAbsolute(nombre)) return 'es una ruta absoluta';
  // Unidad de Windows sin separador: `C:archivo` se resuelve relativo al
  // directorio actual de esa unidad, que no es el que creemos.
  if (/^[a-zA-Z]:/.test(nombre)) return 'lleva una letra de unidad';
  return null;
}

function construirManifiesto(opciones) {
  const version = (opciones && opciones.version) || leerVersion(opciones && opciones.raiz);
  const commit = exigirCommit(opciones && opciones.commit);

  const artifacts = PLANTILLAS.map(plantilla => {
    const nombre = plantilla.patron.replace('{version}', version);
    const problema = nombreSeguro(nombre);
    if (problema) {
      const error = new Error(`el contrato declara un nombre inseguro (${nombre}): ${problema}`);
      error.code = 'NOMBRE_INSEGURO';
      throw error;
    }
    const { platform, arch } = PRODUCTORES[plantilla.producer];
    return {
      name: nombre,
      platform,
      arch,
      producer: plantilla.producer,
      kind: plantilla.kind,
      architectureProofRequired: plantilla.architectureProofRequired
    };
  });

  // Sin marcas de tiempo, sin identificadores aleatorios, sin rutas absolutas y
  // sin nada del runner: dos ejecuciones con las mismas entradas producen bytes
  // idénticos.
  return {
    schemaVersion: VERSION_ESQUEMA,
    product: 'MIKA5',
    version,
    commit,
    producers: Object.keys(PRODUCTORES).map(id => ({
      id,
      platform: PRODUCTORES[id].platform,
      arch: PRODUCTORES[id].arch
    })),
    artifacts
  };
}

function artefactosDe(manifiesto, producer) {
  return manifiesto.artifacts.filter(a => a.producer === producer);
}

function sha256(rutaAbsoluta) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(rutaAbsoluta));
  return hash.digest('hex');
}

/**
 * Genera el `artifact-proof.json` de un productor a partir de los ficheros que
 * tiene delante. Los hashes se calculan aquí sobre los bytes reales; no se
 * aceptan valores dados desde fuera.
 */
function construirProof(opciones) {
  const { producer, dir } = opciones;
  const definicion = PRODUCTORES[producer];
  if (!definicion) {
    const error = new Error(`productor desconocido: ${JSON.stringify(producer)}. Válidos: ${Object.keys(PRODUCTORES).join(', ')}`);
    error.code = 'PRODUCTOR_DESCONOCIDO';
    throw error;
  }
  const manifiesto = construirManifiesto(opciones);
  const esperados = artefactosDe(manifiesto, producer);
  const detectada = opciones.detectedArchitecture || null;

  const files = esperados.map(artefacto => {
    const completa = path.join(dir, artefacto.name);
    const info = fs.lstatSync(completa);
    if (info.isSymbolicLink()) {
      const error = new Error(`${artefacto.name} es un enlace simbólico; un artefacto de release tiene que ser un archivo regular`);
      error.code = 'ENLACE_SIMBOLICO';
      throw error;
    }
    if (!info.isFile()) {
      const error = new Error(`${artefacto.name} no es un archivo regular`);
      error.code = 'NO_ES_ARCHIVO';
      throw error;
    }
    const entrada = {
      name: artefacto.name,
      sha256: sha256(completa),
      bytes: info.size
    };
    if (artefacto.architectureProofRequired) {
      if (!detectada) {
        const error = new Error(
          `${artefacto.name} exige prueba de arquitectura y no se ha proporcionado --detected-arch. Ese valor lo produce el verificador nativo de la plataforma (lipo en macOS); este script no lo inventa a partir del nombre del fichero.`);
        error.code = 'FALTA_ARQUITECTURA_DETECTADA';
        throw error;
      }
      entrada.detectedArchitecture = detectada;
    }
    return entrada;
  });

  return {
    schemaVersion: VERSION_ESQUEMA,
    commit: manifiesto.commit,
    version: manifiesto.version,
    platform: definicion.platform,
    arch: definicion.arch,
    producer,
    files
  };
}

// --- CLI --------------------------------------------------------------------

const AYUDA = `
Inventario y pruebas de integridad de los artefactos de empaquetado.

  --help
      Muestra esta ayuda.

  --manifest --commit=<40 hex>
      Escribe en stdout el manifiesto canónico en JSON. La versión sale de
      package.json; el commit se pasa entero, sin abreviar.

  --proof --producer=<id> --dir=<ruta> --commit=<40 hex> [--detected-arch=<lista>]
      Escribe en stdout el artifact-proof.json de un productor, calculando el
      SHA-256 de cada fichero declarado para él. --detected-arch es obligatorio
      cuando alguno de sus artefactos exige prueba de arquitectura, y su valor
      procede del verificador nativo de la plataforma.

Productores: ${Object.keys(PRODUCTORES).join(', ')}

stdout lleva sólo JSON; los diagnósticos van a stderr.
`.trim();

function leerArgumentos(argv) {
  const opciones = { modo: null };
  for (const argumento of argv) {
    if (argumento === '--help' || argumento === '-h') opciones.modo = 'help';
    else if (argumento === '--manifest') opciones.modo = 'manifest';
    else if (argumento === '--proof') opciones.modo = 'proof';
    else {
      const m = /^--([a-z-]+)=(.*)$/.exec(argumento);
      if (m) opciones[m[1]] = m[2];
    }
  }
  return opciones;
}

function principal(argv) {
  const opciones = leerArgumentos(argv);
  if (opciones.modo === 'help' || opciones.modo === null) {
    process.stderr.write(`${AYUDA}\n`);
    return opciones.modo === 'help' ? 0 : 1;
  }
  try {
    if (opciones.modo === 'manifest') {
      const manifiesto = construirManifiesto({ commit: opciones.commit });
      process.stdout.write(`${JSON.stringify(manifiesto, null, 2)}\n`);
      traza(`manifiesto de ${manifiesto.artifacts.length} artefactos para la versión ${manifiesto.version}`);
      return 0;
    }
    const proof = construirProof({
      producer: opciones.producer,
      dir: opciones.dir,
      commit: opciones.commit,
      detectedArchitecture: opciones['detected-arch']
        ? opciones['detected-arch'].split(',').map(s => s.trim()).filter(Boolean)
        : null
    });
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
    traza(`prueba de ${proof.files.length} artefactos del productor ${proof.producer}`);
    return 0;
  } catch (error) {
    traza(`error: ${error.message}`);
    return 1;
  }
}

module.exports = {
  construirManifiesto,
  construirProof,
  artefactosDe,
  leerVersion,
  exigirCommit,
  nombreSeguro,
  sha256,
  PRODUCTORES,
  PLANTILLAS,
  METADATA_INTERNA,
  ARQUITECTURA_NATIVA,
  VERSION_ESQUEMA,
  COMMIT_VALIDO
};

if (require.main === module) {
  process.exit(principal(process.argv.slice(2)));
}
