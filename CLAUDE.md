# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MIKA5 is an Electron desktop app for working with local AI models (Ollama), organized by projects, chats, and knowledge documents, with a fully local RAG engine backed by SQLite. It also supports cloud AI providers (OpenAI/Anthropic/Groq/Moonshot) with privacy indicators.

Language: Spanish (UI text, comments, and README are in Spanish).

## Commands

```bash
# Install dependencies (also rebuilds native modules for Electron via postinstall)
npm install

# Run in development mode
npm run dev

# Build desktop installer (NSIS .exe output in dist/)
npm run build
```

```bash
# Run tests (RAG chunking + vision detection)
npm test

# Run individual test suites
npm run test:rag      # Chunking, cosine similarity, cache TTL
npm run test:vision   # Vision model detection patterns
npm run test:db       # DB CRUD (requires: npx electron)
```

No linter is set up.

## Architecture

The app follows Electron's two-process model:

### Main process (`src/main/`)

| File | Purpose |
|---|---|
| `main.js` | Entry point. Creates BrowserWindow, registers all IPC handlers, runs `initDb()` and startup RAG sweep |
| `preload.js` | Exposes `window.mika5` API to renderer (db, rag, ai, ollama, saveFile, etc.). All Node access goes through here |
| `db.js` | SQLite via `better-sqlite3`. WAL mode, foreign keys. Tables: projects, chats, messages, app_state, knowledge_items, knowledge_chunks |
| `ai-providers.js` | `AIProviderManager` — manages Local (Ollama) vs Cloud providers, API key encryption (AES-256-GCM), PII sanitization, per-provider timeouts |
| `ollama.js` | HTTP client for local Ollama (`127.0.0.1:11434`): status, tags, chat, pull, embed |
| `rag.js` | RAG engine: chunks documents, gets embeddings via Ollama, stores in SQLite, cosine similarity search with in-memory cache per project |

### Renderer process (`src/renderer/`)

| File | Purpose |
|---|---|
| `index.html` | Main HTML layout with most CSS inline |
| `app.js` | SPA logic: Store wrapper over `window.mika5.db`, UI rendering, message sending with RAG context injection, knowledge/export features |
| `i18n.js` | Internationalization module |
| `styles.css` | Supplemental styles (not linked from HTML — most CSS is inline in index.html) |
| `mika5-diagnostic.js` | Diagnostic utilities |

### Other directories

- `web/` — Static landing page (index.html, logo, icon, robots.txt, sitemap.xml)
- `mika5-desktop/` — Alternate package.json with different Electron/dependency versions (points `dev` script to parent dir via `electron ..`)
- `dist/` — Build output (NSIS installer)

## Key Data Flow

1. User sends message → renderer saves to DB, queries RAG (`rag.query(projectId, text, k=3)`), injects matching chunks as a `system` message
2. Calls active provider via `window.mika5.ai.chat()` or legacy `window.mika5.ollama.chat()`
3. Response displayed and saved to DB
4. Knowledge documents: saved → written to disk → indexed in background (chunked + embedded) → available for RAG queries

## IPC Channels

All renderer↔main communication goes through `window.mika5.*`:
- `db.*` — CRUD for projects, chats, messages, knowledge, app_state
- `ai.*` — provider management, chat, model listing
- `rag.*` — query and indexKnowledgeItem
- `ollama.*` — legacy compatibility layer (redirects to aiManager)
- `saveFile` — native file dialog export (md/txt/html/py)

## Known Issues

- `mika5-desktop/` directory has different Electron/builder versions (experimental, unused)
- Most CSS lives inline in `index.html`; `styles.css` has supplemental rules only

## Requirements

- Node.js + npm
- Ollama running locally on `http://127.0.0.1:11434`
- Embedding model installed (recommended: `nomic-embed-text`)
- At least one Ollama chat model (llama, qwen, etc.)
