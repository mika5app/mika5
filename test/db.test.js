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
