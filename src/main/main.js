const path = require("path");
const fs = require("fs").promises;
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, net } = require("electron");
const { initDb, dbApi, getDb } = require("./db");
const { ollamaApi } = require("./ollama");
const { AIProviderManager } = require("./ai-providers");
const { RequestRegistry } = require("./request-registry");
let aiManager;
const aiRequests = new RequestRegistry();
const { ragApi } = require("./rag");
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

function createWindow() {
  const win = new BrowserWindow({
    title: 'MIKA5',
    icon: path.join(__dirname, "../renderer/assets/icon.png"),
    width: 1280,
    height: 820,
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false  // Fix: Disable spellcheck to prevent textarea freeze
    }
  });

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
ipcMain.handle("db:updateChat", (_e, chatId, payload) => dbApi.updateChat(chatId, payload));
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
ipcMain.handle("db:listKnowledge", (_e, projectId, chatId) => dbApi.listKnowledge(projectId, chatId));
ipcMain.handle("db:addKnowledgeFromText", async (_e, payload) => {
  const res = dbApi.addKnowledgeFromText(payload);
  if (res?.ok && res.id) {
    dbApi.setKnowledgeIndexStatus(res.id, "pending", { indexedAt: null, error: "" });
    enqueueIndex(res.id);
  }
  return res;
});
ipcMain.handle("db:deleteKnowledge", (_e, itemId) => dbApi.deleteKnowledge(itemId));
// RAG
ipcMain.handle("rag:query", (_e, projectId, text, k) => ragApi.query(projectId, text, k));
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
ipcMain.handle("rag:listChunksRaw", (_e, projectId, chatId, maxChars, mode = 'selective') => {
  try {
    const db = getDb();
    // Safety limit: 100k chars for complete mode, otherwise use provided maxChars (default 24k)
    const limit = mode === 'complete'
      ? Math.min(100000, 500000) // 100k safety cap for complete mode
      : Math.min(maxChars || 24000, 50000);
    const whereClause = chatId ? 'kc.chat_id = ?' : 'kc.project_id = ?';
    const param = chatId || projectId;
    if (!param) return [];
    const rows = db.prepare(`
      SELECT kc.chunk_text, kc.chunk_index, ki.title
      FROM knowledge_chunks kc
      JOIN knowledge_items ki ON ki.id = kc.knowledge_item_id
      WHERE ${whereClause} ORDER BY ki.title, kc.chunk_index
    `).all(param);

    if (mode === 'complete') {
      // Complete mode: return chunks in order until limit reached (no round-robin bias)
      let chars = 0;
      const result = [];
      for (const r of rows) {
        const chunkLength = (r.chunk_text || '').length;
        if (chars + chunkLength > limit) break;
        result.push(r);
        chars += chunkLength;
      }
      return result;
    }

    // Selective mode: original round-robin behavior
    // Group chunks by document
    const byDoc = new Map();
    for (const r of rows) {
      if (!byDoc.has(r.title)) byDoc.set(r.title, []);
      byDoc.get(r.title).push(r);
    }

    // Round-robin: take first chunk from each doc, then second, etc.
    const docArrays = [...byDoc.values()];
    let chars = 0;
    const result = [];
    let idx = 0;
    let added = true;
    while (added) {
      added = false;
      for (const docChunks of docArrays) {
        if (idx < docChunks.length) {
          const r = docChunks[idx];
          if (chars + (r.chunk_text || '').length > limit) continue;
          result.push(r);
          chars += (r.chunk_text || '').length;
          added = true;
        }
      }
      idx++;
      if (chars >= limit) break;
    }
    return result;
  } catch (_) { return []; }
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
