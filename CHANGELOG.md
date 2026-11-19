# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- BitNet (bitnet.cpp) local provider. It talks to the `llama-server` started by `run_inference_server.py` on `127.0.0.1:8081/v1`, a different port from llama.cpp so both can run at once. Private, no API key, no vision.
- Provider readiness. Every provider now reports the same states (available, needs setup, starting, loading model, ready, unavailable, error) with a suggested action. llama.cpp and BitNet can be started by MIKA5 once the executable and a GGUF model are chosen; Ollama is started with `ollama serve` when it is installed and stopped. Engines started by MIKA5 stop when it quits; servers started by the user are reused and left alone. Nothing is downloaded or installed without confirmation.
- Local engine discovery. MIKA5 finds `llama-server` and the GGUF models already on the machine, including the ones Ollama downloaded, and lists them in the model selector; picking a model starts the engine. Installing llama.cpp through winget or Homebrew and downloading a model from Hugging Face are offered behind a native confirmation dialog.

- Recommended models. When an engine has no model, MIKA5 offers a short catalogue with sizes and a "Download model" button. The download needs your confirmation, shows progress, can be cancelled, and the file is only used if its size and SHA-256 match the published ones.
- New-version notice. "Check for a new version" compares the installed version with the latest stable release published in the public releases repository and shows the release notes and the official download link. It only informs: nothing is downloaded or installed. Checking when MIKA5 opens is off unless you turn it on, and the request carries none of your data.
- Links to the source, the issue tracker and the license inside the application, and `THIRD_PARTY_NOTICES.md` with the licenses of the bundled dependencies.
- An executable for a local engine is only run after you approve it. The approval is tied to the file's real path and SHA-256, so a replaced binary is not executed.
- Discovered models carry a compatibility verdict per engine (compatible, incompatible, unverified). BitNet no longer lists models from Ollama or other architectures.

### Changed
- Conversations no longer stop at a message count. The 25-message warning, the save dialog at 30 and the trim at 40 are gone; what is sent to the model is bounded by the context budget, and the full history stays in the database.
- `CONTRIBUTING.md` now describes how to report issues and send changes while the development repository is not public.

### Fixed
- The header showed "Ollama (Local)" for llama.cpp and BitNet. It now shows the selected provider, and the Ollama model library is only offered with Ollama.
- "Model library" opened Ollama's library whatever provider was selected. Each provider now opens its own official catalogue: Ollama, OpenAI, Claude, Groq, Kimi, Alibaba Cloud Model Studio, Hugging Face GGUF for llama.cpp and the supported-models list for BitNet.
- Claude and Kimi listed models from a list written in the code, with retired Claude identifiers and none of the current ones. Both now ask the provider (`GET /v1/models`) with your key, like OpenAI and Groq. Listing models is not an inference and is not billed. Images are accepted on the current Claude model families.
- BitNet is marked Experimental and no longer asks a user to install Git, Python, CMake or Clang. "Install and start" prepares an engine with one confirmation: engine and model are downloaded, checked against their published size and SHA-256, authorized and started. A prebuilt engine is published for Windows x64 (unsigned, needs AVX2); on other systems MIKA5 says it has none yet; build tools appear only under advanced settings. A bitnet.cpp build already on the machine is found and used.
- Long documents with BitNet: an attached document that does not fit in the model's window is no longer refused. MIKA5 reads it in full, part by part, shows which part it is on, and answers from the notes of every part, saying that it did so. It is slow (minutes) and loses detail compared with a model that reads it at once; very long documents are still refused with an explanation.
- "Analyse the document…" in a chat that had an image earlier no longer sends that old image, which made providers without vision refuse the message.
- BitNet with documents: the engine closed as soon as a document was attached, and the app only said the request could not be completed. It is now started with a batch size it can handle, MIKA5 sends it less text (its window is 4,096 tokens), and a text that still does not fit is refused with a message that says what to do instead of being cut silently. If a local engine closes while answering, the error says so.
- BitNet engine runs: its own launch arguments (CPU only, as its official launcher), an ASCII-only model alias (a non-ASCII one made the server answer HTTP 500), and a 503 during the readiness check now means "still loading" instead of a failure.
- An attached document was dropped when the message used a verb such as "analiza". "Analiza el documento" was routed as image analysis even with no image anywhere, and on that route the message sent to the model was replaced by the typed text alone, without the document. The model then asked for the document to be pasted. A request with no image is now ordinary chat, and the message that carries the attached text is never replaced.
- With llama.cpp selected, the model selector showed a model nobody had chosen or loaded, named as if it belonged to Ollama, and the status said "offline" for an engine that was simply stopped. Engine, model and where the file came from are now separate: a GGUF that Ollama downloaded and llama.cpp serves is "llama.cpp · model", source Ollama. With no model chosen the selector says so instead of showing the first one, and the status is the engine's own: not installed, needs authorization, needs a model, stopped, starting, loading, ready or error.
- Models wrongly marked incompatible are offered again. A model was marked whenever the engine exited, and the usual cause was running out of graphics memory. Only an engine that reports it does not understand the model marks it now, and verdicts stored under the old rule are discarded.
- A local engine is reported ready only after one real inference with the loaded model, not just because the server lists it.
- llama.cpp requests had no output limit: a small reasoning model generated until the five-minute timeout. Requests now carry the same limits as the Ollama path.
- BitNet says plainly that it is not installed and has to be built from source, instead of offering to configure the llama.cpp program.
- llama.cpp closed a few seconds after starting on machines with an integrated GPU. The server reserved the model's maximum context and ran out of graphics memory. MIKA5 now sets the context size, and if the engine exits before serving the model it retries by itself with less context and then on CPU only; it remembers what worked. Running out of memory is reported as such and does not mark the model as incompatible.
- BitNet accepted any program called `llama-server`, including the one from llama.cpp. It now only recognises the engine inside a bitnet.cpp checkout.
- Status checks while an engine loads no longer pile up, slow down as the load gets longer, and stop when the engine is withdrawn after a load deadline. The same failure is logged once, not on every check.
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
