'use strict';

// Descubrimiento de motores y modelos locales.
//
// Sólo LEE el disco, y sólo en sitios conocidos: los directorios donde los
// instaladores oficiales dejan `llama-server`, y las carpetas donde las
// herramientas habituales guardan modelos GGUF. No recorre el disco entero,
// no sigue enlaces simbólicos, no descarga nada y no ejecuta nada.
//
// Todo recorrido tiene techo —profundidad, entradas visitadas, resultados—
// para que una carpeta enorme no congele la aplicación.

const nodePath = require('path');

const LIMITES = Object.freeze({
  profundidad: 6,
  entradas: 6000,
  modelos: 200,
  ejecutables: 20
});

/** Un proyector multimodal también es GGUF, pero no es un modelo de chat. */
const NO_ES_MODELO = /mmproj|projector/i;

function rutasDe(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function carpetaPersonal(env, platform) {
  return platform === 'win32' ? (env.USERPROFILE || '') : (env.HOME || '');
}

function esFichero(fs, ruta) {
  try {
    return fs.statSync(ruta).isFile();
  } catch (_) {
    return false;
  }
}

function listar(fs, dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

/** Los cuatro primeros bytes de un GGUF son las letras «GGUF». */
function esGguf(fs, ruta) {
  let fd = null;
  try {
    fd = fs.openSync(ruta, 'r');
    const cabecera = Buffer.alloc(4);
    return fs.readSync(fd, cabecera, 0, 4, 0) === 4 && cabecera.toString('latin1') === 'GGUF';
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

/**
 * Directorios donde puede estar el ejecutable de un motor, por orden de
 * preferencia: el PATH, las ubicaciones de los instaladores oficiales y las
 * carpetas de compilación habituales bajo la carpeta personal.
 */
function directoriosDeEjecutable(nombre, { fs, env, platform }) {
  const rutas = rutasDe(platform);
  const home = carpetaPersonal(env, platform);
  const dirs = String(env.PATH || env.Path || '').split(rutas.delimiter);

  if (nombre === 'ollama') {
    if (platform === 'win32') {
      if (env.LOCALAPPDATA) dirs.push(rutas.join(env.LOCALAPPDATA, 'Programs', 'Ollama'));
    } else if (platform === 'darwin') {
      dirs.push('/Applications/Ollama.app/Contents/Resources', '/usr/local/bin', '/opt/homebrew/bin');
    } else {
      dirs.push('/usr/local/bin', '/usr/bin');
    }
  }

  if (nombre === 'llama-server') {
    if (platform === 'win32') {
      if (env.LOCALAPPDATA) {
        const winget = rutas.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet');
        dirs.push(rutas.join(winget, 'Links'));
        // winget deja cada paquete en su carpeta; el nombre lleva el
        // identificador del paquete y un sufijo del origen.
        for (const paquete of listar(fs, rutas.join(winget, 'Packages'))) {
          if (!paquete.isDirectory() || !/llama/i.test(paquete.name)) continue;
          const base = rutas.join(winget, 'Packages', paquete.name);
          dirs.push(base);
          for (const hijo of listar(fs, base)) {
            if (hijo.isDirectory()) dirs.push(rutas.join(base, hijo.name));
          }
        }
      }
      if (home) dirs.push(rutas.join(home, 'scoop', 'shims'));
    } else {
      dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
      if (home) dirs.push(rutas.join(home, '.local', 'bin'));
    }
    // Compilaciones desde el código: `<repo>/build/bin`, con `Release` en
    // Windows. Se miran sólo carpetas cuyo nombre delata el proyecto.
    if (home) {
      for (const raiz of [home, rutas.join(home, 'src'), rutas.join(home, 'source'), rutas.join(home, 'repos')]) {
        for (const entrada of listar(fs, raiz)) {
          if (!entrada.isDirectory() || !/llama\.?cpp|bitnet/i.test(entrada.name)) continue;
          const repo = rutas.join(raiz, entrada.name);
          dirs.push(repo, rutas.join(repo, 'build', 'bin'), rutas.join(repo, 'build', 'bin', 'Release'));
        }
      }
    }
  }

  return [...new Set(dirs.filter(dir => dir && rutas.isAbsolute(dir)))];
}

/** Rutas absolutas del ejecutable de un motor que existen en este equipo. */
function descubrirEjecutables(nombre, contexto) {
  const { fs, platform } = contexto;
  const rutas = rutasDe(platform);
  const fichero = platform === 'win32' ? `${nombre}.exe` : nombre;
  const encontrados = [];
  for (const dir of directoriosDeEjecutable(nombre, contexto)) {
    const candidato = rutas.join(dir, fichero);
    if (encontrados.includes(candidato) || !esFichero(fs, candidato)) continue;
    encontrados.push(candidato);
    if (encontrados.length >= LIMITES.ejecutables) break;
  }
  return encontrados;
}

/** Carpetas donde las herramientas habituales guardan GGUF. */
function carpetasDeModelos({ env, platform }) {
  const rutas = rutasDe(platform);
  const home = carpetaPersonal(env, platform);
  const carpetas = [];
  const anadir = (origen, ...partes) => {
    if (partes.every(Boolean)) carpetas.push({ origen, dir: rutas.join(...partes) });
  };
  anadir('llama.cpp', env.LLAMA_CACHE);
  if (platform === 'win32') anadir('llama.cpp', env.LOCALAPPDATA, 'llama.cpp');
  else if (platform === 'darwin') anadir('llama.cpp', home, 'Library', 'Caches', 'llama.cpp');
  else anadir('llama.cpp', home, '.cache', 'llama.cpp');
  anadir('Hugging Face', env.HF_HOME ? rutas.join(env.HF_HOME, 'hub') : null);
  anadir('Hugging Face', home, '.cache', 'huggingface', 'hub');
  anadir('LM Studio', home, '.lmstudio', 'models');
  anadir('LM Studio', home, '.cache', 'lm-studio', 'models');
  anadir('Jan', home, 'jan', 'models');
  // Clones del proyecto con su carpeta `models`, como deja bitnet.cpp.
  for (const nombre of ['BitNet', 'bitnet', 'llama.cpp']) anadir(nombre, home, nombre, 'models');
  return carpetas;
}

/** GGUF bajo una carpeta, con techo de profundidad y de entradas. */
function buscarGguf(fs, rutas, raiz, origen, presupuesto, salida) {
  const pendientes = [{ dir: raiz, nivel: 0 }];
  while (pendientes.length && presupuesto.entradas > 0 && salida.length < LIMITES.modelos) {
    const { dir, nivel } = pendientes.pop();
    for (const entrada of listar(fs, dir)) {
      if ((presupuesto.entradas -= 1) <= 0 || salida.length >= LIMITES.modelos) break;
      const ruta = rutas.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (nivel < LIMITES.profundidad) pendientes.push({ dir: ruta, nivel: nivel + 1 });
        continue;
      }
      // La caché de Hugging Face enlaza cada fichero a su blob: el enlace es
      // el nombre legible, así que se acepta si apunta a un fichero.
      if (!/\.gguf$/i.test(entrada.name) || NO_ES_MODELO.test(entrada.name)) continue;
      if (!esFichero(fs, ruta) || !esGguf(fs, ruta)) continue;
      salida.push({ nombre: entrada.name.replace(/\.gguf$/i, ''), path: ruta, origen });
    }
  }
}

/**
 * Modelos que Ollama ya descargó. Sus blobs son GGUF, así que `llama-server`
 * puede cargarlos sin descargar nada. No todos son compatibles: algunos usan
 * arquitecturas que sólo entiende Ollama, y eso sólo se sabe al cargarlos.
 */
function modelosDeOllama({ fs, env, platform }, salida) {
  const rutas = rutasDe(platform);
  const home = carpetaPersonal(env, platform);
  const base = env.OLLAMA_MODELS || (home ? rutas.join(home, '.ollama', 'models') : null);
  if (!base || !rutas.isAbsolute(base)) return;
  const manifiestos = rutas.join(base, 'manifests');
  const presupuesto = { entradas: 2000 };
  const pendientes = [{ dir: manifiestos, partes: [] }];
  while (pendientes.length && presupuesto.entradas > 0 && salida.length < LIMITES.modelos) {
    const { dir, partes } = pendientes.pop();
    for (const entrada of listar(fs, dir)) {
      if ((presupuesto.entradas -= 1) <= 0) break;
      const ruta = rutas.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (partes.length < 5) pendientes.push({ dir: ruta, partes: [...partes, entrada.name] });
        continue;
      }
      let capa;
      try {
        const manifiesto = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        capa = (manifiesto.layers || []).find(l => l && l.mediaType === 'application/vnd.ollama.image.model');
      } catch (_) {
        continue;
      }
      const digest = capa && typeof capa.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(capa.digest)
        ? capa.digest : null;
      if (!digest) continue;
      const blob = rutas.join(base, 'blobs', digest.replace(':', '-'));
      if (!esFichero(fs, blob) || !esGguf(fs, blob)) continue;
      // manifests/<registro>/<espacio>/<modelo>/<etiqueta>
      const [, espacio, ...resto] = partes;
      const modelo = [...(espacio && espacio !== 'library' ? [espacio] : []), ...resto].join('/');
      salida.push({ nombre: `${modelo}:${entrada.name}`, path: blob, origen: 'Ollama' });
    }
  }
}

/**
 * Modelos GGUF de este equipo. Cada uno lleva un `id` único y legible, que es
 * lo que ve el usuario y lo que viaja por IPC: la ruta se queda en el proceso
 * principal.
 */
function descubrirModelos(contexto) {
  const { fs, platform } = contexto;
  const rutas = rutasDe(platform);
  const crudos = [];
  const presupuesto = { entradas: LIMITES.entradas };
  const vistas = new Set();
  for (const { origen, dir } of carpetasDeModelos(contexto)) {
    if (vistas.has(dir) || !rutas.isAbsolute(dir)) continue;
    vistas.add(dir);
    buscarGguf(fs, rutas, dir, origen, presupuesto, crudos);
  }
  modelosDeOllama(contexto, crudos);

  const modelos = [];
  const ids = new Set();
  const rutasVistas = new Set();
  for (const crudo of crudos) {
    if (rutasVistas.has(crudo.path)) continue;
    rutasVistas.add(crudo.path);
    let id = crudo.origen === 'Ollama' ? `ollama/${crudo.nombre}` : crudo.nombre;
    for (let n = 2; ids.has(id); n += 1) id = `${crudo.nombre} (${n})`;
    ids.add(id);
    let size = 0;
    try { size = fs.statSync(crudo.path).size; } catch (_) {}
    modelos.push({ id, path: crudo.path, source: crudo.origen, size });
  }
  return modelos.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { LIMITES, esGguf, descubrirEjecutables, descubrirModelos };
