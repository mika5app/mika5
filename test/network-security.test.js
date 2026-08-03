'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  detectImageMimeFromBuffer,
  safeImageExtensionFromMime,
  isBlockedIp,
  resolvePublicDestination,
  downloadHttpsPinned
} = require('../src/main/network-security');

function mockRequest(responder, observations = []) {
  return (options, callback) => {
    observations.push(options);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => {
      if (error) request.emit('error', error);
    };
    request.end = () => {
      process.nextTick(() => {
        const spec = responder(options, observations.length);
        const response = new EventEmitter();
        response.statusCode = spec.status;
        response.headers = spec.headers || {};
        callback(response);
        for (const chunk of spec.chunks || []) response.emit('data', Buffer.from(chunk));
        response.emit('end');
      });
    };
    return request;
  };
}

async function run() {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1',
    '169.254.169.254', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'
  ]) {
    assert.strictEqual(isBlockedIp(address), true, `${address} must be blocked`);
  }
  assert.strictEqual(isBlockedIp('8.8.8.8'), false);

  await assert.rejects(
    resolvePublicDestination('https://private.example/image.png', async () => [
      { address: '10.0.0.1', family: 4 }
    ]),
    /Destino interno/
  );
  await assert.rejects(
    resolvePublicDestination('https://127.0.0.1/image.png'),
    /Destino interno/
  );

  const observations = [];
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1]);
  const allowed = await downloadHttpsPinned('https://public.example/image.png', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: mockRequest(() => ({
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
      chunks: [png]
    }), observations),
    maxBytes: 1024
  });
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(detectImageMimeFromBuffer(allowed.buffer), 'image/png');
  assert.strictEqual(safeImageExtensionFromMime('image/png'), 'png');
  assert.strictEqual(observations[0].servername, 'public.example');
  await new Promise((resolve, reject) => {
    observations[0].lookup('ignored', {}, (error, address, family) => {
      if (error) return reject(error);
      assert.strictEqual(address, '8.8.8.8');
      assert.strictEqual(family, 4);
      resolve();
    });
  });

  let redirectCalls = 0;
  await assert.rejects(
    downloadHttpsPinned('https://public.example/start', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestImpl: mockRequest(() => {
        redirectCalls += 1;
        return {
          status: 302,
          headers: { location: 'https://10.0.0.1/private.png' }
        };
      })
    }),
    /Destino interno/
  );
  assert.strictEqual(redirectCalls, 1);

  await assert.rejects(
    downloadHttpsPinned('https://public.example/loop', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestImpl: mockRequest(() => ({
        status: 302,
        headers: { location: 'https://public.example/loop' }
      })),
      maxRedirects: 5
    }),
    /Demasiadas redirecciones/
  );

  await assert.rejects(
    downloadHttpsPinned('https://public.example/large', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestImpl: mockRequest(() => ({
        status: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [Buffer.alloc(12)]
      })),
      maxBytes: 8
    }),
    /límite de 50 MB/
  );
  assert.strictEqual(detectImageMimeFromBuffer(Buffer.from('not-image')), null);
  assert.strictEqual(safeImageExtensionFromMime('text/html'), null);

  console.log('Network security tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
