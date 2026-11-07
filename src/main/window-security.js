'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const MAIN_WEB_PREFERENCES = Object.freeze({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false
});
const RENDERER_URL = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;

function createTrustedIpc(rawIpcMain) {
  const trusted = new WeakSet();
  return {
    trust(webContents) { trusted.add(webContents); },
    handle(channel, handler) {
      rawIpcMain.handle(channel, (event, ...args) => {
        if (!trusted.has(event.sender) || event.sender.isDestroyed()
          || event.senderFrame !== event.sender.mainFrame
          || event.senderFrame?.url !== RENDERER_URL) {
          throw new Error('IPC_UNTRUSTED_SENDER');
        }
        return handler(event, ...args);
      });
    }
  };
}

module.exports = { MAIN_WEB_PREFERENCES, RENDERER_URL, createTrustedIpc };
