const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { app } = require("electron");

const Database = require("better-sqlite3");
const { v4: uuidv4 } = require("uuid");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let db;

function initDb() {
  const userData = app.getPath("userData"); // Windows: AppData\Roaming\MIKA5
  const dbPath = path.join(userData, "mika5.db");

  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);
  `);

  // Migration: add reply_to_id column if it doesn't exist
  const msgCols = db.prepare("PRAGMA table_info(messages)").all();
  if (!msgCols.find(c => c.name === 'reply_to_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL;`);
  }
  // Migration: add model column to track which model generated each message
  if (!msgCols.find(c => c.name === 'model')) {
    db.exec(`ALTER TABLE messages ADD COLUMN model TEXT DEFAULT NULL;`);
  }

  // Continue with remaining indexes (dummy block to keep syntax valid after migration)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
  `);

  // --- Migración: system_prompt en chats (per-chat context for quick-chat) ---
  const chatCols = db.prepare("PRAGMA table_info(chats)").all().map(r => r.name);
  if (!chatCols.includes("system_prompt")) {
    db.exec("ALTER TABLE chats ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  }

  // --- Migraciones ligeras (no romper instalaciones previas) ---
  const cols = db.prepare("PRAGMA table_info(projects)").all().map(r => r.name);
  if (!cols.includes("system_prompt")) {
    db.exec("ALTER TABLE projects ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes("icon")) {
    db.exec("ALTER TABLE projects ADD COLUMN icon TEXT DEFAULT NULL");
  }
  if (!cols.includes("color")) {
    db.exec("ALTER TABLE projects ADD COLUMN color TEXT DEFAULT NULL");
  }

  // Knowledge items
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'text/markdown',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      content_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_items(project_id);
  `);

  // --- Migración: estado de indexación en knowledge_items ---
  const kiCols = db.prepare("PRAGMA table_info(knowledge_items)").all().map(r => r.name);
  if (!kiCols.includes("index_status")) {
    db.exec("ALTER TABLE knowledge_items ADD COLUMN index_status TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!kiCols.includes("indexed_at")) {
    db.exec("ALTER TABLE knowledge_items ADD COLUMN indexed_at INTEGER");
  }
  if (!kiCols.includes("index_error")) {
    db.exec("ALTER TABLE knowledge_items ADD COLUMN index_error TEXT NOT NULL DEFAULT ''");
  }
  if (!kiCols.includes("chat_id")) {
    db.exec("ALTER TABLE knowledge_items ADD COLUMN chat_id TEXT DEFAULT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_chat ON knowledge_items(chat_id)");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      knowledge_item_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(knowledge_item_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_project ON knowledge_chunks(project_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_item ON knowledge_chunks(knowledge_item_id);
  `);

  // --- Migración: chat_id en knowledge_chunks ---
  const kcCols = db.prepare("PRAGMA table_info(knowledge_chunks)").all().map(r => r.name);
  if (!kcCols.includes("chat_id")) {
    db.exec("ALTER TABLE knowledge_chunks ADD COLUMN chat_id TEXT DEFAULT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_chat ON knowledge_chunks(chat_id)");
  }

  // --- Preflight de alcance de conocimiento (SÓLO LECTURA) ---
  // Instalaciones que movieron chats antes de este parche tienen items y chunks
  // apuntando al proyecto anterior. Abrir la aplicación NO los repara: arrancar
  // no es consentimiento para mover archivos del usuario. Aquí sólo se inspecciona
  // y se registran conteos y códigos; nunca títulos, contenido ni rutas.
  // La reparación es `executeKnowledgeScopeRepair()`, de invocación explícita.
  try {
    const preflight = inspectKnowledgeScopeRepair();
    if (preflight.chatsAffected || preflight.orphanItems || preflight.orphanChunks) {
      console.log(
        "[knowledge] preflight de alcance:",
        `chats=${preflight.chatsAffected}`,
        `items=${preflight.itemsAffected}`,
        `chunks=${preflight.chunksAffected}`,
        `sources_ok=${preflight.sourcesValid}`,
        `sources_ausentes=${preflight.sourcesMissing}`,
        `destinos_reutilizables=${preflight.destinationsExistingValid}`,
        `colisiones=${preflight.collisions}`,
        `items_huerfanos=${preflight.orphanItems}`,
        `chunks_huerfanos=${preflight.orphanChunks}`,
        `errores=${preflight.errors.map(e => `${e.code}x${e.count}`).join(",") || "0"}`
      );
    }
  } catch (e) {
    console.error("[knowledge] el preflight de alcance falló:", String(e?.message || e));
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safeFilename(name) {
  return (name || "document")
    .toString()
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .slice(0, 80) || "document";
}

function sha256Of(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// --- Aislamiento de conocimiento -------------------------------------------
//
// El conocimiento vive en tres tablas que TIENEN que decir lo mismo:
//   chats.project_id            — dónde vive el chat ahora
//   knowledge_items.project_id  — dónde vive el documento
//   knowledge_chunks.project_id — dónde viven sus fragmentos
//
// Mover un chat sólo actualizaba `chats`. Los items y chunks se quedaban
// apuntando al proyecto anterior y, como la recuperación filtraba por UN solo
// campo, el conocimiento quedaba huérfano o se filtraba a todos los chats del
// proyecto destino.
//
// La ruta en disco TAMBIÉN incorpora el projectId:
//   <userData>/knowledge/<projectId>[/<chatId>]/<archivo>
// así que realinear el proyecto obliga a mover el archivo, no sólo la fila.
//
// MODELO DE CONSISTENCIA — leer antes de tocar nada:
//
// SQLite y el sistema de archivos NO son atómicos entre sí. Aquí no se promete
// esa atomicidad. Lo que sí se garantiza:
//
//   · nunca se sobrescribe un archivo distinto (copia con COPYFILE_EXCL);
//   · nunca se borra un archivo preexistente durante el rollback;
//   · `content_path` no se actualiza hasta haber verificado el destino por hash;
//   · el archivo de origen no se borra antes del commit SQLite;
//   · si algo falla DESPUÉS del commit pueden quedar copias duplicadas en disco,
//     pero la base apunta siempre a una copia verificada;
//   · la operación es idempotente: reanudarla tras una interrupción reconoce los
//     destinos ya copiados por su hash y no vuelve a copiarlos.

const KNOWLEDGE_DIRNAME = "knowledge";

// Códigos estables. Se registran y se devuelven tal cual: nunca títulos,
// contenido, chunk_text ni rutas completas.
const KNOWLEDGE_ERRORS = {
  SOURCE_MISSING: "KNOWLEDGE_SOURCE_MISSING",
  SOURCE_OUTSIDE_ROOT: "KNOWLEDGE_SOURCE_OUTSIDE_ROOT",
  SOURCE_OUTSIDE_SELECTED_USER_DATA: "KNOWLEDGE_SOURCE_OUTSIDE_SELECTED_USER_DATA",
  DESTINATION_OUTSIDE_ROOT: "KNOWLEDGE_DESTINATION_OUTSIDE_ROOT",
  DESTINATION_COLLISION: "KNOWLEDGE_DESTINATION_COLLISION",
  SHA256_MISMATCH: "KNOWLEDGE_SHA256_MISMATCH",
  COPY_FAILED: "KNOWLEDGE_COPY_FAILED",
  VERIFY_FAILED: "KNOWLEDGE_VERIFY_FAILED",
  DB_WRITE_FAILED: "KNOWLEDGE_DB_WRITE_FAILED",
  DB_WRITE_FAILED_CLEANUP_INCOMPLETE: "KNOWLEDGE_DB_WRITE_FAILED_CLEANUP_INCOMPLETE"
};

function knowledgeRootDir() {
  return path.join(app.getPath("userData"), KNOWLEDGE_DIRNAME);
}

function knowledgeDirFor(projectId, chatId) {
  const root = knowledgeRootDir();
  return chatId ? path.join(root, projectId, chatId) : path.join(root, projectId);
}

// Destino determinista y único por item. El prefijo con el id del documento
// garantiza que dos knowledge_items NUNCA compartan content_path, aunque su
// `filename` sea idéntico.
function destinationPathFor(item, targetProjectId) {
  const dir = knowledgeDirFor(targetProjectId, item.chat_id);
  return path.join(dir, `${item.id}-${safeFilename(item.filename)}`);
}

function realpathOrNull(p) {
  if (!p) return null;
  try { return fs.realpathSync.native(p); } catch (_) { return null; }
}

/**
 * Resuelve el `content_path` ALMACENADO a la ruta física que se puede leer.
 *
 * En producción son la misma cosa. La distinción existe para poder ensayar la
 * reparación sobre una COPIA de la base: ahí las filas siguen guardando rutas
 * absolutas del userData original, y leerlas tal cual tocaría la instalación
 * real. El mapeo es sólo resolución de filesystem — NO reescribe la base.
 *
 * Sin `rebaseFromUserData`: la ruta almacenada debe caer ya dentro del
 * `<userData>/knowledge` seleccionado. Si apunta fuera se falla cerrado y el
 * archivo externo no se lee, ni se copia, ni se borra.
 *
 * Con `rebaseFromUserData`: sólo se aceptan rutas almacenadas bajo
 * `<origen>/knowledge`; su parte relativa se remapea a
 * `<userData>/knowledge/<relativa>`. La comprobación contra el origen es
 * puramente léxica: nunca se toca físicamente el userData original.
 */
function createSourceResolver({ rebaseFromUserData = null } = {}) {
  const knowledgeRoot = path.resolve(knowledgeRootDir());
  const contains = (root, candidate) =>
    candidate === root || candidate.startsWith(root + path.sep);

  if (!rebaseFromUserData) {
    return (storedPath) => {
      const stored = String(storedPath || "");
      if (!stored) return { ok: false, error: KNOWLEDGE_ERRORS.SOURCE_MISSING };
      const resolved = path.resolve(stored);
      if (!contains(knowledgeRoot, resolved)) {
        return { ok: false, error: KNOWLEDGE_ERRORS.SOURCE_OUTSIDE_SELECTED_USER_DATA };
      }
      return { ok: true, physical: resolved };
    };
  }

  const originRoot = path.resolve(path.join(rebaseFromUserData, KNOWLEDGE_DIRNAME));
  return (storedPath) => {
    const stored = String(storedPath || "");
    if (!stored) return { ok: false, error: KNOWLEDGE_ERRORS.SOURCE_MISSING };
    const resolved = path.resolve(stored);
    if (!contains(originRoot, resolved)) {
      return { ok: false, error: KNOWLEDGE_ERRORS.SOURCE_OUTSIDE_SELECTED_USER_DATA };
    }
    const relative = path.relative(originRoot, resolved);
    // `..` o ruta absoluta tras normalizar: intento de escape.
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ok: false, error: KNOWLEDGE_ERRORS.SOURCE_OUTSIDE_SELECTED_USER_DATA };
    }
    const mapped = path.resolve(path.join(knowledgeRoot, relative));
    if (!contains(knowledgeRoot, mapped)) {
      return { ok: false, error: KNOWLEDGE_ERRORS.SOURCE_OUTSIDE_SELECTED_USER_DATA };
    }
    return { ok: true, physical: mapped };
  };
}

function isInside(parentReal, childReal) {
  if (!parentReal || !childReal) return false;
  const a = path.resolve(parentReal);
  const b = path.resolve(childReal);
  return b === a || b.startsWith(a + path.sep);
}

/**
 * Ruta real que TENDRÁ el directorio destino, resolviendo junctions y symlinks
 * del ancestro existente más cercano sin bajar nunca de la raíz de conocimiento.
 * Los tramos que aún no existen los creamos nosotros, así que no pueden escapar.
 *
 * Devuelve null si la ruta pedida cae fuera de la raíz o si algún tramo real ya
 * apunta fuera de ella.
 */
function resolvedTargetDir(targetDir) {
  const root = path.resolve(knowledgeRootDir());
  const target = path.resolve(targetDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;

  let cursor = target;
  const pending = [];
  while (cursor !== root && !fs.existsSync(cursor)) {
    pending.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
  }

  // Ni la raíz existe todavía: toda la ruta la crearemos nosotros.
  if (!fs.existsSync(cursor)) return target;

  const anchorReal = realpathOrNull(cursor);
  if (!anchorReal) return null;
  const rootReal = realpathOrNull(root);
  if (rootReal && !isInside(rootReal, anchorReal)) return null;
  return pending.length ? path.join(anchorReal, ...pending) : anchorReal;
}

function sha256OfFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * PLANIFICACIÓN — estrictamente de sólo lectura.
 *
 * No crea directorios, no copia, no borra, no toca SQLite. Devuelve, por cada
 * documento del chat, la acción necesaria y su verificación por hash, o el
 * código de error que impide moverlo.
 *
 * Acciones posibles:
 *   copy        — hay que copiar el origen al destino
 *   preexisting — el destino ya existe y su hash coincide (reanudación segura)
 *   in-place    — content_path ya es el destino correcto
 */
function planChatRelocation(chatId, targetProjectId, database = db, resolveSource = null) {
  const sourceResolver = resolveSource || createSourceResolver();
  // Si la raíz aún no existe no hay nada en disco que validar contra ella; se usa
  // la ruta resuelta para que la comprobación de contención siga siendo estricta.
  const knowledgeRootReal = realpathOrNull(knowledgeRootDir()) || path.resolve(knowledgeRootDir());
  const items = database.prepare(
    "SELECT id, project_id, chat_id, filename, content_path, sha256 FROM knowledge_items WHERE chat_id = ?"
  ).all(chatId);

  const plan = { chatId, targetProjectId, entries: [], errors: [] };
  if (!items.length) return plan;

  const targetDir = knowledgeDirFor(targetProjectId, chatId);
  const targetDirReal = resolvedTargetDir(targetDir);
  if (!targetDirReal) {
    plan.errors.push({ code: KNOWLEDGE_ERRORS.DESTINATION_OUTSIDE_ROOT, itemId: null });
    return plan;
  }

  for (const item of items) {
    const destination = path.join(targetDirReal, `${item.id}-${safeFilename(item.filename)}`);
    const storedSha = String(item.sha256 || "");

    // Resolución de la ruta almacenada a la ruta física legible. Falla cerrado
    // ANTES de tocar el disco si apunta fuera del userData seleccionado.
    const mapping = sourceResolver(item.content_path);
    if (!mapping.ok) {
      plan.errors.push({ code: mapping.error, itemId: item.id });
      continue;
    }
    const sourceReal = realpathOrNull(mapping.physical);

    // Un origen que tras resolver junctions y symlinks ya no cae dentro de la
    // raíz de conocimiento se bloquea: no se copia desde fuera.
    if (sourceReal && !isInside(knowledgeRootReal, sourceReal)) {
      plan.errors.push({ code: KNOWLEDGE_ERRORS.SOURCE_OUTSIDE_ROOT, itemId: item.id });
      continue;
    }

    const destinationReal = realpathOrNull(destination);
    if (destinationReal && !isInside(targetDirReal, destinationReal)) {
      plan.errors.push({ code: KNOWLEDGE_ERRORS.DESTINATION_OUTSIDE_ROOT, itemId: item.id });
      continue;
    }

    let sourceSha = null;
    if (sourceReal) {
      try {
        sourceSha = sha256OfFile(sourceReal);
      } catch (_) {
        plan.errors.push({ code: KNOWLEDGE_ERRORS.SOURCE_MISSING, itemId: item.id });
        continue;
      }
      // El hash almacenado es la referencia: si el archivo en disco ya no
      // corresponde al documento registrado, no se mueve nada.
      if (storedSha && storedSha !== sourceSha) {
        plan.errors.push({ code: KNOWLEDGE_ERRORS.SHA256_MISMATCH, itemId: item.id });
        continue;
      }
    }

    let destinationSha = null;
    if (destinationReal) {
      try {
        destinationSha = sha256OfFile(destinationReal);
      } catch (_) {
        plan.errors.push({ code: KNOWLEDGE_ERRORS.DESTINATION_COLLISION, itemId: item.id });
        continue;
      }
    }

    // Ya está en su sitio: nada que copiar ni que borrar.
    if (sourceReal && destinationReal && sourceReal === destinationReal) {
      plan.entries.push({
        itemId: item.id, action: "in-place", source: sourceReal, destination: destinationReal,
        sha256: sourceSha, writeSha: storedSha ? null : sourceSha
      });
      continue;
    }

    if (destinationReal) {
      // El destino sólo se acepta si es de ESTE item (el nombre lo lleva el id)
      // y su hash coincide con el origen, o con el sha256 almacenado cuando el
      // origen ya no está. Cualquier otra cosa es colisión: no se sobrescribe.
      const reference = sourceSha || (storedSha || null);
      if (!reference || destinationSha !== reference) {
        plan.errors.push({ code: KNOWLEDGE_ERRORS.DESTINATION_COLLISION, itemId: item.id });
        continue;
      }
      plan.entries.push({
        itemId: item.id,
        action: "preexisting",
        source: sourceReal,
        destination,
        sha256: destinationSha,
        writeSha: storedSha ? null : destinationSha
      });
      continue;
    }

    if (!sourceReal) {
      // Sin origen y sin destino verificable no se inventa una ruta.
      plan.errors.push({ code: KNOWLEDGE_ERRORS.SOURCE_MISSING, itemId: item.id });
      continue;
    }

    plan.entries.push({
      itemId: item.id,
      action: "copy",
      source: sourceReal,
      destination,
      sha256: sourceSha,
      writeSha: storedSha ? null : sourceSha
    });
  }

  return plan;
}

/**
 * Materializa las copias del plan. COPYFILE_EXCL: si el destino aparece entre la
 * planificación y la copia, la llamada falla en vez de sobrescribir.
 *
 * `created` sólo lista archivos creados por ESTA ejecución — el rollback jamás
 * toca un destino preexistente.
 */
function stageCopies(plans) {
  const created = [];
  for (const plan of plans) {
    for (const entry of plan.entries) {
      if (entry.action !== "copy") continue;
      try {
        ensureDir(path.dirname(entry.destination));
        fs.copyFileSync(entry.source, entry.destination, fs.constants.COPYFILE_EXCL);
        created.push(entry.destination);
      } catch (_) {
        return { ok: false, error: KNOWLEDGE_ERRORS.COPY_FAILED, itemId: entry.itemId, created };
      }
      // Verificación del destino REAL ya escrito, no de lo que creíamos escribir.
      const writtenReal = realpathOrNull(entry.destination);
      if (!writtenReal || path.dirname(writtenReal) !== path.dirname(entry.destination)) {
        return { ok: false, error: KNOWLEDGE_ERRORS.VERIFY_FAILED, itemId: entry.itemId, created };
      }
      let writtenSha = null;
      try { writtenSha = sha256OfFile(writtenReal); } catch (_) { writtenSha = null; }
      if (writtenSha !== entry.sha256) {
        return { ok: false, error: KNOWLEDGE_ERRORS.VERIFY_FAILED, itemId: entry.itemId, created };
      }
    }
  }
  return { ok: true, created };
}

function rollbackStagedCopies(created) {
  for (const p of created) { try { fs.unlinkSync(p); } catch (_) {} }
}

// Best-effort DESPUÉS del commit. Un fallo aquí deja un duplicado en disco, no
// una base incoherente: no se revierte nada.
//
// El borrado se confina a la raíz de conocimiento del userData ACTIVO. En un
// ensayo sobre copia, `entry.source` ya está remapeado a la copia; esta guarda
// es la segunda barrera para que nunca se borre nada de la instalación real.
function cleanupSources(plans) {
  const knowledgeRootReal = realpathOrNull(knowledgeRootDir()) || path.resolve(knowledgeRootDir());
  let cleanupFailures = 0;
  for (const plan of plans) {
    for (const entry of plan.entries) {
      if (entry.action === "in-place" || !entry.source) continue;
      if (entry.source === entry.destination) continue;
      if (!isInside(knowledgeRootReal, entry.source)) { cleanupFailures++; continue; }
      try {
        if (fs.existsSync(entry.source)) fs.unlinkSync(entry.source);
      } catch (_) { cleanupFailures++; }
    }
  }
  return cleanupFailures;
}

// Sentencias de realineación compartidas por el movimiento de chat y por la
// reparación explícita. Se ejecutan SIEMPRE dentro de una transacción.
function relocationStatements(plan, database = db) {
  const updItems = database.prepare(
    "UPDATE knowledge_items SET project_id = ? WHERE chat_id = ? AND project_id <> ?"
  );
  const updChunks = database.prepare(
    "UPDATE knowledge_chunks SET project_id = ? WHERE chat_id = ? AND project_id <> ?"
  );
  const setPath = database.prepare("UPDATE knowledge_items SET content_path = ? WHERE id = ?");
  const setSha = database.prepare("UPDATE knowledge_items SET sha256 = ? WHERE id = ?");

  const items = updItems.run(plan.targetProjectId, plan.chatId, plan.targetProjectId);
  const chunks = updChunks.run(plan.targetProjectId, plan.chatId, plan.targetProjectId);
  for (const entry of plan.entries) {
    setPath.run(entry.destination, entry.itemId);
    if (entry.writeSha) setSha.run(entry.writeSha, entry.itemId);
  }
  return { items: items.changes, chunks: chunks.changes };
}

function misalignedChatTargets(database = db) {
  return database.prepare(`
    SELECT DISTINCT chat_id, project_id FROM (
      SELECT ki.chat_id AS chat_id, c.project_id AS project_id
        FROM knowledge_items ki
        JOIN chats c ON c.id = ki.chat_id
       WHERE ki.chat_id IS NOT NULL AND ki.project_id <> c.project_id
      UNION
      SELECT kc.chat_id AS chat_id, c.project_id AS project_id
        FROM knowledge_chunks kc
        JOIN chats c ON c.id = kc.chat_id
       WHERE kc.chat_id IS NOT NULL AND kc.project_id <> c.project_id
    )
  `).all();
}

function orphanCounts(database = db) {
  return {
    orphanItems: database.prepare(`
      SELECT COUNT(*) AS n FROM knowledge_items ki
       WHERE ki.chat_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = ki.chat_id)
    `).get().n,
    orphanChunks: database.prepare(`
      SELECT COUNT(*) AS n FROM knowledge_chunks kc
       WHERE kc.chat_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = kc.chat_id)
    `).get().n
  };
}

/**
 * PREFLIGHT — sólo lectura, sin excepciones.
 *
 * No crea directorios, no copia archivos, no escribe en SQLite. Es lo único que
 * `initDb` tiene permitido ejecutar, y lo único que puede apuntar a una base
 * abierta en modo readonly.
 *
 * Devuelve exclusivamente conteos y códigos de error. Nunca títulos, contenido,
 * chunk_text ni rutas.
 */
function inspectKnowledgeScopeRepair(opts = {}) {
  const database = opts.db || db;
  const sourceResolver = opts.sourceResolver
    || createSourceResolver({ rebaseFromUserData: opts.rebaseFromUserData || null });
  const targets = misalignedChatTargets(database);
  const orphans = orphanCounts(database);

  let itemsAffected = 0;
  let chunksAffected = 0;
  let sourcesValid = 0;
  let sourcesMissing = 0;
  let destinationsExistingValid = 0;
  let collisions = 0;
  const errorCounts = new Map();

  const countChunks = database.prepare(
    "SELECT COUNT(*) AS n FROM knowledge_chunks kc JOIN chats c ON c.id = kc.chat_id WHERE kc.chat_id = ? AND kc.project_id <> c.project_id"
  );
  const countItems = database.prepare(
    "SELECT COUNT(*) AS n FROM knowledge_items ki JOIN chats c ON c.id = ki.chat_id WHERE ki.chat_id = ? AND ki.project_id <> c.project_id"
  );

  for (const target of targets) {
    itemsAffected += countItems.get(target.chat_id).n;
    chunksAffected += countChunks.get(target.chat_id).n;

    const plan = planChatRelocation(target.chat_id, target.project_id, database, sourceResolver);
    for (const entry of plan.entries) {
      if (entry.action === "preexisting" || entry.action === "in-place") destinationsExistingValid++;
      if (entry.source) sourcesValid++;
      else sourcesMissing++;
    }
    for (const err of plan.errors) {
      if (err.code === KNOWLEDGE_ERRORS.SOURCE_MISSING) sourcesMissing++;
      if (err.code === KNOWLEDGE_ERRORS.DESTINATION_COLLISION) collisions++;
      errorCounts.set(err.code, (errorCounts.get(err.code) || 0) + 1);
    }
  }

  const errors = [...errorCounts.entries()].map(([code, count]) => ({ code, count }));
  return {
    ok: errors.length === 0,
    chatsAffected: targets.length,
    itemsAffected,
    chunksAffected,
    sourcesValid,
    sourcesMissing,
    destinationsExistingValid,
    collisions,
    orphanItems: orphans.orphanItems,
    orphanChunks: orphans.orphanChunks,
    errors
  };
}

/**
 * REPARACIÓN EXPLÍCITA — nunca se llama desde `initDb` ni desde ningún canal IPC.
 *
 * Fail-closed global: replanifica TODO desde cero (no confía en un inspect
 * previo) y, si cualquier chat tiene una ausencia, colisión o hash inválido,
 * termina sin copiar un solo archivo y sin tocar SQLite.
 *
 * Una única transacción SQLite cubre todos los chats afectados.
 */
function executeKnowledgeScopeRepair(opts = {}) {
  const database = opts.db || db;
  const sourceResolver = opts.sourceResolver
    || createSourceResolver({ rebaseFromUserData: opts.rebaseFromUserData || null });
  const targets = misalignedChatTargets(database);
  const orphans = orphanCounts(database);
  const base = {
    chatsRepaired: 0, itemsRepaired: 0, chunksRepaired: 0,
    filesCopied: 0, destinationsReused: 0, cleanupFailures: 0,
    orphanItems: orphans.orphanItems, orphanChunks: orphans.orphanChunks
  };

  if (!targets.length) return { ok: true, ...base, errors: [] };

  // A. Plan completo, revalidado ahora mismo.
  const plans = targets.map(t => planChatRelocation(t.chat_id, t.project_id, database, sourceResolver));
  const errorCounts = new Map();
  for (const plan of plans) {
    for (const err of plan.errors) errorCounts.set(err.code, (errorCounts.get(err.code) || 0) + 1);
  }
  // B. Cualquier defecto aborta la ejecución entera: cero copias, cero SQLite.
  if (errorCounts.size) {
    return {
      ok: false,
      ...base,
      errors: [...errorCounts.entries()].map(([code, count]) => ({ code, count }))
    };
  }

  // C. Copias con exclusión y verificación por hash.
  const staged = stageCopies(plans);
  if (!staged.ok) {
    // D. Sólo se eliminan los archivos creados por esta ejecución.
    rollbackStagedCopies(staged.created);
    return { ok: false, ...base, errors: [{ code: staged.error, count: 1 }] };
  }

  // E. Una sola transacción para todos los chats.
  const commit = database.transaction(() => {
    let items = 0;
    let chunks = 0;
    for (const plan of plans) {
      const counts = relocationStatements(plan, database);
      items += counts.items;
      chunks += counts.chunks;
    }
    return { items, chunks };
  });

  let counts;
  try {
    counts = commit();
  } catch (e) {
    rollbackStagedCopies(staged.created);
    return { ok: false, ...base, errors: [{ code: "KNOWLEDGE_COMMIT_FAILED", count: 1 }] };
  }

  // F/G. Limpieza best-effort. Un fallo aquí deja un duplicado, no una base rota.
  const cleanupFailures = cleanupSources(plans);

  return {
    ok: true,
    chatsRepaired: plans.length,
    itemsRepaired: counts.items,
    chunksRepaired: counts.chunks,
    filesCopied: staged.created.length,
    destinationsReused: plans.reduce(
      (n, p) => n + p.entries.filter(e => e.action !== "copy").length, 0
    ),
    cleanupFailures,
    orphanItems: orphans.orphanItems,
    orphanChunks: orphans.orphanChunks,
    errors: []
  };
}

// --- Alcance de recuperación ------------------------------------------------

function scopeError(code) {
  const err = new Error(code);
  err.code = code;
  err.knowledgeScope = true;
  return err;
}

/**
 * ÚNICA validación de alcance. Todo lector de conocimiento pasa por aquí.
 * Un par proyecto/chat incoherente LANZA: no se devuelven resultados parciales
 * ni se degrada silenciosamente a un alcance más amplio.
 */
function resolveKnowledgeScope(scope, database = db) {
  const projectId = scope && scope.projectId ? String(scope.projectId) : "";
  if (!projectId) throw scopeError("INVALID_PROJECT");
  const chatId = scope && scope.chatId ? String(scope.chatId) : null;
  const includeProjectScope = scope && scope.includeProjectScope !== undefined
    ? !!scope.includeProjectScope
    : true;

  if (chatId) {
    const chat = database.prepare("SELECT id, project_id FROM chats WHERE id = ?").get(chatId);
    if (!chat) throw scopeError("INVALID_CHAT");
    if (chat.project_id !== projectId) throw scopeError("INVALID_CHAT_PROJECT_SCOPE");
  }
  return { projectId, chatId, includeProjectScope };
}

/**
 * ÚNICA consulta de alcance de fragmentos.
 *
 * Exige coherencia de las tres tablas a la vez:
 *   · el chunk y su item pertenecen al mismo proyecto y al mismo chat;
 *   · si el chunk es de un chat, ese chat vive HOY en el mismo proyecto.
 *
 * Alcance permitido:
 *   · conocimiento de proyecto     → project_id = X AND chat_id IS NULL
 *   · conocimiento del chat actual → project_id = X AND chat_id = Y
 * Nunca conocimiento de OTRO chat del mismo proyecto.
 */
const SCOPED_CHUNKS_SQL = `
  SELECT
    kc.id,
    kc.project_id,
    kc.chat_id,
    kc.knowledge_item_id,
    kc.chunk_index,
    kc.chunk_text,
    kc.embedding_json,
    ki.title AS title
  FROM knowledge_chunks kc
  JOIN knowledge_items ki
    ON ki.id = kc.knowledge_item_id
   AND ki.project_id = kc.project_id
   AND ((ki.chat_id IS NULL AND kc.chat_id IS NULL) OR ki.chat_id = kc.chat_id)
  LEFT JOIN chats c ON c.id = kc.chat_id
  WHERE kc.project_id = @projectId
    AND (
      (@includeProjectScope = 1 AND kc.chat_id IS NULL)
      OR (@chatId IS NOT NULL AND kc.chat_id = @chatId AND c.project_id = kc.project_id)
    )
  ORDER BY ki.title, kc.chunk_index
`;

function scopedChunkRows(scope) {
  const resolved = resolveKnowledgeScope(scope);
  return db.prepare(SCOPED_CHUNKS_SQL).all({
    projectId: resolved.projectId,
    chatId: resolved.chatId,
    includeProjectScope: resolved.includeProjectScope ? 1 : 0
  });
}

const dbApi = {
  listProjects() {
    return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
  },

  createProject({ name, description, _internal }) {
    const n = (name || "").trim();
    if (!n) return { ok: false, error: "INVALID_NAME" };

    const id = _internal || uuidv4();
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, n, (description || "").trim(), Date.now());

    return { ok: true, id };
  },

  updateProject(id, payload) {
    const { name, icon, color } = payload || {};
    if (name !== undefined) {
      const n = (name || "").trim();
      if (!n) return { ok: false, error: "INVALID_NAME" };
      db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(n, id);
    }
    if (icon !== undefined) {
      db.prepare("UPDATE projects SET icon = ? WHERE id = ?").run(icon || null, id);
    }
    if (color !== undefined) {
      db.prepare("UPDATE projects SET color = ? WHERE id = ?").run(color || null, id);
    }
    return { ok: true };
  },

  deleteProject(id) {
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return { ok: true };
  },

  listChats(projectId) {
    return db
      .prepare("SELECT * FROM chats WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId);
  },

  createChat({ projectId, title }) {
    const t = (title || "New Chat").trim();
    const id = uuidv4();
    db.prepare(
      "INSERT INTO chats (id, project_id, title, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, projectId, t, Date.now());
    return { ok: true, id };
  },

  getChat(chatId) {
    return db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) || null;
  },

  /**
   * Renombrar y/o mover un chat.
   *
   * Mover un chat mueve TAMBIÉN su conocimiento: los documentos y fragmentos con
   * ese `chat_id` siguen siendo conocimiento del chat, no del proyecto, así que
   * conservan su `chat_id` y sólo cambian de `project_id`. Las tres tablas se
   * actualizan en una única transacción: o cambian las tres o no cambia ninguna.
   *
   * Mover es una acción explícita de la usuaria, así que aquí la migración SÍ es
   * automática — pero usa exactamente el mismo mecanismo seguro que la reparación
   * explícita: planificar, copiar con exclusión, verificar por hash, transaccionar
   * y sólo entonces borrar los orígenes.
   *
   * Cambiar sólo el título no toca archivos ni conocimiento.
   */
  updateChat(chatId, { title, projectId }) {
    const chat = db.prepare("SELECT id, project_id FROM chats WHERE id = ?").get(chatId);
    if (!chat) return { ok: false, error: "NOT_FOUND" };

    const nextTitle = title === undefined ? null : ((title || "").trim() || "Chat");

    // Sin cambio de proyecto: no hay migración de conocimiento que hacer.
    if (projectId === undefined) {
      if (nextTitle !== null) {
        db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(nextTitle, chatId);
      }
      return { ok: true, moved: false };
    }

    const targetProjectId = String(projectId || "");
    if (!targetProjectId) return { ok: false, error: "INVALID_PROJECT" };
    if (targetProjectId !== "quick-chat" && !UUID_RE.test(targetProjectId)) {
      return { ok: false, error: "INVALID_PROJECT" };
    }
    const target = db.prepare("SELECT id FROM projects WHERE id = ?").get(targetProjectId);
    if (!target) return { ok: false, error: "INVALID_PROJECT" };

    if (targetProjectId === chat.project_id) {
      if (nextTitle !== null) {
        db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(nextTitle, chatId);
      }
      return { ok: true, moved: false };
    }

    // Fail-closed: si algún documento del chat no se puede reubicar con garantías
    // (origen ausente, colisión en destino, hash que no cuadra), el chat NO se
    // mueve. Mover el chat dejando atrás su conocimiento es justo el defecto que
    // este trabajo cierra.
    const plan = planChatRelocation(chatId, targetProjectId);
    if (plan.errors.length) return { ok: false, error: plan.errors[0].code };

    const staged = stageCopies([plan]);
    if (!staged.ok) {
      rollbackStagedCopies(staged.created);
      return { ok: false, error: staged.error };
    }

    const applyMove = db.transaction(() => {
      if (nextTitle !== null) {
        db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(nextTitle, chatId);
      }
      db.prepare("UPDATE chats SET project_id = ? WHERE id = ?").run(targetProjectId, chatId);
      return relocationStatements(plan);
    });

    let counts;
    try {
      counts = applyMove();
    } catch (e) {
      rollbackStagedCopies(staged.created);
      return { ok: false, error: "MOVE_FAILED", detail: String(e?.message || e).slice(0, 200) };
    }

    // Después del commit. Un fallo aquí deja un duplicado en disco; la base ya
    // apunta a una copia verificada, así que no se revierte nada.
    const cleanupFailures = cleanupSources([plan]);

    return {
      ok: true,
      moved: true,
      fromProjectId: chat.project_id,
      toProjectId: targetProjectId,
      itemsMoved: counts.items,
      chunksMoved: counts.chunks,
      filesCopied: staged.created.length,
      cleanupFailures
    };
  },

  deleteChat(chatId) {
    // Clean up chat-scoped knowledge items and their files
    const items = db.prepare("SELECT id, content_path FROM knowledge_items WHERE chat_id = ?").all(chatId);
    for (const item of items) {
      if (item.content_path && fs.existsSync(item.content_path)) {
        try { fs.unlinkSync(item.content_path); } catch {}
      }
    }
    db.prepare("DELETE FROM knowledge_chunks WHERE chat_id = ?").run(chatId);
    db.prepare("DELETE FROM knowledge_items WHERE chat_id = ?").run(chatId);
    db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
    return { ok: true };
  },

  listMessages(chatId, { limit, offset } = {}) {
    if (limit > 0) {
      return db
        .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?")
        .all(chatId, limit, offset || 0);
    }
    return db
      .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC")
      .all(chatId);
  },

  countMessages(chatId) {
    const row = db.prepare("SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?").get(chatId);
    return row ? row.total : 0;
  },

  addMessage({ chatId, role, content, replyToId, model }) {
    const c = (content || "").toString();
    if (!c.trim()) return { ok: false, error: "EMPTY_MESSAGE" };

    const id = uuidv4();
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at, reply_to_id, model) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, chatId, role, c, Date.now(), replyToId || null, model || null);

    return { ok: true, id };
  },

  getMessage(msgId) {
    return db.prepare("SELECT * FROM messages WHERE id = ?").get(msgId) || null;
  },

  clearChat(chatId) {
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
    return { ok: true };
  },

  getAppState(key) {
    const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
    return row ? row.value : null;
  },

  setAppState(key, value) {
    // Security: whitelist of allowed keys
    const ALLOWED = [
      'ai_provider', 'openai_key', 'anthropic_key', 'groq_key', 'moonshot_key',
      'theme', 'language', 'lastProjectId', 'lastChatId', 'lastModel',
      'onboarding_done', 'plan_type', 'plan_expires', 'sidebar_collapsed'
    ];
    if (!ALLOWED.includes(key)) return { ok: false, error: 'INVALID_KEY' };
    const val = value == null ? "" : String(value);
    if (val.length > 10240) return { ok: false, error: 'VALUE_TOO_LARGE' };
    
    db.prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, val);
    return { ok: true };
  },

  // --- Project context ---
  getProjectContext(projectId) {
    const row = db.prepare("SELECT system_prompt FROM projects WHERE id = ?").get(projectId);
    return row ? row.system_prompt : "";
  },

  setProjectContext(projectId, systemPrompt) {
    db.prepare("UPDATE projects SET system_prompt = ? WHERE id = ?").run(String(systemPrompt || ""), projectId);
    return { ok: true };
  },

  // --- Chat context (per-chat system prompt for quick-chat) ---
  getChatContext(chatId) {
    const row = db.prepare("SELECT system_prompt FROM chats WHERE id = ?").get(chatId);
    return row ? row.system_prompt : "";
  },

  setChatContext(chatId, systemPrompt) {
    db.prepare("UPDATE chats SET system_prompt = ? WHERE id = ?").run(String(systemPrompt || ""), chatId);
    return { ok: true };
  },

  // --- Knowledge ---
  /**
   * Documentos visibles en un contexto.
   *
   * Con `chatId` devuelve los documentos de ESE chat, exigiendo que item y chat
   * coincidan en proyecto (antes bastaba con `chat_id`, así que un item con el
   * project_id obsoleto seguía listándose donde no debía).
   *
   * `includeProjectScope` añade además el conocimiento de proyecto (chat_id
   * NULL): es lo que necesita el panel de un chat normal dentro de un proyecto.
   *
   * Un par proyecto/chat incoherente LANZA (mismo validador que la recuperación
   * de fragmentos). Nada de degradar a un alcance más amplio.
   */
  listKnowledge(projectId, chatId, opts) {
    const scope = resolveKnowledgeScope({
      projectId,
      chatId,
      includeProjectScope: opts && opts.includeProjectScope !== undefined
        ? opts.includeProjectScope
        : !chatId
    });

    const projectRows = () => db
      .prepare("SELECT * FROM knowledge_items WHERE project_id = ? AND chat_id IS NULL ORDER BY created_at DESC")
      .all(scope.projectId);

    if (!scope.chatId) return scope.includeProjectScope ? projectRows() : [];

    const chatRows = db.prepare(`
      SELECT ki.*
      FROM knowledge_items ki
      JOIN chats c ON c.id = ki.chat_id
      WHERE ki.chat_id = ?
        AND ki.project_id = ?
        AND c.project_id = ki.project_id
      ORDER BY ki.created_at DESC
    `).all(scope.chatId, scope.projectId);

    if (!scope.includeProjectScope) return chatRows;
    return [...projectRows(), ...chatRows].sort((a, b) => b.created_at - a.created_at);
  },

  addKnowledgeFromText({ projectId, title, content, mimeType, chatId }) {
    const t = (title || "Documento").toString().trim();
    const c = (content || "").toString();
    if (!projectId) return { ok: false, error: "INVALID_PROJECT" };
    if (!c.trim()) return { ok: false, error: "EMPTY_CONTENT" };

    // Security: validate projectId is UUID to prevent path traversal
    if (projectId !== 'quick-chat' && !UUID_RE.test(projectId)) {
      return { ok: false, error: "INVALID_PROJECT" };
    }
    const proj = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!proj) return { ok: false, error: "INVALID_PROJECT" };

    // Security: validate chatId if provided
    if (chatId && !UUID_RE.test(chatId)) {
      return { ok: false, error: "INVALID_CHAT" };
    }

    // El chat tiene que existir Y pertenecer al proyecto indicado. Validarlos por
    // separado permitía crear conocimiento chat-scoped bajo un proyecto que no es
    // el del chat: incoherente desde el primer INSERT.
    // Va ANTES de tocar el disco: una validación fallida no debe dejar archivo.
    if (chatId) {
      const chat = db.prepare("SELECT id, project_id FROM chats WHERE id = ?").get(chatId);
      if (!chat) return { ok: false, error: "INVALID_CHAT" };
      if (chat.project_id !== projectId) return { ok: false, error: "INVALID_CHAT_PROJECT_SCOPE" };
    }

    // Per-chat knowledge goes into its own subdirectory
    const baseDir = knowledgeDirFor(projectId, chatId || null);

    // Security: el directorio real (resueltos junctions y symlinks) tiene que
    // caer dentro de la raíz de conocimiento.
    const baseDirReal = resolvedTargetDir(baseDir);
    if (!baseDirReal) return { ok: false, error: "INVALID_PATH" };

    ensureDir(baseDirReal);

    // Nombre determinista prefijado por el id del documento: dos knowledge_items
    // no pueden compartir content_path. Con `${Date.now()}-${título}` dos
    // documentos del mismo título creados en el mismo milisegundo se pisaban el
    // archivo — el segundo `writeFileSync` sobrescribía el del primero.
    const id = uuidv4();
    const ext = (mimeType === "text/plain") ? "txt" : "md";
    const fname = `${Date.now()}-${safeFilename(t)}.${ext}`;
    const fullPath = path.join(baseDirReal, `${id}-${safeFilename(fname)}`);
    const hash = sha256Of(c);

    // "wx": falla si el archivo existe. Nunca se sobrescribe nada — y por eso la
    // compensación de más abajo sólo puede borrar un archivo que creó ESTA
    // llamada: si ya existía, aquí se habría abortado.
    try {
      fs.writeFileSync(fullPath, c, { encoding: "utf8", flag: "wx" });
    } catch (_) {
      return { ok: false, error: "KNOWLEDGE_WRITE_FAILED" };
    }

    // El archivo se crea antes del INSERT, así que un INSERT fallido dejaba un
    // archivo huérfano en disco sin fila que lo referenciara. Se compensa.
    try {
      const stat = fs.statSync(fullPath);
      db.prepare(`
        INSERT INTO knowledge_items (id, project_id, title, filename, mime_type, size_bytes, sha256, content_path, created_at, chat_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        projectId,
        t,
        fname,
        mimeType === "text/plain" ? "text/plain" : "text/markdown",
        stat.size,
        hash,
        fullPath,
        Date.now(),
        chatId || null
      );
    } catch (_) {
      try {
        fs.unlinkSync(fullPath);
      } catch (_cleanupError) {
        // El archivo huérfano sigue en disco. Se distingue del caso limpio para
        // que quien llama sepa que queda residuo. Sin rutas en el error.
        return { ok: false, error: KNOWLEDGE_ERRORS.DB_WRITE_FAILED_CLEANUP_INCOMPLETE };
      }
      return { ok: false, error: KNOWLEDGE_ERRORS.DB_WRITE_FAILED };
    }

    return { ok: true, id };
  },

  deleteKnowledge(itemId) {
    const row = db.prepare("SELECT content_path FROM knowledge_items WHERE id = ?").get(itemId);
    if (row?.content_path && fs.existsSync(row.content_path)) {
      try { fs.unlinkSync(row.content_path); } catch {}
    }
    db.prepare("DELETE FROM knowledge_items WHERE id = ?").run(itemId);
    return { ok: true };
  },

  getKnowledgeItem(itemId) {
    return db.prepare("SELECT * FROM knowledge_items WHERE id = ?").get(itemId) || null;
  },

  deleteChunksForKnowledgeItem(itemId) {
    db.prepare("DELETE FROM knowledge_chunks WHERE knowledge_item_id = ?").run(itemId);
    return { ok: true };
  },

  insertChunk({ id, projectId, itemId, chunkIndex, chunkText, embeddingJson, chatId }) {
    db.prepare(`
      INSERT INTO knowledge_chunks (
        id, project_id, knowledge_item_id, chunk_index, chunk_text, embedding_json, created_at, chat_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, itemId, chunkIndex, chunkText, embeddingJson, Date.now(), chatId || null);
    return { ok: true };
  },

  /**
   * Fragmentos visibles desde un contexto. Único punto de verdad del alcance.
   *   { projectId }                        → sólo conocimiento de proyecto
   *   { projectId, chatId }                → proyecto + chat actual
   *   { projectId, chatId, includeProjectScope:false } → sólo el chat actual
   */
  listScopedChunks(scope) {
    return scopedChunkRows(scope || {});
  },

  // Conocimiento de proyecto: chat_id NULL. Ya NO devuelve los fragmentos
  // chat-scoped de otros chats del proyecto — esa era la fuga.
  listChunksForProject(projectId) {
    return scopedChunkRows({ projectId, chatId: null, includeProjectScope: true });
  },

  // Conocimiento exclusivo de un chat, resuelto contra el proyecto ACTUAL del
  // chat (no contra el project_id almacenado en el chunk).
  listChunksForChat(chatId) {
    const chat = db.prepare("SELECT project_id FROM chats WHERE id = ?").get(chatId);
    if (!chat) throw scopeError("INVALID_CHAT");
    return scopedChunkRows({
      projectId: chat.project_id,
      chatId,
      includeProjectScope: false
    });
  },

  /**
   * Texto de fragmentos para inyección directa de contexto (sin embeddings).
   * La consulta de alcance es la misma que la de RAG; aquí sólo se decide cuánto
   * cabe y en qué orden.
   */
  listChunksRaw({ projectId, chatId, maxChars, mode = "selective", includeProjectScope } = {}) {
    // Un alcance inválido LANZA (no devuelve [] silenciosamente): quien llama
    // tiene que poder distinguir "no hay documentos" de "el alcance es incoherente".
    // Safety limit: 100k chars for complete mode, otherwise use provided maxChars (default 24k)
    const limit = mode === "complete"
      ? 100000
      : Math.min(maxChars || 24000, 50000);

    const rows = scopedChunkRows({
      projectId,
      chatId: chatId || null,
      includeProjectScope: includeProjectScope === undefined ? true : !!includeProjectScope
    }).map(r => ({ chunk_text: r.chunk_text, chunk_index: r.chunk_index, title: r.title }));

    if (mode === "complete") {
      // Complete mode: return chunks in order until limit reached (no round-robin bias)
      let chars = 0;
      const result = [];
      for (const r of rows) {
        const chunkLength = (r.chunk_text || "").length;
        if (chars + chunkLength > limit) break;
        result.push(r);
        chars += chunkLength;
      }
      return result;
    }

    // Selective mode: round-robin across documents
    const byDoc = new Map();
    for (const r of rows) {
      if (!byDoc.has(r.title)) byDoc.set(r.title, []);
      byDoc.get(r.title).push(r);
    }

    const docArrays = [...byDoc.values()];
    let chars = 0;
    const result = [];
    let idx = 0;
    let added = true;
    while (added) {
      added = false;
      for (const docChunks of docArrays) {
        if (idx < docChunks.length) {
          const r = docChunks[idx];
          if (chars + (r.chunk_text || "").length > limit) continue;
          result.push(r);
          chars += (r.chunk_text || "").length;
          added = true;
        }
      }
      idx++;
      if (chars >= limit) break;
    }
    return result;
  },
  setKnowledgeIndexStatus(itemId, status, { indexedAt = null, error = "" } = {}) {
    db.prepare(`
      UPDATE knowledge_items
      SET index_status = ?, indexed_at = ?, index_error = ?
      WHERE id = ?
    `).run(
      String(status || "pending"),
      indexedAt,
      String(error || ""),
      itemId
    );
    return { ok: true };
  },

  getKnowledgeIndexStatus(itemId) {
    const row = db.prepare(`
      SELECT index_status, indexed_at, index_error
      FROM knowledge_items WHERE id = ?
    `).get(itemId);
    return row || { index_status: "pending", indexed_at: null, index_error: "" };
  },

  listKnowledgeNeedingIndex({ includeError = false } = {}) {
    if (includeError) {
      return db.prepare(`
        SELECT id, project_id
        FROM knowledge_items
        WHERE index_status IN ('pending','indexing','error')
        ORDER BY created_at DESC
      `).all();
    }

    return db.prepare(`
      SELECT id, project_id
      FROM knowledge_items
      WHERE index_status IN ('pending','indexing')
      ORDER BY created_at DESC
    `).all();
  },

  // Preflight de sólo lectura. Se puede exponer sin riesgo: no escribe nada.
  inspectKnowledgeScopeRepair(opts) {
    return inspectKnowledgeScopeRepair(opts);
  }
};

// `executeKnowledgeScopeRepair` NO está en `dbApi` a propósito: `dbApi` es la
// superficie que alimentan los canales IPC, y la reparación no debe poder
// dispararse desde el renderer. Sólo es alcanzable requiriendo este módulo desde
// el proceso principal (script de mantenimiento o pruebas).
module.exports = {
  initDb,
  dbApi,
  getDb: () => db,
  inspectKnowledgeScopeRepair,
  executeKnowledgeScopeRepair,
  createSourceResolver,
  resolveKnowledgeScope,
  // Exportada para que las verificaciones de ensayo consulten el alcance REAL
  // contra una conexión readonly, en vez de reimplementar la consulta.
  SCOPED_CHUNKS_SQL,
  KNOWLEDGE_ERRORS
};
