/**
 * scripts/gen-ico.js
 * Generate build/icon.ico from src/renderer/assets/icon.png
 * Uses only Node.js built-ins + electron-builder's bundled png-to-ico.
 *
 * Usage: node scripts/gen-ico.js
 *
 * If electron-builder is not installed, run: npm install first.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const src = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'icon.png');
const outDir = path.join(__dirname, '..', 'build');
const out = path.join(outDir, 'icon.ico');

if (!fs.existsSync(src)) {
  console.error('ERROR: Source icon not found:', src);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

// electron-builder bundles a PNG→ICO converter internally.
// We invoke it via the electron-builder CLI so we don't need extra deps.
const { execSync } = require('child_process');
try {
  // electron-builder can convert a PNG to ICO as part of its build pipeline.
  // For standalone conversion we use the fact that Electron itself ships
  // a native image API accessible via the main process.
  // Simplest cross-platform approach: call electron to do the conversion.
  const script = `
    const { app, nativeImage } = require('electron');
    const fs = require('fs');
    const path = require('path');
    app.whenReady().then(() => {
      const img = nativeImage.createFromPath(${JSON.stringify(src)});
      const ico = img.toICO();
      fs.writeFileSync(${JSON.stringify(out)}, ico);
      console.log('Generated:', ${JSON.stringify(out)});
      app.quit();
    });
  `;
  const tmpScript = path.join(__dirname, '_tmp_ico_gen.js');
  fs.writeFileSync(tmpScript, script);
  execSync(`npx electron "${tmpScript}"`, { stdio: 'inherit' });
  fs.unlinkSync(tmpScript);
} catch (e) {
  // Fallback: just copy the PNG with .ico extension (works with electron-builder)
  console.warn('electron not available for ICO conversion, copying PNG as fallback...');
  fs.copyFileSync(src, out.replace('.ico', '.png'));
  console.log('Copied PNG to build/. electron-builder will convert it during build.');
}
