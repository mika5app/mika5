// src/main/rag.js
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { dbApi } = require("./db");
const { ollamaApi } = require("./ollama");

const EMBED_MODEL_DEFAULT = "nomic-embed-text";
const TOP_K_DEFAULT = 3;

const CHUNK_CHARS = 4200;
const OVERLAP_CHARS = 700;

const projectCache = new Map(); // projectId -> { rows: [{ title, chunk_text, emb, ... }], ts }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL for cache entries

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

async function embedBatch(texts, embedModel) {
  const res = await ollamaApi.embed({ model: embedModel, input: texts });
  if (!res || !Array.isArray(res.embeddings)) throw new Error("INVALID_EMBED_RESPONSE");
  return res.embeddings;
}

const ragApi = {
  async indexKnowledgeItem(knowledgeItemId, opts = {}) {
    const embedModel = opts.embedModel || EMBED_MODEL_DEFAULT;

    const item = dbApi.getKnowledgeItem(knowledgeItemId);
    if (!item) return { ok: false, error: "KNOWLEDGE_NOT_FOUND" };

    dbApi.setKnowledgeIndexStatus(knowledgeItemId, "indexing", { indexedAt: null, error: "" });

    const cacheKey = item.chat_id ? `chat:${item.chat_id}` : item.project_id;

    if (!item.content_path || !fs.existsSync(item.content_path)) {
      dbApi.setKnowledgeIndexStatus(knowledgeItemId, "error", { indexedAt: null, error: "CONTENT_FILE_MISSING" });
      projectCache.delete(cacheKey);
      return { ok: false, error: "CONTENT_FILE_MISSING" };
    }

    try {
      const raw = fs.readFileSync(item.content_path, "utf8");
      const chunks = chunkText(raw);

      dbApi.deleteChunksForKnowledgeItem(knowledgeItemId);

      if (!chunks.length) {
        dbApi.setKnowledgeIndexStatus(knowledgeItemId, "ready", { indexedAt: Date.now(), error: "" });
        projectCache.delete(cacheKey);
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
      projectCache.delete(cacheKey);
      return { ok: true, indexed: chunks.length };
    } catch (e) {
      const msg = String(e?.message || e);
      dbApi.setKnowledgeIndexStatus(knowledgeItemId, "error", { indexedAt: null, error: msg.slice(0, 500) });
      projectCache.delete(cacheKey);
      return { ok: false, error: msg };
    }
  },

  async query(projectId, text, k = TOP_K_DEFAULT, opts = {}) {
    const embedModel = opts.embedModel || EMBED_MODEL_DEFAULT;
    const q = (text || "").toString().trim();
    if (!projectId) return { ok: false, error: "INVALID_PROJECT" };
    if (!q) return { ok: true, chunks: [] };

    let cached = projectCache.get(projectId);

    // Invalidate if expired
    if (cached && (Date.now() - cached.ts) > CACHE_TTL_MS) {
      projectCache.delete(projectId);
      cached = null;
    }

    if (!cached) {
      const rows = dbApi.listChunksForProject(projectId);
      const parsed = [];
      for (const r of rows) {
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
      projectCache.set(projectId, cached);
    }

    if (!cached.rows.length) return { ok: true, chunks: [] };

    const vec = (await embedBatch([q], embedModel))[0];

    const scored = [];
    for (const r of cached.rows) {
      const score = dot(vec, r.emb);
      scored.push({
        score,
        title: r.title,
        chunk_text: r.chunk_text,
        knowledge_item_id: r.knowledge_item_id,
        chunk_index: r.chunk_index
      });
    }

    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, Math.max(1, Math.min(10, Number(k) || TOP_K_DEFAULT)));

    return { ok: true, chunks: top };
  },

  async queryByChat(chatId, text, k = TOP_K_DEFAULT, opts = {}) {
    const embedModel = opts.embedModel || EMBED_MODEL_DEFAULT;
    const q = (text || "").toString().trim();
    if (!chatId) return { ok: false, error: "INVALID_CHAT" };
    if (!q) return { ok: true, chunks: [] };

    const cacheKey = `chat:${chatId}`;
    let cached = projectCache.get(cacheKey);

    // Invalidate if expired
    if (cached && (Date.now() - cached.ts) > CACHE_TTL_MS) {
      projectCache.delete(cacheKey);
      cached = null;
    }

    if (!cached) {
      const rows = dbApi.listChunksForChat(chatId);
      const parsed = [];
      for (const r of rows) {
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
      projectCache.set(cacheKey, cached);
    }

    if (!cached.rows.length) return { ok: true, chunks: [] };

    const vec = (await embedBatch([q], embedModel))[0];

    const scored = [];
    for (const r of cached.rows) {
      const score = dot(vec, r.emb);
      scored.push({
        score,
        title: r.title,
        chunk_text: r.chunk_text,
        knowledge_item_id: r.knowledge_item_id,
        chunk_index: r.chunk_index
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.max(1, Math.min(10, Number(k) || TOP_K_DEFAULT)));
    return { ok: true, chunks: top };
  }
};

module.exports = { ragApi };
