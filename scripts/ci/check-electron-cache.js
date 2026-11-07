#!/usr/bin/env node
'use strict';

// Windows CI-only negative test of the official Electron installer. Mutates
// only this job's isolated cache and installed Electron, before packaging.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function matchingZips(dir, name) {
  const matches = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Linked cache entry');
    if (entry.isDirectory()) matches.push(...matchingZips(file, name));
    else if (entry.name === name && entry.isFile()) matches.push(file);
  }
  return matches;
}

function checkCache() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.CI !== 'true') {
    throw new Error('This destructive cache fixture requires Windows x64 CI');
  }
  if (!process.env.RUNNER_TEMP || !process.env.electron_config_cache) throw new Error('Missing isolated cache');
  const temp = fs.realpathSync(process.env.RUNNER_TEMP);
  const cache = fs.realpathSync(process.env.electron_config_cache);
  const relative = path.relative(temp, cache);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Cache is outside runner temp');
  const root = path.join(__dirname, '..', '..');
  const electron = path.join(root, 'node_modules', 'electron');
  const version = JSON.parse(fs.readFileSync(path.join(electron, 'package.json'), 'utf8')).version;
  const matches = matchingZips(cache, `electron-v${version}-win32-x64.zip`);
  if (matches.length !== 1) throw new Error(`Expected exactly one cached Electron zip, got ${matches.length}`);
  fs.writeFileSync(matches[0], 'invalid zip: official installer must replace this');
  fs.rmSync(path.join(electron, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(electron, 'path.txt'), { force: true });
  const installed = spawnSync(process.execPath, [path.join(root, 'scripts', 'ensure-electron-binary.js')], {
    cwd: root, stdio: 'inherit', shell: false
  });
  if (installed.error || installed.status !== 0) throw new Error('Official installer failed');
  const actual = fs.readFileSync(path.join(electron, 'dist', 'version'), 'utf8').trim().replace(/^v/, '');
  const binary = fs.readFileSync(path.join(electron, 'path.txt'), 'utf8').trim();
  if (actual !== version || binary !== 'electron.exe'
    || !fs.statSync(path.join(electron, 'dist', binary)).isFile()) throw new Error('Reinstalled Electron is invalid');
  console.log(`Official installer replaced the corrupt cache: Electron ${version}`);
}

module.exports = { matchingZips };
if (require.main === module) checkCache();
