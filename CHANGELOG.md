# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-11-18

### Added
- BitNet (bitnet.cpp) local provider. It talks to the `llama-server` started by `run_inference_server.py` on `127.0.0.1:8081/v1`, a different port from llama.cpp so both can run at once. Private, no API key, no vision.

### Fixed
- Ordinary messages are no longer blocked in a conversation that holds an image. On providers that cannot generate images, a message was refused with "El proveedor actual no soporta edición o variación de imágenes" for any model; it is now sent as normal chat, and an attached image still goes through the vision check. Common words such as "esta" or "queda" no longer count as image-edit commands.
- llama.cpp and BitNet: a server that is still loading its model (HTTP 503) is no longer shown as offline, the "not running" hint with the start command now reaches the user, and HTTP errors keep their status code. The start hint names `llama-server`.

## [0.3.1] - 2026-11-07

### Changed
- Provider registry/adapters, availability reporting, model selection and request cancellation stabilized.
- Ollama local and cloud models supported with explicit cloud notices and consent tied to provider, model, request and outgoing data.
- Electron updated to 43.8.7; better-sqlite3 13.0.3 uses N-API; SheetJS 0.20.3 vendored.
- Canonical Node 22.23.2/npm 10.9.8 workflow validates four native producers and nine packages using hashes, source commit and architecture proofs.
- Website, bilingual model guide, white paper and contributor documentation updated for 0.3.1.

### Fixed
- PDF extraction, bounded image downloads, DNS/proxy handling and trusted IPC sender validation.
- Windows installation/upgrade verification with real installers and synthetic AppData; ASAR metadata refreshed after package replacement.

### Security and privacy
- Renderer remains sandboxed with context isolation and no Node integration.
- Automatic PII rewriting is disabled; cloud consent does not imply anonymization.
- Windows/Linux run nine quality gates; macOS icon and architecture checks run natively.
- Windows binaries remain unsigned and macOS builds are not notarized. Updates are manual.

Earlier entries below are historical records and may describe behavior superseded by 0.3.1.

## [0.1.0] - 2026-03-29

### Added
- Chat with local AI models via Ollama (llama, qwen, mistral, gemma, phi, etc.)
- Chat with cloud providers: OpenAI, Anthropic, Groq, Moonshot
- llama.cpp local server support (OpenAI-compatible)
- Project-based organization with custom system prompts
- Multiple chats per project with rename and move between projects
- Per-project and per-chat knowledge base
- Local RAG engine: automatic document chunking, embeddings via nomic-embed-text, cosine similarity search
- Background knowledge indexing with sequential queue
- Automatic RAG reindexing on startup
- Privacy indicators: Private (local) vs Cloud per provider
- Vision model auto-detection (LLaVA, Gemma3, Qwen2.5-VL, GPT-4o, Claude-3, etc.)
- Image attachments with inline preview and zoom modal
- Document text extraction: PDF, DOCX, XLSX, PPTX, ODF, CSV, RTF
- Plain text file support: 30+ extensions (JS, PY, HTML, CSS, JSON, MD, TS, etc.)
- Chat search (Ctrl+F) with highlighting and navigation
- Message reply (WhatsApp-style) with scroll-to-quoted
- Export: Markdown, Text, HTML, Python, PDF
- Save messages or full chats as knowledge documents
- Download Ollama models from UI
- Cancel in-progress generation (Stop button)
- Progressive context management with automatic history trimming
- Dark/light theme with persistent toggle
- Internationalization: Spanish (default) and English
- AES-256-GCM encryption for cloud API keys
- PII sanitization before sending to cloud providers
- HTML sanitization (XSS prevention)
- Cross-platform builds: Windows (NSIS), macOS (DMG), Linux (AppImage/deb/rpm)
- CI/CD via GitHub Actions with automatic releases

### Security
- Electron context isolation enabled, node integration disabled
- Prepared statements for all database queries (SQL injection prevention)
- URL protocol whitelist for external links
- File path validation with UUID check and traversal protection
- Per-installation encryption salt
