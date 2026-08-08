#!/usr/bin/env node
'use strict';

// Verifica un staging de artefactos contra el manifiesto canónico.
//
//   node scripts/ci/verify-artifacts.js --dir=<staging> --commit=<40 hex>
//
// Estructura esperada, un directorio por productor para que ninguna prueba pueda
// confundirse con la de otro:
//
//   <staging>/
//     windows-x64/    MIKA5-Setup-…exe  MIKA5-Portable-…exe  artifact-proof.json
//     macos-x64/      …-mac-x64.dmg     …-mac-x64.zip        artifact-proof.json
//     macos-arm64/    …-mac-arm64.dmg   …-mac-arm64.zip      artifact-proof.json
//     linux-x64/      …AppImage  …deb  …rpm                  artifact-proof.json
//
// Todo se comprueba en contra: la identidad exacta de cada artefacto es la regla
// primaria, y el recuento sólo un último cierre de cordura. Un `count === 9` que
// pasara con nueve ficheros equivocados no valdría de nada.
//
// Qué demuestra y qué no: recalcular el SHA-256 prueba que lo recibido es byte a
// byte lo que el productor hasheó. No es una firma, no acredita el origen, y no
// protege frente a quien pueda alterar prueba y fichero a la vez. Eso exigiría
// firma o atestación, que no están aquí.

const fs = require('fs');
const path = require('path');

const {
  construirManifiesto,
  artefactosDe,
  leerVersion,
  exigirCommit,
  nombreSeguro,
  sha256,
  PRODUCTORES,
  METADATA_INTERNA,
  VERSION_ESQUEMA
} = require('./artifact-manifest');

const RAIZ = path.join(__dirname, '..', '..');
const NOMBRE_PROOF = 'artifact-proof.json';

function traza(mensaje) {
  process.stderr.write(`${mensaje}\n`);
}

/**
 * Comprueba que `candidato` queda realmente dentro de `base` una vez resuelto.
 * Un nombre puede parecer inocente y resolverse fuera; lo que decide es la ruta
 * resuelta, no su aspecto.
 */
function dentroDe(base, candidato) {
  const raizResuelta = path.resolve(base);
  const destino = path.resolve(base, candidato);
  const relativa = path.relative(raizResuelta, destino);
  return relativa !== '' && !relativa.startsWith('..') && !path.isAbsolute(relativa);
}

function verificarStaging(opciones) {
  const problemas = [];
  const anotar = (mensaje) => problemas.push(mensaje);

  const staging = opciones.dir;
  const version = opciones.version || leerVersion(opciones.raiz || RAIZ);
  let commit;
  try {
    commit = exigirCommit(opciones.commit);
  } catch (error) {
    return { ok: false, problemas: [error.message], comprobados: 0 };
  }

  let manifiesto;
  try {
    manifiesto = construirManifiesto({ commit, version });
  } catch (error) {
    return { ok: false, problemas: [error.message], comprobados: 0 };
  }

  if (!fs.existsSync(staging) || !fs.statSync(staging).isDirectory()) {
    return { ok: false, problemas: [`el staging no existe o no es un directorio: ${staging}`], comprobados: 0 };
  }

  const productoresEsperados = Object.keys(PRODUCTORES);

  // Directorios presentes. Un productor de más también es un fallo: nadie debería
  // estar subiendo algo que el contrato no conoce.
  const entradasRaiz = fs.readdirSync(staging, { withFileTypes: true });
  const dirsPresentes = entradasRaiz.filter(e => e.isDirectory()).map(e => e.name);
  for (const entrada of entradasRaiz) {
    if (!entrada.isDirectory()) anotar(`el staging contiene algo que no es un directorio de productor: ${entrada.name}`);
    else if (!productoresEsperados.includes(entrada.name)) anotar(`directorio de productor desconocido: ${entrada.name}`);
  }
  // Un mismo productor no puede aparecer dos veces ni siquiera cambiando
  // mayúsculas: en Windows serían el mismo directorio y en Linux dos distintos.
  const porMinusculas = new Map();
  for (const nombre of dirsPresentes) {
    const clave = nombre.toLowerCase();
    if (porMinusculas.has(clave)) anotar(`dos directorios de productor colisionan ignorando mayúsculas: ${porMinusculas.get(clave)} y ${nombre}`);
    else porMinusculas.set(clave, nombre);
  }

  // Nombre de artefacto -> productores que lo reclaman. Ningún fichero puede
  // atribuirse a dos.
  const atribucion = new Map();
  let comprobados = 0;

  for (const producer of productoresEsperados) {
    const definicion = PRODUCTORES[producer];
    const dirProductor = path.join(staging, producer);
    const esperados = artefactosDe(manifiesto, producer);

    if (!fs.existsSync(dirProductor)) {
      anotar(`falta el directorio del productor ${producer}`);
      continue;
    }

    // --- la prueba ---
    const rutaProof = path.join(dirProductor, NOMBRE_PROOF);
    if (!fs.existsSync(rutaProof)) {
      anotar(`${producer}: falta ${NOMBRE_PROOF}`);
      continue;
    }
    let proof;
    try {
      proof = JSON.parse(fs.readFileSync(rutaProof, 'utf8'));
    } catch (error) {
      anotar(`${producer}: ${NOMBRE_PROOF} no es JSON válido (${error.message})`);
      continue;
    }

    if (proof.schemaVersion !== VERSION_ESQUEMA) {
      anotar(`${producer}: schemaVersion ${JSON.stringify(proof.schemaVersion)} no reconocido (se espera ${VERSION_ESQUEMA})`);
      continue;
    }
    if (proof.producer !== producer) {
      anotar(`${producer}: la prueba dice pertenecer al productor ${JSON.stringify(proof.producer)}`);
      continue;
    }
    if (proof.commit !== manifiesto.commit) anotar(`${producer}: la prueba declara el commit ${proof.commit}, se esperaba ${manifiesto.commit}`);
    if (proof.version !== manifiesto.version) anotar(`${producer}: la prueba declara la versión ${proof.version}, se esperaba ${manifiesto.version}`);
    if (proof.platform !== definicion.platform) anotar(`${producer}: la prueba declara la plataforma ${proof.platform}, se esperaba ${definicion.platform}`);
    if (proof.arch !== definicion.arch) anotar(`${producer}: la prueba declara la arquitectura ${proof.arch}, se esperaba ${definicion.arch}`);

    const entradas = Array.isArray(proof.files) ? proof.files : null;
    if (!entradas) {
      anotar(`${producer}: la prueba no lleva una lista files[]`);
      continue;
    }

    // La seguridad de las rutas se comprueba sobre TODAS las entradas, antes de
    // cruzarlas con el contrato. Si sólo se validaran las que coinciden con un
    // artefacto esperado, un `../fuera.bin` se rechazaría de rebote —por no
    // pertenecer al productor— en lugar de por lo que es, y la regla dejaría de
    // aplicarse el día que el nombre sí coincidiera.
    for (const entrada of entradas) {
      const nombre = entrada && entrada.name;
      const problema = nombreSeguro(nombre);
      if (problema) {
        anotar(`${producer}: la prueba declara una ruta insegura (${JSON.stringify(nombre)}): ${problema}`);
      } else if (!dentroDe(dirProductor, nombre)) {
        anotar(`${producer}: ${nombre} se resuelve fuera del directorio del productor`);
      }
    }

    // --- contenido del directorio ---
    const presentes = fs.readdirSync(dirProductor, { withFileTypes: true });
    const nombresPresentes = presentes.map(e => e.name);
    const nombresEsperados = esperados.map(a => a.name);

    for (const entrada of presentes) {
      if (METADATA_INTERNA.includes(entrada.name)) continue;
      if (!nombresEsperados.includes(entrada.name)) {
        anotar(`${producer}: sobra ${entrada.name}, que el contrato no declara`);
      }
    }
    const vistos = new Map();
    for (const nombre of nombresPresentes) {
      const clave = nombre.toLowerCase();
      if (vistos.has(clave) && vistos.get(clave) !== nombre) {
        anotar(`${producer}: ${vistos.get(clave)} y ${nombre} colisionan ignorando mayúsculas`);
      } else {
        vistos.set(clave, nombre);
      }
    }

    // --- cada artefacto declarado ---
    for (const artefacto of esperados) {
      const previo = atribucion.get(artefacto.name);
      if (previo && previo !== producer) {
        anotar(`${artefacto.name} lo reclaman dos productores: ${previo} y ${producer}`);
      }
      atribucion.set(artefacto.name, producer);

      const declaradas = entradas.filter(f => f && f.name === artefacto.name);
      if (declaradas.length === 0) {
        anotar(`${producer}: la prueba no menciona ${artefacto.name}`);
        continue;
      }
      if (declaradas.length > 1) {
        anotar(`${producer}: la prueba declara ${artefacto.name} ${declaradas.length} veces`);
        continue;
      }
      const declarada = declaradas[0];

      const problemaNombre = nombreSeguro(declarada.name);
      if (problemaNombre) {
        anotar(`${producer}: nombre inseguro en la prueba (${JSON.stringify(declarada.name)}): ${problemaNombre}`);
        continue;
      }
      if (!dentroDe(dirProductor, declarada.name)) {
        anotar(`${producer}: ${declarada.name} se resuelve fuera del directorio del productor`);
        continue;
      }

      const completa = path.join(dirProductor, declarada.name);
      if (!fs.existsSync(completa)) {
        anotar(`${producer}: falta el artefacto ${declarada.name}`);
        continue;
      }
      const info = fs.lstatSync(completa);
      if (info.isSymbolicLink()) {
        anotar(`${producer}: ${declarada.name} es un enlace simbólico; se exige un archivo regular`);
        continue;
      }
      if (!info.isFile()) {
        anotar(`${producer}: ${declarada.name} no es un archivo regular`);
        continue;
      }

      if (info.size !== declarada.bytes) {
        anotar(`${producer}: ${declarada.name} ocupa ${info.size} bytes y la prueba declara ${declarada.bytes}`);
      }
      const real = sha256(completa);
      if (real !== declarada.sha256) {
        anotar(`${producer}: el SHA-256 de ${declarada.name} no coincide (recibido ${real}, declarado ${declarada.sha256})`);
      }

      if (artefacto.architectureProofRequired) {
        const detectada = declarada.detectedArchitecture;
        if (!Array.isArray(detectada) || detectada.length === 0) {
          anotar(`${producer}: ${declarada.name} exige prueba de arquitectura y la prueba no la trae`);
        } else {
          const nativa = require('./artifact-manifest').ARQUITECTURA_NATIVA[artefacto.arch];
          const contraria = Object.entries(require('./artifact-manifest').ARQUITECTURA_NATIVA)
            .filter(([k]) => k !== artefacto.arch).map(([, v]) => v);
          if (!detectada.includes(nativa)) {
            anotar(`${producer}: ${declarada.name} debía declarar ${nativa} y declara ${JSON.stringify(detectada)}`);
          }
          const mezcla = detectada.filter(a => contraria.includes(a));
          if (mezcla.length > 0) {
            anotar(`${producer}: ${declarada.name} mezcla la arquitectura contraria (${mezcla.join(', ')})`);
          }
        }
      }

      comprobados += 1;
    }

    // Entradas de la prueba que no corresponden a ningún artefacto del contrato.
    for (const entrada of entradas) {
      if (!entrada || typeof entrada.name !== 'string') {
        anotar(`${producer}: la prueba lleva una entrada sin nombre`);
        continue;
      }
      if (!nombresEsperados.includes(entrada.name)) {
        anotar(`${producer}: la prueba declara ${entrada.name}, que no pertenece a este productor`);
      }
    }
  }

  // Cierre de cordura, nunca la regla principal.
  const totalEsperado = manifiesto.artifacts.length;
  if (problemas.length === 0 && comprobados !== totalEsperado) {
    anotar(`se verificaron ${comprobados} artefactos y el contrato declara ${totalEsperado}`);
  }

  return { ok: problemas.length === 0, problemas, comprobados, totalEsperado, manifiesto };
}

// --- CLI --------------------------------------------------------------------

const AYUDA = `
Verifica un staging de artefactos contra el manifiesto canónico.

  --dir=<ruta>        Directorio de staging, con un subdirectorio por productor.
  --commit=<40 hex>   Commit que deben declarar el manifiesto y cada prueba.
  --help              Muestra esta ayuda.

Sale con 0 si todo cuadra y con 1 en cuanto algo no lo hace.
`.trim();

function principal(argv) {
  const opciones = {};
  for (const argumento of argv) {
    if (argumento === '--help' || argumento === '-h') opciones.help = true;
    const m = /^--([a-z-]+)=(.*)$/.exec(argumento);
    if (m) opciones[m[1]] = m[2];
  }
  if (opciones.help || !opciones.dir) {
    process.stderr.write(`${AYUDA}\n`);
    return opciones.help ? 0 : 1;
  }

  const resultado = verificarStaging({ dir: opciones.dir, commit: opciones.commit });
  if (resultado.ok) {
    traza(`${resultado.comprobados}/${resultado.totalEsperado} artefactos verificados contra sus pruebas`);
    return 0;
  }
  traza(`${resultado.problemas.length} problema(s):`);
  for (const problema of resultado.problemas) traza(`  - ${problema}`);
  return 1;
}

module.exports = { verificarStaging, dentroDe, NOMBRE_PROOF };

if (require.main === module) {
  process.exit(principal(process.argv.slice(2)));
}
