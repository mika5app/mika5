#!/usr/bin/env electron
//
// Herramienta de mantenimiento del alcance de conocimiento.
//
//   npx electron scripts/knowledge-scope-repair.js --user-data "<ruta>"
//   npx electron scripts/knowledge-scope-repair.js --user-data "<ruta>" \
//     --rebase-from-user-data "<origen>" --execute --confirm REPAIR-KNOWLEDGE-SCOPE
//
// NO está expuesta por IPC, preload ni renderer. Sólo se alcanza ejecutando este
// archivo desde el proceso principal.
//
// Sin `--execute` sólo inspecciona: abre SQLite en readonly, NO llama a initDb()
// (así que no corre migraciones de esquema), no crea directorios y no copia
// archivos.
//
// SALVEDAD sobre "sólo lectura": la base está en modo WAL. Aun abriendo con
// `readonly: true`, SQLite crea los sidecars `-shm` y `-wal` si faltan — los
// necesita para leer. El archivo `mika5.db` no se modifica.
//
// SALIDA: sólo conteos, códigos de error, el userData anonimizado y el estado
// final. Nunca títulos, contenido, chunk_text, hashes completos ni content_path.

"use strict";

const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const Database = require("better-sqlite3");

const pkg = require("../package.json");
const { parseArgs, selectRepairState, REPAIR_STATES } = require("./knowledge-scope-args");

const STATES = {
  INSPECT_OK: { name: "INSPECT_OK", exit: 0 },
  INSPECT_BLOCKED: { name: "INSPECT_BLOCKED", exit: 1 },
  ARGUMENTS_REJECTED: { name: "ARGUMENTS_REJECTED", exit: 64 },
  DATABASE_UNAVAILABLE: { name: "DATABASE_UNAVAILABLE", exit: 65 },
  ...REPAIR_STATES
};

// El userData sólo se nombra por su directorio final. La ruta completa es
// información del entorno del usuario y no aporta nada al diagnóstico.
function anonymizeUserData(p) {
  return `<user-data:${path.basename(path.resolve(p))}>`;
}

function emit(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function finish(state, payload) {
  emit({ state: state.name, ...payload });
  app.exit(state.exit);
}

function realUserDataPath() {
  return path.join(app.getPath("appData"), pkg.name);
}

function openDatabase(dbPath, { readonly }) {
  return new Database(dbPath, { readonly, fileMustExist: true });
}

app.whenReady().then(() => {
  const argv = process.argv.slice(process.defaultApp ? 2 : 1)
    .filter(a => a !== "." && !a.endsWith("knowledge-scope-repair.js"));

  const parsed = parseArgs(argv, realUserDataPath());
  if (!parsed.ok) {
    finish(STATES.ARGUMENTS_REJECTED, { error: parsed.error, detail: parsed.detail || null });
    return;
  }
  const options = parsed.options;

  // El userData seleccionado define TODA la resolución de rutas de db.js:
  // knowledgeRootDir(), destinos y limpieza cuelgan de aquí.
  app.setPath("userData", path.resolve(options.userData));

  // Se requiere DESPUÉS de fijar userData: db.js resuelve la raíz de
  // conocimiento en cada llamada, pero así no queda ninguna duda del orden.
  const {
    inspectKnowledgeScopeRepair,
    executeKnowledgeScopeRepair,
    createSourceResolver
  } = require("../src/main/db");

  const userDataLabel = anonymizeUserData(options.userData);
  const dbPath = path.join(path.resolve(options.userData), "mika5.db");
  if (!fs.existsSync(dbPath)) {
    finish(STATES.DATABASE_UNAVAILABLE, { userData: userDataLabel, error: "DATABASE_NOT_FOUND" });
    return;
  }

  const sourceResolver = createSourceResolver({
    rebaseFromUserData: options.rebaseFromUserData
      ? path.resolve(options.rebaseFromUserData)
      : null
  });

  const common = {
    userData: userDataLabel,
    rebased: Boolean(options.rebaseFromUserData),
    execute: options.execute
  };

  // --- Preflight: siempre, y siempre en readonly ---
  let readonlyDb;
  try {
    readonlyDb = openDatabase(dbPath, { readonly: true });
  } catch (e) {
    finish(STATES.DATABASE_UNAVAILABLE, {
      ...common,
      error: "DATABASE_OPEN_READONLY_FAILED",
      detail: "cierra MIKA5 por completo y vuelve a intentarlo"
    });
    return;
  }

  let preflight;
  try {
    preflight = inspectKnowledgeScopeRepair({ db: readonlyDb, sourceResolver });
  } finally {
    try { readonlyDb.close(); } catch (_) {}
  }

  if (!options.execute) {
    finish(preflight.ok ? STATES.INSPECT_OK : STATES.INSPECT_BLOCKED, { ...common, preflight });
    return;
  }

  // Sin un preflight limpio no se abre la base para escritura.
  if (!preflight.ok) {
    finish(STATES.INSPECT_BLOCKED, {
      ...common,
      preflight,
      detail: "la reparación no se intentó"
    });
    return;
  }

  // --- Reparación: writable sólo ahora ---
  let writableDb;
  try {
    writableDb = openDatabase(dbPath, { readonly: false });
  } catch (e) {
    finish(STATES.DATABASE_UNAVAILABLE, {
      ...common, preflight, error: "DATABASE_OPEN_WRITABLE_FAILED"
    });
    return;
  }

  let repair;
  try {
    writableDb.pragma("foreign_keys = ON");
    repair = executeKnowledgeScopeRepair({ db: writableDb, sourceResolver });
  } catch (e) {
    try { writableDb.close(); } catch (_) {}
    finish(STATES.REPAIR_NOT_COMMITTED, {
      ...common, preflight, error: "REPAIR_THREW", detail: String(e && e.message || e).slice(0, 120)
    });
    return;
  }

  if (!repair.ok) {
    try { writableDb.close(); } catch (_) {}
    finish(STATES.REPAIR_NOT_COMMITTED, { ...common, preflight, repair });
    return;
  }

  // Segundo inspect sobre la misma conexión ya confirmada.
  const verification = inspectKnowledgeScopeRepair({ db: writableDb, sourceResolver });
  try { writableDb.close(); } catch (_) {}

  // SQLite confirmó. Si quedó residuo en disco NO se dice que se revirtió nada.
  finish(selectRepairState(repair), { ...common, preflight, repair, verification });
});
