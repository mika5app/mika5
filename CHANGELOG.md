# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- BitNet (bitnet.cpp) local provider. It talks to the `llama-server` started by `run_inference_server.py` on `127.0.0.1:8081/v1`, a different port from llama.cpp so both can run at once. Private, no API key, no vision.
- Provider readiness. Every provider now reports the same states (available, needs setup, starting, loading model, ready, unavailable, error) with a suggested action. llama.cpp and BitNet can be started by MIKA5 once the executable and a GGUF model are chosen; Ollama is started with `ollama serve` when it is installed and stopped. Engines started by MIKA5 stop when it quits; servers started by the user are reused and left alone. Nothing is downloaded or installed without confirmation.
- Local engine discovery. MIKA5 finds `llama-server` and the GGUF models already on the machine, including the ones Ollama downloaded, and lists them in the model selector; picking a model starts the engine. Installing llama.cpp through winget or Homebrew and downloading a model from Hugging Face are offered behind a native confirmation dialog.

- New-version notice. "Check for a new version" compares the installed version with the latest stable release published in the public releases repository and shows the release notes and the official download link. It only informs: nothing is downloaded or installed. Checking when MIKA5 opens is off unless you turn it on, and the request carries none of your data.
- Links to the source, the issue tracker and the license inside the application, and `THIRD_PARTY_NOTICES.md` with the licenses of the bundled dependencies.
- An executable for a local engine is only run after you approve it. The approval is tied to the file's real path and SHA-256, so a replaced binary is not executed.
- Discovered models carry a compatibility verdict per engine (compatible, incompatible, unverified). BitNet no longer lists models from Ollama or other architectures.

### Changed
- Conversations no longer stop at a message count. The 25-message warning, the save dialog at 30 and the trim at 40 are gone; what is sent to the model is bounded by the context budget, and the full history stays in the database.
- `CONTRIBUTING.md` now describes how to report issues and send changes while the development repository is not public.

### Fixed
- The header showed "Ollama (Local)" for llama.cpp and BitNet. It now shows the selected provider, and the Ollama model library is only offered with Ollama.
- Long documents were only read from the start: the first fragments were sent whatever the question, so asking for article 380 of a long code answered that it was not in the documents. Every fragment of every document in scope is now searched for the words of the question, with a meaning-based search as a fallback, and the model is told when it is seeing part of a document.
- Asking to analyse and change an image no longer makes the model report an internal "describe-only-do-not-edit" restriction. The model receives your message unchanged, and MIKA5 says when the provider can analyse images but not edit them.

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
