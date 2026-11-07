'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { sliceFunction } = require('./helpers/renderer-source');
const { resolveRequestPrivacy, assertRequestConsent } = require('../src/main/request-privacy');
const { buildCloudDataScope, mergeConsentScope } = require('../src/renderer/cloud-consent');
const { createTrustedIpc, RENDERER_URL } = require('../src/main/window-security');
const { fetchElectronImage, detectImageMimeFromBuffer } = require('../src/main/network-security');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function mainHandler(channel, context) {
  const begin = main.indexOf(`ipcMain.handle("${channel}"`);
  assert(begin >= 0);
  const end = main.indexOf('\n});', begin) + 4;
  let handler;
  vm.runInNewContext(main.slice(begin, end), { ...context, ipcMain: { handle(_name, fn) { handler = fn; } } });
  return handler;
}
function minimalPDF(stream = 'BT /F1 12 Tf 20 200 Td (Hi) Tj ET') {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}`;
  return Buffer.from(pdf + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
async function run() {
  const { PDFParse } = require('pdf-parse');
  let destroyed = 0;
  class Parser extends PDFParse { async destroy() { destroyed++; return super.destroy(); } }
  const pdf = mainHandler('file:extractPDF', { PDFParseClass: Parser, Buffer });
  const result = await pdf(null, minimalPDF().toString('base64'));
  assert.strictEqual(result.ok, true); assert(result.text.includes('Hi')); assert.strictEqual(result.pages, 1);
  assert.strictEqual(destroyed, 1);
  await pdf(null, Buffer.from('broken').toString('base64'));
  assert.strictEqual(destroyed, 2, 'parser cleanup after failed extraction');
  // A page with graphics but no text used to return only "-- 1 of 1 --".
  const scanned = await pdf(null, minimalPDF('0 0 0 rg 20 20 100 100 re f').toString('base64'));
  assert.strictEqual(scanned.ok, false);
  assert.strictEqual(scanned.error, 'PDF_NO_TEXT', 'image/graphics-only page reaches OCR');
  assert.strictEqual(destroyed, 3);

  assert.strictEqual((await resolveRequestPrivacy('local', 'alias', { show: async () => ({ remote_host: 'https://ollama.com' }) })).privacy, 'cloud');
  assert.strictEqual((await resolveRequestPrivacy('local', 'llama3', { show: async () => ({ model_info: {} }) })).privacy, 'private');
  assert.strictEqual((await resolveRequestPrivacy('local', 'model:cloud', { show: async () => ({}) })).privacy, 'cloud');
  await assert.rejects(resolveRequestPrivacy('local', 'bad', { show: async () => { throw new Error('offline'); } }), /offline/);
  const scope = buildCloudDataScope({ providerId: 'local', projectScope: 'global', message: true, ragContext: true });
  const params = { providerId: 'local', projectScope: 'global', model: 'alias', requestId: 'r1', dataScope: scope };
  assert.throws(() => assertRequestConsent(params, 'cloud'), /CONSENT/);
  params.cloudConsent = { ...mergeConsentScope(null, scope, scope), model: 'alias', requestId: 'r1' };
  assert.doesNotThrow(() => assertRequestConsent(params, 'cloud'), 'Ollama Cloud works with explicit consent');
  assert.throws(() => assertRequestConsent({ ...params, providerId: 'openai' }, 'cloud'), /CONSENT/);
  assert.throws(() => assertRequestConsent({ ...params, model: 'different' }, 'cloud'), /CONSENT/);
  assert.throws(() => assertRequestConsent({ ...params, images: [{}] }, 'cloud'), /CONSENT/);
  assert.doesNotThrow(() => assertRequestConsent({}, 'private'), 'local models do not request cloud consent');

  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const consentApi = require('../src/renderer/cloud-consent');
  let prompts = 0; let sent; let remote = true;
  const values = new Map();
  const ui = vm.createContext({ ...consentApi,
    cloudProjectScope: consentApi.projectScope,
    createRequestContext: require('../src/renderer/request-context').createRequestContext,
    Map, Set, console, currentProvider: 'local', activeChatId: 'c1', activeProjectId: 'p1',
    QUICK_CHAT_ID: 'quick-chat', approvedRemoteImages: new Set(),
    el: () => ({ value: 'alias' }), updatePrivacyUI() {}, showToast() {},
    cloudConsentProjectId: id => id, providerDisplayName: id => id,
    window: { mika5: {
      getAppState: async key => values.get(key),
      setAppState: async (key, value) => { values.set(key, value); return { ok: true }; },
      ai: { resolvePrivacy: async () => ({ privacy: remote ? 'cloud' : 'private' }),
        chat: async payload => { sent = payload; return { message: { content: 'ok' } }; } }
    } },
    requestCloudConsentChoice: async () => { prompts++; ui.currentProvider = 'openai'; return 'once'; }
  });
  const authStart = renderer.indexOf('const requestAuthorizations');
  const authEnd = renderer.indexOf('function buildEffectiveCloudScope', authStart);
  vm.runInContext(renderer.slice(authStart, authEnd) + sliceFunction(renderer, 'buildEffectiveCloudScope'), ui);
  const identity = { requestId: 'fixture-123', providerId: 'local', selectedModel: 'alias', projectId: 'p1', chatId: 'c1' };
  assert(await ui.ensureCloudConsent(identity, buildCloudDataScope({ message: true, ragContext: true })));
  await ui.sendAuthorizedAI('chat', { requestId: identity.requestId, model: 'alias', messages: [] });
  assert.strictEqual(prompts, 1, 'Ollama cloud asks for authorization');
  assert.strictEqual(sent.providerId, 'local', 'switching the UI while awaiting consent must not reroute');
  assert.strictEqual(sent.cloudConsent.categories.ragContext, true);
  assert.doesNotThrow(() => assertRequestConsent(sent, 'cloud'));
  remote = false;
  assert(await ui.ensureCloudConsent({ ...identity, requestId: 'fixture-124' }, buildCloudDataScope({ message: true })));
  assert.strictEqual(prompts, 1, 'genuinely local model adds no cloud prompt');

  const { AIProviderManager, registroDeProveedores } = require('../src/main/ai-providers');
  const adapter = registroDeProveedores.getAdapter('local'); const original = adapter.chat;
  adapter.chat = async () => ({ provider: 'local' });
  try {
    const manager = Object.assign(Object.create(AIProviderManager.prototype), { currentProvider: 'openai', apiKeys: {}, providerConfigs: {} });
    assert.strictEqual((await manager.chat({ providerId: 'local', model: 'fixture' })).provider, 'local');
  } finally { adapter.chat = original; }

  let guarded;
  const bridge = createTrustedIpc({ handle(_channel, fn) { guarded = fn; } });
  const mainFrame = { url: RENDERER_URL };
  const sender = { mainFrame, isDestroyed: () => false };
  bridge.trust(sender); bridge.handle('fixture', () => 'allowed');
  assert.strictEqual(guarded({ sender, senderFrame: mainFrame }), 'allowed');
  assert.throws(() => guarded({ sender, senderFrame: { url: RENDERER_URL } }), /UNTRUSTED/);
  assert.throws(() => guarded({ sender: { ...sender }, senderFrame: mainFrame }), /UNTRUSTED/);
  mainFrame.url = 'https://attacker.invalid';
  assert.throws(() => guarded({ sender, senderFrame: mainFrame }), /UNTRUSTED/);

  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let chunks = 0; let canceled = false;
  await assert.rejects(fetchElectronImage('https://image.invalid/a', { lookup, maxBytes: 32,
    fetchImpl: async (_url, options) => {
      assert.strictEqual(options.destination.addresses[0].address, '93.184.216.34');
      assert(!options.headers.Accept.includes('avif'));
      return { status: 200, headers: {}, body: new ReadableStream({
        pull(controller) { chunks++; controller.enqueue(Buffer.alloc(16)); },
        cancel() { canceled = true; }
      }, { highWaterMark: 0 }) };
    }
  }), error => error.code === 'DOWNLOAD_TOO_LARGE');
  assert.strictEqual(chunks, 3); assert(canceled);
  const before = Date.now();
  await assert.rejects(fetchElectronImage('https://image.invalid/a', { timeoutMs: 20, lookup: () => new Promise(() => {}) }), error => error.code === 'DOWNLOAD_TIMEOUT');
  assert(Date.now() - before < 1000);
  assert.strictEqual(detectImageMimeFromBuffer(Buffer.from('GIF89a')), 'image/gif');
  let bodyCanceled = false;
  await assert.rejects(fetchElectronImage('https://image.invalid/slow', { lookup, timeoutMs: 20,
    fetchImpl: async () => ({ status: 200, headers: {}, body: new ReadableStream({
      pull() { return new Promise(() => {}); }, cancel() { bodyCanceled = true; }
    }) })
  }), error => error.code === 'DOWNLOAD_TIMEOUT');
  assert(bodyCanceled, 'deadline cancels a stalled body, not just its result promise');
  let redirectCanceled = false;
  let fetchCount = 0;
  await assert.rejects(fetchElectronImage('https://image.invalid/redirect', { lookup,
    fetchImpl: async () => { fetchCount++; return { status: 302, headers: { location: 'https://127.0.0.1/internal' },
      body: new ReadableStream({ cancel() { redirectCanceled = true; } }) }; }
  }), error => error.code === 'DOWNLOAD_BLOCKED_DESTINATION');
  assert(redirectCanceled); assert.strictEqual(fetchCount, 1);

  // Exercise the production transport wiring without any real connections.
  const transportCalls = [];
  let proxyConnect; let tlsOptions; let lookupCount = 0;
  class Agent { destroy() {} }
  const networkModule = { exports: {} };
  const fakeHttps = { Agent, request(url, options, callback) {
    transportCalls.push(options);
    if (options.agent.createConnection) options.agent.createConnection({ servername: options.servername });
    const request = new EventEmitter(); request.destroy = () => {};
    request.end = () => {
      options.lookup(new URL(url).hostname, { all: true }, (error, addresses) => {
        assert.ifError(error); assert.strictEqual(addresses[0].address, '93.184.216.34');
      });
      const response = new (require('stream').PassThrough)();
      response.statusCode = 200; response.headers = {};
      callback(response); response.end(Buffer.from('GIF89a'));
    };
    return request;
  } };
  let failedProxy = ''; let proxyStatus = 200; const proxyHosts = [];
  const fakeHttp = { request(url, options) {
    proxyConnect = options;
    proxyHosts.push(url.hostname);
    const request = new EventEmitter(); request.end = () => {
      if (url.hostname === failedProxy) request.emit('error', Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }));
      else request.emit('connect', { statusCode: proxyStatus }, { destroy() {} }, Buffer.alloc(0));
    };
    return request;
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/network-security.js'), 'utf8'), {
    module: networkModule, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === 'https') return fakeHttps;
      if (name === 'http') return fakeHttp;
      if (name === 'tls') return { connect(options) { tlsOptions = options; return {}; } };
      return require(name);
    }
  });
  for (const proxy of ['DIRECT', 'PROXY proxy.invalid:8080']) {
    const image = await networkModule.exports.fetchElectronImage('https://images.invalid/photo', {
      lookup: async () => { lookupCount++; return lookup(); }, resolveProxy: async () => proxy
    });
    assert.strictEqual(image.mimeType, 'image/gif');
  }
  assert.strictEqual(lookupCount, 2, 'one destination lookup per request');
  assert.strictEqual(transportCalls[0].servername, 'images.invalid');
  assert.strictEqual(proxyConnect.method, 'CONNECT');
  assert.strictEqual(proxyConnect.path, '93.184.216.34:443');
  assert.strictEqual(tlsOptions.servername, 'images.invalid');

  failedProxy = 'offline.invalid';
  const fetchWithProxies = rules => networkModule.exports.fetchElectronImage('https://images.invalid/photo', {
    lookup, resolveProxy: async () => rules
  });
  assert.strictEqual((await fetchWithProxies('PROXY offline.invalid:8080; DIRECT')).mimeType, 'image/gif');
  assert.strictEqual((await fetchWithProxies('PROXY offline.invalid:8080; PROXY backup.invalid:8080')).mimeType, 'image/gif');
  assert.deepStrictEqual(proxyHosts.slice(-2), ['offline.invalid', 'backup.invalid']);
  assert.strictEqual(proxyConnect.path, '93.184.216.34:443', 'fallback proxy still receives the pinned IP');
  const requestsBefore = transportCalls.length;
  await assert.rejects(fetchWithProxies('PROXY offline.invalid:8080'), e => e.code === 'DOWNLOAD_PROXY_CONNECTION_FAILED');
  proxyStatus = 407;
  await assert.rejects(fetchWithProxies('PROXY auth.invalid:8080; DIRECT'), e => e.code === 'DOWNLOAD_PROXY_AUTH_REQUIRED');
  assert.strictEqual(transportCalls.length, requestsBefore, 'no invented direct route or authentication bypass');


  let child; let args;
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortController, console, setTimeout, clearTimeout,
    require(name) { if (name === 'http') return {}; if (name === 'child_process') return { spawn(_exe, argv) {
      args = argv; child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child;
    } }; throw new Error(name); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/ollama.js'), 'utf8'), context);
  const ollama = context.module.exports.ollamaApi;
  const pull = ollama.pull('hf.co/user/model:Q4_K_M');
  assert.strictEqual(args.join(' '), 'pull hf.co/user/model:Q4_K_M');
  child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  assert.strictEqual((await pull).error, 'OLLAMA_NOT_INSTALLED');
  for (const bad of ['--help', '../model', 'model;id', 'model\nother', 'model//bad']) assert.strictEqual((await ollama.pull(bad)).error, 'INVALID_MODEL');

  const { adaptadorOpenai } = require('../src/main/providers/openai');
  const savedFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: ['gpt-4o', 'o3', 'o4-mini', 'text-embedding-3-large', 'gpt-image-1', 'gpt-4o-realtime-preview'].map(id => ({ id })) }) });
  try { assert.deepStrictEqual((await adaptadorOpenai.listModels('synthetic')).models.map(m => m.name), ['gpt-4o', 'o3', 'o4-mini']); }
  finally { global.fetch = savedFetch; }

  const stateContext = {};
  vm.createContext(stateContext);
  vm.runInContext(sliceFunction(main, 'validateCloudBannerValue'), stateContext);
  const banner = { schemaVersion: 1, fingerprint: 'history+message', dismissedAt: new Date().toISOString() };
  assert.strictEqual(JSON.parse(stateContext.validateCloudBannerValue(JSON.stringify(banner))).fingerprint, banner.fingerprint);
  assert.throws(() => stateContext.validateCloudBannerValue('{"schemaVersion":1}'));
  console.log('Security regressions: PDF, provider binding, cloud/local consent, IPC, bounded downloads, Ollama names/errors, model catalogue, banner PASS');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
