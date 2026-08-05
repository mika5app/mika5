const path = require("path");
const fs = require("fs").promises;
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, net } = require("electron");
const { buildApplicationMenuTemplate, shouldHideMenuBar } = require("./application-menu");
const { initDb, dbApi, getDb } = require("./db");
const { ollamaApi } = require("./ollama");
const { AIProviderManager } = require("./ai-providers");
const { RequestRegistry } = require("./request-registry");
const {
  downloadAndSaveElectronImage,
  fetchElectronImage,
  detectImageMimeFromBuffer,
  safeImageExtensionFromMime
} = require("./network-security");
const { createPrintExport } = require("./print-export");
let aiManager;
const aiRequests = new RequestRegistry();
const { ragApi, invalidateKnowledgeCache } = require("./rag");
// Document extraction libraries (graceful if missing)
let PDFParseClass, mammoth, XLSX;
try { PDFParseClass = require('pdf-parse').PDFParse; } catch (_) {}
try { mammoth = require('mammoth'); } catch (_) {}
try { XLSX = require('xlsx'); } catch (_) {}

// Windows-only: disable GPU acceleration to prevent UI freeze with certain GPU drivers
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// Altura mínima de ventana soportada.
//
// No es un número de gusto. El primer elemento que deja de ser utilizable al
// encoger la ventana es el desplegable de proveedores, así que la altura
// mínima sale de SU geometría, medida con `getBoundingClientRect()` sobre el
// renderer real, no estimada:
//
//    50 px  posición real del menú (`top: calc(100% + 8px)` bajo la cabecera)
//  + 16 px  margen inferior declarado (`MARGEN_DESPLEGABLE` en app.js)
//  + 18 px  relleno y borde propios del menú — 8+8 de padding y 1+1 de borde;
//           con `box-sizing: border-box` entran dentro del `max-height`, así
//           que restan área visible
//  + 82 px  fila más alta medida: la de llama.cpp, cuya descripción ocupa dos
//           líneas (81,59 px; las otras seis miden 64,80 px)
//  + 39 px  diferencia medida entre el tamaño exterior de `BrowserWindow` y
//           `window.innerHeight` en Windows (constante entre 60 y 820 px)
//  = 205 px
//
// Se declara 220 para dejar holgura frente a marcos de ventana más altos que
// los 39 px medidos aquí. La prueba no se fía de esta cuenta: redimensiona por
// debajo del mínimo, lee el `window.innerHeight` efectivo tras el recorte de
// Electron y comprueba la geometría resultante.
const ALTO_MINIMO_VENTANA = 220;

function createWindow() {
  const win = new BrowserWindow({
    title: 'MIKA5',
    icon: path.join(__dirname, "../renderer/assets/icon.png"),
    width: 1280,
    height: 820,
    // Sin esto la ventana se puede encoger hasta dejar el desplegable de
    // proveedores con altura cero: presente en el DOM, dentro del viewport y
    // sin una sola opción pulsable.
    minHeight: ALTO_MINIMO_VENTANA,
    // Fuera de macOS la barra de menú no aporta y roba una franja de alto; los
    // aceleradores de edición siguen activos porque el menú sí se registra.
    autoHideMenuBar: shouldHideMenuBar(process.platform),
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false  // Fix: Disable spellcheck to prevent textarea freeze
    }
  });

  if (shouldHideMenuBar(process.platform)) win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, "../renderer/index.html"));

  // Disable renderer cache in dev to prevent stale CSS/JS
  win.webContents.session.clearCache();

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = win.webContents.getURL();
    if (!currentUrl || targetUrl !== currentUrl) event.preventDefault();
  });

  // Native right-click context menu with Cut/Copy/Paste for inputs
  win.webContents.on('context-menu', (_event, params) => {
    const { isEditable, selectionText, editFlags } = params;
    if (!isEditable && !selectionText) return;

    const items = [];
    if (isEditable) {
      if (editFlags.canCut && selectionText) {
        items.push({ label: 'Cortar', role: 'cut' });
      }
      if (selectionText) {
        items.push({ label: 'Copiar', role: 'copy' });
      }
      if (editFlags.canPaste) {
        items.push({ label: 'Pegar', role: 'paste' });
      }
    } else if (selectionText) {
      items.push({ label: 'Copiar', role: 'copy' });
    }

    if (items.length > 0) {
      Menu.buildFromTemplate(items).popup({ window: win });
    }
  });
}

app.whenReady().then(() => {
  // Set app name for Task Manager / OS process list
  app.setName('MIKA5');
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.mika5.desktop');
  }
  
  // Menú real con roles nativos en vez de la barra por defecto. Sin él, ocultar
  // la barra dejaría a Windows y Linux sin Ctrl+C/V/X/A ni deshacer.
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate({
    platform: process.platform,
    isDevelopment: !app.isPackaged
  })));

  initDb();
  // Inicializar el gestor de proveedores AI usando la instancia de DB
  aiManager = new AIProviderManager(getDb());
  createWindow();

  // --- Startup sweep: reindex docs pendientes (Fase 1 prod-safe) ---
  setTimeout(() => {
    try {
      const items = dbApi.listKnowledgeNeedingIndex({ includeError: false });
      if (!items?.length) return;
      console.log(`[RAG] Startup sweep: enqueuing ${items.length} items`);
      for (const it of items) {
        dbApi.setKnowledgeIndexStatus(it.id, "pending", { indexedAt: null, error: "" });
        enqueueIndex(it.id);
      }
    } catch (e) {
      console.warn("[RAG] Startup sweep error:", e?.message || e);
    }
  }, 0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// DB
ipcMain.handle("db:listProjects", () => dbApi.listProjects());
ipcMain.handle("db:createProject", (_e, payload) => dbApi.createProject(payload));
ipcMain.handle("db:updateProject", (_e, id, payload) => dbApi.updateProject(id, payload));
ipcMain.handle("db:deleteProject", (_e, id) => dbApi.deleteProject(id));

ipcMain.handle("db:listChats", (_e, projectId) => dbApi.listChats(projectId));
ipcMain.handle("db:createChat", (_e, payload) => dbApi.createChat(payload));
ipcMain.handle("db:updateChat", (_e, chatId, payload) => {
  const res = dbApi.updateChat(chatId, payload);
  // Mover un chat cambia qué conocimiento ve cada proyecto: la caché RAG de
  // origen y destino queda obsoleta al instante.
  if (res?.ok && res.moved) {
    invalidateKnowledgeCache({ projectId: res.fromProjectId, chatId });
    invalidateKnowledgeCache({ projectId: res.toProjectId, chatId });
  }
  return res;
});
ipcMain.handle("db:listMessages", (_e, chatId, opts) => dbApi.listMessages(chatId, opts));
ipcMain.handle("db:countMessages", (_e, chatId) => dbApi.countMessages(chatId));
ipcMain.handle("db:addMessage", (_e, payload) => dbApi.addMessage(payload));
ipcMain.handle("db:getMessage", (_e, msgId) => dbApi.getMessage(msgId));
ipcMain.handle("db:clearChat", (_e, chatId) => dbApi.clearChat(chatId));
ipcMain.handle("db:deleteChat", (_e, chatId) => dbApi.deleteChat(chatId));

// Project context
ipcMain.handle("db:getProjectContext", (_e, projectId) => dbApi.getProjectContext(projectId));
ipcMain.handle("db:setProjectContext", (_e, projectId, systemPrompt) => dbApi.setProjectContext(projectId, systemPrompt));

// Chat context (per-chat system prompt for quick-chat)
ipcMain.handle("db:getChatContext", (_e, chatId) => dbApi.getChatContext(chatId));
ipcMain.handle("db:setChatContext", (_e, chatId, systemPrompt) => dbApi.setChatContext(chatId, systemPrompt));

// Knowledge
// Fail-closed: si el par proyecto/chat es incoherente NO se devuelve un alcance
// más amplio. Se registra el código estable y se devuelve la lista vacía, que es
// el contrato externo histórico (array).
ipcMain.handle("db:listKnowledge", (_e, projectId, chatId, opts) => {
  try {
    return dbApi.listKnowledge(projectId, chatId, opts);
  } catch (e) {
    if (e && e.knowledgeScope) {
      console.warn("[knowledge] listKnowledge con alcance rechazado:", e.code);
      return [];
    }
    throw e;
  }
});
ipcMain.handle("db:addKnowledgeFromText", async (_e, payload) => {
  const res = dbApi.addKnowledgeFromText(payload);
  if (res?.ok && res.id) {
    dbApi.setKnowledgeIndexStatus(res.id, "pending", { indexedAt: null, error: "" });
    enqueueIndex(res.id);
  }
  return res;
});
ipcMain.handle("db:deleteKnowledge", (_e, itemId) => {
  // Se lee el alcance ANTES de borrar: después ya no hay fila que consultar y la
  // caché quedaría sirviendo un documento eliminado.
  const item = dbApi.getKnowledgeItem(itemId);
  const res = dbApi.deleteKnowledge(itemId);
  if (item) invalidateKnowledgeCache({ projectId: item.project_id, chatId: item.chat_id || null });
  return res;
});

// RAG
ipcMain.handle("rag:query", (_e, projectId, text, k, opts) => ragApi.query(projectId, text, k, opts || {}));
ipcMain.handle("rag:queryByChat", (_e, chatId, text, k) => ragApi.queryByChat(chatId, text, k));
ipcMain.handle("rag:indexKnowledgeItem", (_e, knowledgeItemId) => ragApi.indexKnowledgeItem(knowledgeItemId));
ipcMain.handle("rag:getFullDocumentText", async (_e, knowledgeItemId) => {
  try {
    const item = dbApi.getKnowledgeItem(knowledgeItemId);
    if (!item || !item.content_path) return null;
    const text = await fs.readFile(item.content_path, "utf8");
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err?.message || err };
  }
});
// Returns chunk text with server-side truncation and round-robin distribution across documents
ipcMain.handle("rag:listChunksRaw", (_e, projectId, chatId, maxChars, mode = 'selective', opts = {}) => {
  try {
    return dbApi.listChunksRaw({
      projectId,
      chatId,
      maxChars,
      mode,
      includeProjectScope: opts && opts.includeProjectScope !== undefined
        ? !!opts.includeProjectScope
        : undefined
    });
  } catch (e) {
    // Fail-closed: un alcance incoherente NO degrada a la consulta de proyecto
    // entera. Se devuelve vacío y se deja constancia del código.
    if (e && e.knowledgeScope) console.warn("[knowledge] listChunksRaw con alcance rechazado:", e.code);
    else console.error("[knowledge] listChunksRaw falló:", String(e?.message || e));
    return [];
  }
});
ipcMain.handle("rag:getDocumentText", async (_e, knowledgeItemId) => {
  try {
    const item = dbApi.getKnowledgeItem(knowledgeItemId);
    if (!item || !item.content_path) return null;
    return await fs.readFile(item.content_path, "utf8");
  } catch (_) { return null; }
});

// Extract text from PDF using pdf-parse v2 (class-based API)
ipcMain.handle("file:extractPDF", async (_e, base64Data) => {
  if (!PDFParseClass) return { ok: false, error: 'pdf-parse not available' };
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const parser = new PDFParseClass({ data: buffer });
    await parser.load();
    const text = (await parser.getText() || '').trim();
    const info = await parser.getInfo().catch(() => ({}));
    parser.destroy();
    if (!text) return { ok: false, error: 'PDF_NO_TEXT' };
    return { ok: true, text, pages: info.numPages || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Extract text from Word documents (.doc/.docx) using mammoth
ipcMain.handle("file:extractWord", async (_e, base64Data) => {
  if (!mammoth) return { ok: false, error: 'mammoth not available' };
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value || '').trim();
    if (!text) return { ok: false, error: 'WORD_NO_TEXT' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Extract text from Excel/Spreadsheets (.xls/.xlsx/.ods) using SheetJS
ipcMain.handle("file:extractSpreadsheet", async (_e, base64Data) => {
  if (!XLSX) return { ok: false, error: 'xlsx not available' };
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) sheets.push(`--- ${name} ---\n${csv}`);
    }
    const text = sheets.join('\n\n');
    if (!text.trim()) return { ok: false, error: 'SPREADSHEET_NO_TEXT' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


const CLOUD_CONSENT_KEY_PATTERN =
  /^cloud-consent:v1:(openai|anthropic|groq|moonshot|alibaba):(global|project:[A-Za-z0-9._:-]{1,128})$/;

function validateCloudConsentValue(key, value) {
  if (value === '') return '';
  const serialized = String(value || '');
  if (serialized.length > 4096) throw new Error('Consentimiento cloud demasiado grande');
  const parsed = JSON.parse(serialized);
  const keyMatch = key.match(CLOUD_CONSENT_KEY_PATTERN);
  const allowedCategories = [
    'message', 'history', 'projectInstructions', 'textAttachments',
    'imageAttachments', 'ragContext'
  ];
  if (parsed.schemaVersion !== 1
    || parsed.providerId !== keyMatch[1]
    || parsed.projectScope !== keyMatch[2]
    || typeof parsed.grantedAt !== 'string'
    || !parsed.categories
    || Object.keys(parsed.categories).some(category => !allowedCategories.includes(category))
    || allowedCategories.some(category => typeof parsed.categories[category] !== 'boolean')) {
    throw new Error('Registro de consentimiento cloud inválido');
  }
  return JSON.stringify({
    providerId: parsed.providerId,
    projectScope: parsed.projectScope,
    categories: Object.fromEntries(
      allowedCategories.map(category => [category, parsed.categories[category]])
    ),
    schemaVersion: 1,
    grantedAt: parsed.grantedAt
  });
}

ipcMain.handle("appState:get", (_, key) => {
  if (!CLOUD_CONSENT_KEY_PATTERN.test(String(key || ''))) return dbApi.getAppState(key);
  const row = getDb().prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  return row ? row.value : null;
});
ipcMain.handle("appState:set", (_, key, value) => {
  if (!CLOUD_CONSENT_KEY_PATTERN.test(String(key || ''))) return dbApi.setAppState(key, value);
  const validated = validateCloudConsentValue(key, value);
  if (!validated) {
    getDb().prepare('DELETE FROM app_state WHERE key = ?').run(key);
    return { ok: true };
  }
  getDb().prepare(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, validated);
  return { ok: true };
});
ipcMain.handle("openExternal", async (_, url) => {
  try {
    const parsed = new URL(String(url || ''));
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return { opened: false };
    if (parsed.username || parsed.password) return { opened: false };
    await shell.openExternal(parsed.href);
    return { opened: true };
  } catch (_) {
    return { opened: false };
  }
});

// MIKA5 no tiene cuentas de usuario ni sesión remota: no hay nada que
// invalidar en un servidor. Lo único que existe es la sesión de escritorio, y
// fuera de macOS la barra de menú está oculta, así que sin esto no había
// ninguna vía visible para terminarla. Cerrar no borra nada: proyectos, chats,
// documentos y credenciales viven en SQLite y siguen ahí al volver a abrir.
ipcMain.handle("app:quit", () => {
  app.quit();
  return { ok: true };
});

// Versión instalada. Se lee del package.json de la aplicación y no de
// `app.getVersion()`: cuando el punto de entrada no es la raíz del proyecto
// —al ejecutar una prueba con `electron test/...`— `app.getVersion()` devuelve
// la versión de Electron (31.7.7), no la de MIKA5. El package.json es el mismo
// fichero que electron-builder sella al empaquetar, así que la cifra coincide
// con la del instalador. Es la única versión que MIKA5 conoce de sí misma: no
// hay comprobación de actualizaciones ni, por tanto, "versión disponible".
ipcMain.handle("app:getVersion", () => ({
  installed: require("../../package.json").version,
  packaged: app.isPackaged
}));

ipcMain.handle("app:saveFile", async (_, { defaultName, filters, content, encoding }) => {
  // Security: limit file size to 50MB
  const MAX_SIZE = 50 * 1024 * 1024;
  if (content && content.length > MAX_SIZE) {
    return { ok: false, error: 'File too large (max 50MB)' };
  }
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName || "export",
    filters: filters || [{ name: "All", extensions: ["*"] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.writeFile(filePath, content || "", { encoding: encoding || "utf8" });
  return { ok: true, filePath };
});

// AI provider handlers (exponer API genérica)
ipcMain.handle('files:download-image', async (_event, params) => {
  const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

  try {
    const src = typeof params?.src === 'string' ? params.src.trim() : '';
    if (!src) return { ok: false, error: 'La imagen no tiene una fuente válida' };

    let mimeType = '';
    let imageBuffer = null;
    const dataMatch = src.match(/^data:(image\/(?:png|jpeg|jpg|webp|bmp));base64,([\s\S]+)$/i);

    if (dataMatch) {
      mimeType = dataMatch[1].toLowerCase();
      const base64 = dataMatch[2].replace(/\s+/g, '');
      if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
        return { ok: false, error: 'Los datos de la imagen no son válidos' };
      }
      imageBuffer = Buffer.from(base64, 'base64');
    } else {
      try {
        return await downloadAndSaveElectronImage(src, {
          fetchImpl: net.fetch,
          lookup: require('dns').promises.lookup,
          maxRedirects: 5,
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: 30000,
          appVersion: app.getVersion(),
          suggestedName: params?.suggestedName,
          downloadsPath: app.getPath('downloads'),
          joinPath: path.join,
          showSaveDialog: options => dialog.showSaveDialog(options),
          writeFile: (filePath, buffer) => fs.writeFile(filePath, buffer)
        });
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code.startsWith('DOWNLOAD_')
          ? error.code
          : 'DOWNLOAD_UNKNOWN';
        if (!app.isPackaged) console.warn(`Image download failed: ${code}`);
        return {
          ok: false,
          error: 'No se pudo descargar la imagen remota',
          ...(!app.isPackaged ? { code } : {})
        };
      }
    }

    if (!imageBuffer?.length) return { ok: false, error: 'La imagen está vacía' };
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: 'La imagen excede el límite de 50 MB' };
    }

    const extension = safeImageExtensionFromMime(mimeType) || 'png';
    const requestedName = path.basename(String(params?.suggestedName || 'imagen-mika5'))
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/^\.+/, '')
      .slice(0, 120);
    const baseName = requestedName.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'imagen-mika5';
    const safeName = `${baseName}.${extension}`;
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('downloads'), safeName),
      filters: [{ name: 'Imagen', extensions: [extension] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    await fs.writeFile(filePath, imageBuffer);
    return { ok: true, path: filePath };
  } catch (error) {
    if (!app.isPackaged) console.warn('Image download failed: DOWNLOAD_UNKNOWN');
    return {
      ok: false,
      error: 'No se pudo descargar la imagen remota',
      ...(!app.isPackaged ? { code: 'DOWNLOAD_UNKNOWN' } : {})
    };
  }
});

// Exportación a PDF. El cuerpo vive en print-export.js para que la suite
// Electron pueda ejercitar exactamente este handler sin arrancar la app.
// Las imágenes remotas del documento se descargan aquí, con los mismos
// controles que el resto de descargas; la ventana de impresión sólo recibe
// data: URIs y nunca habla con la red.
ipcMain.handle(
  "app:printToPDF",
  createPrintExport({
    createWindow: (options) => new BrowserWindow(options),
    showSaveDialog: (options) => dialog.showSaveDialog(options),
    writeFile: (filePath, buffer) => fs.writeFile(filePath, buffer),
    fetchRemoteImage: (url, options) => fetchElectronImage(url, {
      ...options,
      fetchImpl: net.fetch,
      lookup: require('dns').promises.lookup,
      maxRedirects: 5,
      appVersion: app.getVersion()
    }),
    printHtmlPath: path.join(__dirname, "../renderer/print.html"),
    logger: console
  })
);


ipcMain.handle('ai:get-providers', () => aiManager.getAllProviders());
ipcMain.handle('ai:get-current-provider', () => aiManager.getProvider());
ipcMain.handle('ai:set-provider', (_e, id) => aiManager.setProvider(id));
ipcMain.handle('ai:set-api-key', (_e, provider, key) => aiManager.setApiKey(provider, key));
ipcMain.handle('ai:get-provider-config', (_e, provider) => aiManager.getProviderConfig(provider));
ipcMain.handle('ai:save-provider-config', (_e, provider, config) => aiManager.saveProviderConfig(provider, config));
ipcMain.handle('ai:add-provider-model', (_e, provider, model) => aiManager.addProviderModel(provider, model));
ipcMain.handle('ai:update-provider-model', (_e, provider, modelId, model) => aiManager.updateProviderModel(provider, modelId, model));
ipcMain.handle('ai:delete-provider-model', (_e, provider, modelId) => aiManager.deleteProviderModel(provider, modelId));
ipcMain.handle('ai:chat', (_e, params = {}) => {
  const controller = aiRequests.start(params.requestId);
  return aiManager.chat({ ...params, signal: controller.signal })
    .finally(() => aiRequests.finish(params.requestId));
});
ipcMain.handle('ai:generate-image', (_e, params) => {
  if (!params || typeof params !== 'object') throw new Error('Parámetros de generación inválidos');
  const controller = aiRequests.start(params.requestId);
  return aiManager.generateImage({ ...params, signal: controller.signal })
    .finally(() => aiRequests.finish(params.requestId));
});
ipcMain.handle('ai:route-intent', (_e, params) => aiManager.routeIntent(params));
ipcMain.handle('ai:list-models', () => aiManager.listModels());
ipcMain.handle('ai:status', () => aiManager.status());
ipcMain.handle('ai:get-availability', (_e, providerId) => aiManager.getAvailability(providerId));
// Contrato de capacidades: la interfaz lo consulta en vez de adivinar por nombre.
ipcMain.handle('ai:get-capabilities', (_e, providerId) => aiManager.getCapabilities(providerId));
ipcMain.handle('ai:resolve-vision', (_e, params = {}) => aiManager.resolveVision(params));

// --- Knowledge indexing queue (prevents parallel indexation race conditions) ---
const indexQueue = [];
let indexRunning = false;
async function enqueueIndex(itemId) {
  indexQueue.push(itemId);
  if (indexRunning) return;
  indexRunning = true;
  while (indexQueue.length > 0) {
    const id = indexQueue.shift();
    try {
      const result = await ragApi.indexKnowledgeItem(id);
      // Notify renderer so it can refresh the knowledge list status indicators
      const mainWin = BrowserWindow.getAllWindows()[0];
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('knowledge:index-complete', {
          id,
          ok: result?.ok,
          saved: result?.saved,
          pending: result?.pending,
          code: result?.code,
          indexed: result?.indexed,
          error: result?.error,
          embeddingProvider: result?.embeddingProvider,
          embeddingModel: result?.embeddingModel
        });
      }
    } catch (err) {
      console.warn("RAG index error:", err?.message || err);
      const mainWin = BrowserWindow.getAllWindows()[0];
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('knowledge:index-complete', { id, ok: false, error: err?.message || String(err) });
      }
    }
  }
  indexRunning = false;
}

ipcMain.handle('ai:abort', (_event, requestId) => aiRequests.abort(requestId));

// Mantener compatibilidad con canales 'ollama:*' redirigiendo a aiManager
ipcMain.handle("ollama:status", () => aiManager.status());
ipcMain.handle("ollama:tags", () => aiManager.listModels());
ipcMain.handle("ollama:chat", (_e, payload) => aiManager.chat(payload));
// Mantener pull específico de Ollama para descargas locales
ipcMain.handle("ollama:pull", (_e, model) => ollamaApi.pull(model));

// Se exporta para que la suite compruebe la altura mínima contra el mismo
// número que usa la ventana y no contra una copia que pueda quedarse atrás.
module.exports = { ALTO_MINIMO_VENTANA };
