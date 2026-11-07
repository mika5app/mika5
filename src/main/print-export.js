// src/main/print-export.js — Exportación a PDF con render aislado.
//
// Vive fuera de main.js por una razón concreta: main.js registra 55 handlers,
// abre la base y crea ventanas al cargarse, así que una prueba no puede
// requerirlo sin arrancar la aplicación entera. Aquí el handler se construye
// con dependencias explícitas y se puede ejercitar con BrowserWindow y
// printToPDF reales sin tocar nada más.
//
// El módulo no importa Electron, no registra IPC y no ejecuta nada al
// importarse.
//
// El contenido imprimible puede traer imágenes generadas cuya URL es un enlace
// firmado remoto (?OSSAccessKeyId=…&Signature=…). Si la ventana de impresión
// las cargara, cada exportación produciría una petición saliente con esas
// credenciales en la query. Por eso el flujo va en dos fases: la ventana
// inspecciona y devuelve las URLs sin pedir nada a la red, el proceso
// principal las descarga con los controles ya auditados de network-security.js
// y devuelve data: URIs. La ventana nunca ve un origen http o https.

'use strict';

const PRINT_ERRORS = Object.freeze({
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  HTML_TOO_LARGE: 'HTML_TOO_LARGE',
  UNSAFE_FILENAME: 'UNSAFE_FILENAME',
  INSPECT_FAILED: 'INSPECT_FAILED',
  RENDER_FAILED: 'RENDER_FAILED',
  PRINT_FAILED: 'PRINT_FAILED',
  WRITE_FAILED: 'WRITE_FAILED',
  REMOTE_IMAGE_FETCH_FAILED: 'REMOTE_IMAGE_FETCH_FAILED',
  REMOTE_IMAGE_POLICY_VIOLATION: 'REMOTE_IMAGE_POLICY_VIOLATION',
  REMOTE_IMAGE_TOO_LARGE: 'REMOTE_IMAGE_TOO_LARGE',
  TOO_MANY_REMOTE_IMAGES: 'TOO_MANY_REMOTE_IMAGES',
  REMOTE_IMAGE_TOTAL_TOO_LARGE: 'REMOTE_IMAGE_TOTAL_TOO_LARGE',
  REMOTE_IMAGE_UNRESOLVED: 'REMOTE_IMAGE_UNRESOLVED'
});

// Una conversación larga exportada a HTML ronda los cientos de KB; 5 MiB deja
// margen amplio y sigue acotando la memoria del render.
const MAX_PRINT_HTML_BYTES = 5 * 1024 * 1024;

// Cada imagen remota es una petición saliente distinta. Una conversación
// imprimible con más de veinte imágenes generadas es excepcional, y el límite
// mantiene el número de egresos acotado y auditable.
const MAX_PRINT_REMOTE_IMAGES = 20;

// Límite individual: por encima de esto una sola imagen ya no es material de
// documento imprimible.
const MAX_PRINT_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024;

// Límite agregado, independiente del individual: veinte imágenes al máximo
// individual serían 160 MiB en memoria y un PDF inmanejable.
const MAX_PRINT_REMOTE_TOTAL_BYTES = 32 * 1024 * 1024;

// Descargas simultáneas. Pequeño y explícito: el objetivo es imprimir, no
// saturar la red del usuario ni multiplicar conexiones a un mismo origen.
const REMOTE_FETCH_CONCURRENCY = 2;

// Plazo compartido por todo el prefetch. Cada descarga individual además
// respeta su propio timeout dentro de network-security.js.
const REMOTE_FETCH_DEADLINE_MS = 60 * 1000;

const MAX_FILENAME_LENGTH = 128;
const DEFAULT_FILENAME = 'chat.pdf';

// Fijas en el proceso principal. El renderer no puede influir en ninguna.
const PRINT_WINDOW_OPTIONS = Object.freeze({
  show: false,
  width: 1024,
  height: 800,
  webPreferences: Object.freeze({
    offscreen: true,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  })
});

const PRINT_TO_PDF_OPTIONS = Object.freeze({
  marginsType: 2,
  printBackground: true,
  landscape: false,
  pageSize: 'A4'
});

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);

// Códigos de network-security.js que significan "la política rechazó este
// destino", frente a los que significan "la red falló".
const POLICY_CODES = new Set([
  'DOWNLOAD_BLOCKED_DESTINATION',
  'DOWNLOAD_TOO_MANY_REDIRECTS',
  'DOWNLOAD_INVALID_IMAGE'
]);

function isPlainObject(value) {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Sólo nombre de archivo. Nunca una ruta: el renderer no elige dónde se
// escribe, sólo sugiere cómo se llama el archivo en el diálogo.
function normalizeFileName(value) {
  if (value === undefined || value === null) return { ok: true, defaultName: DEFAULT_FILENAME };
  if (typeof value !== 'string') return { ok: false, error: PRINT_ERRORS.INVALID_PAYLOAD };

  const name = value.trim();
  if (!name || name.length > MAX_FILENAME_LENGTH) return { ok: false, error: PRINT_ERRORS.UNSAFE_FILENAME };
  // Separadores de ruta, dos puntos de unidad y los caracteres que Windows
  // reserva. Un nombre, nunca una ruta.
  if (/[/\:*?"<>|]/.test(name)) return { ok: false, error: PRINT_ERRORS.UNSAFE_FILENAME };
  // NUL y caracteres de control.
  if ([...name].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
    return { ok: false, error: PRINT_ERRORS.UNSAFE_FILENAME };
  }
  if (name.startsWith('.')) return { ok: false, error: PRINT_ERRORS.UNSAFE_FILENAME };
  if (name.split('.').some(seg => seg === '.' || seg === '..')) {
    return { ok: false, error: PRINT_ERRORS.UNSAFE_FILENAME };
  }
  if (!/\.pdf$/i.test(name)) return { ok: false, error: PRINT_ERRORS.UNSAFE_FILENAME };

  return { ok: true, defaultName: name };
}

// Pura: sin red, sin disco, sin Electron. Fail-closed.
function normalizePrintPayload(payload) {
  if (!isPlainObject(payload)) return { ok: false, error: PRINT_ERRORS.INVALID_PAYLOAD };

  const { html, defaultName } = payload;
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, error: PRINT_ERRORS.INVALID_PAYLOAD };
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_PRINT_HTML_BYTES) {
    return { ok: false, error: PRINT_ERRORS.HTML_TOO_LARGE };
  }

  const nombre = normalizeFileName(defaultName);
  if (!nombre.ok) return nombre;

  // Todo lo demás del payload se descarta aquí: ni destino, ni URL, ni
  // opciones de ventana, impresión o diálogo llegan desde el renderer.
  return { ok: true, html, defaultName: nombre.defaultName };
}

// Para logs. Nunca la query: ahí viajan OSSAccessKeyId, Signature y Expires.
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    return url.origin + url.pathname;
  } catch (_) {
    return '[url ilegible]';
  }
}

function mapFetchError(error) {
  const code = error && error.code;
  if (code === 'DOWNLOAD_TOO_LARGE') return PRINT_ERRORS.REMOTE_IMAGE_TOO_LARGE;
  if (POLICY_CODES.has(code)) return PRINT_ERRORS.REMOTE_IMAGE_POLICY_VIOLATION;
  return PRINT_ERRORS.REMOTE_IMAGE_FETCH_FAILED;
}

// Plazo máximo para que una ventana se cierre por las buenas antes de
// destruirla a la fuerza.
const WINDOW_CLOSE_TIMEOUT_MS = 5000;

// Cierre determinista y sin romper la siguiente exportación.
//
// `destroy()` a secas parece lo más contundente, pero sobre una ventana
// offscreen deja el proceso de render en un estado que hace fallar el
// `loadFile` de la SIGUIENTE ventana offscreen con ERR_FAILED (-2): la segunda
// exportación de la sesión no produciría PDF. Medido, no supuesto.
//
// Con `close()` y espera del evento `closed` la ventana queda destruida antes
// de que la función retorne — el determinismo que hace falta — y la siguiente
// exportación funciona. `destroy()` se conserva como último recurso para una
// ventana que no responda.
function cerrarVentana(ventana, timeoutMs = WINDOW_CLOSE_TIMEOUT_MS) {
  return new Promise(resolve => {
    if (!ventana || typeof ventana.isDestroyed !== 'function' || ventana.isDestroyed()) {
      return resolve();
    }
    const temporizador = setTimeout(() => {
      if (!ventana.isDestroyed()) ventana.destroy();
      resolve();
    }, timeoutMs);
    ventana.once('closed', () => {
      clearTimeout(temporizador);
      resolve();
    });
    try {
      ventana.close();
    } catch (_) {
      clearTimeout(temporizador);
      if (!ventana.isDestroyed()) ventana.destroy();
      resolve();
    }
  });
}

class PrintError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PrintError';
    this.code = code;
  }
}

// Ejecuta las tareas con concurrencia acotada. Si una falla, el resto se
// abandona: no existe el PDF parcial.
async function withConcurrency(items, limit, worker) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  let abortado = null;

  const corredor = async () => {
    while (!abortado) {
      const indice = siguiente++;
      if (indice >= items.length) return;
      try {
        resultados[indice] = await worker(items[indice], indice);
      } catch (error) {
        abortado = abortado || error;
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, corredor)
  );
  if (abortado) throw abortado;
  return resultados;
}

function createPrintExport({
  createWindow,
  showSaveDialog,
  writeFile,
  fetchRemoteImage,
  printHtmlPath,
  logger
} = {}) {
  for (const [nombre, valor] of Object.entries({
    createWindow, showSaveDialog, writeFile, fetchRemoteImage
  })) {
    if (typeof valor !== 'function') {
      throw new TypeError(`createPrintExport requiere la dependencia ${nombre}`);
    }
  }
  if (typeof printHtmlPath !== 'string' || !printHtmlPath) {
    throw new TypeError('createPrintExport requiere printHtmlPath');
  }
  const registro = logger || { error() {}, warn() {} };

  const anotar = (etapa, code, extra = {}) => {
    if (typeof registro.error !== 'function') return;
    // Sólo código, etapa e identificadores internos. Nunca HTML, data URI,
    // buffers ni la query de una URL firmada.
    registro.error('[print] fallo', { etapa, code, ...extra });
  };

  async function ejecutar(ventana, expresion, etapa) {
    try {
      return await ventana.webContents.executeJavaScript(expresion, true);
    } catch (error) {
      anotar(etapa, PRINT_ERRORS.RENDER_FAILED);
      throw new PrintError(
        etapa === 'inspect' ? PRINT_ERRORS.INSPECT_FAILED : PRINT_ERRORS.RENDER_FAILED
      );
    }
  }

  async function prefetch(urls, deadline) {
    const distintas = [...new Set(urls.map(String))];
    if (distintas.length > MAX_PRINT_REMOTE_IMAGES) {
      anotar('prefetch', PRINT_ERRORS.TOO_MANY_REMOTE_IMAGES, { imagenes: distintas.length });
      throw new PrintError(PRINT_ERRORS.TOO_MANY_REMOTE_IMAGES);
    }

    let acumulado = 0;
    const mapa = Object.create(null);

    await withConcurrency(distintas, REMOTE_FETCH_CONCURRENCY, async (url, indice) => {
      const restante = deadline - Date.now();
      if (restante <= 0) {
        anotar('prefetch', PRINT_ERRORS.REMOTE_IMAGE_FETCH_FAILED, { imagen: indice });
        throw new PrintError(PRINT_ERRORS.REMOTE_IMAGE_FETCH_FAILED);
      }

      let resultado;
      try {
        resultado = await fetchRemoteImage(url, {
          maxBytes: MAX_PRINT_REMOTE_IMAGE_BYTES,
          timeoutMs: restante
        });
      } catch (error) {
        const code = mapFetchError(error);
        anotar('prefetch', code, { imagen: indice, origen: redactUrl(url) });
        throw new PrintError(code);
      }

      const buffer = resultado && resultado.buffer;
      const mimeType = resultado && resultado.mimeType;
      if (!Buffer.isBuffer(buffer) || !ALLOWED_IMAGE_MIME.has(mimeType)) {
        anotar('prefetch', PRINT_ERRORS.REMOTE_IMAGE_POLICY_VIOLATION, { imagen: indice });
        throw new PrintError(PRINT_ERRORS.REMOTE_IMAGE_POLICY_VIOLATION);
      }
      if (buffer.length > MAX_PRINT_REMOTE_IMAGE_BYTES) {
        anotar('prefetch', PRINT_ERRORS.REMOTE_IMAGE_TOO_LARGE, { imagen: indice });
        throw new PrintError(PRINT_ERRORS.REMOTE_IMAGE_TOO_LARGE);
      }

      acumulado += buffer.length;
      if (acumulado > MAX_PRINT_REMOTE_TOTAL_BYTES) {
        anotar('prefetch', PRINT_ERRORS.REMOTE_IMAGE_TOTAL_TOO_LARGE, { imagen: indice });
        throw new PrintError(PRINT_ERRORS.REMOTE_IMAGE_TOTAL_TOO_LARGE);
      }

      mapa[url] = `data:${mimeType};base64,${buffer.toString('base64')}`;
    });

    return mapa;
  }

  return async function printToPdfHandler(_event, payload) {
    const normalizado = normalizePrintPayload(payload);
    if (!normalizado.ok) {
      anotar('payload', normalizado.error);
      return { ok: false, error: normalizado.error };
    }

    let ventana = null;
    let embebidas = null;
    try {
      ventana = createWindow(PRINT_WINDOW_OPTIONS);
      ventana.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      ventana.webContents.on('will-navigate', event => event.preventDefault());
      await ventana.loadFile(printHtmlPath);

      // Fase A: la ventana sanea en memoria y enumera las imágenes remotas.
      // No inserta nada en el documento, así que no dispara ninguna petición.
      const inspeccion = await ejecutar(
        ventana,
        `window.MIKA5Print.inspect(${JSON.stringify(normalizado.html)})`,
        'inspect'
      );
      if (!inspeccion || inspeccion.ok !== true || !Array.isArray(inspeccion.remoteImages)) {
        anotar('inspect', PRINT_ERRORS.INSPECT_FAILED);
        return { ok: false, error: PRINT_ERRORS.INSPECT_FAILED };
      }

      // Fase B: el proceso principal es el único que habla con la red.
      const deadline = Date.now() + REMOTE_FETCH_DEADLINE_MS;
      embebidas = await prefetch(inspeccion.remoteImages, deadline);

      const render = await ejecutar(
        ventana,
        `window.MIKA5Print.render(${JSON.stringify({ html: normalizado.html, embeddedImages: embebidas })})`,
        'render'
      );
      if (!render || render.ok !== true) {
        const code = render && render.error === PRINT_ERRORS.REMOTE_IMAGE_UNRESOLVED
          ? PRINT_ERRORS.REMOTE_IMAGE_UNRESOLVED
          : PRINT_ERRORS.RENDER_FAILED;
        anotar('render', code);
        return { ok: false, error: code };
      }

      // Fuentes y layout listos antes de imprimir.
      await ejecutar(ventana, 'window.MIKA5Print.settle()', 'render');

      let pdf;
      try {
        pdf = await ventana.webContents.printToPDF(PRINT_TO_PDF_OPTIONS);
      } catch (error) {
        anotar('print', PRINT_ERRORS.PRINT_FAILED);
        return { ok: false, error: PRINT_ERRORS.PRINT_FAILED };
      }
      if (!Buffer.isBuffer(pdf) || pdf.length === 0) {
        anotar('print', PRINT_ERRORS.PRINT_FAILED);
        return { ok: false, error: PRINT_ERRORS.PRINT_FAILED };
      }

      const { canceled, filePath } = await showSaveDialog({
        defaultPath: normalizado.defaultName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
      if (canceled || !filePath) return { ok: false, canceled: true };

      try {
        await writeFile(filePath, pdf);
      } catch (error) {
        anotar('write', PRINT_ERRORS.WRITE_FAILED);
        return { ok: false, error: PRINT_ERRORS.WRITE_FAILED };
      }
      return { ok: true, filePath };
    } catch (error) {
      const code = error instanceof PrintError ? error.code : PRINT_ERRORS.RENDER_FAILED;
      if (!(error instanceof PrintError)) anotar('desconocido', code);
      return { ok: false, error: code };
    } finally {
      await cerrarVentana(ventana);
      embebidas = null;
    }
  };
}

module.exports = {
  PRINT_ERRORS,
  MAX_PRINT_HTML_BYTES,
  MAX_PRINT_REMOTE_IMAGES,
  MAX_PRINT_REMOTE_IMAGE_BYTES,
  MAX_PRINT_REMOTE_TOTAL_BYTES,
  REMOTE_FETCH_CONCURRENCY,
  PRINT_WINDOW_OPTIONS,
  PRINT_TO_PDF_OPTIONS,
  normalizePrintPayload,
  createPrintExport
};
