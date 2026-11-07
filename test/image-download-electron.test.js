'use strict';

const assert = require('assert');
const path = require('path');
const { app } = require('electron');
const {
  fetchElectronImage,
  downloadAndSaveElectronImage
} = require('../src/main/network-security');

const MAX_BYTES = 50 * 1024 * 1024;
const PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
]);

function headers(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return { get: name => normalized[String(name).toLowerCase()] ?? null };
}

function response(status, body = PNG, values = {}) {
  return { status, headers: headers(values), body: new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(body)); controller.close(); }
  }) };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.strictEqual(error.code, code);
    assert(!String(error.message).includes('?'));
    return true;
  });
}

async function run() {
  await app.whenReady();
  const publicLookup = async hostname => {
    if (hostname === 'private.test') return [{ address: '127.0.0.1', family: 4 }];
    if (hostname === 'private10.test') return [{ address: '10.0.0.1', family: 4 }];
    return [{ address: '93.184.216.34', family: 4 }];
  };
  const common = {
    lookup: publicLookup,
    appVersion: 'test',
    timeoutMs: 30000,
    maxBytes: MAX_BYTES
  };

  let calls = [];
  let result = await fetchElectronImage('https://public.test/image.png', {
    ...common,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, PNG, { 'content-type': 'image/png' });
    }
  });
  assert.deepStrictEqual(result.buffer, PNG);
  assert.strictEqual(result.mimeType, 'image/png');
  assert.strictEqual(calls[0].options.redirect, 'manual');
  assert.strictEqual(calls[0].options.headers['Accept-Encoding'], 'identity');
  assert.strictEqual(calls[0].options.headers.Authorization, undefined);

  calls = [];
  result = await fetchElectronImage('https://public.test/start', {
    ...common,
    fetchImpl: async url => {
      calls.push(url);
      return url.endsWith('/start')
        ? response(302, Buffer.alloc(0), { location: '/image.png' })
        : response(200, PNG);
    }
  });
  assert.deepStrictEqual(result.buffer, PNG);
  assert.strictEqual(calls.length, 2);

  for (const target of ['https://private.test/image.png', 'https://private10.test/image.png']) {
    calls = [];
    await expectCode(fetchElectronImage('https://public.test/start', {
      ...common,
      fetchImpl: async url => {
        calls.push(url);
        return response(302, Buffer.alloc(0), { location: target });
      }
    }), 'DOWNLOAD_BLOCKED_DESTINATION');
    assert.strictEqual(calls.length, 1, 'private redirect must be blocked before second fetch');
  }

  calls = [];
  await expectCode(fetchElectronImage('https://public.test/0', {
    ...common,
    fetchImpl: async url => {
      calls.push(url);
      const index = Number(new URL(url).pathname.slice(1));
      return response(302, Buffer.alloc(0), { location: `/${index + 1}` });
    }
  }), 'DOWNLOAD_TOO_MANY_REDIRECTS');
  assert.strictEqual(calls.length, 6);

  await expectCode(fetchElectronImage('https://public.test/forbidden', {
    ...common,
    fetchImpl: async () => response(403)
  }), 'DOWNLOAD_HTTP_STATUS');

  let bodyRead = false;
  await expectCode(fetchElectronImage('https://public.test/large-header', {
    ...common,
    fetchImpl: async () => ({
      status: 200,
      headers: headers({ 'content-length': MAX_BYTES + 1 }),
      arrayBuffer: async () => {
        bodyRead = true;
        return PNG.buffer;
      }
    })
  }), 'DOWNLOAD_TOO_LARGE');
  assert.strictEqual(bodyRead, false, 'oversized Content-Length must reject before reading');

  const oversized = Buffer.alloc(MAX_BYTES + 1, 0x41);
  await expectCode(fetchElectronImage('https://public.test/large-body', {
    ...common,
    fetchImpl: async () => response(200, oversized)
  }), 'DOWNLOAD_TOO_LARGE');

  await expectCode(fetchElectronImage('https://public.test/fake.png', {
    ...common,
    fetchImpl: async () => response(200, Buffer.from('not a png'), { 'content-type': 'image/png' })
  }), 'DOWNLOAD_INVALID_IMAGE');

  const signedUrl = 'https://public.test/image.png?signature=SECRET_VALUE&token=PRIVATE_VALUE';
  const logged = [];
  const originalWarn = console.warn;
  console.warn = (...args) => logged.push(args.join(' '));
  try {
    result = await fetchElectronImage(signedUrl, {
      ...common,
      fetchImpl: async () => response(200, PNG)
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepStrictEqual(result.buffer, PNG);
  assert(!JSON.stringify(logged).includes('SECRET_VALUE'));
  assert(!JSON.stringify(logged).includes('PRIVATE_VALUE'));

  await expectCode(fetchElectronImage('https://public.test/timeout', {
    ...common,
    timeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })
  }), 'DOWNLOAD_TIMEOUT');

  let validated = false;
  let dialogCalledAfterValidation = false;
  let writeCalls = 0;
  const saveOptions = {
    ...common,
    fetchImpl: async () => {
      validated = true;
      return response(200, PNG);
    },
    suggestedName: 'signed-image.png',
    downloadsPath: '/downloads',
    joinPath: path.join,
    showSaveDialog: async () => {
      dialogCalledAfterValidation = validated;
      return { canceled: true };
    },
    writeFile: async () => { writeCalls += 1; }
  };
  result = await downloadAndSaveElectronImage(signedUrl, saveOptions);
  assert.strictEqual(dialogCalledAfterValidation, true);
  assert.strictEqual(result.canceled, true);
  assert.strictEqual(writeCalls, 0);

  let written = null;
  result = await downloadAndSaveElectronImage('https://public.test/save.png', {
    ...saveOptions,
    showSaveDialog: async () => ({ canceled: false, filePath: '/downloads/saved.png' }),
    writeFile: async (_filePath, buffer) => { written = Buffer.from(buffer); }
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(written, PNG);

  console.log('Electron image download tests passed');
}

run().then(
  () => app.quit(),
  error => {
    console.error(error);
    app.exit(1);
  }
);
