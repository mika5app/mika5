'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFunction } = require('./helpers/renderer-source');
module.exports = async function testRendererSecurity(BrowserWindow, requests) {
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const readVendor = name => fs.readFileSync(path.join(__dirname, '../src/renderer/vendor', name), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true
  } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
    const start = renderer.indexOf('const MARKDOWN_ALLOWED_TAGS');
    const end = renderer.indexOf('function safeExternalHref', start);
    const cssStart = renderer.indexOf('const EXPORT_CSS');
    const cssEnd = renderer.indexOf('\nfunction buildExportHTML', cssStart);
    await win.webContents.executeJavaScript([
      readVendor('marked.min.js'), readVendor('purify.min.js'),
      renderer.slice(start, end), sliceFunction(renderer, 'renderMarkdown'),
      sliceFunction(renderer, 'parseStoredAttachments'),
      sliceFunction(renderer, 'safeExternalHref'), sliceFunction(renderer, 'closeImageViewer'),
      sliceFunction(renderer, 'openImageViewer'),
      sliceFunction(renderer, 'escapeHtml'), sliceFunction(renderer, 'renderExportMarkdown'),
      renderer.slice(cssStart, cssEnd), sliceFunction(renderer, 'buildExportHTML')
    ].join('\n'));
    for (const payload of [
      '<div><svg/onload="window.securityProbe=1"></svg></div>',
      '<img src=x onerror="window.securityProbe=1">',
      '<a href="javascript:window.securityProbe=1">bad</a>',
      '<math><mtext><img src=x onerror="window.securityProbe=1"></mtext></math>'
    ]) {
      const html = await win.webContents.executeJavaScript(`renderExportMarkdown(${JSON.stringify(payload)})`);
      assert(!/onload|onerror|javascript:|<svg|<math/i.test(html), html);
      await win.webContents.executeJavaScript(`document.body.innerHTML=${JSON.stringify(html)}`);
      assert.strictEqual(await win.webContents.executeJavaScript('window.securityProbe'), undefined);
    }
    requests.length = 0;
    const output = await win.webContents.executeJavaScript(`(() => {
      const html = renderMarkdown('![tracker](https://audit.invalid/pixel)');
      document.body.innerHTML = html;
      return { image: document.querySelector('img[src]') !== null, link: document.querySelector('a')?.href };
    })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(output.image, false);
    assert.strictEqual(output.link, 'https://audit.invalid/pixel');
    assert(!requests.some(url => url.includes('audit.invalid')));
    const legitimate = await win.webContents.executeJavaScript(`(() => {
      approvedRemoteImages.add('https://images.invalid/generated.png');
      return renderExportMarkdown('**bold**\\n\\n|a|b|\\n|-|-|\\n|1|2|\\n\\n![generated](https://images.invalid/generated.png)');
    })()`);
    assert(legitimate.includes('<strong>bold</strong>'));
    assert(legitimate.includes('<table>'));
    assert(legitimate.includes('src="https://images.invalid/generated.png"'));
    const exported = await win.webContents.executeJavaScript(`buildExportHTML([{role:'x" onmouseover="bad',content:'ok'}], 'safe', {lang:'x" onload="bad'})`);
    assert(exported.includes("script-src 'none'"));
    assert(!exported.includes('onmouseover') && !exported.includes('onload'));
    const browserRecovery = await win.webContents.executeJavaScript(`(() => {
      const opened = [];
      window.mika5 = { openExternal: url => opened.push(url) };
      openImageViewer('https://images.invalid/generated.png', 'generated');
      const before = opened.length;
      Array.from(document.querySelectorAll('#imageModal button'))
        .find(button => button.textContent === 'Abrir en navegador').click();
      closeImageViewer();
      return { before, opened };
    })()`);
    assert.strictEqual(browserRecovery.before, 0, 'no automatic handoff to the browser');
    assert.deepStrictEqual(browserRecovery.opened, ['https://images.invalid/generated.png']);
    console.log('Renderer regressions: inert HTML, remote tracking blocked, formatting and approved images PASS');
  } finally { win.destroy(); }
};
