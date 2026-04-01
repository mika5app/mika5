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

  updateChat(chatId, { title, projectId }) {
    if (title !== undefined) {
      const t = (title || "").trim();
      const r = db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(t || "Chat", chatId);
      if (!r.changes) return { ok: false, error: "NOT_FOUND" };
    }
    if (projectId !== undefined) {
      const r = db.prepare("UPDATE chats SET project_id = ? WHERE id = ?").run(projectId, chatId);
      if (!r.changes) return { ok: false, error: "NOT_FOUND" };
    }
    return { ok: true };
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
  listKnowledge(projectId, chatId) {
    if (chatId) {
      return db
        .prepare("SELECT * FROM knowledge_items WHERE chat_id = ? ORDER BY created_at DESC")
        .all(chatId);
    }
    return db
      .prepare("SELECT * FROM knowledge_items WHERE project_id = ? AND chat_id IS NULL ORDER BY created_at DESC")
      .all(projectId);
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

    const userData = app.getPath("userData");
    // Per-chat knowledge goes into its own subdirectory
    const baseDir = chatId
      ? path.join(userData, "knowledge", projectId, chatId)
      : path.join(userData, "knowledge", projectId);

    // Security: verify path stays under knowledge root
    const resolved = path.resolve(baseDir);
    if (!resolved.startsWith(path.resolve(path.join(userData, "knowledge")))) {
      return { ok: false, error: "INVALID_PATH" };
    }

    ensureDir(baseDir);

    const ext = (mimeType === "text/plain") ? "txt" : "md";
    const fname = `${Date.now()}-${safeFilename(t)}.${ext}`;
    const fullPath = path.join(baseDir, fname);

    fs.writeFileSync(fullPath, c, "utf8");

    const id = uuidv4();
    const stat = fs.statSync(fullPath);
    const hash = sha256Of(c);

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

  listChunksForProject(projectId) {
    return db.prepare(`
      SELECT
        kc.id,
        kc.project_id,
        kc.knowledge_item_id,
        kc.chunk_index,
        kc.chunk_text,
        kc.embedding_json,
        ki.title AS title
      FROM knowledge_chunks kc
      JOIN knowledge_items ki ON ki.id = kc.knowledge_item_id
      WHERE kc.project_id = ?
    `).all(projectId);
  },

  listChunksForChat(chatId) {
    return db.prepare(`
      SELECT
        kc.id,
        kc.project_id,
        kc.knowledge_item_id,
        kc.chunk_index,
        kc.chunk_text,
        kc.embedding_json,
        ki.title AS title
      FROM knowledge_chunks kc
      JOIN knowledge_items ki ON ki.id = kc.knowledge_item_id
      WHERE kc.chat_id = ?
    `).all(chatId);
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
  }
};

module.exports = { initDb, dbApi, getDb: () => db };