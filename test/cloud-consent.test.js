'use strict';

const assert = require('assert');
const {
  CLOUD_CONSENT_SCHEMA_VERSION,
  buildCloudDataScope,
  buildCloudConsentKey,
  consentCoversScope,
  mergeConsentScope,
  summarizeCloudScope,
  normalizeStoredConsent,
  projectScope
} = require('../src/renderer/cloud-consent');
const {
  AIProviderManager,
  sanitizeForCloud
} = require('../src/main/ai-providers');

function createDb() {
  const values = new Map();
  return {
    prepare(sql) {
      if (sql.startsWith('SELECT key, value')) {
        return { all: (...keys) => keys.filter(key => values.has(key)).map(key => ({ key, value: values.get(key) })) };
      }
      if (sql.startsWith('INSERT OR REPLACE')) {
        return { run: (key, value) => values.set(key, value) };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

async function authorize({ providerId, projectId, scope, stored = null, choice = 'once' }) {
  const state = { modals: 0, providerCalls: 0, persisted: null, dbWrites: 0, cleared: false };
  if (providerId === 'local' || providerId === 'llamacpp' || providerId === 'bitnet') {
    state.providerCalls += 1;
    return state;
  }
  const effectiveScope = {
    ...scope,
    providerId,
    projectScope: projectScope(projectId)
  };
  if (!consentCoversScope(stored, effectiveScope)) {
    state.modals += 1;
    if (choice === 'cancel') return state;
    if (choice === 'persist') {
      state.persisted = mergeConsentScope(stored, effectiveScope, {
        providerId,
        projectScope: projectScope(projectId)
      });
    }
  }
  state.providerCalls += 1;
  state.dbWrites += 1;
  state.cleared = true;
  return state;
}

async function run() {
  assert.strictEqual(CLOUD_CONSENT_SCHEMA_VERSION, 1);
  const textScope = buildCloudDataScope({ message: true });
  const historyScope = buildCloudDataScope({ message: true, history: true, historyMessageCount: 2 });
  const expandedScope = buildCloudDataScope({
    message: true,
    history: true,
    historyMessageCount: 20,
    imageAttachments: true,
    imageNames: ['diagram.png'],
    ragContext: true,
    ragDocumentTitles: ['Architecture.md'],
    ragDocumentCount: 1
  });

  const local = await authorize({ providerId: 'local', projectId: 'a', scope: textScope });
  assert.strictEqual(local.modals, 0);
  assert.strictEqual(local.providerCalls, 1);

  const first = await authorize({ providerId: 'openai', projectId: 'a', scope: textScope });
  assert.strictEqual(first.modals, 1);
  assert.strictEqual(first.providerCalls, 1);
  assert.strictEqual(first.persisted, null, 'continue once must not persist');

  const allowed = await authorize({
    providerId: 'openai',
    projectId: 'a',
    scope: historyScope,
    choice: 'persist'
  });
  assert(allowed.persisted);
  assert.strictEqual(allowed.persisted.providerId, 'openai');
  assert.strictEqual(allowed.persisted.projectScope, 'project:a');
  assert.strictEqual(JSON.stringify(allowed.persisted).includes('historyMessageCount'), false);

  const repeated = await authorize({
    providerId: 'openai',
    projectId: 'a',
    scope: buildCloudDataScope({ message: true, history: true, historyMessageCount: 200 }),
    stored: allowed.persisted
  });
  assert.strictEqual(repeated.modals, 0, 'count changes inside an authorized category must not reprompt');

  assert.notStrictEqual(
    buildCloudConsentKey('openai', 'a'),
    buildCloudConsentKey('anthropic', 'a')
  );
  assert.notStrictEqual(
    buildCloudConsentKey('openai', 'a'),
    buildCloudConsentKey('openai', 'b')
  );
  assert.strictEqual(buildCloudConsentKey('openai', null), 'cloud-consent:v1:openai:global');

  const otherProvider = await authorize({
    providerId: 'anthropic',
    projectId: 'a',
    scope: historyScope,
    stored: allowed.persisted
  });
  assert.strictEqual(otherProvider.modals, 1);
  const otherProject = await authorize({
    providerId: 'openai',
    projectId: 'b',
    scope: historyScope,
    stored: null
  });
  assert.strictEqual(otherProject.modals, 1);

  assert.strictEqual(consentCoversScope(allowed.persisted, expandedScope), false);
  const expanded = await authorize({
    providerId: 'openai',
    projectId: 'a',
    scope: expandedScope,
    stored: allowed.persisted
  });
  assert.strictEqual(expanded.modals, 1);
  assert(summarizeCloudScope(expandedScope).some(item => item.category === 'imageAttachments'));
  assert(summarizeCloudScope(expandedScope).some(item => item.category === 'ragContext'));

  const canceled = await authorize({
    providerId: 'openai',
    projectId: 'a',
    scope: textScope,
    choice: 'cancel'
  });
  assert.strictEqual(canceled.providerCalls, 0);
  assert.strictEqual(canceled.dbWrites, 0);
  assert.strictEqual(canceled.cleared, false);

  const revoked = null;
  assert.strictEqual(consentCoversScope(revoked, textScope), false);
  assert.strictEqual(normalizeStoredConsent(JSON.stringify(allowed.persisted)).providerId, 'openai');
  assert.strictEqual(normalizeStoredConsent('invalid'), null);

  const manager = new AIProviderManager(createDb());
  manager.currentProvider = 'openai';
  manager.apiKeys.openai = 'test-key';
  assert.strictEqual(manager.sanitizeCloud, false);
  const exact = 'timestamp 1727654321 build 20260729 exit 3221225477 hash 12345678901234567890';
  let capturedBody = null;
  const previousFetch = global.fetch;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    };
  };
  try {
    await manager.chat({ model: 'test-model', messages: [{ role: 'user', content: exact }] });
  } finally {
    global.fetch = previousFetch;
  }
  assert.strictEqual(capturedBody.messages[0].content, exact);
  assert(!capturedBody.messages[0].content.includes('[PHONE]'));
  assert(!capturedBody.messages[0].content.includes('[ID]'));
  assert.notStrictEqual(sanitizeForCloud(exact), exact, 'compatibility helper remains available for future opt-in');

  const visualScope = buildCloudDataScope({
    message: true,
    imageAttachments: true,
    imageNames: ['source.png']
  });
  assert.strictEqual(visualScope.imageAttachments, true);
  assert.deepStrictEqual(visualScope.imageNames, ['source.png']);

  console.log('Cloud consent tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
