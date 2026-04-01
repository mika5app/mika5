# MIKA5 Architecture

This document describes the internal architecture of MIKA5 for contributors who want to understand, modify, or extend the codebase.

MIKA5 is an Electron desktop app for working with local AI models (Ollama) and cloud providers, organized by projects, chats, and knowledge documents, with a fully local RAG engine backed by SQLite.

---

## Process Model

Electron splits the app into two OS processes:

```
┌─────────────────────────────────────────────────┐
│  Main Process (Node.js)                         │
│                                                 │
│  main.js ─── db.js (SQLite)                     │
│    │    ├── ai-providers.js (6 providers)        │
│    │    ├── ollama.js (local HTTP client)         │
│    │    └── rag.js (chunking + embeddings)        │
│    │                                             │
│    └── preload.js (contextBridge)                │
│              │                                   │
├──────────────┼───────────────────────────────────┤
│  Renderer Process (Chromium)                     │
│              │                                   │
│         window.mika5 API                         │
│              │                                   │
│  app.js ─── index.html ─── i18n.js              │
└─────────────────────────────────────────────────┘
```

All communication between processes goes through IPC via the `window.mika5` bridge. The renderer never has direct access to Node.js APIs.

---

## Main Process (`src/main/`)

### main.js (267 lines)

Entry point. Creates the BrowserWindow, registers all 34 IPC handlers, calls `initDb()`, and runs a startup RAG sweep to re-index any pending knowledge items.

### db.js (~495 lines)

SQLite database layer using `better-sqlite3` in WAL mode with foreign keys enabled.

**Tables:**

| Table | Purpose |
|---|---|
| `projects` | Top-level containers for organizing work |
| `chats` | Conversations within a project |
| `messages` | Individual messages in a chat |
| `knowledge_items` | Source documents uploaded by the user |
| `knowledge_chunks` | Chunked + embedded fragments used for RAG |
| `app_state` | Key-value store for settings and UI state |

All CRUD operations are exposed as prepared statements. The renderer calls them through IPC (`window.mika5.db.*`).

### ai-providers.js (~737 lines)

`AIProviderManager` class that abstracts over six providers:

| Provider | Type | Notes |
|---|---|---|
| Ollama | Local | Default, no API key needed |
| llama.cpp | Local | Direct HTTP to llama.cpp server |
| OpenAI | Cloud | API key required |
| Anthropic | Cloud | API key required |
| Groq | Cloud | API key required |
| Moonshot | Cloud | API key required |

Cloud provider API keys are encrypted at rest using AES-256-GCM. Outbound messages to cloud providers pass through a PII sanitization step. The UI shows privacy indicators so users know when data leaves their machine.

### ollama.js (~241 lines)

HTTP client targeting `http://127.0.0.1:11434`. Handles status checks, model listing (`/api/tags`), chat completions, embeddings, and model pulls. Model pulling uses `child_process.spawn` to stream progress. Includes custom timeout management for long-running requests.

### rag.js (~216 lines)

Local RAG engine with the following pipeline:

1. **Chunk** documents into segments of 4200 characters with 700-character overlap
2. **Embed** each chunk via Ollama using `nomic-embed-text`
3. **Store** chunk text and embedding vectors in `knowledge_chunks`
4. **Query** by embedding the user's message, then ranking stored chunks by cosine similarity
5. **Return** top-3 matching chunks for context injection

Embeddings are cached in memory per project with a 5-minute TTL to avoid redundant Ollama calls.

### preload.js (63 lines)

Uses Electron's `contextBridge` to expose the `window.mika5` API object to the renderer. This is the only bridge between the two processes. Groups: `db`, `ai`, `rag`, `ollama`, `saveFile`.

---

## Renderer Process (`src/renderer/`)

### app.js (4063 lines)

Monolithic SPA that handles all UI logic. This is intentional for v0.1.0; modularization is planned for v0.2.

**Section map:**

| Lines | Responsibility |
|---|---|
| 1-87 | Global state, vision model detection |
| 208-377 | Custom modal dialogs (prompt/confirm/select) |
| 516-910 | Document extraction (DOCX/XLSX/PPTX/ODF/RTF/PDF via binary parsing) |
| 1083-1143 | Markdown rendering + HTML sanitization |
| 1241-1365 | Context management (conversation trimming, 25/40 message limits) |
| 1365-1530 | Provider and runtime loading |
| 1570-1823 | Project CRUD |
| 1823-2208 | Chat management with pagination (50 messages per page) |
| 2221-2748 | Message rendering, search (Ctrl+F), reply threading |
| 2759-3120 | Core `send()` function with RAG context injection |
| 3062-3305 | Export (MD/TXT/HTML/PY/PDF) |
| 3374-3554 | Ollama model pull UI |
| 3554-3904 | Event wiring, sidebar |
| 3994-4063 | Boot sequence |

### index.html

Main layout file. Most CSS lives inline here rather than in external stylesheets.

### i18n.js (314 lines)

Internationalization module with 112 translation keys. Spanish and English are supported with full parity between the two languages.

### styles.css

Supplemental styles only. The bulk of styling is inline in `index.html`.

---

## IPC Architecture

34 IPC handlers total, organized into namespaces:

- **`db.*`** -- CRUD for projects, chats, messages, knowledge, app_state
- **`ai.*`** -- Provider management, chat, model listing
- **`rag.*`** -- Query and indexKnowledgeItem
- **`ollama.*`** -- Legacy compatibility layer (redirects to AIProviderManager)
- **`saveFile`** -- Native file dialog export
- **`printToPDF`** -- PDF generation

**Validation strategy:**

- 31 handlers delegate validation to `db.js` and `ai-providers.js`
- 3 handlers validate at the IPC boundary itself:
  - `openExternal` -- protocol whitelist (prevents arbitrary URL opening)
  - `saveFile` -- 50 MB file size limit
  - `printToPDF` -- HTML sanitization

**Security model:**

- `contextIsolation: true` -- renderer cannot access Node.js globals
- `nodeIntegration: false` -- no `require()` in renderer
- `sandbox: false` -- required by `better-sqlite3` native module

---

## Data Flow

### Sending a message

```
User types message
  → Saved to messages table
  → RAG query: embed message, cosine search, return top-3 chunks
  → Chunks injected as a system message in the conversation context
  → Sent to active provider (Ollama / cloud)
  → Full response returned (no streaming yet)
  → Rendered as Markdown with HTML sanitization
  → Saved to messages table
```

### Indexing a knowledge document

```
User adds document
  → Saved to knowledge_items table
  → Written to disk
  → Queued for background indexing
  → Chunked (4200 chars, 700 overlap)
  → Each chunk embedded via nomic-embed-text
  → Stored in knowledge_chunks with vector
  → Available for RAG queries in that project
```

### Context management

Conversations are trimmed to stay within model context limits: 25-message window for standard models, 40 for larger context models. Older messages are dropped from the request but remain in the database.

---

## Testing

3 test files with 98 total assertions:

```bash
npm test              # Run all tests
npm run test:rag      # Chunking, cosine similarity, cache TTL
npm run test:vision   # Vision model detection patterns
npm run test:db       # DB CRUD (requires: npx electron)
```

---

## Known Technical Debt

| Item | Status |
|---|---|
| `app.js` monolith (4063 lines) | Planned modularization in v0.2 |
| IPC validation mostly delegated to inner modules | Boundary validation planned for v0.2 |
| No streaming (full response load before rendering) | Planned |

---

## Other Directories

- **`web/`** -- Static landing page (not part of the Electron app)
- **`mika5-desktop/`** -- Experimental alternate package.json with different dependency versions (unused)
- **`dist/`** -- Build output (NSIS installer)
