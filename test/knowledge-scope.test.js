// test/knowledge-scope.test.js — Aislamiento de conocimiento entre proyectos y chats.
// Run: npx electron test/knowledge-scope.test.js
//
// Usa SIEMPRE un userData temporal. Nunca toca %APPDATA%\mika5-desktop.
//
// Cubre la causa raíz: mover un chat sólo actualizaba `chats.project_id`, así que
// sus documentos y fragmentos quedaban apuntando al proyecto anterior, y la
// recuperación (que filtraba por UN solo campo) los perdía o los filtraba a
// todos los chats del proyecto destino.
//
// Cubre también el modelo de consistencia disco/SQLite: destino determinista,
// copia con exclusión, verificación por hash, rollback que nunca borra archivos
// preexistentes, y separación inspect (sólo lectura) / execute (explícito).

const path = require('path');
const fs = require('fs');
const os = require('os');

// --- Mock Electron's app.getPath — userData temporal y aislado ---
const TEST_DIR = path.join(os.tmpdir(), `mika5-scope-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

const Module = require('module');
const originalResolve = Module._resolveFilename;
const mockElectronPath = path.join(__dirname, 'mock-electron-scope.js');
Module._resolveFilename = function (request, parent, ...args) {
  if (request === 'electron') return mockElectronPath;
  return originalResolve.call(this, request, parent, ...args);
};
fs.writeFileSync(mockElectronPath, `
  module.exports = {
    app: { getPath: () => '${TEST_DIR.replace(/\\/g, '\\\\')}' },
    safeStorage: { isEncryptionAvailable: () => false }
  };
`);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertEq(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++; console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg} — esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  }
}

function assertThrowsCode(fn, code, msg) {
  try {
    fn();
    failed++; console.error(`  ✗ ${msg} — no lanzó nada`);
  } catch (e) {
    if (e && e.code === code) { passed++; console.log(`  ✓ ${msg}`); }
    else { failed++; console.error(`  ✗ ${msg} — lanzó ${e && e.code || e.message}`); }
  }
}

const QUICK_CHAT_ID = 'quick-chat';

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out.sort();
}

(async () => {
try {
  const {
    initDb, dbApi, getDb,
    inspectKnowledgeScopeRepair, executeKnowledgeScopeRepair,
    createSourceResolver, KNOWLEDGE_ERRORS
  } = require('../src/main/db');
  initDb();
  const db = getDb();
  const KNOWLEDGE_ROOT = path.join(TEST_DIR, 'knowledge');

  const titlesOf = rows => [...new Set(rows.map(r => r.title))].sort();

  // Alcance real del recuperador, tal como lo llama el renderer.
  const scopeFor = (projectId, chatId) => dbApi.listChunksRaw({
    projectId,
    chatId: chatId || null,
    mode: projectId === QUICK_CHAT_ID ? 'selective' : 'complete',
    includeProjectScope: projectId !== QUICK_CHAT_ID
  });

  const mismatches = () => ({
    item_vs_chat: db.prepare(`
      SELECT COUNT(*) AS n FROM knowledge_items ki
      JOIN chats c ON c.id = ki.chat_id
      WHERE ki.project_id <> c.project_id
    `).get().n,
    chunk_vs_chat: db.prepare(`
      SELECT COUNT(*) AS n FROM knowledge_chunks kc
      JOIN chats c ON c.id = kc.chat_id
      WHERE kc.project_id <> c.project_id
    `).get().n,
    item_vs_chunk: db.prepare(`
      SELECT COUNT(*) AS n FROM knowledge_chunks kc
      JOIN knowledge_items ki ON ki.id = kc.knowledge_item_id
      WHERE kc.project_id <> ki.project_id
    `).get().n
  });

  function indexDoc(itemId, howMany) {
    const item = dbApi.getKnowledgeItem(itemId);
    for (let i = 0; i < howMany; i++) {
      dbApi.insertChunk({
        id: `${itemId}-c${i}`,
        projectId: item.project_id,
        itemId,
        chunkIndex: i,
        chunkText: `${item.title} fragmento ${i}`,
        embeddingJson: '[1,0,0]',
        chatId: item.chat_id || null
      });
    }
  }

  // Reproduce la corrupción histórica: el UPDATE antiguo tocaba sólo `chats`.
  const legacyMoveChat = (chatId, projectId) =>
    db.prepare('UPDATE chats SET project_id = ? WHERE id = ?').run(projectId, chatId);

  // ============================================
  console.log('\n=== Preparación ===');
  // ============================================
  dbApi.createProject({ name: 'Quick Chat', _internal: QUICK_CHAT_ID });
  const techy = dbApi.createProject({ name: 'TechyBot' });
  const gpu = dbApi.createProject({ name: 'GPUBridge' });

  const qc1 = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'QC uno' });
  const qc2 = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'QC dos' });
  const techyChat = dbApi.createChat({ projectId: techy.id, title: 'Chat TechyBot' });

  const docMovido = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: qc1.id, title: 'Doc del chat movido', content: 'contenido A'
  });
  assert(docMovido.ok, 'documento chat-scoped creado en Quick Chat');
  indexDoc(docMovido.id, 4);

  const docQuedado = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: qc2.id, title: 'Doc que se queda', content: 'contenido B'
  });
  indexDoc(docQuedado.id, 3);

  const docProyecto = dbApi.addKnowledgeFromText({
    projectId: techy.id, title: 'Doc de proyecto TechyBot', content: 'contenido de proyecto'
  });
  assert(docProyecto.ok, 'documento project-scoped creado en TechyBot');
  indexDoc(docProyecto.id, 5);

  const rutaOriginal = dbApi.getKnowledgeItem(docMovido.id).content_path;
  assert(rutaOriginal.includes(QUICK_CHAT_ID), 'content_path incluye el projectId de origen');
  assert(fs.existsSync(rutaOriginal), 'el archivo original existe antes de mover');

  // ============================================
  console.log('\n=== Destino determinista único ===');
  // ============================================
  // Dos documentos del mismo chat con título idéntico: el nombre de archivo
  // legado (`<timestamp>-<título>`) podía coincidir y sobrescribirse.
  const gemeloA = dbApi.addKnowledgeFromText({
    projectId: techy.id, chatId: techyChat.id, title: 'Informe', content: 'gemelo A'
  });
  const gemeloB = dbApi.addKnowledgeFromText({
    projectId: techy.id, chatId: techyChat.id, title: 'Informe', content: 'gemelo B'
  });
  indexDoc(gemeloA.id, 2);
  const pathA = dbApi.getKnowledgeItem(gemeloA.id).content_path;
  const pathB = dbApi.getKnowledgeItem(gemeloB.id).content_path;
  assert(pathA !== pathB, 'dos items con el mismo filename reciben rutas distintas');
  assert(pathA.includes(gemeloA.id) && pathB.includes(gemeloB.id),
    'cada content_path lleva el id de su propio item');
  assertEq(fs.readFileSync(pathA, 'utf8'), 'gemelo A', 'el primero conserva su contenido');
  assertEq(fs.readFileSync(pathB, 'utf8'), 'gemelo B', 'el segundo no pisó al primero');
  assertEq(db.prepare('SELECT COUNT(DISTINCT content_path) AS n FROM knowledge_items').get().n,
    db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get().n,
    'ningún content_path está duplicado en toda la tabla');

  // ============================================
  console.log('\n=== A. Mover el chat migra chat, items y chunks ===');
  // ============================================
  const move = dbApi.updateChat(qc1.id, { projectId: techy.id });
  assert(move.ok && move.moved, 'updateChat mueve el chat');

  assertEq(dbApi.getChat(qc1.id).project_id, techy.id, 'chat.project_id = TechyBot');
  const itemMovido = dbApi.getKnowledgeItem(docMovido.id);
  assertEq(itemMovido.project_id, techy.id, 'item.project_id = TechyBot');
  assertEq(itemMovido.chat_id, qc1.id, 'chat_id del item permanece igual');

  const chunksMovidos = db.prepare(
    'SELECT project_id, chat_id FROM knowledge_chunks WHERE knowledge_item_id = ?'
  ).all(docMovido.id);
  assertEq(chunksMovidos.length, 4, 'los 4 chunks siguen existiendo');
  assert(chunksMovidos.every(c => c.project_id === techy.id), 'chunks.project_id = TechyBot');
  assert(chunksMovidos.every(c => c.chat_id === qc1.id), 'chat_id de los chunks permanece igual');

  assertEq(mismatches(), { item_vs_chat: 0, chunk_vs_chat: 0, item_vs_chunk: 0 }, 'cero mismatches');

  const rutaNueva = itemMovido.content_path;
  assert(rutaNueva.includes(techy.id), 'content_path apunta ya al proyecto destino');
  assert(fs.existsSync(rutaNueva), 'el archivo existe en la ruta nueva');
  assert(!fs.existsSync(rutaOriginal), 'el archivo de origen se borró SÓLO tras el commit');
  assertEq(fs.readFileSync(rutaNueva, 'utf8'), 'contenido A', 'el contenido sobrevive intacto');

  // ============================================
  console.log('\n=== B/C/D/E. Semántica de recuperación ===');
  // ============================================
  assertEq(titlesOf(scopeFor(techy.id, qc1.id)),
    ['Doc de proyecto TechyBot', 'Doc del chat movido'],
    'B: el chat movido recupera su documento (más el del proyecto)');

  assertEq(titlesOf(scopeFor(techy.id, techyChat.id)),
    ['Doc de proyecto TechyBot', 'Informe'],
    'C: otro chat de TechyBot NO recupera el documento del chat movido');

  assertThrowsCode(() => scopeFor(QUICK_CHAT_ID, qc1.id), 'INVALID_CHAT_PROJECT_SCOPE',
    'D: pedir el chat movido bajo Quick Chat falla cerrado');
  assertEq(titlesOf(scopeFor(QUICK_CHAT_ID, qc2.id)), ['Doc que se queda'],
    'D: el Quick Chat que se quedó sólo ve lo suyo');

  assertEq(titlesOf(scopeFor(techy.id, null)), ['Doc de proyecto TechyBot'],
    'E: el conocimiento de proyecto se recupera sin chat activo');
  assert(titlesOf(scopeFor(techy.id, techyChat.id)).includes('Doc de proyecto TechyBot'),
    'E: y también desde cualquier chat de TechyBot');

  const panelChatMovido = dbApi.listKnowledge(techy.id, qc1.id, { includeProjectScope: true });
  assert(panelChatMovido.some(i => i.title === 'Doc del chat movido'),
    'el panel del chat movido muestra su documento');
  const panelOtroChat = dbApi.listKnowledge(techy.id, techyChat.id, { includeProjectScope: true });
  assert(!panelOtroChat.some(i => i.title === 'Doc del chat movido'),
    'el panel de otro chat no lo muestra');

  // ============================================
  console.log('\n=== Alcance: par proyecto/chat inválido falla cerrado ===');
  // ============================================
  assertThrowsCode(() => dbApi.listChunksRaw({ projectId: gpu.id, chatId: techyChat.id }),
    'INVALID_CHAT_PROJECT_SCOPE', 'listChunksRaw rechaza proyecto A con chat de B');
  assertThrowsCode(() => dbApi.listKnowledge(gpu.id, techyChat.id, { includeProjectScope: true }),
    'INVALID_CHAT_PROJECT_SCOPE', 'listKnowledge rechaza proyecto A con chat de B');
  assertThrowsCode(() => dbApi.listScopedChunks({ projectId: gpu.id, chatId: techyChat.id }),
    'INVALID_CHAT_PROJECT_SCOPE', 'listScopedChunks rechaza proyecto A con chat de B');
  assertThrowsCode(() => dbApi.listChunksRaw({ projectId: techy.id, chatId: 'no-existe' }),
    'INVALID_CHAT', 'chat inexistente da INVALID_CHAT');
  assertThrowsCode(() => dbApi.listChunksRaw({ chatId: techyChat.id }),
    'INVALID_PROJECT', 'sin projectId da INVALID_PROJECT');
  assertThrowsCode(() => dbApi.listChunksForChat('no-existe'),
    'INVALID_CHAT', 'listChunksForChat rechaza un chat inexistente');

  // ============================================
  console.log('\n=== F. addKnowledgeFromText rechaza chat de otro proyecto ===');
  // ============================================
  const itemsAntes = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get().n;
  const archivosAntes = walkFiles(KNOWLEDGE_ROOT).length;

  const cruzado = dbApi.addKnowledgeFromText({
    projectId: gpu.id, chatId: techyChat.id, title: 'Cruzado', content: 'no debe escribirse'
  });
  assertEq(cruzado.ok, false, 'F: rechaza projectId A con chat de B');
  assertEq(cruzado.error, 'INVALID_CHAT_PROJECT_SCOPE', 'F: error estable INVALID_CHAT_PROJECT_SCOPE');
  assertEq(db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get().n, itemsAntes,
    'F: cero filas nuevas');
  assertEq(walkFiles(KNOWLEDGE_ROOT).length, archivosAntes, 'F: cero archivos creados');

  const chatInexistente = dbApi.addKnowledgeFromText({
    projectId: gpu.id, chatId: '00000000-0000-4000-8000-000000000000', title: 'X', content: 'y'
  });
  assertEq(chatInexistente.error, 'INVALID_CHAT', 'F: chat inexistente sigue dando INVALID_CHAT');

  assert(dbApi.addKnowledgeFromText({
    projectId: techy.id, chatId: techyChat.id, title: 'Legítimo chat', content: 'ok'
  }).ok, 'F: proyecto normal + chat propio sigue permitido');
  assert(dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: qc2.id, title: 'Legítimo QC', content: 'ok'
  }).ok, 'F: Quick Chat + chat de quick-chat sigue permitido');
  assert(dbApi.addKnowledgeFromText({
    projectId: gpu.id, title: 'Legítimo proyecto', content: 'ok'
  }).ok, 'F: conocimiento de proyecto con chatId null sigue permitido');

  // ============================================
  console.log('\n=== G. Proyecto destino inexistente ===');
  // ============================================
  const antesG = {
    chat: dbApi.getChat(qc1.id).project_id,
    item: dbApi.getKnowledgeItem(docMovido.id).project_id,
    ruta: dbApi.getKnowledgeItem(docMovido.id).content_path,
    chunks: db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE chat_id = ? AND project_id = ?')
      .get(qc1.id, techy.id).n
  };
  const fantasma = dbApi.updateChat(qc1.id, { projectId: '11111111-1111-4111-8111-111111111111' });
  assertEq(fantasma.ok, false, 'G: movimiento rechazado');
  assertEq(fantasma.error, 'INVALID_PROJECT', 'G: error INVALID_PROJECT');
  assertEq(dbApi.getChat(qc1.id).project_id, antesG.chat, 'G: el chat conserva su proyecto');
  assertEq(dbApi.getKnowledgeItem(docMovido.id).project_id, antesG.item, 'G: el item conserva su proyecto');
  assertEq(dbApi.getKnowledgeItem(docMovido.id).content_path, antesG.ruta, 'G: content_path intacto');
  assertEq(db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE chat_id = ? AND project_id = ?')
    .get(qc1.id, techy.id).n, antesG.chunks, 'G: los chunks conservan su proyecto');
  assert(fs.existsSync(antesG.ruta), 'G: el archivo sigue en su sitio');

  const soloTitulo = dbApi.updateChat(qc1.id, { title: 'Renombrado' });
  assertEq(soloTitulo.moved, false, 'cambiar sólo el título no migra conocimiento');
  assertEq(dbApi.getChat(qc1.id).title, 'Renombrado', 'el título sí cambia');
  assertEq(dbApi.getKnowledgeItem(docMovido.id).content_path, antesG.ruta,
    'cambiar sólo el título no toca archivos');

  // ============================================
  console.log('\n=== inspect es sólo lectura ===');
  // ============================================
  const legacyA = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Legacy A' });
  const legacyB = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Legacy B' });
  const legacyDocs = [
    { chat: legacyA.id, title: 'Legacy 1', chunks: 63 },
    { chat: legacyA.id, title: 'Legacy 2', chunks: 62 },
    { chat: legacyB.id, title: 'Legacy 3', chunks: 32 }
  ].map(spec => {
    const doc = dbApi.addKnowledgeFromText({
      projectId: QUICK_CHAT_ID, chatId: spec.chat, title: spec.title, content: `contenido ${spec.title}`
    });
    indexDoc(doc.id, spec.chunks);
    return { ...spec, id: doc.id, rutaVieja: dbApi.getKnowledgeItem(doc.id).content_path };
  });

  const intocable = dbApi.addKnowledgeFromText({
    projectId: gpu.id, title: 'Intocable', content: 'sin chat'
  });
  indexDoc(intocable.id, 2);

  legacyMoveChat(legacyA.id, techy.id);
  legacyMoveChat(legacyB.id, gpu.id);

  const snapshotArchivos = walkFiles(KNOWLEDGE_ROOT);
  const snapshotItems = db.prepare('SELECT id, project_id, content_path, sha256 FROM knowledge_items ORDER BY id').all();
  const snapshotChunks = db.prepare('SELECT id, project_id FROM knowledge_chunks ORDER BY id').all();

  const inspect1 = inspectKnowledgeScopeRepair();
  assertEq(inspect1.chatsAffected, 2, 'inspect ve 2 chats afectados');
  assertEq(inspect1.itemsAffected, 3, 'inspect cuenta 3 items desalineados');
  assertEq(inspect1.chunksAffected, 157, 'inspect cuenta 157 chunks desalineados');
  assertEq(inspect1.sourcesValid, 3, 'inspect ve 3 sources válidos');
  assertEq(inspect1.sourcesMissing, 0, 'inspect ve 0 sources ausentes');
  assertEq(inspect1.collisions, 0, 'inspect ve 0 colisiones');
  assertEq(inspect1.errors, [], 'inspect no reporta errores');
  assertEq(inspect1.ok, true, 'inspect declara el plan ejecutable');

  assertEq(walkFiles(KNOWLEDGE_ROOT), snapshotArchivos, 'inspect no creó ni movió ningún archivo');
  assertEq(db.prepare('SELECT id, project_id, content_path, sha256 FROM knowledge_items ORDER BY id').all(),
    snapshotItems, 'inspect no modificó knowledge_items');
  assertEq(db.prepare('SELECT id, project_id FROM knowledge_chunks ORDER BY id').all(),
    snapshotChunks, 'inspect no modificó knowledge_chunks');
  assert(!fs.existsSync(path.join(KNOWLEDGE_ROOT, techy.id, legacyA.id)),
    'inspect no creó el directorio destino');

  // Contrato de salida: sólo conteos y códigos.
  const clavesPermitidas = ['ok', 'chatsAffected', 'itemsAffected', 'chunksAffected', 'sourcesValid',
    'sourcesMissing', 'destinationsExistingValid', 'collisions', 'orphanItems', 'orphanChunks', 'errors'];
  assertEq(Object.keys(inspect1).sort(), clavesPermitidas.sort(),
    'inspect devuelve exclusivamente conteos, huérfanos y errores');
  assert(!JSON.stringify(inspect1).includes(TEST_DIR), 'inspect no filtra rutas');
  assert(!JSON.stringify(inspect1).includes('Legacy 1'), 'inspect no filtra títulos');

  // initDb ejecuta el preflight, nunca la reparación.
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const dbSource = fs.readFileSync(path.join(__dirname, '../src/main/db.js'), 'utf8');
  const initDbBody = stripComments(
    dbSource.slice(dbSource.indexOf('function initDb('), dbSource.indexOf('function ensureDir('))
  );
  assert(initDbBody.includes('inspectKnowledgeScopeRepair'), 'initDb llama al preflight');
  assert(!initDbBody.includes('executeKnowledgeScopeRepair'), 'initDb NO llama a la reparación');
  const dbApiBody = stripComments(
    dbSource.slice(dbSource.indexOf('const dbApi = {'), dbSource.indexOf('module.exports = {'))
  );
  assert(!dbApiBody.includes('executeKnowledgeScopeRepair'),
    'executeKnowledgeScopeRepair no está expuesta en dbApi');
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert(!mainSource.includes('executeKnowledgeScopeRepair'),
    'ningún canal IPC expone la reparación al renderer');

  // ============================================
  console.log('\n=== H. Reparación explícita, fail-closed y una sola transacción ===');
  // ============================================
  // Una única transacción para toda la reparación: se cuentan los BEGIN.
  let transacciones = 0;
  const originalTransaction = db.transaction.bind(db);
  db.transaction = (fn) => { transacciones++; return originalTransaction(fn); };

  const repair = executeKnowledgeScopeRepair();
  db.transaction = originalTransaction;

  assertEq(repair.ok, true, 'H: la reparación termina sin fallos');
  assertEq(repair.itemsRepaired, 3, 'H: repara 3 items');
  assertEq(repair.chunksRepaired, 157, 'H: repara 157 chunks');
  assertEq(repair.filesCopied, 3, 'H: copia los 3 archivos');
  assertEq(repair.cleanupFailures, 0, 'H: sin fallos de limpieza');
  assertEq(transacciones, 1, 'H: una sola transacción SQLite para toda la reparación');
  assertEq(mismatches(), { item_vs_chat: 0, chunk_vs_chat: 0, item_vs_chunk: 0 },
    'H: cero mismatches tras reparar');

  for (const doc of legacyDocs) {
    const item = dbApi.getKnowledgeItem(doc.id);
    const destino = doc.chat === legacyA.id ? techy.id : gpu.id;
    assert(item.content_path.includes(destino), `H: content_path de ${doc.title} apunta al proyecto actual`);
    assert(fs.existsSync(item.content_path), `H: el archivo de ${doc.title} existe en la ruta nueva`);
    assert(!fs.existsSync(doc.rutaVieja), `H: el archivo viejo de ${doc.title} ya no está duplicado`);
    assertEq(fs.readFileSync(item.content_path, 'utf8'), `contenido ${doc.title}`,
      `H: el contenido de ${doc.title} sobrevive`);
  }

  const inspect2 = inspectKnowledgeScopeRepair();
  assertEq(inspect2.chatsAffected, 0, 'H: el preflight posterior no ve nada que reparar');
  const repair2 = executeKnowledgeScopeRepair();
  assertEq(repair2.itemsRepaired, 0, 'H: la segunda ejecución modifica 0 items');
  assertEq(repair2.chunksRepaired, 0, 'H: la segunda ejecución modifica 0 chunks');
  assertEq(repair2.filesCopied, 0, 'H: la segunda ejecución no copia archivos');

  const intocableRow = dbApi.getKnowledgeItem(intocable.id);
  assertEq(intocableRow.project_id, gpu.id, 'H: el item con chat_id null conserva su proyecto');
  assertEq(intocableRow.chat_id, null, 'H: y sigue sin chat');

  assertEq(titlesOf(scopeFor(techy.id, legacyA.id)).includes('Legacy 3'), false,
    'H: el chat de TechyBot no ve el documento del chat de GPUBridge');
  assert(titlesOf(scopeFor(gpu.id, legacyB.id)).includes('Legacy 3'),
    'H: el chat de GPUBridge sí ve el suyo');

  // ============================================
  console.log('\n=== Reanudación: destino ya copiado del mismo item ===');
  // ============================================
  const resumeChat = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Reanudar' });
  const resumeDoc = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: resumeChat.id, title: 'Reanudable', content: 'contenido reanudable'
  });
  indexDoc(resumeDoc.id, 2);
  const resumeSource = dbApi.getKnowledgeItem(resumeDoc.id).content_path;
  legacyMoveChat(resumeChat.id, techy.id);

  // Simula una ejecución interrumpida tras copiar pero antes del commit.
  const resumeDest = path.join(KNOWLEDGE_ROOT, techy.id, resumeChat.id,
    `${resumeDoc.id}-${path.basename(resumeSource).slice(resumeDoc.id.length + 1)}`);
  fs.mkdirSync(path.dirname(resumeDest), { recursive: true });
  fs.copyFileSync(resumeSource, resumeDest);

  const inspectResume = inspectKnowledgeScopeRepair();
  assertEq(inspectResume.destinationsExistingValid, 1, 'inspect reconoce el destino ya copiado');
  assertEq(inspectResume.collisions, 0, 'un destino idéntico del mismo item no es colisión');

  const repairResume = executeKnowledgeScopeRepair();
  assertEq(repairResume.ok, true, 'la reanudación completa la reparación');
  assertEq(repairResume.filesCopied, 0, 'no vuelve a copiar el destino que ya existía');
  assertEq(dbApi.getKnowledgeItem(resumeDoc.id).content_path, resumeDest,
    'content_path apunta a la copia verificada');
  assert(!fs.existsSync(resumeSource), 'el origen se limpia tras el commit');

  // ============================================
  console.log('\n=== Colisión: destino distinto preexistente ===');
  // ============================================
  const colChat = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Colisión' });
  const colDoc = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: colChat.id, title: 'Colisionable', content: 'contenido bueno'
  });
  indexDoc(colDoc.id, 2);
  const colSource = dbApi.getKnowledgeItem(colDoc.id).content_path;
  legacyMoveChat(colChat.id, techy.id);

  const colDest = path.join(KNOWLEDGE_ROOT, techy.id, colChat.id,
    `${colDoc.id}-${path.basename(colSource).slice(colDoc.id.length + 1)}`);
  fs.mkdirSync(path.dirname(colDest), { recursive: true });
  fs.writeFileSync(colDest, 'CONTENIDO AJENO QUE NO SE PUEDE PERDER', 'utf8');

  const inspectCol = inspectKnowledgeScopeRepair();
  assertEq(inspectCol.collisions, 1, 'inspect detecta la colisión');
  assertEq(inspectCol.ok, false, 'inspect declara el plan NO ejecutable');
  assert(inspectCol.errors.some(e => e.code === KNOWLEDGE_ERRORS.DESTINATION_COLLISION),
    'el código de error es KNOWLEDGE_DESTINATION_COLLISION');

  const itemsAntesCol = db.prepare('SELECT id, project_id, content_path FROM knowledge_items ORDER BY id').all();
  const repairCol = executeKnowledgeScopeRepair();
  assertEq(repairCol.ok, false, 'la reparación se aborta entera');
  assertEq(repairCol.itemsRepaired, 0, 'cero items modificados');
  assertEq(repairCol.chunksRepaired, 0, 'cero chunks modificados');
  assertEq(repairCol.filesCopied, 0, 'cero copias nuevas');
  assertEq(db.prepare('SELECT id, project_id, content_path FROM knowledge_items ORDER BY id').all(),
    itemsAntesCol, 'ninguna fila cambió');
  assertEq(fs.readFileSync(colDest, 'utf8'), 'CONTENIDO AJENO QUE NO SE PUEDE PERDER',
    'el archivo preexistente distinto NO se sobrescribió');
  assert(fs.existsSync(colSource), 'el origen sigue intacto');

  // El destino preexistente tampoco se borra durante el rollback.
  assert(fs.existsSync(colDest), 'el destino preexistente nunca se elimina en rollback');

  // Limpiar la colisión para las pruebas siguientes.
  fs.unlinkSync(colDest);
  assertEq(executeKnowledgeScopeRepair().ok, true, 'resuelta la colisión, la reparación procede');

  // ============================================
  console.log('\n=== sha256 almacenado distinto del source ===');
  // ============================================
  const shaChat = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Hash' });
  const shaDoc = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: shaChat.id, title: 'Hasheado', content: 'contenido con hash'
  });
  indexDoc(shaDoc.id, 2);
  legacyMoveChat(shaChat.id, gpu.id);
  db.prepare('UPDATE knowledge_items SET sha256 = ? WHERE id = ?').run('0'.repeat(64), shaDoc.id);

  const inspectSha = inspectKnowledgeScopeRepair();
  assert(inspectSha.errors.some(e => e.code === KNOWLEDGE_ERRORS.SHA256_MISMATCH),
    'inspect bloquea cuando el sha256 almacenado no coincide con el archivo');
  const shaSourcePath = dbApi.getKnowledgeItem(shaDoc.id).content_path;
  const repairSha = executeKnowledgeScopeRepair();
  assertEq(repairSha.ok, false, 'la reparación se aborta por hash inválido');
  assertEq(repairSha.filesCopied, 0, 'cero copias con hash inválido');
  assertEq(dbApi.getKnowledgeItem(shaDoc.id).content_path, shaSourcePath, 'content_path sin tocar');
  assert(fs.existsSync(shaSourcePath), 'el archivo original sigue existiendo');

  // Restaurar el hash correcto y comprobar que ya procede.
  const shaReal = require('crypto').createHash('sha256')
    .update(fs.readFileSync(shaSourcePath)).digest('hex');
  db.prepare('UPDATE knowledge_items SET sha256 = ? WHERE id = ?').run(shaReal, shaDoc.id);
  assertEq(executeKnowledgeScopeRepair().ok, true, 'con el hash correcto la reparación procede');

  // ============================================
  console.log('\n=== Source ausente sin destino verificable ===');
  // ============================================
  const missChat = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Ausente' });
  const missDoc = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: missChat.id, title: 'Perdido', content: 'contenido perdido'
  });
  indexDoc(missDoc.id, 2);
  const okChat = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Acompañante' });
  const okDoc = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: okChat.id, title: 'Sano', content: 'contenido sano'
  });
  indexDoc(okDoc.id, 2);
  legacyMoveChat(missChat.id, techy.id);
  legacyMoveChat(okChat.id, techy.id);
  fs.unlinkSync(dbApi.getKnowledgeItem(missDoc.id).content_path);

  const inspectMiss = inspectKnowledgeScopeRepair();
  assertEq(inspectMiss.sourcesMissing, 1, 'inspect cuenta el source ausente');
  assertEq(inspectMiss.ok, false, 'inspect declara el plan no ejecutable');

  const archivosAntesMiss = walkFiles(KNOWLEDGE_ROOT);
  const itemsAntesMiss = db.prepare('SELECT id, project_id, content_path FROM knowledge_items ORDER BY id').all();
  const repairMiss = executeKnowledgeScopeRepair();
  assertEq(repairMiss.ok, false, 'fail-closed GLOBAL: un source ausente aborta toda la reparación');
  assert(repairMiss.errors.some(e => e.code === KNOWLEDGE_ERRORS.SOURCE_MISSING),
    'el código es KNOWLEDGE_SOURCE_MISSING');
  assertEq(walkFiles(KNOWLEDGE_ROOT), archivosAntesMiss, 'cero archivos nuevos');
  assertEq(db.prepare('SELECT id, project_id, content_path FROM knowledge_items ORDER BY id').all(),
    itemsAntesMiss, 'cero cambios SQLite, ni siquiera en el chat sano');
  assert(!dbApi.getKnowledgeItem(missDoc.id).content_path.includes(techy.id),
    'no se inventa una ruta para el documento sin archivo');

  // Retirar el documento roto devuelve el sistema a un estado reparable.
  dbApi.deleteKnowledge(missDoc.id);
  assertEq(executeKnowledgeScopeRepair().ok, true, 'retirado el documento roto, la reparación procede');
  assert(dbApi.getKnowledgeItem(okDoc.id).content_path.includes(techy.id),
    'el chat sano se repara en la pasada siguiente');

  // ============================================
  console.log('\n=== Fallo del último archivo: cero DB y cero copias restantes ===');
  // ============================================
  const failChats = ['F1', 'F2', 'F3'].map(title => {
    const chat = dbApi.createChat({ projectId: QUICK_CHAT_ID, title });
    const doc = dbApi.addKnowledgeFromText({
      projectId: QUICK_CHAT_ID, chatId: chat.id, title: `Doc ${title}`, content: `contenido ${title}`
    });
    indexDoc(doc.id, 2);
    legacyMoveChat(chat.id, techy.id);
    return { chat: chat.id, doc: doc.id, source: dbApi.getKnowledgeItem(doc.id).content_path };
  });

  // El último destino se ocupa con un directorio: la copia fallará ahí.
  const ultimo = failChats[failChats.length - 1];
  const ultimoDest = path.join(KNOWLEDGE_ROOT, techy.id, ultimo.chat,
    `${ultimo.doc}-${path.basename(ultimo.source).slice(ultimo.doc.length + 1)}`);
  fs.mkdirSync(ultimoDest, { recursive: true });

  const itemsAntesFail = db.prepare('SELECT id, project_id, content_path FROM knowledge_items ORDER BY id').all();
  const repairFail = executeKnowledgeScopeRepair();
  assertEq(repairFail.ok, false, 'la reparación falla');
  assertEq(db.prepare('SELECT id, project_id, content_path FROM knowledge_items ORDER BY id').all(),
    itemsAntesFail, 'cero cambios SQLite tras el fallo de copia');
  for (const f of failChats) {
    assert(fs.existsSync(f.source), `el origen de ${f.doc.slice(0, 8)} sigue existiendo`);
    const dest = path.join(KNOWLEDGE_ROOT, techy.id, f.chat,
      `${f.doc}-${path.basename(f.source).slice(f.doc.length + 1)}`);
    if (dest !== ultimoDest) {
      assert(!fs.existsSync(dest), 'las copias creadas por esta ejecución se eliminaron en el rollback');
    }
  }
  assert(fs.existsSync(ultimoDest) && fs.statSync(ultimoDest).isDirectory(),
    'el obstáculo preexistente no se borró durante el rollback');

  fs.rmdirSync(ultimoDest);
  assertEq(executeKnowledgeScopeRepair().ok, true, 'retirado el obstáculo, la reparación procede');

  // ============================================
  console.log('\n=== Huérfanos: se reportan, no se reparan en silencio ===');
  // ============================================
  const huerfano = dbApi.addKnowledgeFromText({
    projectId: techy.id, chatId: techyChat.id, title: 'Huérfano', content: 'x'
  });
  indexDoc(huerfano.id, 2);
  db.prepare('UPDATE knowledge_items SET chat_id = ? WHERE id = ?')
    .run('99999999-9999-4999-8999-999999999999', huerfano.id);
  db.prepare('UPDATE knowledge_chunks SET chat_id = ? WHERE knowledge_item_id = ?')
    .run('99999999-9999-4999-8999-999999999999', huerfano.id);

  const inspectOrphan = inspectKnowledgeScopeRepair();
  assertEq(inspectOrphan.orphanItems, 1, 'reporta 1 item huérfano');
  assertEq(inspectOrphan.orphanChunks, 2, 'reporta 2 chunks huérfanos');
  assertEq(inspectOrphan.chatsAffected, 0, 'no intenta reparar referencias a chats inexistentes');
  assertEq(db.prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE id = ?').get(huerfano.id).n, 1,
    'no borra el documento huérfano');
  assert(!titlesOf(scopeFor(techy.id, techyChat.id)).includes('Huérfano'),
    'un documento huérfano no se inyecta en ningún chat');

  // ============================================
  console.log('\n=== Compensación de addKnowledgeFromText ===');
  // ============================================
  // El archivo se crea antes del INSERT. Se provoca un fallo REAL del INSERT con
  // un trigger de SQLite — nada de ganchos de inyección en producción.
  const compChat = dbApi.createChat({ projectId: techy.id, title: 'Compensación' });

  // Archivo preexistente que la compensación nunca debe tocar.
  const guardaDir = path.join(KNOWLEDGE_ROOT, techy.id, compChat.id);
  fs.mkdirSync(guardaDir, { recursive: true });
  const guardaPath = path.join(guardaDir, 'no-me-toques.md');
  fs.writeFileSync(guardaPath, 'archivo ajeno preexistente', 'utf8');

  const itemsAntesComp = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get().n;
  const archivosAntesComp = walkFiles(KNOWLEDGE_ROOT);

  db.exec(`CREATE TRIGGER bloquea_insert BEFORE INSERT ON knowledge_items
           BEGIN SELECT RAISE(ABORT, 'INSERT bloqueado'); END`);
  const fallo = dbApi.addKnowledgeFromText({
    projectId: techy.id, chatId: compChat.id, title: 'Compensado', content: 'contenido a compensar'
  });
  db.exec('DROP TRIGGER bloquea_insert');

  assertEq(fallo.ok, false, 'un INSERT fallido devuelve error');
  assertEq(fallo.error, 'KNOWLEDGE_DB_WRITE_FAILED',
    'el código es KNOWLEDGE_DB_WRITE_FAILED cuando la compensación funciona');
  assertEq(db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get().n, itemsAntesComp,
    'cero filas nuevas');
  assertEq(walkFiles(KNOWLEDGE_ROOT), archivosAntesComp,
    'cero archivos nuevos: la compensación borró el que había creado');
  assert(fs.existsSync(guardaPath), 'el archivo preexistente sigue ahí');
  assertEq(fs.readFileSync(guardaPath, 'utf8'), 'archivo ajeno preexistente',
    'y con su contenido intacto');
  assert(!JSON.stringify(fallo).includes(TEST_DIR), 'el error no filtra rutas');

  // Cleanup fallido: se distingue con un código propio. El fallo de `unlinkSync`
  // se simula desde el TEST parcheando el módulo `fs` — db.js comparte esa misma
  // instancia. No hay ningún gancho en producción.
  const unlinkOriginal = fs.unlinkSync;
  db.exec(`CREATE TRIGGER bloquea_insert BEFORE INSERT ON knowledge_items
           BEGIN SELECT RAISE(ABORT, 'INSERT bloqueado'); END`);
  fs.unlinkSync = () => { throw new Error('EPERM simulado'); };
  let falloSucio;
  try {
    falloSucio = dbApi.addKnowledgeFromText({
      projectId: techy.id, chatId: compChat.id, title: 'Residuo', content: 'queda en disco'
    });
  } finally {
    fs.unlinkSync = unlinkOriginal;
    db.exec('DROP TRIGGER bloquea_insert');
  }

  assertEq(falloSucio.error, 'KNOWLEDGE_DB_WRITE_FAILED_CLEANUP_INCOMPLETE',
    'si el borrado falla se devuelve un código distinto, no el limpio');
  assertEq(db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get().n, itemsAntesComp,
    'sigue sin haber filas nuevas');
  const residuos = walkFiles(KNOWLEDGE_ROOT).filter(f => !archivosAntesComp.includes(f));
  assertEq(residuos.length, 1, 'queda exactamente el archivo huérfano declarado');
  assert(fs.existsSync(guardaPath), 'el preexistente sigue sin tocarse tras el fallo de limpieza');
  fs.unlinkSync(residuos[0]);

  // Un archivo preexistente en la ruta destino aborta ANTES del INSERT: la
  // compensación nunca puede alcanzar un archivo que no creó esta llamada.
  const dbSourceForWx = fs.readFileSync(path.join(__dirname, '../src/main/db.js'), 'utf8');
  assert(dbSourceForWx.includes(`flag: "wx"`),
    'la escritura usa el flag wx, así que un archivo preexistente aborta antes del INSERT');

  // ============================================
  console.log('\n=== Resolución de rutas: userData seleccionado y rebase ===');
  // ============================================
  const sinRebase = createSourceResolver();
  const dentro = path.join(KNOWLEDGE_ROOT, techy.id, 'doc.md');
  assertEq(sinRebase(dentro), { ok: true, physical: dentro },
    'sin rebase una ruta dentro del userData se acepta tal cual');
  assertEq(sinRebase(path.join(TEST_DIR, 'fuera.md')).error,
    'KNOWLEDGE_SOURCE_OUTSIDE_SELECTED_USER_DATA',
    'una ruta fuera de knowledge/ del userData seleccionado falla cerrada');
  assertEq(sinRebase('C:\\Users\\otro\\AppData\\Roaming\\mika5-desktop\\knowledge\\a.md').error,
    'KNOWLEDGE_SOURCE_OUTSIDE_SELECTED_USER_DATA',
    'una ruta de otra instalación falla cerrada');

  // `content_path` se guarda canonizado: resolvedTargetDir() resuelve junctions
  // y symlinks antes de escribir. Si el resolver comparase contra una raiz solo
  // normalizada lexicamente, ese mismo archivo se leeria como externo y la
  // reparacion no encontraria ni un origen valido. Paso en CI de Windows, donde
  // el perfil del runner tiene nombre corto 8.3 y ambas formas difieren.
  const tipoEnlace = process.platform === 'win32' ? 'junction' : 'dir';
  const enlaceDir = path.join(TEST_DIR, 'enlace-a-knowledge');
  let canonizacionProbada = false;
  try {
    fs.symlinkSync(path.join(KNOWLEDGE_ROOT, techy.id), enlaceDir, tipoEnlace);
    canonizacionProbada = true;
  } catch (_) { /* sin privilegios para enlaces */ }

  if (canonizacionProbada) {
    const real = fs.realpathSync.native(enlaceDir);
    assert(path.resolve(real) !== path.resolve(enlaceDir),
      'el enlace y su destino real son rutas distintas');
    assert(sinRebase(path.join(enlaceDir, 'doc.md')).ok,
      'una ruta que solo cae dentro tras canonizar se acepta');
    assert(sinRebase(path.join(real, 'doc.md')).ok,
      'y su forma ya canonizada tambien');
    fs.unlinkSync(enlaceDir);
  } else {
    console.log('  - omitido: este entorno no permite crear enlaces de directorio');
  }

  // La contencion no se debilita: un enlace que apunta FUERA de la raiz sigue
  // rechazado aunque exista fisicamente.
  const destinoFuera = path.join(TEST_DIR, 'destino-externo');
  const enlaceFuera = path.join(TEST_DIR, 'enlace-externo');
  fs.mkdirSync(destinoFuera, { recursive: true });
  try {
    fs.symlinkSync(destinoFuera, enlaceFuera, tipoEnlace);
    assertEq(sinRebase(path.join(enlaceFuera, 'doc.md')).error,
      'KNOWLEDGE_SOURCE_OUTSIDE_SELECTED_USER_DATA',
      'un enlace que apunta fuera de la raiz sigue fallando cerrado');
    fs.unlinkSync(enlaceFuera);
  } catch (_) { /* mismo caso */ }


  const ORIGEN_FICTICIO = path.join(TEST_DIR, 'origen-que-no-existe');
  const conRebase = createSourceResolver({ rebaseFromUserData: ORIGEN_FICTICIO });
  const almacenada = path.join(ORIGEN_FICTICIO, 'knowledge', 'proj-x', 'chat-y', 'doc.md');
  assertEq(conRebase(almacenada),
    { ok: true, physical: path.join(KNOWLEDGE_ROOT, 'proj-x', 'chat-y', 'doc.md') },
    'con rebase la ruta se mapea a la copia, conservando la parte relativa');
  assert(!fs.existsSync(ORIGEN_FICTICIO),
    'el mapeo no accede físicamente al origen: ni siquiera existe');
  assertEq(conRebase(path.join(TEST_DIR, 'otro', 'knowledge', 'doc.md')).error,
    'KNOWLEDGE_SOURCE_OUTSIDE_SELECTED_USER_DATA',
    'una ruta que no cuelga del origen declarado se rechaza');
  assertEq(conRebase(path.join(ORIGEN_FICTICIO, 'knowledge', '..', '..', 'escape.md')).error,
    'KNOWLEDGE_SOURCE_OUTSIDE_SELECTED_USER_DATA',
    'un escape con .. se rechaza tras normalizar');
  assertEq(conRebase('').error, 'KNOWLEDGE_SOURCE_MISSING',
    'una ruta vacía se reporta como source ausente, no como escape');

  // El resolver aplicado de punta a punta: base con rutas del origen, archivos
  // sólo en la copia.
  const rebChat = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Rebase' });
  const rebDoc = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: rebChat.id, title: 'Rebasable', content: 'contenido rebasado'
  });
  indexDoc(rebDoc.id, 2);
  legacyMoveChat(rebChat.id, gpu.id);

  // Se reescribe SOLO la fila para simular una base copiada de otra instalación.
  const rutaLocal = dbApi.getKnowledgeItem(rebDoc.id).content_path;
  const rutaComoOrigen = path.join(ORIGEN_FICTICIO, path.relative(TEST_DIR, rutaLocal));
  db.prepare('UPDATE knowledge_items SET content_path = ? WHERE id = ?')
    .run(rutaComoOrigen, rebDoc.id);

  const sinMapeo = inspectKnowledgeScopeRepair();
  assert(sinMapeo.errors.some(e => e.code === 'KNOWLEDGE_SOURCE_OUTSIDE_SELECTED_USER_DATA'),
    'sin rebase, una ruta del origen falla cerrada');

  const conMapeo = inspectKnowledgeScopeRepair({ rebaseFromUserData: ORIGEN_FICTICIO });
  assertEq(conMapeo.sourcesValid, 1, 'con rebase el source se resuelve dentro de la copia');
  assertEq(conMapeo.errors, [], 'y no quedan errores');

  const repairRebase = executeKnowledgeScopeRepair({ rebaseFromUserData: ORIGEN_FICTICIO });
  assertEq(repairRebase.ok, true, 'la reparación con rebase completa');
  assertEq(repairRebase.filesCopied, 1, 'copia el archivo desde la copia local');
  assertEq(repairRebase.cleanupFailures, 0, 'y limpia el origen local sin fallos');
  const rebFinal = dbApi.getKnowledgeItem(rebDoc.id).content_path;
  assert(rebFinal.startsWith(KNOWLEDGE_ROOT),
    'el content_path resultante queda dentro del userData seleccionado');
  assert(!rebFinal.includes('origen-que-no-existe'),
    'el content_path resultante ya no menciona el origen');
  assert(!fs.existsSync(rutaLocal), 'el archivo local de origen se limpió');
  assert(!fs.existsSync(ORIGEN_FICTICIO), 'el origen declarado nunca se creó ni se tocó');

  // ============================================
  console.log('\n=== La limpieza sólo borra dentro del userData activo ===');
  // ============================================
  // Se registran TODOS los borrados de una reparación con rebase: ninguno puede
  // caer fuera del knowledge/ del userData seleccionado.
  const rebChat2 = dbApi.createChat({ projectId: QUICK_CHAT_ID, title: 'Rebase 2' });
  const rebDoc2 = dbApi.addKnowledgeFromText({
    projectId: QUICK_CHAT_ID, chatId: rebChat2.id, title: 'Rebasable 2', content: 'contenido 2'
  });
  indexDoc(rebDoc2.id, 2);
  legacyMoveChat(rebChat2.id, gpu.id);
  const rutaLocal2 = dbApi.getKnowledgeItem(rebDoc2.id).content_path;
  db.prepare('UPDATE knowledge_items SET content_path = ? WHERE id = ?')
    .run(path.join(ORIGEN_FICTICIO, path.relative(TEST_DIR, rutaLocal2)), rebDoc2.id);

  const borrados = [];
  const unlinkReal = fs.unlinkSync;
  fs.unlinkSync = (p) => { borrados.push(String(p)); return unlinkReal(p); };
  let repairVigilada;
  try {
    repairVigilada = executeKnowledgeScopeRepair({ rebaseFromUserData: ORIGEN_FICTICIO });
  } finally {
    fs.unlinkSync = unlinkReal;
  }
  assertEq(repairVigilada.ok, true, 'la reparación con rebase completa');
  assert(borrados.length > 0, 'hubo al menos un borrado de origen');
  assertEq(borrados.filter(p => !path.resolve(p).startsWith(KNOWLEDGE_ROOT)).length, 0,
    'ningún borrado cae fuera del knowledge/ del userData seleccionado');
  assertEq(borrados.filter(p => p.includes('origen-que-no-existe')).length, 0,
    'ninguna ruta del origen declarado llegó nunca a unlink');

  // Un archivo fuera de knowledge/ no participa en ninguna operación: el
  // resolver lo rechaza antes, y la guarda de `cleanupSources` es la segunda
  // barrera para que jamás llegue a unlink.
  const guardaFuera = path.join(TEST_DIR, 'fuera-de-knowledge.md');
  fs.writeFileSync(guardaFuera, 'no me toques', 'utf8');
  assertEq(createSourceResolver()(guardaFuera).error,
    'KNOWLEDGE_SOURCE_OUTSIDE_SELECTED_USER_DATA',
    'un archivo fuera de knowledge/ ni siquiera se resuelve como source');
  assertEq(borrados.filter(p => path.resolve(p) === path.resolve(guardaFuera)).length, 0,
    'y nunca aparece entre los borrados');
  assert(fs.existsSync(guardaFuera), 'sigue en disco intacto');
  fs.unlinkSync(guardaFuera);

  // ============================================
  console.log('\n=== Caché: los tres alcances no comparten entrada ===');
  // ============================================
  const { ragApi, scopeKey, invalidateKnowledgeCache } = require('../src/main/rag');

  assert(new Set([
    scopeKey(techy.id, techyChat.id, true),
    scopeKey(techy.id, techyChat.id, false),
    scopeKey(techy.id, null, true)
  ]).size === 3, 'project+chat, chat-only y project-only generan tres claves distintas');

  const stubClient = { embed: async ({ input }) => ({ embeddings: input.map(() => [1, 0, 0]) }) };
  invalidateKnowledgeCache({ projectId: techy.id });

  const conProyecto = await ragApi.query(techy.id, 'consulta', 10, {
    chatId: techyChat.id, includeProjectScope: true, embeddingClient: stubClient
  });
  const soloChat = await ragApi.query(techy.id, 'consulta', 10, {
    chatId: techyChat.id, includeProjectScope: false, embeddingClient: stubClient
  });
  const soloProyecto = await ragApi.query(techy.id, 'consulta', 10, {
    chatId: null, includeProjectScope: true, embeddingClient: stubClient
  });

  const t1 = titlesOf(conProyecto.chunks);
  const t2 = titlesOf(soloChat.chunks);
  const t3 = titlesOf(soloProyecto.chunks);
  assert(t1.includes('Doc de proyecto TechyBot') && t1.includes('Informe'),
    'project+chat devuelve ambos alcances');
  assert(!t2.includes('Doc de proyecto TechyBot'),
    'chat-only NO recibe el documento de proyecto desde la caché de project+chat');
  assert(!t3.includes('Informe'),
    'project-only NO recibe el documento del chat desde la caché de project+chat');

  const scopeErr = await ragApi.query(gpu.id, 'consulta', 3, {
    chatId: techyChat.id, embeddingClient: stubClient
  });
  assertEq(scopeErr.error, 'INVALID_CHAT_PROJECT_SCOPE', 'ragApi.query falla cerrado con alcance inválido');
  assertEq(scopeErr.chunks, [], 'y no devuelve fragmentos');

} catch (e) {
  console.error('\nFATAL:', e.message);
  console.error(e.stack);
  failed++;
} finally {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
  try { fs.unlinkSync(mockElectronPath); } catch (_) {}

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}`);
  process.exit(failed > 0 ? 1 : 0);
}
})();
