'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MAIN_WEB_PREFERENCES } = require('../src/main/window-security');
const { app, BrowserWindow, session } = require('electron');

async function run() {
  await app.whenReady();
  const requests = [];
  const navigations = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/i.test(details.url)) {
      requests.push(details.url);
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  // Ventana equivalente a la principal: mismas garantias de aislamiento.
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      ...MAIN_WEB_PREFERENCES,
      offscreen: true
    }
  });

  requests.length = 0;
  navigations.length = 0;
  const indexSource = fs.readFileSync(
    path.join(__dirname, '../src/renderer/index.html'),
    'utf8'
  );
  const cspMatch = indexSource.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/
  );
  assert(cspMatch, 'index.html must declare its CSP');
  const cspFixture = path.join(os.tmpdir(), `mika5-csp-${process.pid}.html`);
  fs.writeFileSync(
    cspFixture,
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${cspMatch[1]}"></head><body></body></html>`,
    'utf8'
  );

  assert.strictEqual(win.webContents.getLastWebPreferences().sandbox, true);
  const mainLikeWindow = win;
  mainLikeWindow.webContents.removeAllListeners('will-navigate');
  await mainLikeWindow.loadFile(cspFixture);
  mainLikeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainLikeWindow.webContents.on('will-navigate', (event, url) => {
    navigations.push(url);
    event.preventDefault();
  });
  const cspResult = await mainLikeWindow.webContents.executeJavaScript(`(async () => {
    const result = {};
    try {
      await fetch('https://example.com/csp-fetch');
      result.fetchBlocked = false;
    } catch (_) {
      result.fetchBlocked = true;
    }
    try {
      const socket = new WebSocket('wss://example.com/csp-websocket');
      result.webSocketBlocked = await new Promise(resolve => {
        socket.onerror = () => resolve(true);
        socket.onopen = () => { socket.close(); resolve(false); };
        setTimeout(() => resolve(socket.readyState !== WebSocket.OPEN), 150);
      });
    } catch (_) {
      result.webSocketBlocked = true;
    }
    const form = document.createElement('form');
    form.action = 'https://example.com/csp-form';
    form.method = 'post';
    document.body.appendChild(form);
    form.requestSubmit();
    const iframe = document.createElement('iframe');
    iframe.src = 'https://example.com/csp-frame';
    document.body.appendChild(iframe);
    await new Promise(resolve => setTimeout(resolve, 150));
    result.iframeBlocked = performance.getEntriesByName('https://example.com/csp-frame')
      .every(entry => entry.transferSize === 0);
    try { window.location.href = 'https://example.com/csp-navigation'; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
    return result;
  })()`, true);
  assert.strictEqual(await win.webContents.executeJavaScript('typeof window.mika5.ai.chat'), 'function', 'actual sandboxed preload must expose the bridge');
  assert.strictEqual(cspResult.fetchBlocked, true);
  assert.strictEqual(cspResult.webSocketBlocked, true);
  assert.strictEqual(cspResult.iframeBlocked, true);
  assert(
    !requests.some(url => /csp-(?:fetch|websocket|form|frame)/.test(url)),
    'CSP must block renderer network primitives before a request is made'
  );
  assert(navigations.some(url => url === 'https://example.com/csp-navigation'));
  assert(mainLikeWindow.webContents.getURL().startsWith('file:'));
  await require('./security-renderer-regressions')(BrowserWindow, requests);
  mainLikeWindow.destroy();
  fs.unlinkSync(cspFixture);
  console.log('Electron security tests passed');
}

run().then(
  () => app.quit(),
  error => {
    console.error(error);
    app.exit(1);
  }
);
