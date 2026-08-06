# MIKA5 — Sovereign AI Desktop Platform

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](https://github.com/mika5app/mika5/releases/tag/v0.1.0)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/mika5app/mika5/releases)

Desktop application for working with local and cloud AI models, organized by projects, chats, and knowledge documents, with a built-in local RAG engine backed by SQLite.

**Version:** 0.1.0
**Platforms:** Windows 10/11 · macOS 12+ · Linux (x64)
**License:** [AGPL-3.0](LICENSE)

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Requirements](#requirements)
- [Install & Run](#install--run)
- [Build Scripts](#build-scripts)
- [Architecture](#architecture)
  - [Main Process](#main-process)
  - [Renderer Process](#renderer-process)
  - [Database](#database)
  - [RAG Engine](#rag-engine)
- [AI Providers](#ai-providers)
- [Supported Formats](#supported-formats)
- [Security](#security)
- [Internal API (IPC)](#internal-api-ipc)
- [Usage Flow](#usage-flow)
- [Folder Structure](#folder-structure)
- [CI/CD](#cicd)
- [Known Issues](#known-issues)

---

## Features

### Chat & AI

- Chat with local models (Ollama, llama.cpp) and cloud (OpenAI, Anthropic, Groq, Moonshot)
- Privacy indicators: **local** or **cloud** per provider and model
- Model selector with automatic capability detection (vision, code, etc.)
- Download Ollama models from the UI (`ollama pull`)
- Cancel in-progress generation (Stop button + AbortController)
- Progressive context management: automatic history trimming for long chats

### Projects & Organization

- Projects with per-project custom system prompt
- Multiple chats per project with rename and move-between-projects
- Auto-rename of chat based on the user's first message

### Search & Navigation

- **Chat search** (Ctrl+F): full-text search with highlighting, prev/next navigation, result counter
- **Lazy loading**: loads the last 50 messages on open, "Load earlier messages" button to paginate
- **Message reply** (WhatsApp-style): visual quote of the original message, scroll-to-quoted with animation, context injected into the AI model

### Knowledge & RAG

- Per-project knowledge base with text files
- Local RAG engine: chunking, embeddings via Ollama, cosine similarity search
- Background indexing with sequential queue (no race conditions)
- Automatic reindexing on startup (startup sweep)
- In-memory embedding cache per project

### Attachments

- Images: inline preview, zoom modal click-to-expand, send to vision models
- Documents: text extraction from PDF, DOCX, XLSX, PPTX, ODF, CSV, RTF
- Plain text files: JS, PY, HTML, CSS, JSON, MD, TS, and 30+ more extensions
- Binary detection for automatic rejection
- Compact preview with height limit and scroll

### Export

| Format | Description |
|--------|-------------|
| Markdown (.md) | Full chat in markdown |
| Text (.txt) | Plain text |
| HTML (.html) | Styled document for web/printing |
| Python (.py) | Chat as Python comments |
| PDF (.pdf) | Via Electron printToPDF with A4-optimized CSS |

- Save individual messages as knowledge documents
- Save full chat as a knowledge document

### Interface

- Dark/light theme with persistent toggle
- User messages right-aligned with differentiated background (chat style)
- Assistant messages left-aligned
- Internationalization: Spanish (default) and English
- Collapsible sidebar with projects and recent chats
- Toasts with 3-simultaneous limit
- Native modal dialogs (prompt, confirm, select)
- Automatic collapse of long messages (+2000 chars) with "Show full"
- Native right-click context menu (Cut / Copy / Paste)

---

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Desktop | Electron | 43.3.0 |
| Database | better-sqlite3 (WAL mode, N-API) | 13.0.3 |
| Markdown | marked | ^17.0.4 |
| Syntax highlight | highlight.js + atom-one-dark | ^11.11.1 |
| UUIDs | uuid | ^9.0.1 |
| Build | electron-builder (NSIS + DMG + AppImage) | 26.15.7 |
| Frontend | Vanilla JavaScript (no frameworks) | — |

---

## Requirements

- **Node.js** and **npm**
- **Ollama** running locally on `http://127.0.0.1:11434`
  - At least one chat model installed (llama, qwen, mistral, etc.)
  - Embedding model (recommended: `nomic-embed-text`)
- **Optional**: API keys for cloud providers (OpenAI, Anthropic, Groq, Moonshot)
- **Optional**: llama.cpp server on `http://127.0.0.1:8080/v1` for GGUF direct inference

---

## Install & Run

```bash
# Clone and install dependencies (includes native module rebuild)
cd MIKA5
npm install

# Install embedding model for RAG
ollama pull nomic-embed-text

# Install at least one chat model
ollama pull llama3.2

# Run in development mode
npm run dev
```

---

## Build Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `electron .` | Start app in development mode |
| `build` | `electron-builder --config electron-builder.json` | Build default (Windows NSIS) |
| `build:win` | `electron-builder --win` | Windows NSIS installer + Portable (.exe) in `dist/` |
| `build:mac` | `electron-builder --mac` | macOS DMG (x64 + arm64) + ZIP in `dist/` |
| `build:linux` | `electron-builder --linux` | AppImage + .deb + .rpm in `dist/` |
| `build:all` | `electron-builder --win --mac --linux` | All platforms |
| `icons:win` | `node scripts/gen-ico.js` | Generate build/icon.ico from PNG |
| `icons:mac` | `bash scripts/gen-icns.sh` | Generate build/icon.icns from PNG (macOS only) |
| `test` | runs all test suites | RAG chunking + vision detection + DB CRUD |
| `postinstall` | `electron-builder install-app-deps` | Rebuild native modules for Electron |

---

## Architecture

The app follows Electron's two-process model with context isolation.

### Main Process

| File | Purpose |
|------|---------|
| `src/main/main.js` | Entry point. BrowserWindow, IPC handlers, startup RAG sweep, indexing queue |
| `src/main/preload.js` | Secure bridge `window.mika5` (contextBridge). All Node access goes through here |
| `src/main/db.js` | SQLite with WAL mode, foreign keys, incremental migrations, full CRUD |
| `src/main/ai-providers.js` | AIProviderManager: local + cloud, API key encryption (AES-256-GCM), PII sanitization |
| `src/main/ollama.js` | HTTP client for Ollama with dual timeouts |
| `src/main/rag.js` | RAG engine: chunking, embeddings via Ollama, cosine similarity, in-memory cache |

### Renderer Process

| File | Purpose |
|------|---------|
| `src/renderer/index.html` | HTML layout + inline CSS (sidebar, chat area, input, search bar, modals) |
| `src/renderer/app.js` | Full SPA: Store, rendering, send, search, reply, attachments, export |
| `src/renderer/i18n.js` | Internationalization system (ES/EN, 263 keys) |
| `src/renderer/styles.css` | Supplemental styles (privacy indicators, cloud warnings, project items) |
| `src/renderer/mika5-diagnostic.js` | Diagnostic utilities |

### Database

SQLite stored at:
- Windows: `%AppData%/MIKA5/mika5.db`
- macOS: `~/Library/Application Support/MIKA5/mika5.db`
- Linux: `~/.config/MIKA5/mika5.db`

| Table | Key fields | Relation |
|-------|-----------|----------|
| `projects` | id, name, description, system_prompt, icon, color | — |
| `chats` | id, project_id, title | FK → projects (CASCADE) |
| `messages` | id, chat_id, role, content | FK → chats (CASCADE) |
| `knowledge_items` | id, project_id, title, content_path, index_status, sha256 | FK → projects (CASCADE) |
| `knowledge_chunks` | id, project_id, knowledge_item_id, chunk_text, embedding_json | FK → knowledge_items (CASCADE) |
| `app_state` | key, value | KV store (whitelist enforced) |

### RAG Engine

1. **Save**: document written to disk in `{userData}/knowledge/{projectId}/`
2. **Index**: text chunked (4200 chars + 700 overlap) → embeddings via `nomic-embed-text` → stored in `knowledge_chunks`
3. **Query**: query embedding → cosine similarity against all project chunks → top-k (default 3) injected as `system` message
4. **Queue**: sequential indexing via `enqueueIndex()` to avoid race conditions
5. **Startup sweep**: automatic retry of pending/errored items

---

## AI Providers

| Provider | Mode | Privacy | API Key | Endpoint |
|----------|------|---------|---------|----------|
| Ollama | Local | Private | No | `127.0.0.1:11434` |
| llama.cpp | Local | Private | No | `127.0.0.1:8080/v1` |
| OpenAI | Cloud | Cloud | Yes | `api.openai.com` |
| Anthropic (Claude) | Cloud | Cloud | Yes | `api.anthropic.com` |
| Groq | Cloud | Cloud | Yes | `api.groq.com` |
| Moonshot (Kimi) | Cloud | Cloud | Yes | `api.moonshot.cn` |

**llama.cpp** runs as an OpenAI-compatible local server:
```bash
# Start llama.cpp server (example)
./llama-server -m your-model.gguf --port 8080 --host 127.0.0.1
```

Vision models detected automatically: llava, moondream, bakllava, qwen-vl, gpt-4o, gpt-4-vision, claude-3 series, gemma3, qwen2.5-vl.

---

## Supported Formats

### Chat attachments

| Type | Formats | Action |
|------|---------|--------|
| Images | png, jpg, jpeg, gif, bmp, webp | Base64 → preview + send to vision models |
| Documents | pdf, docx, xlsx, pptx, odt, ods, odp, csv, tsv, rtf | Automatic text extraction |
| Plain text | txt, md, json, js, py, html, css, ts, tsx, jsx, xml, yaml, yml, go, rs, c, cpp, java, php, rb, sql, sh, bat, +20 more | Direct read |
| Binaries | zip, exe, mp3, mp4, dll, etc. | Rejected with message |

### Knowledge base

Same formats as attachments except images (cannot be indexed as text).

---

## Security

| Layer | Mechanism |
|-------|-----------|
| API Keys | AES-256-GCM encryption at rest with per-installation salt |
| PII | Sanitize emails, phones, IDs before sending to cloud |
| HTML | Strip script, iframe, object, embed, event handlers, javascript: URLs |
| Files | UUID validation of projectId, path traversal check |
| URLs | http/https whitelist in openExternal |
| App State | Allowed key whitelist, 10 KB per-value limit |
| Context | contextIsolation: true, nodeIntegration: false |
| GPU | Hardware acceleration disabled on Windows only (prevents freeze); enabled on macOS/Linux |

---

## Internal API (IPC)

All channels exposed via `window.mika5`:

```
db.listProjects()               db.createProject(payload)
db.updateProject(id, payload)   db.deleteProject(id)
db.listChats(projectId)         db.createChat(payload)
db.updateChat(chatId, payload)  db.deleteChat(chatId)
db.listMessages(chatId, opts)   db.countMessages(chatId)
db.addMessage(payload)          db.clearChat(chatId)
db.getProjectContext(id)        db.setProjectContext(id, prompt)
db.listKnowledge(projectId)     db.addKnowledgeFromText(payload)
db.deleteKnowledge(itemId)

rag.query(projectId, text, k)
rag.indexKnowledgeItem(knowledgeItemId)

ai.getProviders()               ai.getCurrentProvider()
ai.setProvider(id)              ai.setApiKey(provider, key)
ai.chat(params)                 ai.listModels()
ai.status()                     ai.abort()

ollama.status()  ollama.tags()  ollama.chat(payload)  ollama.pull(model)

getAppState(key)   setAppState(key, value)
openExternal(url)  saveFile(payload)  printToPDF(payload)
```

---

## Usage Flow

1. Open MIKA5 (`npm run dev`)
2. Connects to Ollama and loads available models
3. Create a **project** with an optional system prompt
4. Upload documents to the **knowledge base** (automatically indexed for RAG)
5. Create a **chat** or start typing (created automatically)
6. On message send:
   - RAG queried for relevant context
   - Chunks injected as `system` message
   - Sent to the active model (local or cloud)
   - Response displayed and saved to DB
7. Use **Ctrl+F** to search within the chat
8. Use **Reply** to quote a previous message (WhatsApp-style)
9. **Export** the chat as Markdown, HTML, PDF, text, or Python
10. **Save** individual messages or the full chat as a knowledge document

---

## Folder Structure

```
MIKA5/
├── package.json                  # Dependencies and scripts
├── electron-builder.json         # Cross-platform build config
├── CLAUDE.md                     # Guide for Claude Code
├── README.md                     # This file
├── src/
│   ├── main/
│   │   ├── main.js               # Entry point, IPC, startup
│   │   ├── preload.js            # Secure bridge window.mika5
│   │   ├── db.js                 # SQLite (WAL, migrations)
│   │   ├── ai-providers.js       # Local + cloud providers
│   │   ├── ollama.js             # Ollama HTTP client
│   │   └── rag.js                # RAG engine
│   └── renderer/
│       ├── index.html            # Layout + inline CSS
│       ├── app.js                # Full SPA logic
│       ├── i18n.js               # Internationalization ES/EN
│       ├── styles.css            # Supplemental styles
│       ├── mika5-diagnostic.js   # Diagnostics
│       ├── assets/
│       │   ├── logo.png
│       │   └── icon.png
│       └── vendor/
│           ├── marked.min.js
│           ├── highlight.min.js
│           └── atom-one-dark.min.css
├── build/
│   ├── icon.ico                  # Windows icon (committed)
│   ├── icon.icns                 # macOS icon (gitignored, generated)
│   ├── entitlements.mac.plist    # macOS hardened runtime entitlements
│   └── scripts/
│       ├── postinstall.sh        # .deb post-install hook
│       └── postrm.sh             # .deb post-remove hook
├── scripts/
│   ├── gen-ico.js                # Generate icon.ico from PNG (Electron nativeImage)
│   └── gen-icns.sh               # Generate icon.icns from PNG (macOS sips/iconutil)
├── web/                          # Static landing page
│   ├── landing.html              # Main landing (EN + ES, auto-detect)
│   ├── models.html               # Model guide
│   ├── whitepaper.html           # Technical white paper
│   ├── logo.png, icon.png
│   ├── robots.txt
│   └── sitemap.xml
└── dist/                         # Build output
    ├── *.exe                     # Windows installer + portable
    ├── *.dmg                     # macOS disk image
    ├── *.AppImage                # Linux universal
    ├── *.deb                     # Debian/Ubuntu package
    └── *.rpm                     # Fedora/RHEL package
```

---

## CI/CD

Automated builds run on GitHub Actions (`.github/workflows/build.yml`):

| Job | Runner | Output |
|-----|--------|--------|
| `build-windows` | windows-latest | NSIS installer + Portable .exe |
| `build-macos` | macos-latest | DMG (x64 + arm64) + ZIP |
| `build-linux` | ubuntu-latest | AppImage + .deb + .rpm |
| `release` | ubuntu-latest | GitHub Release with all artifacts |

Triggers:
- **Tag push** (`v*.*.*`): builds all platforms + creates GitHub Release automatically
- **Manual dispatch**: builds all platforms, optionally publishes as release

---

## Known Issues

- `styles.css` is not linked from `index.html` (CSS lives inline in the HTML)
- No token-by-token streaming (responses load fully before display)
- No cloud sync (everything is local)
- No drag-and-drop for files (file picker only)
- macOS builds are unsigned — Gatekeeper will prompt on first launch (right-click → Open)

---

## License

Copyright © 2026 MIKA5

MIKA5 is free software: you can redistribute it and/or modify it under the terms of the
[GNU Affero General Public License v3.0](LICENSE) as published by the Free Software Foundation.

**Key implications of AGPL-3.0:**
- You may use, study, modify, and distribute this software freely.
- If you distribute modified versions — including running a modified version over a network — you **must** release the source code of your modifications under the same AGPL-3.0 license.
- Commercial use is permitted. Enterprises requiring a commercial license without copyleft obligations should contact the maintainers.

The AGPL-3.0 license text is available in the [LICENSE](LICENSE) file.
Trademark rights are governed separately by [TRADEMARK.md](TRADEMARK.md).
