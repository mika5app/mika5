#!/usr/bin/env node
'use strict';

// Verifica el paquete Windows recién construido, y verifica que TODO lo que
// afirma se refiere al MISMO fichero.
//
//   node scripts/verify-packaged-windows.js [ruta/a/win-unpacked]
//
// Por qué existe: comprobar los fuses de un ejecutable, arrancar otro y medir
// SQLite en un tercero produce un informe que suena completo y no lo es. Aquí se
// calcula el SHA-256 al principio y al final, y si cambia se falla: los seis
// resultados hablan del mismo binario o no valen.
//
// Qué comprueba, sobre ese único `.exe`:
//
//   1. SHA-256
//   2. Los cinco fuses, leídos del ejecutable con la herramienta oficial
//   3. Que arranca con un userData aislado
//   4. Que carga better-sqlite3 y crea su base: tablas, WAL, integrity_check
//   5. Que un `resources/app` plantado NO se carga (onlyLoadAppFromAsar)
//   6. Que el SHA-256 sigue siendo el mismo
//
// No firma, no publica y no toca el userData real: el perfil es temporal.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DIR = process.argv[2] || path.join(RAIZ, 'dist', 'win-unpacked');
const EXE = path.join(DIR, 'MIKA5.exe');

const FUSES_ESPERADOS = {
  RunAsNode: 'Disabled',
  EnableNodeOptionsEnvironmentVariable: 'Disabled',
  EnableNodeCliInspectArguments: 'Disabled',
  EnableEmbeddedAsarIntegrityValidation: 'Enabled',
  OnlyLoadAppFromAsar: 'Enabled'
};

let fallos = 0;
function check(condicion, mensaje) {
  console.log(`${condicion ? '  OK  ' : '  FAIL'} ${mensaje}`);
  if (!condicion) fallos += 1;
}

function sha256(archivo) {
  return crypto.createHash('sha256').update(fs.readFileSync(archivo)).digest('hex');
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarFichero(ruta, segundos) {
  for (let i = 0; i < segundos; i++) {
    if (fs.existsSync(ruta)) return true;
    await dormir(1000);
  }
  return false;
}

/** Arranca el paquete con un perfil aislado y devuelve el proceso y el perfil. */
function arrancar() {
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'mika5-verify-'));
  const proc = spawn(EXE, [`--user-data-dir=${perfil}`], { stdio: 'ignore', detached: false });
  return { proc, perfil, base: path.join(perfil, 'mika5.db') };
}

function matar(proc) {
  try { proc.kill(); } catch (_) { /* ya muerto */ }
}

async function principal() {
  console.log(`verificando: ${EXE}`);
  if (!fs.existsSync(EXE)) {
    console.error(`no existe ${EXE}`);
    process.exit(1);
  }

  // --- 1. SHA-256 -----------------------------------------------------------
  const hashInicial = sha256(EXE);
  console.log(`\nSHA256 = ${hashInicial}`);
  console.log(`tamaño = ${fs.statSync(EXE).size} bytes`);

  // --- 2. Fuses -------------------------------------------------------------
  console.log('\n== fuses leídos del ejecutable ==');
  const cliFuses = path.join(RAIZ, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js');
  const salida = execFileSync(process.execPath, [cliFuses, 'read', '--app', EXE], { encoding: 'utf8' });
  console.log(salida.trim());
  for (const [nombre, esperado] of Object.entries(FUSES_ESPERADOS)) {
    const re = new RegExp(`^\\s*${nombre} is (\\w+)`, 'm');
    const m = salida.match(re);
    check(Boolean(m) && m[1] === esperado, `${nombre} = ${m ? m[1] : 'ausente'} (esperado ${esperado})`);
  }

  // --- 3 y 4. Arranque, better-sqlite3 y SQLite real ------------------------
  console.log('\n== arranque y SQLite ==');
  const versionBs = JSON.parse(
    fs.readFileSync(path.join(RAIZ, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8')).version;
  check(versionBs === '13.0.3', `better-sqlite3 del checkout es ${versionBs}`);

  const unpacked = path.join(DIR, 'resources', 'app.asar.unpacked',
    'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
  check(fs.existsSync(unpacked), 'el prebuild N-API win32-x64 viaja en app.asar.unpacked');

  const a = arrancar();
  const creada = await esperarFichero(a.base, 60);
  check(creada, 'la aplicación empaquetada crea su base de datos');
  await dormir(2000);
  check(a.proc.exitCode === null, 'y sigue viva (no se cayó al cargar el módulo nativo)');

  if (creada) {
    const Database = require(path.join(RAIZ, 'node_modules', 'better-sqlite3'));
    const db = new Database(a.base, { readonly: true });
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => r.name).filter((n) => !n.startsWith('sqlite_'));
    const journal = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    const integridad = db.pragma('integrity_check', { simple: true });
    const sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
    db.close();
    console.log(`  tablas: ${tablas.join(', ')}`);
    for (const t of ['app_state', 'projects', 'chats', 'messages', 'knowledge_items', 'knowledge_chunks']) {
      check(tablas.includes(t), `la base tiene ${t}`);
    }
    check(journal === 'wal', `journal_mode = ${journal}`);
    check(integridad === 'ok', `integrity_check = ${integridad}`);
    console.log(`  SQLite ${sqlite}`);
    check(fs.existsSync(`${a.base}-wal`), 'existe el fichero -wal');
  }
  matar(a.proc);
  await dormir(2000);
  fs.rmSync(a.perfil, { recursive: true, force: true });

  // --- 5. Prueba negativa: resources/app alternativo -------------------------
  console.log('\n== prueba negativa: resources/app ==');
  const alt = path.join(DIR, 'resources', 'app');
  const marca = path.join(os.tmpdir(), `mika5-app-alternativo-${process.pid}.txt`);
  fs.rmSync(marca, { force: true });
  fs.mkdirSync(alt, { recursive: true });
  fs.writeFileSync(path.join(alt, 'package.json'),
    JSON.stringify({ name: 'suplantador', version: '9.9.9', main: 'main.js' }));
  fs.writeFileSync(path.join(alt, 'main.js'),
    `require('fs').writeFileSync(${JSON.stringify(marca)}, 'CARGO');`
    + " require('electron').app.quit();\n");

  const b = arrancar();
  const arrancoReal = await esperarFichero(b.base, 45);
  await dormir(3000);
  const cargoAlternativo = fs.existsSync(marca);
  matar(b.proc);
  await dormir(2000);
  fs.rmSync(alt, { recursive: true, force: true });
  fs.rmSync(marca, { force: true });
  fs.rmSync(b.perfil, { recursive: true, force: true });

  check(!cargoAlternativo, 'el resources/app plantado NO se carga');
  check(arrancoReal, 'y la aplicación real sí arranca desde app.asar');
  check(!fs.existsSync(alt), 'el directorio plantado queda eliminado');

  // --- 6. El fichero no cambió ---------------------------------------------
  console.log('\n== identidad del artefacto ==');
  const hashFinal = sha256(EXE);
  check(hashFinal === hashInicial,
    `el SHA-256 es el mismo antes y después (${hashFinal})`);

  console.log(`\n${'='.repeat(40)}`);
  if (fallos) {
    console.error(`verify-packaged-windows: ${fallos} comprobaciones fallaron`);
    process.exit(1);
  }
  console.log(`verify-packaged-windows: todo correcto sobre ${hashFinal}`);
}

principal().catch((error) => {
  console.error(`verify-packaged-windows: ${error && error.stack || error}`);
  process.exit(1);
});
