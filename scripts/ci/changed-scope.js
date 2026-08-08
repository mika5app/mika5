#!/usr/bin/env node
'use strict';

// ¿Este rango de commits obliga a empaquetar, o a desplegar la web?
//
//   node scripts/ci/changed-scope.js --scope=packaging
//   node scripts/ci/changed-scope.js --scope=web
//
// Escribe `true` o `false` en stdout y nada más: todo lo explicativo va a
// stderr, para que el consumidor no tenga que parsear. El código de salida
// indica si la evaluación pudo hacerse, no su resultado — un `false` legítimo
// sale con 0, igual que un `true`.
//
// La regla que gobierna todo lo demás: ante cualquier duda, `true`. Un rango que
// no se puede resolver, un `before` que ya no existe tras un force-push, git
// ausente — todos ellos responden «hay que validar más», nunca «no hace falta».
// Equivocarse hacia `true` cuesta unos minutos de CI; equivocarse hacia `false`
// significa publicar sin haber empaquetado, que es la clase de fallo que este
// trabajo existe para evitar.
//
// Sobre `packaging`: lista lo que cambia la INFRAESTRUCTURA de empaquetado, no
// cualquier cambio de la aplicación. `src/**` no está: su contenido acaba dentro
// del paquete, pero los gates ya lo cubren y empaquetar cuatro plataformas por
// cada cambio de renderer no aportaría evidencia nueva. Sí está
// `src/renderer/assets/icon.png`, porque electron-builder lo nombra como icono
// de Linux y los dos generadores de iconos lo leen: no está por vivir en `src/`.

const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');

const SHA_CERO = '0'.repeat(40);
// Git acepta abreviaturas; se admite de 7 a 40 hexadecimales y nada más. Sirve
// también de barrera: lo que no encaja aquí no llega nunca a un argumento de git.
const SHA_VALIDO = /^[0-9a-f]{7,40}$/i;

/**
 * Cada scope declara prefijos de directorio y rutas exactas. Se separan porque
 * `build/**` debe aceptar `build/x` y rechazar `build-tools/x`, mientras que
 * `src/renderer/assets/icon.png` sólo vale exacto: un `icon.png.backup` no es el
 * icono.
 */
const SCOPES = {
  packaging: {
    prefijos: [
      'scripts/ci/',
      // directories.buildResources de electron-builder: entitlements.mac.plist,
      // icon.ico y los scripts afterInstall/afterRemove del .deb viven aquí.
      'build/'
    ],
    exactos: [
      '.github/workflows/_canonical.yml',
      '.github/workflows/integration.yml',
      'scripts/gen-icns.sh',
      'scripts/ensure-electron-binary.js',
      'scripts/verify-packaged-windows.js',
      'electron-builder.json',
      'package.json',
      'package-lock.json',
      // Icono de Linux en electron-builder.json y fuente de gen-icns.sh.
      // `scripts/gen-ico.js` NO está: ningún workflow lo ejecuta hoy, y el
      // build/icon.ico que consume electron-builder viene commiteado. Si algún
      // día se invoca, hay que ampliar esta lista en ese mismo cambio.
      'src/renderer/assets/icon.png'
    ]
  },
  web: {
    prefijos: ['web/'],
    exactos: []
  }
};

/** Traza a stderr. stdout queda reservado para el veredicto. */
function traza(mensaje) {
  process.stderr.write(`${mensaje}\n`);
}

function esShaValido(valor) {
  return typeof valor === 'string' && SHA_VALIDO.test(valor);
}

function rutaEnScope(ruta, definicion) {
  const normalizada = String(ruta).replace(/\\/g, '/');
  if (definicion.exactos.includes(normalizada)) return true;
  // El prefijo termina en `/`, así que `build/` no puede casar con
  // `build-tools/foo` ni con `mybuild/foo`.
  return definicion.prefijos.some(prefijo => normalizada.startsWith(prefijo));
}

/** Ejecución real de git. Sin shell y con los argumentos separados. */
function ejecutarGit(argumentos, cwd) {
  const resultado = spawnSync('git', argumentos, {
    cwd,
    encoding: 'utf8',
    shell: false
  });
  if (resultado.error) {
    return { ok: false, motivo: resultado.error.code || resultado.error.message, salida: '' };
  }
  if (resultado.status !== 0) {
    return { ok: false, motivo: `git salió con ${resultado.status}`, salida: '' };
  }
  return { ok: true, motivo: null, salida: String(resultado.stdout || '') };
}

function existeCommit(sha, cwd, git) {
  // `^{commit}` obliga a que sea un commit y no una etiqueta o un blob.
  return git(['cat-file', '-e', `${sha}^{commit}`], cwd).ok;
}

/**
 * Devuelve las rutas del rango, o `null` si no se puede determinar. `null`
 * significa «no lo sé», y quien lo recibe responde `true`.
 */
function rutasCambiadas(opciones) {
  const { before, sha, eventName, repoRoot, git } = opciones;

  if (eventName === 'workflow_dispatch') {
    traza('workflow_dispatch: no hay rango que calcular, se evalúa como cambio total');
    return null;
  }
  if (before === SHA_CERO) {
    traza('before es el SHA cero: rama recién creada o reescrita, se evalúa como cambio total');
    return null;
  }
  // Ausente o con forma inválida se tratan igual, y a propósito. Distinguir el
  // error humano de un dato que GitHub no envió exigiría una señal que aquí no
  // existe, y equivocarse hacia `false` es el único desenlace inaceptable. El
  // motivo concreto sí se traza, para que el diagnóstico no se pierda.
  if (!esShaValido(before)) {
    traza(`before ausente o con forma no válida (${JSON.stringify(before)}): se evalúa como cambio total`);
    return null;
  }
  if (!esShaValido(sha)) {
    traza(`sha ausente o con forma no válida (${JSON.stringify(sha)}): se evalúa como cambio total`);
    return null;
  }
  if (!existeCommit(before, repoRoot, git)) {
    traza(`el commit ${before} no está en el repositorio: se evalúa como cambio total`);
    return null;
  }
  if (!existeCommit(sha, repoRoot, git)) {
    traza(`el commit ${sha} no está en el repositorio: se evalúa como cambio total`);
    return null;
  }

  // Dos puntos, no tres: interesa lo que cambió entre before y sha, no lo que
  // cambió desde su base común. Con tres puntos, un force-push daría un conjunto
  // distinto del que el push realmente introdujo.
  //
  // `--no-renames` y `-z` no son adorno; sin ellas la respuesta era falsa en dos
  // situaciones distintas, ambas medidas:
  //
  //   1. La detección de renames viene activada por defecto, y `--name-only`
  //      colapsa el par en una sola línea con el DESTINO. Mover
  //      web/index.html a archive/index.html imprimía sólo `archive/index.html`,
  //      así que el scope `web` respondía `false` a un cambio que deja la web
  //      sin ese fichero. Con `--no-renames` el rename se reporta como borrado
  //      más alta, y aparecen los dos lados.
  //
  //   2. Con `core.quotePath` —también por defecto— git envuelve en comillas y
  //      escapa en octal cualquier byte no ASCII: `web/página.html` salía como
  //      `"web/p\303\241gina.html"`, que no empieza por `web/`. `-z` desactiva
  //      ese escapado y además separa por NUL, de modo que un nombre con salto
  //      de línea o tabulador deja de partir la salida en dos.
  //
  // Por lo mismo no se recorta cada entrada: con `-z` el separador es
  // inequívoco, y un `trim()` mutilaría un nombre que empiece o acabe en espacio.
  const diff = git(['diff', '--name-only', '-z', '--no-renames', before, sha, '--'], repoRoot);
  if (!diff.ok) {
    traza(`git diff no se pudo ejecutar (${diff.motivo}): se evalúa como cambio total`);
    return null;
  }
  return diff.salida.split('\0').filter(l => l !== '');
}

/**
 * @returns {{ afecta: boolean, rutas: string[]|null, coincidencias: string[] }}
 */
function evaluarScope(opciones) {
  const scope = opciones && opciones.scope;
  const definicion = SCOPES[scope];
  if (!definicion) {
    const error = new Error(`scope desconocido: ${JSON.stringify(scope)}. Válidos: ${Object.keys(SCOPES).join(', ')}`);
    error.code = 'SCOPE_DESCONOCIDO';
    throw error;
  }

  const rutas = rutasCambiadas({
    before: opciones.before,
    sha: opciones.sha,
    eventName: opciones.eventName,
    repoRoot: opciones.repoRoot || RAIZ,
    git: opciones.git || ejecutarGit
  });

  if (rutas === null) return { afecta: true, rutas: null, coincidencias: [] };

  const coincidencias = rutas.filter(ruta => rutaEnScope(ruta, definicion));
  traza(`${rutas.length} ruta(s) en el rango, ${coincidencias.length} dentro del scope ${scope}`);
  if (coincidencias.length > 0) traza(`  ${coincidencias.join('\n  ')}`);
  return { afecta: coincidencias.length > 0, rutas, coincidencias };
}

function leerArgumentos(argv) {
  let scope;
  for (const argumento of argv) {
    const m = /^--scope=(.*)$/.exec(argumento);
    if (m) scope = m[1];
  }
  return { scope };
}

function principal(argv, entorno) {
  const { scope } = leerArgumentos(argv);
  let resultado;
  try {
    resultado = evaluarScope({
      scope,
      // `GITHUB_EVENT_BEFORE` no la define Actions: el caller tiene que pasarla
      // explícitamente desde `github.event.before`. Que no exista por sí sola es
      // deseable — así nadie da por hecho un rango que nadie proporcionó.
      before: entorno.GITHUB_EVENT_BEFORE,
      sha: entorno.GITHUB_SHA,
      eventName: entorno.GITHUB_EVENT_NAME,
      repoRoot: RAIZ
    });
  } catch (error) {
    traza(`error de uso: ${error.message}`);
    return 1;
  }
  process.stdout.write(`${resultado.afecta}\n`);
  return 0;
}

module.exports = { evaluarScope, rutaEnScope, esShaValido, SCOPES, SHA_CERO };

if (require.main === module) {
  process.exit(principal(process.argv.slice(2), process.env));
}
