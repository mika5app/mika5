# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
