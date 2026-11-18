'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const http = require('http');
const {
  PROVIDERS,
  ALIBABA_DEFAULT_CONFIG,
  createAbortContext,
  fetchWithProviderRetry
} = require('../src/main/ai-providers');
const { RequestRegistry } = require('../src/main/request-registry');

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function controlledFetch(state) {
  return (_url, options = {}) => {
    state.calls += 1;
    state.signal = options.signal;
    return new Promise((_resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  };
}

async function assertAdapterCancellation(providerId, params) {
  const state = { calls: 0, signal: null };
  const previousFetch = global.fetch;
  global.fetch = controlledFetch(state);
  try {
    const controller = new AbortController();
    const pending = PROVIDERS[providerId].chat({ ...params, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, error => (
      error.name === 'AbortError' && error.code === 'USER_CANCELED'
    ));
    assert(state.signal?.aborted, `${providerId} fetch must observe the aborted signal`);
    assert.strictEqual(state.calls, 1, `${providerId} must not retry explicit cancellation`);
  } finally {
    global.fetch = previousFetch;
  }
}

async function assertOllamaCancellation() {
  const previousRequest = http.request;
  let observedSignal = null;
  http.request = options => {
    observedSignal = options.signal;
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {};
    request.destroy = () => {};
    options.signal.addEventListener('abort', () => {
      const error = abortError();
      request.emit('error', error);
    }, { once: true });
    return request;
  };
  try {
    const controller = new AbortController();
    const pending = PROVIDERS.local.chat({
      model: 'local-test',
      messages: [{ role: 'user', content: 'test' }],
      signal: controller.signal
    });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, error => (
      error.name === 'AbortError' && error.code === 'USER_CANCELED'
    ));
    assert(observedSignal?.aborted, 'Ollama signal must reach the native HTTP request');
  } finally {
    http.request = previousRequest;
  }
}

async function run() {
  const messages = [{ role: 'user', content: 'test' }];
  await assertAdapterCancellation('openai', { model: 'gpt-test', messages, apiKey: 'test-key', sanitize: false });
  await assertAdapterCancellation('anthropic', { model: 'claude-test', messages, apiKey: 'test-key', sanitize: false });
  await assertAdapterCancellation('groq', { model: 'groq-test', messages, apiKey: 'test-key', sanitize: false });
  await assertAdapterCancellation('moonshot', { model: 'moonshot-test', messages, apiKey: 'test-key', sanitize: false });
  await assertAdapterCancellation('alibaba', {
    model: 'qwen3.7-max',
    messages,
    apiKey: 'test-key',
    sanitize: false,
    providerConfig: ALIBABA_DEFAULT_CONFIG
  });
  await assertAdapterCancellation('llamacpp', { model: 'local-test', messages });
  await assertAdapterCancellation('bitnet', { model: 'local-test', messages });
  await assertOllamaCancellation();

  const imageState = { calls: 0, signal: null };
  const previousImageFetch = global.fetch;
  global.fetch = controlledFetch(imageState);
  try {
    const controller = new AbortController();
    const pending = PROVIDERS.alibaba.generateImage({
      model: 'wan2.7-image',
      prompt: 'test image',
      sourceImages: [{ base64: 'aW1hZ2U=', mediaType: 'image/png' }],
      apiKey: 'test-key',
      providerConfig: ALIBABA_DEFAULT_CONFIG,
      signal: controller.signal
    });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, error => (
      error.name === 'AbortError' && error.code === 'USER_CANCELED'
    ));
    assert.strictEqual(imageState.calls, 1, 'image generation must not retry explicit cancellation');
    assert.strictEqual(imageState.signal?.aborted, true, 'image generation fetch must observe abort');
  } finally {
    global.fetch = previousImageFetch;
  }

  const retryState = { calls: 0, signal: null };
  const previousFetch = global.fetch;
  global.fetch = controlledFetch(retryState);
  try {
    const controller = new AbortController();
    const pending = fetchWithProviderRetry('https://example.test', {
      signal: controller.signal
    }, { attempts: 2, retryDelayMs: 0 });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.strictEqual(retryState.calls, 1, 'Alibaba retry helper must not retry AbortError');
  } finally {
    global.fetch = previousFetch;
  }

  const timeoutContext = createAbortContext(null, 5, 'Proveedor de prueba');
  await new Promise(resolve => setTimeout(resolve, 15));
  const timeoutError = timeoutContext.normalize(abortError());
  timeoutContext.cleanup();
  assert.strictEqual(timeoutError.code, 'PROVIDER_TIMEOUT');
  assert.match(timeoutError.message, /^Timeout:/);
  assert.notStrictEqual(timeoutError.code, 'USER_CANCELED');

  const registry = new RequestRegistry();
  const first = registry.start('request-a-0001');
  const second = registry.start('request-b-0002');
  assert.strictEqual(registry.abort('request-a-0001').aborted, true);
  assert.strictEqual(first.signal.aborted, true);
  assert.strictEqual(second.signal.aborted, false);
  registry.finish('request-a-0001');
  assert.strictEqual(registry.has('request-b-0002'), true);
  assert.strictEqual(registry.size, 1);
  assert.strictEqual(registry.abort('unknown-request').aborted, false);
  assert.strictEqual(second.signal.aborted, false);
  registry.finish('request-b-0002');
  assert.strictEqual(registry.size, 0);
  assert.throws(() => registry.start(''), /inválido/);
  registry.start('request-duplicate');
  assert.throws(() => registry.start('request-duplicate'), /duplicado/);
  registry.finish('request-duplicate');

  console.log('Provider cancellation tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
