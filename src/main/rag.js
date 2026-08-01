// src/main/rag.js
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { dbApi } = require("./db");
const { ollamaApi } = require("./ollama");

const EMBED_MODEL_DEFAULT = "nomic-embed-text";
const TOP_K_DEFAULT = 3;

const CHUNK_CHARS = 4200;
const OVERLAP_CHARS = 700;

// Clave = ALCANCE completo, no sólo el proyecto: el mismo proyecto ve distinto
// conocimiento según el chat activo, así que cachear por projectId a secas
// devolvía fragmentos de otro chat.
const projectCache = new Map(); // scopeKey -> { rows: [{ title, chunk_text, emb, ... }], ts }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL for cache entries

// La clave lleva los TRES componentes del alcance. Sin `includeProjectScope`,
// "proyecto + chat" y "sólo chat" comparten entrada y el segundo lector recibe
// los documentos de proyecto que no le corresponden.
function scopeKey(projectId, chatId, includeProjectScope) {
  return `proj:${projectId || ""}|chat:${chatId || ""}|pscope:${includeProjectScope ? 1 : 0}`;
}

// Invalida todas las entradas que puedan contener conocimiento del proyecto o
// del chat afectado, sin barrer la caché entera.
function invalidateKnowledgeCache({ projectId = null, chatId = null } = {}) {
  for (const key of [...projectCache.keys()]) {
    if (projectId && key.includes(`proj:${projectId}|`)) { projectCache.delete(key); continue; }
    if (chatId && key.includes(`|chat:${chatId}|`)) projectCache.delete(key);
  }
}

function chunkText(text) {
  const t = (text || "").toString();
  const chunks = [];
  let start = 0;
  let idx = 0;

  while (start < t.length) {
    const end = Math.min(t.length, start + CHUNK_CHARS);
    const chunk = t.slice(start, end).trim();
    if (chunk) chunks.push({ idx, text: chunk });
    idx += 1;
    if (end >= t.length) break;
    start = Math.max(0, end - OVERLAP_CHARS);
  }

  return chunks;
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// `embeddingClient` es un punto de inyección para las pruebas: permite ejercitar
// el alcance y la caché sin un Ollama vivo. En producción sigue siendo ollamaApi.
async function embedBatch(texts, embedModel, embeddingClient = ollamaApi) {
  const res = await embeddingClient.embed({ model: embedModel, input: texts });
  if (!res || !Array.isArray(res.embeddings)) throw new Error("INVALID_EMBED_RESPONSE");
  return res.embeddings;
}

const ragApi = {
  async indexKnowledgeItem(knowledgeItemId, opts = {}) {
    const embedModel = opts.embedModel || EMBED_MODEL_DEFAULT;

    const item = dbApi.getKnowledgeItem(knowledgeItemId);
    if (!item) return { ok: false, error: "KNOWLEDGE_NOT_FOUND" };

    dbApi.setKnowledgeIndexStatus(knowledgeItemId, "indexing", { indexedAt: null, error: "" });

    const invalidate = () => invalidateKnowledgeCache({
      projectId: item.project_id,
      chatId: item.chat_id || null
    });

    if (!item.content_path || !fs.existsSync(item.content_path)) {
      dbApi.setKnowledgeIndexStatus(knowledgeItemId, "error", { indexedAt: null, error: "CONTENT_FILE_MISSING" });
      invalidate();
      return { ok: false, error: "CONTENT_FILE_MISSING" };
    }

    try {
      const raw = fs.readFileSync(item.content_path, "utf8");
      const chunks = chunkText(raw);

      dbApi.deleteChunksForKnowledgeItem(knowledgeItemId);

      if (!chunks.length) {
        dbApi.setKnowledgeIndexStatus(knowledgeItemId, "ready", { indexedAt: Date.now(), error: "" });
        invalidate();
        return { ok: true, indexed: 0 };
      }

      const texts = chunks.map(c => c.text);
      const vectors = await embedBatch(texts, embedModel);

      if (vectors.length !== chunks.length) throw new Error("EMBED_MISMATCH");

      for (let i = 0; i < chunks.length; i++) {
        const id = uuidv4();
        dbApi.insertChunk({
          id,
          projectId: item.project_id,
          itemId: knowledgeItemId,
          chunkIndex: chunks[i].idx,
          chunkText: chunks[i].text,
          embeddingJson: JSON.stringify(vectors[i]),
          chatId: item.chat_id || null
        });
      }

      dbApi.setKnowledgeIndexStatus(knowledgeItemId, "ready", { indexedAt: Date.now(), error: "" });
      invalidate();
      return { ok: true, indexed: chunks.length };
    } catch (e) {
      const msg = String(e?.message || e);
      dbApi.setKnowledgeIndexStatus(knowledgeItemId, "error", { indexedAt: null, error: msg.slice(0, 500) });
      invalidate();
      return { ok: false, error: msg };
    }
  },

  /**
   * Búsqueda semántica dentro de un alcance.
   *
   * `opts.chatId` incluye además el conocimiento exclusivo de ESE chat. Sin él,
   * sólo conocimiento de proyecto. Nunca fragmentos de otro chat.
   */
  async query(projectId, text, k = TOP_K_DEFAULT, opts = {}) {
    const chatId = opts.chatId || null;
    const includeProjectScope = opts.includeProjectScope === undefined
      ? true
      : !!opts.includeProjectScope;
    try {
      return await runScopedQuery({
        key: scopeKey(projectId, chatId, includeProjectScope),
        loadRows: () => dbApi.listScopedChunks({ projectId, chatId, includeProjectScope }),
        text,
        k,
        embedModel: opts.embedModel || EMBED_MODEL_DEFAULT,
        embeddingClient: opts.embeddingClient
      });
    } catch (e) {
      // Fail-closed: un alcance incoherente no devuelve fragmentos de nadie.
      if (e && e.knowledgeScope) return { ok: false, error: e.code, chunks: [] };
      throw e;
    }
  },

  // Conocimiento EXCLUSIVO del chat — contrato histórico de `queryByChat`, que
  // consultaba `WHERE kc.chat_id = ?` sin conocimiento de proyecto. No se amplía.
  // El proyecto se resuelve desde el chat, así que un chat movido consulta
  // siempre su proyecto actual.
  async queryByChat(chatId, text, k = TOP_K_DEFAULT, opts = {}) {
    try {
      if (!chatId) return { ok: false, error: "INVALID_CHAT", chunks: [] };
      const chat = dbApi.getChat ? dbApi.getChat(chatId) : null;
      if (!chat) return { ok: false, error: "INVALID_CHAT", chunks: [] };
      return await runScopedQuery({
        key: scopeKey(chat.project_id, chatId, false),
        loadRows: () => dbApi.listChunksForChat(chatId),
        text,
        k,
        embedModel: opts.embedModel || EMBED_MODEL_DEFAULT,
        embeddingClient: opts.embeddingClient
      });
    } catch (e) {
      if (e && e.knowledgeScope) return { ok: false, error: e.code, chunks: [] };
      throw e;
    }
  },

  invalidateKnowledgeCache
};

async function runScopedQuery({ key, loadRows, text, k, embedModel, embeddingClient }) {
  const q = (text || "").toString().trim();
  // El alcance se valida SIEMPRE, aunque el texto esté vacío: así una consulta
  // vacía con un par proyecto/chat incoherente falla igual que una con texto.
  if (!q) { loadRows(); return { ok: true, chunks: [] }; }

  let cached = projectCache.get(key);
  if (cached && (Date.now() - cached.ts) > CACHE_TTL_MS) {
    projectCache.delete(key);
    cached = null;
  }

  if (!cached) {
    const parsed = [];
    for (const r of loadRows()) {
      try {
        parsed.push({
          title: r.title,
          chunk_text: r.chunk_text,
          knowledge_item_id: r.knowledge_item_id,
          chunk_index: r.chunk_index,
          emb: JSON.parse(r.embedding_json)
        });
      } catch {}
    }
    cached = { rows: parsed, ts: Date.now() };
    projectCache.set(key, cached);
  }

  if (!cached.rows.length) return { ok: true, chunks: [] };

  const vec = (await embedBatch([q], embedModel, embeddingClient || ollamaApi))[0];
  const scored = cached.rows.map(r => ({
    score: dot(vec, r.emb),
    title: r.title,
    chunk_text: r.chunk_text,
    knowledge_item_id: r.knowledge_item_id,
    chunk_index: r.chunk_index
  }));

  scored.sort((a, b) => b.score - a.score);
  return { ok: true, chunks: scored.slice(0, Math.max(1, Math.min(10, Number(k) || TOP_K_DEFAULT))) };
}

module.exports = { ragApi, invalidateKnowledgeCache, scopeKey };
