# MIKA5 Community 0.3.1 Architecture

MIKA5 uses Electron 43.8.7 with a sandboxed renderer, a restricted preload bridge and a main process that owns providers, SQLite and file/network operations. This document describes the current contributor-facing structure; version-specific audits in `docs/` remain historical records.

## Processes and boundaries

The renderer in `src/renderer/` manages conversations, projects, attachments, translations and interface state. It calls the `window.mika5` API exposed by `src/main/preload.js`; it has no direct Node.js access.

`src/main/window-security.js` sets `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. The trusted IPC wrapper accepts only registered web contents, their main frame and the application renderer URL. `src/main/main.js` owns lifecycle, handlers, provider setup and indexing queues. Database/native modules run in the main process; they do not require disabling the renderer sandbox.

## Providers and request privacy

`src/main/ai-providers.js` manages providers through `src/main/provider-registry.js`. Eight adapters live in `src/main/providers/`: Ollama, llama.cpp, BitNet, OpenAI, Anthropic, Groq, Moonshot and Alibaba Cloud Model Studio. llama.cpp and BitNet are two configurations of the same `llama-server` client in `providers/llama-server.js`. Credentials, runtime behavior and errors are separated into the corresponding `provider-credentials.js`, `provider-runtime.js` and `provider-errors.js` modules.

Ollama can provide local or cloud inference. `src/main/request-privacy.js` resolves the selected model's privacy and validates cloud consent. The renderer captures request identity and approval before dispatch; changing the visible provider while approval is pending must not reroute that request. Cloud consent is tied to the provider, model, request and data scope. Automatic PII rewriting is disabled, so consent must not be interpreted as anonymization.

Capabilities are declared through the provider contracts. Model availability depends on runtime connectivity, configuration and account access. See [adapter architecture](docs/provider-adapter-architecture.md) and the [availability contract](docs/provider-availability-contract.md).

## Storage and retrieval

`src/main/db.js` uses better-sqlite3 13.0.3 with N-API, WAL and foreign keys. The database contains `projects`, `chats`, `messages`, `knowledge_items`, `knowledge_chunks` and `app_state`. Application data and knowledge files belong to the active user profile; tests use isolated profiles.

`src/main/rag.js` splits text into 4,200-character chunks with 700-character overlap, embeds through Ollama using `nomic-embed-text` by default, and ranks stored vectors by cosine similarity. Retrieval is scoped by project/chat. Its in-memory embedding cache has a five-minute TTL. Background indexing uses the queue managed by the main process.

## Documents, downloads and export

Document handling is split across renderer operations and validated main-process handlers. Generated image downloads pass through `src/main/network-security.js`, with destination checks, bounded redirects/body sizes, deadlines and image-byte validation. PDF export uses the dedicated print window and export modules. Conversation exports support Markdown, plain text, HTML, Python and PDF.

## Validation and distribution

`npm test` runs the Node regression suites; `npm run test:all` runs nine gates including database, knowledge isolation, Electron security/UI, image download, PDF export, provider selection and native bindings. Linux headless testing uses Xvfb.

The reusable canonical workflow audits source/dependencies and builds Windows x64, macOS Intel, macOS Apple Silicon and Linux x64 on native runners. macOS uses native icon and binary tooling. Producers create `artifact-proof.json`; aggregate verification requires exactly nine packages bound to hashes, architecture and source commit.

Windows installation QA runs only on disposable GitHub-hosted runners and uses published 0.3.0 bytes plus synthetic data to test upgrading. Its documented baseline preparation avoids an old NSIS folder-lookup issue; the current install is tested cleanly first.

Tag publication consumes the verified Actions artifact by ID, adds corresponding source/documentation/checksums and verifies uploaded bytes before publishing. The separately deployed static site in `web/` is outside the Electron package. See [BUILDING.md](BUILDING.md) for reproducible commands.
