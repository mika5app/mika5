// test/print-pdf-electron.test.js — Exportación a PDF, extremo a extremo.
// Run: npx electron test/print-pdf-electron.test.js
//
// Ejercita el MISMO handler que registra main.js: requiere print-export.js
// directamente y lo construye con BrowserWindow y printToPDF reales, con
// print.html y print.js reales y con DOMPurify vendorizado real. Sólo se
// inyectan el diálogo, la escritura y la descarga remota — las tres cosas que
// no deben tocar el disco del usuario ni la red durante una prueba.
//
// Sin red real. userData y salida en directorios temporales.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const {
  PRINT_ERRORS,
  MAX_PRINT_HTML_BYTES,
  MAX_PRINT_REMOTE_IMAGES,
  MAX_PRINT_REMOTE_TOTAL_BYTES,
  PRINT_WINDOW_OPTIONS,
  normalizePrintPayload,
  createPrintExport
} = require('../src/main/print-export');

const TEST_DIR = path.join(os.tmpdir(), `mika5-print-${Date.now()}`);
app.setPath('userData', path.join(TEST_DIR, 'userData'));
const SALIDA = path.join(TEST_DIR, 'salida');
fs.mkdirSync(SALIDA, { recursive: true });

const PRINT_HTML = path.join(__dirname, '../src/renderer/print.html');

let passed = 0;
function check(condition, message) {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

// PNG 1x1 real: el data: URI resultante tiene que ser cargable de verdad.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const URL_FIRMADA =
  'https://example.com/generated.png?OSSAccessKeyId=fake&Signature=fakesig&Expires=1';
const URL_FIRMADA_2 =
  'https://example.com/otra.png?OSSAccessKeyId=fake2&Signature=fakesig2&Expires=2';

// --- Instrumentación: qué ventanas se crearon y qué pidió la red -----------

const ventanas = [];
function createWindowReal(options) {
  const ventana = new BrowserWindow(options);
  ventanas.push({ options, ventana });
  return ventana;
}

const peticiones = [];
function observarRed() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = String(details.url || '');
    if (!/^(file|devtools|chrome-extension):/.test(url)) peticiones.push(url);
    callback({ cancel: false });
  });
}

// Las ventanas que abre la propia prueba se cierran igual que las del helper:
// un destroy() directo sobre una ventana offscreen hace fallar el loadFile de
// la siguiente con ERR_FAILED, y la prueba se quedaría sin las secciones
// posteriores.
function cerrar(ventana) {
  return new Promise(resolve => {
    if (ventana.isDestroyed()) return resolve();
    const t = setTimeout(() => { if (!ventana.isDestroyed()) ventana.destroy(); resolve(); }, 5000);
    ventana.once('closed', () => { clearTimeout(t); resolve(); });
    ventana.close();
  });
}

function registroFalso() {
  const entradas = [];
  return {
    entradas,
    error: (...args) => entradas.push(args.map(a => JSON.stringify(a)).join(' ')),
    warn: (...args) => entradas.push(args.map(a => JSON.stringify(a)).join(' '))
  };
}

function guardarEn(nombre) {
  return async () => ({ canceled: false, filePath: path.join(SALIDA, nombre) });
}
const escribirReal = (filePath, buffer) => fs.promises.writeFile(filePath, buffer);

function imagenOk(buffer = PNG_1X1, mimeType = 'image/png') {
  const llamadas = [];
  const fn = async (url, options) => {
    llamadas.push({ url, options });
    return { buffer, mimeType };
  };
  fn.llamadas = llamadas;
  return fn;
}

const HTML_SIMPLE = '<h1>Informe</h1><p>Contenido seguro</p>';
const HTML_CON_IMAGEN = `<h1>Chat</h1><p>antes</p><img src="${URL_FIRMADA}" alt="Imagen generada"><p>después</p>`;

// =====================================================================
async function main() {
  await app.whenReady();
  observarRed();

  console.log('\n=== normalizePrintPayload (puro, sin Electron) ===');

  check(normalizePrintPayload({ html: HTML_SIMPLE }).defaultName === 'chat.pdf',
    'sin nombre sugerido usa chat.pdf');
  check(normalizePrintPayload({ html: HTML_SIMPLE, defaultName: 'chat-2026-08-02.pdf' }).ok,
    'acepta el nombre que genera el renderer');
  check(normalizePrintPayload(null).error === PRINT_ERRORS.INVALID_PAYLOAD,
    'payload nulo rechazado');
  check(normalizePrintPayload({ html: 123 }).error === PRINT_ERRORS.INVALID_PAYLOAD,
    'html no string rechazado');
  check(normalizePrintPayload({ html: '' }).error === PRINT_ERRORS.INVALID_PAYLOAD,
    'html vacío rechazado');
  check(normalizePrintPayload({ html: 'x'.repeat(MAX_PRINT_HTML_BYTES + 1) }).error === PRINT_ERRORS.HTML_TOO_LARGE,
    'html por encima del límite rechazado');
  for (const malo of ['../../evil.pdf', 'C:\\tmp\\x.pdf', '/etc/x.pdf', 'x.exe', 'a\u0000b.pdf']) {
    check(normalizePrintPayload({ html: HTML_SIMPLE, defaultName: malo }).error === PRINT_ERRORS.UNSAFE_FILENAME,
      `nombre peligroso rechazado: ${JSON.stringify(malo)}`);
  }
  const conBasura = normalizePrintPayload({
    html: HTML_SIMPLE,
    filePath: '/etc/passwd',
    webPreferences: { nodeIntegration: true },
    printOptions: { pageSize: 'A0' }
  });
  check(conBasura.ok && !('filePath' in conBasura) && !('webPreferences' in conBasura),
    'los campos desconocidos no sobreviven a la normalización');

  // ===================================================================
  console.log('\n=== A. Prefetch, deduplicación y PDF real ===');
  // ===================================================================

  const antesDeTodo = peticiones.length;
  const fetchA = imagenOk();
  const logA = registroFalso();
  const handlerA = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: guardarEn('ok.pdf'),
    writeFile: escribirReal,
    fetchRemoteImage: fetchA,
    printHtmlPath: PRINT_HTML,
    logger: logA
  });

  const htmlDuplicado = `${HTML_CON_IMAGEN}<img src="${URL_FIRMADA}" alt="repetida">`;
  const resA = await handlerA({}, { html: htmlDuplicado, defaultName: 'ok.pdf' });

  check(resA.ok === true, 'la exportación termina en ok');
  check(fetchA.llamadas.length === 1,
    `la URL repetida se descarga una sola vez (${fetchA.llamadas.length})`);
  check(fetchA.llamadas[0].url === URL_FIRMADA,
    'fetchRemoteImage recibe exactamente la URL detectada');

  const pdf = fs.readFileSync(resA.filePath);
  check(pdf.length > 0, `el PDF guardado no está vacío (${pdf.length} bytes)`);
  check(pdf.subarray(0, 5).toString('latin1') === '%PDF-', 'el archivo empieza por %PDF-');
  check(path.dirname(resA.filePath) === SALIDA, 'el PDF se guardó en el directorio temporal');

  const ventanaA = ventanas.at(-1);
  check(ventanaA.ventana.isDestroyed(), 'la ventana se destruyó tras el éxito');

  const opciones = ventanaA.options;
  check(opciones.show === false, 'la ventana no se muestra');
  check(opciones.webPreferences.offscreen === true, 'offscreen: true');
  check(opciones.webPreferences.contextIsolation === true, 'contextIsolation: true');
  check(opciones.webPreferences.nodeIntegration === false, 'nodeIntegration: false');
  check(opciones.webPreferences.sandbox === true, 'sandbox: true');
  check(opciones === PRINT_WINDOW_OPTIONS,
    'las opciones son las constantes del módulo, no algo que llegue del renderer');

  const remotas = peticiones.slice(antesDeTodo);
  check(remotas.length === 0,
    `la ventana de impresión no hizo ninguna petición de red (${remotas.length})`);

  // ===================================================================
  console.log('\n=== B. La URL firmada no aparece en los logs ===');
  // ===================================================================

  const fetchB = async () => { throw Object.assign(new Error('x'), { code: 'DOWNLOAD_TIMEOUT' }); };
  const logB = registroFalso();
  const handlerB = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: guardarEn('nunca.pdf'),
    writeFile: escribirReal,
    fetchRemoteImage: fetchB,
    printHtmlPath: PRINT_HTML,
    logger: logB
  });
  const resB = await handlerB({}, { html: HTML_CON_IMAGEN });
  const textoLog = logB.entradas.join('\n');

  check(resB.error === PRINT_ERRORS.REMOTE_IMAGE_FETCH_FAILED,
    `una descarga fallida devuelve REMOTE_IMAGE_FETCH_FAILED (recibido: ${JSON.stringify(resB)})`);
  check(logB.entradas.length > 0, 'el fallo quedó registrado');
  check(!textoLog.includes('OSSAccessKeyId'), 'el log no contiene OSSAccessKeyId');
  check(!textoLog.includes('Signature'), 'el log no contiene Signature');
  check(!textoLog.includes('Expires'), 'el log no contiene Expires');
  check(!textoLog.includes('?'), 'el log no contiene ninguna query string');
  check(textoLog.includes('https://example.com/generated.png'),
    'el log conserva origen y ruta, que es lo que sirve para diagnosticar');
  check(!/error\.message|\bx\b/.test(resB.error), 'al renderer no le llega el mensaje interno');
  check(Object.values(PRINT_ERRORS).includes(resB.error), 'el renderer recibe un código normalizado');
  check(ventanas.at(-1).ventana.isDestroyed(), 'la ventana se destruyó tras el fallo de descarga');

  // ===================================================================
  console.log('\n=== C. Imagen caducada: sin PDF y sin diálogo ===');
  // ===================================================================

  let dialogoAbierto = 0;
  let escrituras = 0;
  const handlerC = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: async () => { dialogoAbierto++; return { canceled: true }; },
    writeFile: async () => { escrituras++; },
    fetchRemoteImage: async () => {
      throw Object.assign(new Error('gone'), { code: 'DOWNLOAD_HTTP_STATUS' });
    },
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const resC = await handlerC({}, { html: HTML_CON_IMAGEN });
  check(resC.ok === false && resC.error === PRINT_ERRORS.REMOTE_IMAGE_FETCH_FAILED,
    'un enlace caducado hace fallar la exportación entera');
  check(dialogoAbierto === 0, 'no se abrió el diálogo de guardado tras el fallo');
  check(escrituras === 0, 'no se escribió ningún archivo');
  check(ventanas.at(-1).ventana.isDestroyed(), 'la ventana se destruyó');

  // ===================================================================
  console.log('\n=== D. Política de seguridad de la primitiva ===');
  // ===================================================================

  const POLITICA = [
    ['DOWNLOAD_BLOCKED_DESTINATION', PRINT_ERRORS.REMOTE_IMAGE_POLICY_VIOLATION, 'destino privado o URL no https'],
    ['DOWNLOAD_TOO_MANY_REDIRECTS', PRINT_ERRORS.REMOTE_IMAGE_POLICY_VIOLATION, 'redirección prohibida'],
    ['DOWNLOAD_INVALID_IMAGE', PRINT_ERRORS.REMOTE_IMAGE_POLICY_VIOLATION, 'MIME no permitido'],
    ['DOWNLOAD_TOO_LARGE', PRINT_ERRORS.REMOTE_IMAGE_TOO_LARGE, 'buffer demasiado grande']
  ];
  for (const [code, esperado, descripcion] of POLITICA) {
    const h = createPrintExport({
      createWindow: createWindowReal,
      showSaveDialog: guardarEn('nunca.pdf'),
      writeFile: escribirReal,
      fetchRemoteImage: async () => { throw Object.assign(new Error(code), { code }); },
      printHtmlPath: PRINT_HTML,
      logger: registroFalso()
    });
    const r = await h({}, { html: HTML_CON_IMAGEN });
    check(r.error === esperado, `${descripcion} → ${esperado}`);
    check(ventanas.at(-1).ventana.isDestroyed(), `ventana destruida tras ${code}`);
  }

  // Un MIME fuera de la lista permitida tampoco pasa aunque la primitiva
  // devuelva un buffer.
  const hMime = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: guardarEn('nunca.pdf'),
    writeFile: escribirReal,
    fetchRemoteImage: imagenOk(PNG_1X1, 'image/svg+xml'),
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const rMime = await hMime({}, { html: HTML_CON_IMAGEN });
  check(rMime.error === PRINT_ERRORS.REMOTE_IMAGE_POLICY_VIOLATION,
    'un MIME no permitido se rechaza aunque llegue con buffer');

  // ===================================================================
  console.log('\n=== E. Límites agregados ===');
  // ===================================================================

  const muchas = Array.from({ length: MAX_PRINT_REMOTE_IMAGES + 1 },
    (_, i) => `<img src="https://example.com/i${i}.png?Signature=s${i}">`).join('');
  const hMuchas = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: guardarEn('nunca.pdf'),
    writeFile: escribirReal,
    fetchRemoteImage: imagenOk(),
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const rMuchas = await hMuchas({}, { html: muchas });
  check(rMuchas.error === PRINT_ERRORS.TOO_MANY_REMOTE_IMAGES,
    `más de ${MAX_PRINT_REMOTE_IMAGES} imágenes distintas falla`);

  // La misma URL repetida muchas veces no consume el límite.
  const repetidas = Array.from({ length: MAX_PRINT_REMOTE_IMAGES + 5 },
    () => `<img src="${URL_FIRMADA}">`).join('');
  const fetchRep = imagenOk();
  const hRep = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: guardarEn('repetidas.pdf'),
    writeFile: escribirReal,
    fetchRemoteImage: fetchRep,
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const rRep = await hRep({}, { html: repetidas });
  check(rRep.ok === true, 'una URL repetida no agota el límite de imágenes');
  check(fetchRep.llamadas.length === 1, 'y se descarga una sola vez');

  // Total agregado: cada imagen cabe en el límite individual, pero la suma no.
  const grande = Buffer.alloc(7 * 1024 * 1024, 0x41);
  const cuantas = Math.floor(MAX_PRINT_REMOTE_TOTAL_BYTES / grande.length) + 1;
  const htmlDos = Array.from({ length: cuantas },
    (_, i) => `<img src="https://example.com/grande${i}.png?Signature=s">`).join('');
  const hTotal = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: guardarEn('nunca.pdf'),
    writeFile: escribirReal,
    fetchRemoteImage: imagenOk(grande, 'image/png'),
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const rTotal = await hTotal({}, { html: htmlDos });
  check(rTotal.error === PRINT_ERRORS.REMOTE_IMAGE_TOTAL_TOO_LARGE,
    'el total acumulado por encima del límite falla');
  check(!fs.existsSync(path.join(SALIDA, 'nunca.pdf')),
    'ningún fallo dejó un PDF parcial en disco');

  // ===================================================================
  console.log('\n=== F. CSP y saneamiento dentro de la página ===');
  // ===================================================================

  const antesCsp = peticiones.length;
  const ventanaCsp = createWindowReal(PRINT_WINDOW_OPTIONS);
  await ventanaCsp.loadFile(PRINT_HTML);

  const peligroso = [
    '<h1>Título seguro</h1>',
    '<script>window.__pwned = 1;<\/script>',
    '<img src="x" onerror="window.__pwned = 2">',
    '<a href="javascript:alert(1)">enlace</a>',
    '<iframe src="https://example.com/frame"></iframe>',
    '<p>Párrafo legítimo</p>',
    '<table><tr><td>celda</td></tr></table>',
    `<img src="data:image/png;base64,${PNG_1X1.toString('base64')}" alt="local">`
  ].join('');

  const inspeccion = await ventanaCsp.webContents.executeJavaScript(
    `window.MIKA5Print.inspect(${JSON.stringify(peligroso)})`, true);
  check(inspeccion.ok === true, 'inspect devuelve ok');
  check(Array.isArray(inspeccion.remoteImages) && inspeccion.remoteImages.length === 0,
    'inspect no reporta imágenes remotas cuando no las hay');

  const render = await ventanaCsp.webContents.executeJavaScript(
    `window.MIKA5Print.render(${JSON.stringify({ html: peligroso, embeddedImages: {} })})`, true);
  check(render.ok === true, 'render devuelve ok con contenido saneado');

  const dom = await ventanaCsp.webContents.executeJavaScript(`(() => {
    const raiz = document.getElementById('print-root');
    return {
      scripts: raiz.querySelectorAll('script').length,
      iframes: raiz.querySelectorAll('iframe').length,
      conOnerror: raiz.querySelectorAll('[onerror]').length,
      hrefs: [...raiz.querySelectorAll('a')].map(a => a.getAttribute('href') || ''),
      imgs: [...raiz.querySelectorAll('img')].map(i => i.getAttribute('src') || ''),
      encabezado: raiz.querySelector('h1') ? raiz.querySelector('h1').textContent : null,
      parrafos: raiz.querySelectorAll('p').length,
      celdas: raiz.querySelectorAll('td').length,
      pwned: typeof window.__pwned
    };
  })()`, true);

  check(dom.scripts === 0, 'ningún <script> sobrevive');
  check(dom.iframes === 0, 'ningún <iframe> sobrevive');
  check(dom.conOnerror === 0, 'ningún atributo onerror sobrevive');
  check(dom.pwned === 'undefined', 'no se ejecutó nada del contenido');
  check(dom.hrefs.every(h => !/^javascript:/i.test(h)), 'ningún href javascript: sobrevive');
  check(dom.encabezado === 'Título seguro', 'el encabezado legítimo permanece');
  check(dom.parrafos >= 1 && dom.celdas === 1, 'párrafos y tablas permanecen');
  const conSrc = dom.imgs.filter(Boolean);
  check(conSrc.length === 1 && conSrc[0].startsWith('data:image/png;base64,'),
    `la única imagen con src es la data: (${conSrc.length} con src de ${dom.imgs.length})`);
  check(dom.imgs.every(src => !src || src.startsWith('data:image/')),
    'ninguna imagen conserva un origen que no sea data:');

  // Una imagen https insertada directamente en el DOM: la CSP debe impedir
  // que el navegador la pida.
  const cspBloqueo = await ventanaCsp.webContents.executeJavaScript(`(() => {
    return new Promise(resolve => {
      const img = document.createElement('img');
      img.onerror = () => resolve('error');
      img.onload = () => resolve('cargada');
      img.src = 'https://example.com/directa.png';
      document.body.appendChild(img);
      setTimeout(() => resolve('sin-evento'), 1500);
    });
  })()`, true);
  const peticionesCsp = peticiones.slice(antesCsp);
  check(cspBloqueo !== 'cargada', `la imagen https directa no se cargó (${cspBloqueo})`);
  check(peticionesCsp.length === 0,
    `la CSP impidió la petición saliente (${peticionesCsp.length} peticiones)`);

  await cerrar(ventanaCsp);

  // ===================================================================
  console.log('\n=== F2. Popup y navegación sobre la ventana del handler ===');
  // ===================================================================

  // Las comprobaciones se hacen sobre la ventana que configura el propio
  // handler, no sobre una que prepare la prueba: si el handler dejara de
  // denegar popups o de bloquear la navegación, aquí tiene que notarse.
  const sonda = { popup: null, urlAntes: null, urlDespues: null };
  const handlerNav = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: async () => {
      const w = ventanas.at(-1).ventana;
      sonda.urlAntes = w.webContents.getURL();
      sonda.popup = await w.webContents.executeJavaScript(
        `(() => { try { return window.open('https://example.com/popup') === null ? 'denegado' : 'abierto'; } catch (_) { return 'denegado'; } })()`,
        true);
      await w.webContents.executeJavaScript(
        `try { location.href = 'https://example.com/otro'; } catch (_) {}`, true);
      await new Promise(r => setTimeout(r, 600));
      sonda.urlDespues = w.webContents.getURL();
      return { canceled: true };
    },
    writeFile: escribirReal,
    fetchRemoteImage: imagenOk(),
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  await handlerNav({}, { html: HTML_SIMPLE });

  check(sonda.urlAntes && sonda.urlAntes.startsWith('file://'),
    'la ventana del handler está cargada desde file://');
  check(sonda.popup === 'denegado',
    `el handler deniega window.open (${sonda.popup})`);
  check(sonda.urlDespues === sonda.urlAntes,
    'el handler impide navegar fuera del documento local');
  check(peticiones.length === 0,
    `ni el popup ni la navegación produjeron petición (${peticiones.length})`);

  // ===================================================================
  console.log('\n=== G. URL detectada pero no resuelta ===');
  // ===================================================================

  const ventanaG = createWindowReal(PRINT_WINDOW_OPTIONS);
  await ventanaG.loadFile(PRINT_HTML);
  const renderG = await ventanaG.webContents.executeJavaScript(
    `window.MIKA5Print.render(${JSON.stringify({ html: HTML_CON_IMAGEN, embeddedImages: {} })})`, true);
  check(renderG.ok === false && renderG.error === 'REMOTE_IMAGE_UNRESOLVED',
    'render rechaza si falta el data: URI de una imagen detectada');
  const vacio = await ventanaG.webContents.executeJavaScript(
    `document.getElementById('print-root').querySelectorAll('img').length`, true);
  check(vacio === 0, 'no quedó ninguna imagen insertada tras el rechazo');
  await cerrar(ventanaG);

  const hG = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: guardarEn('nunca.pdf'),
    writeFile: escribirReal,
    // Devuelve un data: URI para una URL distinta de la detectada.
    fetchRemoteImage: imagenOk(),
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const resG = await hG({}, { html: HTML_CON_IMAGEN });
  check(resG.ok === true, 'el camino normal sí resuelve la imagen detectada');

  // ===================================================================
  console.log('\n=== Cancelación, error de impresión y error de escritura ===');
  // ===================================================================

  let escribio = 0;
  const hCancel = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    writeFile: async () => { escribio++; },
    fetchRemoteImage: imagenOk(),
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const rCancel = await hCancel({}, { html: HTML_SIMPLE });
  check(rCancel.ok === false && rCancel.canceled === true, 'la cancelación se normaliza');
  check(!('error' in rCancel), 'una cancelación no es un error');
  check(escribio === 0, 'la cancelación no escribe nada');
  check(ventanas.at(-1).ventana.isDestroyed(), 'la ventana se destruyó tras cancelar');

  // printToPDF que rechaza: se envuelve la ventana real y sólo se sustituye
  // ese método. Es el único stub sobre la generación, y se declara.
  console.log('  · stub declarado: sólo printToPDF rechaza; la ventana es real');
  const hPrint = createPrintExport({
    createWindow: (options) => {
      // La ventana es real; sólo se sustituye printToPDF, que es el error
      // difícil de provocar de otro modo.
      const ventana = createWindowReal(options);
      ventana.webContents.printToPDF = async () => { throw new Error('boom interno'); };
      return ventana;
    },
    showSaveDialog: guardarEn('nunca.pdf'),
    writeFile: escribirReal,
    fetchRemoteImage: imagenOk(),
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const rPrint = await hPrint({}, { html: HTML_SIMPLE });
  check(rPrint.error === PRINT_ERRORS.PRINT_FAILED, 'un fallo de printToPDF devuelve PRINT_FAILED');
  check(!String(rPrint.error).includes('boom'), 'el mensaje interno no llega al renderer');
  check(ventanas.at(-1).ventana.isDestroyed(), 'la ventana se destruyó tras el fallo de impresión');

  const hWrite = createPrintExport({
    createWindow: createWindowReal,
    showSaveDialog: guardarEn('fallo-escritura.pdf'),
    writeFile: async () => { throw new Error('EACCES /ruta/privada'); },
    fetchRemoteImage: imagenOk(),
    printHtmlPath: PRINT_HTML,
    logger: registroFalso()
  });
  const rWrite = await hWrite({}, { html: HTML_SIMPLE });
  check(rWrite.error === PRINT_ERRORS.WRITE_FAILED, 'un fallo de escritura devuelve WRITE_FAILED');
  check(!String(rWrite.error).includes('/ruta/privada'), 'no se filtra ninguna ruta local');
  check(ventanas.at(-1).ventana.isDestroyed(), 'la ventana se destruyó tras el fallo de escritura');

  // ===================================================================
  console.log('\n=== Todas las ventanas quedaron destruidas ===');
  // ===================================================================

  const vivas = ventanas.filter(v => !v.ventana.isDestroyed());
  check(vivas.length === 0, `ninguna ventana de impresión sigue viva (${vivas.length} de ${ventanas.length})`);
  check(BrowserWindow.getAllWindows().length === 0,
    `no queda ninguna BrowserWindow abierta (${BrowserWindow.getAllWindows().length})`);
  check(peticiones.length === 0,
    `en toda la suite no salió ni una petición de red (${peticiones.length})`);

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Print PDF electron tests passed (${passed} comprobaciones)`);
  console.log(`${'='.repeat(40)}`);
}

main()
  .then(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
    app.exit(0);
  })
  .catch(error => {
    console.error(error);
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
    app.exit(1);
  });
