// test/db.test.js — Unit tests for db.js
// Run: npx electron test/db.test.js
// Note: better-sqlite3 is compiled for Electron, not Node.js.
//       Use `npx electron` or `npm run test:db` to run this test.

const path = require('path');
const fs = require('fs');
const os = require('os');

// --- Mock Electron's app.getPath ---
const TEST_DIR = path.join(os.tmpdir(), `mika5-test-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

// Monkey-patch require to intercept electron
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  if (request === 'electron') {
    return require.resolve('./mock-electron');
  }
  return originalResolve.call(this, request, parent, ...args);
};

// Create mock electron module
const mockElectronPath = path.join(__dirname, 'mock-electron.js');
fs.writeFileSync(mockElectronPath, `
  module.exports = {
    app: { getPath: (key) => '${TEST_DIR.replace(/\\/g, '\\\\')}' },
    safeStorage: { isEncryptionAvailable: () => false }
  };
`);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

try {
  const { initDb, dbApi } = require('../src/main/db');

  // ============================================
  console.log('\n=== DB Initialization ===');
  // ============================================
  initDb();
  assert(true, 'initDb() runs without error');

  // ============================================
  console.log('\n=== Projects ===');
  // ============================================
  const p1 = dbApi.createProject({ name: 'Test Project', description: 'desc' });
  assert(p1.ok, 'createProject returns ok');
  assert(p1.id, 'createProject returns id');

  const projects = dbApi.listProjects();
  assert(projects.length >= 1, 'listProjects returns at least 1');
  assert(projects.find(p => p.id === p1.id), 'created project appears in list');

  const badProject = dbApi.createProject({ name: '' });
  assertEq(badProject.ok, false, 'createProject rejects empty name');
  assertEq(badProject.error, 'INVALID_NAME', 'error code is INVALID_NAME');

  // ============================================
  console.log('\n=== Project Context ===');
  // ============================================
  dbApi.setProjectContext(p1.id, 'You are a helpful assistant');
  const ctx = dbApi.getProjectContext(p1.id);
  assertEq(ctx, 'You are a helpful assistant', 'getProjectContext returns saved prompt');

  // ============================================
  console.log('\n=== Chats ===');
  // ============================================
  const c1 = dbApi.createChat({ projectId: p1.id, title: 'Chat 1' });
  assert(c1.ok, 'createChat returns ok');

  const chats = dbApi.listChats(p1.id);
  assert(chats.length === 1, 'listChats returns 1 chat');
  assertEq(chats[0].title, 'Chat 1', 'chat title matches');

  // ============================================
  console.log('\n=== Chat Context (per-chat) ===');
  // ============================================
  dbApi.setChatContext(c1.id, 'Per-chat prompt');
  const chatCtx = dbApi.getChatContext(c1.id);
  assertEq(chatCtx, 'Per-chat prompt', 'getChatContext returns per-chat prompt');

  // ============================================
  console.log('\n=== Messages ===');
  // ============================================
  const m1 = dbApi.addMessage({ chatId: c1.id, role: 'user', content: 'Hello', model: 'llama3.2' });
  assert(m1.ok, 'addMessage user returns ok');

  const m2 = dbApi.addMessage({ chatId: c1.id, role: 'assistant', content: 'Hi!', model: 'llama3.2' });
  assert(m2.ok, 'addMessage assistant returns ok');

  const msgs = dbApi.listMessages(c1.id);
  assertEq(msgs.length, 2, 'listMessages returns 2 messages');
  assertEq(msgs[0].role, 'user', 'first message is user');
  assertEq(msgs[0].model, 'llama3.2', 'message has model field');

  const empty = dbApi.addMessage({ chatId: c1.id, role: 'user', content: '' });
  assertEq(empty.ok, false, 'addMessage rejects empty content');

  // ============================================
  console.log('\n=== Adjuntos visuales del mensaje ===');
  // ============================================
  // Antes solo se guardaba texto: la imagen adjunta llegaba al proveedor pero
  // desaparecía de la burbuja al recargar el chat.
  const cAttach = dbApi.createChat({ projectId: p1.id, title: 'Adjuntos' });
  const withImage = dbApi.addMessage({
    chatId: cAttach.id,
    role: 'user',
    content: 'rediseña el logo por uno más moderno',
    model: 'qwen3.7-plus',
    attachments: [
      { name: 'logo.png', mediaType: 'image/png', base64: 'aW1hZ2U=', visualEntryId: 've-1' },
      { name: 'Imagen generada', url: 'https://example.test/gen.png' }
    ]
  });
  assert(withImage.ok, 'addMessage acepta adjuntos');
  const storedRow = dbApi.getMessage(withImage.id);
  const storedAttachments = JSON.parse(storedRow.attachments);
  assertEq(storedAttachments.length, 2, 'los dos adjuntos persisten');
  assertEq(storedAttachments[0].base64, 'aW1hZ2U=', 'el base64 sobrevive');
  assertEq(storedAttachments[0].visualEntryId, 've-1', 'el visualEntryId sobrevive');
  assertEq(storedAttachments[1].url, 'https://example.test/gen.png', 'la url https sobrevive');
  assert(!('base64' in storedAttachments[1]), 'una imagen con url no duplica bytes');

  // Los mensajes sin adjuntos siguen guardando NULL, no "[]".
  assertEq(dbApi.getMessage(m1.id).attachments, null, 'mensaje sin adjuntos guarda NULL');
  const emptyAttachments = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'solo texto', attachments: []
  });
  assertEq(dbApi.getMessage(emptyAttachments.id).attachments, null, 'array vacío guarda NULL');

  // ATÓMICO: un adjunto inválido aborta el mensaje entero. Guardar el texto y
  // perder la imagen devolviendo ok reabría la omisión visual tras recargar.
  for (const [etiqueta, adjunto] of [
    ['GIF', { name: 'x.gif', mediaType: 'image/gif', base64: 'aW1hZ2U=' }],
    ['http', { name: 'inseguro', url: 'http://example.test/a.png' }],
    ['vacío', { name: 'vacio', mediaType: 'image/png', base64: '' }],
    ['base64 inválido', { name: 'no-base64', mediaType: 'image/png', base64: '<script>' }],
    ['no-objeto', 'no es un objeto']
  ]) {
    const res = dbApi.addMessage({
      chatId: cAttach.id, role: 'user', content: 'texto válido', attachments: [adjunto]
    });
    assertEq(res.ok, false, `${etiqueta}: aborta el mensaje, no se guarda a medias`);
    assertEq(res.error, 'ATTACHMENT_INVALID', `${etiqueta}: error explícito`);
  }
  // El texto tampoco se guarda: la fila no llega a escribirse.
  assertEq(dbApi.listMessages(cAttach.id).some(r => r.content === 'texto válido'), false,
    'ningún texto huérfano quedó escrito');

  // listMessages devuelve la columna para repintar al abrir el chat.
  const listed = dbApi.listMessages(cAttach.id).find(row => row.id === withImage.id);
  assert(listed && typeof listed.attachments === 'string', 'listMessages incluye attachments');

  // Un mensaje de SOLO imagen es legítimo: la interfaz permite enviarlo sin texto.
  const imageOnly = dbApi.addMessage({
    chatId: cAttach.id,
    role: 'user',
    content: '',
    attachments: [{ name: 'solo.png', mediaType: 'image/png', base64: 'aW1hZ2U=' }]
  });
  assert(imageOnly.ok, 'addMessage acepta imagen sin texto');
  assert(dbApi.getMessage(imageOnly.id).attachments, 'la imagen sin texto persiste');

  // Sin texto y sin adjunto válido sigue siendo inválido.
  assertEq(dbApi.addMessage({ chatId: cAttach.id, role: 'user', content: '   ' }).ok, false,
    'rechaza mensaje sin texto ni adjuntos');
  assertEq(dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: '',
    attachments: [{ name: 'x.gif', mediaType: 'image/gif', base64: 'aW1hZ2U=' }]
  }).ok, false, 'rechaza texto vacío con adjuntos todos inválidos');

  // ============================================
  console.log('\n=== Límite de tamaño de adjuntos (el main no confía en el renderer) ===');
  // ============================================
  // La interfaz limita a 5 MB, pero una llamada IPC directa no pasa por ella.
  const base64OfBytes = n => Buffer.alloc(n).toString('base64');
  const justUnder = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'justo debajo',
    attachments: [{ name: 'ok.png', mediaType: 'image/png', base64: base64OfBytes(5 * 1024 * 1024 - 16) }]
  });
  assert(dbApi.getMessage(justUnder.id).attachments, 'un adjunto justo bajo 5 MB se acepta');

  const justOver = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'justo encima',
    attachments: [{ name: 'big.png', mediaType: 'image/png', base64: base64OfBytes(5 * 1024 * 1024 + 16) }]
  });
  assertEq(justOver.ok, false, 'un adjunto sobre 5 MB aborta el mensaje');
  assertEq(justOver.error, 'ATTACHMENT_TOO_LARGE', 'con error explícito de tamaño');

  // Texto + imagen demasiado grande: NO se guarda el texto solo.
  assertEq(dbApi.listMessages(cAttach.id).some(r => r.content === 'justo encima'), false,
    'el texto no sobrevive a una imagen rechazada por tamaño');

  // Acumulado: cinco de 4,5 MB superan los 20 MB del mensaje → aborta, no recorta.
  const accumulated = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'acumulado',
    attachments: Array.from({ length: 5 }, (_, i) => ({
      name: `p${i}.png`, mediaType: 'image/png', base64: base64OfBytes(4.5 * 1024 * 1024)
    }))
  });
  assertEq(accumulated.ok, false, 'el acumulado excesivo aborta en vez de guardar un subconjunto');
  assertEq(accumulated.error, 'ATTACHMENTS_TOTAL_TOO_LARGE', 'error de total explícito');
  assertEq(dbApi.listMessages(cAttach.id).some(r => r.content === 'acumulado'), false,
    'no queda un mensaje con solo 4 de las 5 imágenes');

  // Cuatro de 4,5 MB (18 MB) sí caben: el límite no es sobre-restrictivo.
  const fourFit = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'cuatro caben',
    attachments: Array.from({ length: 4 }, (_, i) => ({
      name: `q${i}.png`, mediaType: 'image/png', base64: base64OfBytes(4.5 * 1024 * 1024)
    }))
  });
  assert(fourFit.ok, 'cuatro imágenes de 4,5 MB caben');
  assertEq(JSON.parse(dbApi.getMessage(fourFit.id).attachments).length, 4, 'las cuatro persisten');

  // Más adjuntos que el máximo por mensaje.
  const tooMany = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'demasiados',
    attachments: Array.from({ length: 9 }, (_, i) => ({
      name: `r${i}.png`, mediaType: 'image/png', base64: 'aW1hZ2U='
    }))
  });
  assertEq(tooMany.error, 'TOO_MANY_ATTACHMENTS', 'más de 8 adjuntos aborta');

  // base64 de longitud no múltiplo de 4 es inválido.
  const oddLength = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'longitud rara',
    attachments: [{ name: 'x.png', mediaType: 'image/png', base64: 'aW1hZ2' }]
  });
  assertEq(oddLength.error, 'ATTACHMENT_INVALID',
    'base64 con longitud no múltiplo de 4 aborta');

  // Una URL https no puede rodear el límite con longitud arbitraria.
  const hugeUrl = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'url enorme',
    attachments: [{ name: 'u.png', url: 'https://example.test/' + 'a'.repeat(5000) }]
  });
  assertEq(hugeUrl.error, 'ATTACHMENT_TOO_LARGE', 'una URL de más de 4096 chars aborta');

  const hugeMediaType = dbApi.addMessage({
    chatId: cAttach.id, role: 'user', content: 'mediatype enorme',
    attachments: [{ name: 'm.png', mediaType: 'image/' + 'x'.repeat(200), base64: 'aW1hZ2U=' }]
  });
  assertEq(hugeMediaType.error, 'ATTACHMENT_INVALID', 'un mediaType desmedido aborta');

  const count = dbApi.countMessages(c1.id);
  assertEq(count, 2, 'countMessages returns 2');

  // ============================================
  console.log('\n=== Messages with reply_to_id ===');
  // ============================================
  const m3 = dbApi.addMessage({ chatId: c1.id, role: 'user', content: 'Reply', replyToId: m2.id });
  assert(m3.ok, 'addMessage with replyToId ok');
  const fetched = dbApi.getMessage(m3.id);
  assertEq(fetched.reply_to_id, m2.id, 'reply_to_id persisted correctly');

  // ============================================
  console.log('\n=== Pagination ===');
  // ============================================
  const page = dbApi.listMessages(c1.id, { limit: 1, offset: 0 });
  assertEq(page.length, 1, 'pagination limit=1 returns 1');

  // ============================================
  console.log('\n=== App State ===');
  // ============================================
  const s1 = dbApi.setAppState('lastModel', 'qwen2.5');
  assert(s1.ok, 'setAppState accepts lastModel');
  assertEq(dbApi.getAppState('lastModel'), 'qwen2.5', 'getAppState returns saved value');

  const bad = dbApi.setAppState('hacker_key', 'evil');
  assertEq(bad.ok, false, 'setAppState rejects unknown key');
  assertEq(bad.error, 'INVALID_KEY', 'error is INVALID_KEY');

  // ============================================
  console.log('\n=== Knowledge ===');
  // ============================================
  const k1 = dbApi.addKnowledgeFromText({ projectId: p1.id, title: 'Doc 1', content: 'Hello world', mimeType: 'text/markdown' });
  assert(k1.ok, 'addKnowledgeFromText returns ok');

  const kList = dbApi.listKnowledge(p1.id);
  assertEq(kList.length, 1, 'listKnowledge returns 1 item');

  // Per-chat knowledge
  const k2 = dbApi.addKnowledgeFromText({ projectId: p1.id, title: 'Chat Doc', content: 'Chat context', chatId: c1.id });
  assert(k2.ok, 'addKnowledgeFromText with chatId ok');

  const chatKnowledge = dbApi.listKnowledge(p1.id, c1.id);
  assertEq(chatKnowledge.length, 1, 'listKnowledge with chatId returns chat-specific item');
  assertEq(chatKnowledge[0].title, 'Chat Doc', 'chat knowledge title matches');

  // Project knowledge should NOT include chat-scoped items
  const projKnowledge = dbApi.listKnowledge(p1.id);
  assert(!projKnowledge.find(k => k.title === 'Chat Doc'), 'project knowledge excludes chat-scoped items');

  // ============================================
  console.log('\n=== Knowledge Index Status ===');
  // ============================================
  dbApi.setKnowledgeIndexStatus(k1.id, 'ready', { indexedAt: Date.now() });
  const status = dbApi.getKnowledgeIndexStatus(k1.id);
  assertEq(status.index_status, 'ready', 'index status is ready');

  // ============================================
  console.log('\n=== Cascade Deletion ===');
  // ============================================
  // Delete chat should clean up chat-scoped knowledge.
  // Ya no se consulta con listKnowledge(): un chat borrado es un alcance
  // inválido y la API falla cerrada en vez de devolver una lista vacía
  // indistinguible de "no había documentos".
  dbApi.deleteChat(c1.id);
  const { getDb } = require('../src/main/db');
  const chatKAfter = getDb()
    .prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE chat_id = ?').get(c1.id).n;
  assertEq(chatKAfter, 0, 'deleteChat cleans up chat-scoped knowledge');

  let deletedScopeError = null;
  try { dbApi.listKnowledge(p1.id, c1.id); } catch (e) { deletedScopeError = e.code; }
  assertEq(deletedScopeError, 'INVALID_CHAT',
    'consultar el alcance de un chat borrado falla cerrado');

  // Delete project should cascade
  dbApi.deleteProject(p1.id);
  const projAfter = dbApi.listProjects();
  assert(!projAfter.find(p => p.id === p1.id), 'deleteProject removes project');

  // ============================================
  console.log('\n=== Security: Path Traversal ===');
  // ============================================
  const evil = dbApi.addKnowledgeFromText({ projectId: '../../../etc', title: 'Evil', content: 'hack' });
  assertEq(evil.ok, false, 'rejects path traversal projectId');

} catch (e) {
  console.error('\nFATAL:', e.message);
  console.error(e.stack);
  failed++;
} finally {
  // Cleanup
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
  try { fs.unlinkSync(mockElectronPath); } catch (_) {}

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}`);
  process.exit(failed > 0 ? 1 : 0);
}
