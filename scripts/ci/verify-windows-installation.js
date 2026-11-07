#!/usr/bin/env node
'use strict';

// Real NSIS install/upgrade tests on a disposable GitHub-hosted Windows VM.
// Never run an installer against a developer's account or real user profile.
// Usage: node scripts/ci/verify-windows-installation.js <baseline-installer>
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { extractFile } = require('@electron/asar');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const BASELINE_VERSION = '0.3.0';
// Published release asset 500822411; also recorded in v0.3.0/SHA256SUMS.txt.
const BASELINE_SHA256 = 'c4c34e957342c811cafdcf7f90c066848fe317cf94514bd34309cc6949480b7c';
const PROJECT = '10000000-0000-4000-8000-000000000001';
const CHAT = '10000000-0000-4000-8000-000000000002';
const MESSAGE = '10000000-0000-4000-8000-000000000003';
const ITEM = '10000000-0000-4000-8000-000000000004';
const CHUNK = '10000000-0000-4000-8000-000000000005';
const DOCUMENT = '# Documento de prueba\nConservar acentos: información, México.\n';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireIsolatedRunner(env = process.env, platform = process.platform) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !env.RUNNER_TEMP) {
    throw new Error('Installer QA requires a disposable GitHub-hosted Windows runner');
  }
}

async function waitFor(predicate, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(500);
  }
  throw new Error(`Timed out: ${label}`);
}

function install(installer, directory) {
  // NSIS /D must be the last, unquoted command-line argument. The hosted
  // runner temp path has no spaces; fail instead of changing its semantics.
  assert(!/\s/.test(directory), 'Installer test path must have no whitespace');
  execFileSync(installer, ['/S', '/currentuser', `/D=${directory}`], {
    stdio: 'inherit', timeout: 180000, windowsHide: true
  });
}

function installedVersion(directory) {
  return JSON.parse(extractFile(path.join(directory, 'resources', 'app.asar'), 'package.json').toString('utf8')).version;
}

async function stopApp(child) {
  if (!child.pid) return;
  if (child.exitCode === null && !child.signalCode) try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$p=Get-Process -Id $env:MIKA5_QA_PID -ErrorAction Stop; $null=$p.CloseMainWindow()'],
    { env: { ...process.env, MIKA5_QA_PID: String(child.pid) }, stdio: 'ignore', timeout: 10000 });
  } catch (_) { /* the tracked process may already have exited */ }
  for (let i = 0; i < 60 && child.exitCode === null && !child.signalCode; i++) await sleep(250);
  if (child.exitCode === null && !child.signalCode) {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
    await waitFor(() => child.exitCode !== null || Boolean(child.signalCode), 'owned app process stopped', 10000);
    throw new Error('Installed app did not close gracefully; forced termination was cleanup only');
  }
  assert.strictEqual(child.exitCode, 0, 'Installed app must exit normally');
  assert.strictEqual(child.signalCode, null, 'Installed app must not be terminated by a signal');
}

async function launchAndClose(directory, profile) {
  fs.mkdirSync(profile, { recursive: true });
  const database = path.join(profile, 'mika5.db');
  const wal = `${database}-wal`;
  if (fs.existsSync(database)) {
    const db = new Database(database, { fileMustExist: true });
    try { assert.strictEqual(db.pragma('wal_checkpoint(TRUNCATE)')[0].busy, 0); }
    finally { db.close(); }
  }
  // A stale DB must not count as startup proof. Closing the last SQLite
  // connection removes its WAL; the installed app must open this exact profile.
  assert(!fs.existsSync(wal), 'Profile still has an active SQLite connection');
  const child = spawn(path.join(directory, 'MIKA5.exe'), [`--user-data-dir=${profile}`], { stdio: 'ignore' });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  try {
    await waitFor(() => {
      if (spawnError) throw spawnError;
      assert(child.exitCode === null && !child.signalCode, 'Installed app exited during startup');
      return fs.existsSync(database) && fs.existsSync(wal);
    }, 'installed app created its isolated database');
    // Check a real top-level window, not just the existence of a DB file.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'for($i=0;$i -lt 60;$i++){ $p=Get-Process -Id $env:MIKA5_QA_PID -ErrorAction Stop; if($p.MainWindowHandle -ne 0){exit 0}; Start-Sleep -Milliseconds 500 }; exit 1'],
    { env: { ...process.env, MIKA5_QA_PID: String(child.pid) }, stdio: 'inherit', timeout: 40000 });
    await sleep(2000);
    assert(child.exitCode === null && !child.signalCode, 'Installed app must remain running');
    assert(fs.existsSync(wal), 'Installed app must keep the requested profile open');
  } finally {
    await stopApp(child);
  }
}

async function uninstall(directory) {
  const candidates = fs.readdirSync(directory).filter(name => /^Uninstall.*\.exe$/i.test(name));
  assert.strictEqual(candidates.length, 1, 'Exactly one uninstaller is required');
  // _?= is also used by electron-builder's uninstallOldVersion macro: keep
  // this uninstaller in-process so ExecFile waits for registry cleanup too.
  execFileSync(path.join(directory, candidates[0]), ['/S', '/currentuser', `_?=${directory}`], { stdio: 'inherit', timeout: 120000 });
  await waitFor(() => !fs.existsSync(path.join(directory, 'MIKA5.exe')), 'uninstaller removed the installed app');
}

function seedFixture(profile) {
  const document = path.join(profile, 'knowledge', PROJECT, 'fixture.md');
  fs.mkdirSync(path.dirname(document), { recursive: true });
  fs.writeFileSync(document, DOCUMENT, { flag: 'wx' });
  const db = new Database(path.join(profile, 'mika5.db'), { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
      db.prepare('INSERT INTO projects(id,name,description,created_at,system_prompt) VALUES(?,?,?,?,?)')
        .run(PROJECT, 'Proyecto de prueba', 'Conservar al actualizar', 1, 'Contexto del proyecto');
      db.prepare('INSERT INTO chats(id,project_id,title,created_at,system_prompt) VALUES(?,?,?,?,?)')
        .run(CHAT, PROJECT, 'Conversación de prueba', 2, 'Contexto del chat');
      const attachments = JSON.stringify([{ name: 'pixel.png', mediaType: 'image/png',
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6MZwAAAAASUVORK5CYII=' }]);
      db.prepare('INSERT INTO messages(id,chat_id,role,content,created_at,attachments,model) VALUES(?,?,?,?,?,?,?)')
        .run(MESSAGE, CHAT, 'user', 'Texto que debe conservarse: áéíóú', 3, attachments, 'fixture-local');
      db.prepare('INSERT INTO knowledge_items(id,project_id,title,filename,mime_type,size_bytes,sha256,content_path,created_at,index_status) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(ITEM, PROJECT, 'Documento de prueba', 'fixture.md', 'text/markdown', Buffer.byteLength(DOCUMENT), hash(document), document, 4, 'indexed');
      db.prepare('INSERT INTO knowledge_chunks(id,project_id,knowledge_item_id,chunk_index,chunk_text,embedding_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(CHUNK, PROJECT, ITEM, 0, DOCUMENT, '[1,0,0]', 5);
      for (const [key, value] of [['theme', 'dark'], ['language', 'es']]) {
        db.prepare('INSERT OR REPLACE INTO app_state(key,value) VALUES(?,?)').run(key, value);
      }
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
}

function snapshot(profile) {
  const db = new Database(path.join(profile, 'mika5.db'), { readonly: true, fileMustExist: true });
  try {
    assert.strictEqual(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
    const project = db.prepare('SELECT id,name,description,created_at,system_prompt FROM projects WHERE id=?').get(PROJECT);
    const chat = db.prepare('SELECT id,project_id,title,created_at,system_prompt FROM chats WHERE id=?').get(CHAT);
    const message = db.prepare('SELECT id,chat_id,role,content,created_at,attachments,model FROM messages WHERE id=?').get(MESSAGE);
    const document = db.prepare('SELECT id,project_id,title,filename,mime_type,size_bytes,sha256,content_path,chat_id,created_at,index_status FROM knowledge_items WHERE id=?').get(ITEM);
    const chunk = db.prepare('SELECT id,project_id,knowledge_item_id,chunk_index,chunk_text,embedding_json,chat_id,created_at FROM knowledge_chunks WHERE id=?').get(CHUNK);
    assert(project && chat && message && document && chunk, 'All fixture records must survive');
    const preferences = db.prepare("SELECT key,value FROM app_state WHERE key IN ('theme','language') ORDER BY key").all();
    assert.strictEqual(preferences.length, 2);
    const bytes = fs.readFileSync(path.join(profile, 'knowledge', PROJECT, 'fixture.md'));
    assert.strictEqual(bytes.toString('utf8'), DOCUMENT);
    assert.strictEqual(hash(document.content_path), document.sha256);
    return { project, chat, message, document, chunk, preferences };
  } finally { db.close(); }
}

async function verify(baseline) {
  requireIsolatedRunner();
  const version = require(path.join(ROOT, 'package.json')).version;
  assert.strictEqual(hash(baseline), BASELINE_SHA256, 'Wrong v0.3.0 installer bytes');
  const current = path.join(ROOT, 'dist', `MIKA5-Setup-${version}-win-x64.exe`);
  const currentHash = hash(current);
  assert(process.env.APPDATA, 'Windows AppData must be available');
  // NSIS cleanup targets these real AppData locations. An arbitrary temp
  // profile would miss installer data loss. Claim only absent paths on this VM.
  const profile = path.join(process.env.APPDATA, 'MIKA5');
  for (const name of ['MIKA5', 'mika5-desktop']) {
    assert(!fs.existsSync(path.join(process.env.APPDATA, name)), `Pre-existing profile: ${name}`);
  }
  fs.mkdirSync(profile);
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'mika5-install-'));
  const directory = path.join(temp, 'installed');
  const report = { ok: false, commit: process.env.GITHUB_SHA, version, baselineVersion: BASELINE_VERSION,
    installerSha256: currentHash, baselineSha256: BASELINE_SHA256, checks: [] };
  const check = label => { report.checks.push(label); console.log(`PASS: ${label}`); };
  const assertCurrentFiles = () => {
    assert.strictEqual(installedVersion(directory), version);
    for (const file of ['MIKA5.exe', 'resources/app.asar', 'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node']) {
      assert.strictEqual(hash(path.join(directory, file)), hash(path.join(ROOT, 'dist', 'win-unpacked', file)), `Installed bytes differ: ${file}`);
    }
  };
  try {
    install(current, directory);
    assertCurrentFiles();
    await launchAndClose(directory, profile);
    check('clean installation, exact packaged bytes and visible window');
    await uninstall(directory);
    check('clean-install uninstaller');
    fs.rmSync(profile, { recursive: true, force: true });

    install(baseline, directory);
    assert.strictEqual(installedVersion(directory), BASELINE_VERSION);
    await launchAndClose(directory, profile);
    seedFixture(profile);
    await launchAndClose(directory, profile);
    const before = snapshot(profile);
    check('published v0.3.0 opens the synthetic upgrade fixture');

    install(current, directory);
    assertCurrentFiles();
    await launchAndClose(directory, profile);
    assert.deepStrictEqual(snapshot(profile), before);
    check('v0.3.0 upgrade preserves projects, chats, attachments, documents, chunks and preferences');
    await launchAndClose(directory, profile);
    assert.deepStrictEqual(snapshot(profile), before);
    check('upgraded data survives another restart');
    await uninstall(directory);
    assert.deepStrictEqual(snapshot(profile), before);
    check('uninstaller preserves synthetic data in the real AppData location');
    assert.strictEqual(hash(current), currentHash, 'Installer changed during QA');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    const logs = path.join(ROOT, '.gate-logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'windows-installation.json'), JSON.stringify(report, null, 2) + '\n');
    // On failure leave only this synthetic fixture for diagnostics until the
    // hosted VM is discarded. Never remove an unrelated installation/profile.
  }
}

module.exports = { requireIsolatedRunner };
if (require.main === module) {
  verify(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
