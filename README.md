# MIKA5 — Sovereign AI Desktop Platform

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.2-green.svg)](https://github.com/mika5app/mika5-releases/releases/tag/v0.3.2)

MIKA5 Community 0.3.2 is a desktop application for local and optional cloud AI, with projects, conversations, attachments and a local SQLite knowledge base.

- [Download Community 0.3.2](https://github.com/mika5app/mika5-releases/releases/tag/v0.3.2)
- [Website](https://mika5.xyz/) · [Model guide](https://mika5.xyz/models.html) · [Technical white paper](https://mika5.xyz/whitepaper.html)
- [Build from source](BUILDING.md) · [Community and license](COMMUNITY.md)

## What's new in 0.3.2

- BitNet (bitnet.cpp) joins Ollama and llama.cpp as an experimental local runtime.
- MIKA5 finds `llama-server` and the GGUF models already on the machine, including the ones Ollama downloaded, and starts the engine when you pick a model. An engine executable runs only after you approve it, and nothing is downloaded or installed without confirmation.
- Every provider reports the same readiness states (needs setup, starting, loading model, ready, error) with a suggested action. A local engine is ready only after one real answer.
- Long documents: every fragment in scope is searched for the words of the question, instead of sending only the first ones.
- Conversations no longer stop at a message count; what is sent is bounded by the model's context.
- "Check for a new version" compares with the latest published release. It only informs; nothing is downloaded or installed.
- Fixed: ordinary messages blocked in conversations with an image, attached documents dropped by "analyse…", and a wrong provider name and model library for llama.cpp and BitNet.

## What 0.3.1 introduced

- Stable provider registry and adapters, clearer availability and model selection, and request cancellation.
- Consent bound to the selected provider, model, request and outgoing data. Ollama supports both local and cloud models, with cloud privacy notices and consent.
- Improved PDF extraction, bounded image downloads, proxy handling and IPC sender validation.
- Electron 43.8.7, better-sqlite3 13.0.3 with N-API, and vendored SheetJS 0.20.3.
- Canonical validation across Windows, macOS Intel, macOS Apple Silicon and Linux, with SHA-256 artifact proofs and real Windows installation/upgrade tests.

## Download and update

The public release contains nine desktop packages: Windows x64 installer and portable executable; macOS Intel/Apple Silicon DMG and ZIP; Linux x64 AppImage, DEB and RPM. It also includes corresponding source, license, build instructions, Community information, build metadata and SHA-256 checksums.

Download the package for your platform and compare its SHA-256 with `SHA256SUMS.txt`. Windows builds have no Authenticode signature; macOS builds are not notarized and may show an operating-system warning.

Updates are manual. Close MIKA5 before running the new installer. Keep a backup of your application data before upgrading. The CI verifies installation and upgrade from the published 0.3.0 Windows installer using synthetic projects, chats, attachments, documents, indexed chunks and preferences.

## Features

- Projects and chats with separate instructions, chat search, replies and message pagination.
- Local knowledge retrieval with document chunking, Ollama embeddings and project/chat isolation.
- Images for supported vision models; document extraction including PDF, DOCX and spreadsheets.
- Export conversations as Markdown, plain text, HTML, Python or PDF.
- Spanish/English interface, dark/light themes and persistent preferences.

Provider capabilities are declared by each adapter. Model availability depends on the configured runtime, provider catalogue and account. Community has no automatic updater, cloud synchronization, mobile client or general background agent.

## AI providers and privacy

| Provider | Inference | Configuration |
|---|---|---|
| Ollama | Local models or Ollama cloud models | Local Ollama runtime; cloud access depends on its configuration |
| llama.cpp | Local | OpenAI-compatible local server, default `127.0.0.1:8080/v1` |
| BitNet ([bitnet.cpp](https://github.com/microsoft/BitNet)) | Local | Its `llama-server`, started with `python run_inference_server.py -m <model>.gguf --port 8081`; MIKA5 expects `127.0.0.1:8081/v1` |
| OpenAI, Anthropic, Groq, Moonshot | Optional cloud | Provider API key |
| Alibaba Cloud Model Studio | Optional cloud | Key, region, endpoint and model catalogue configuration |

For fully local inference, select a locally installed model. An Ollama cloud model still sends data outside the device. MIKA5 displays cloud notices and requires consent for the relevant provider, model and data; consent can be revoked. Conversation history and knowledge are stored locally. Provider credentials are encrypted locally. Automatic PII rewriting is disabled; do not assume prompts are anonymized.

Local document indexing requires Ollama and an embedding model, by default:

```bash
ollama pull nomic-embed-text
```

Ollama is optional for users who only need a configured cloud chat provider. It is not bundled with MIKA5.

## Develop and test

Use Node **22.23.2**, as pinned in `.nvmrc`, and its bundled npm **10.9.8**. Download the corresponding source archive from the public release or use a repository checkout.

```bash
npm ci
npm run dev
npm test
npm run test:all
```

`npm ci` installs native application dependencies and ensures the Electron binary is usable. The full battery contains nine gates covering unit/security tests, database operations, knowledge isolation, Electron UI, downloads, PDF export, provider selection and native bindings. Headless Linux requires Xvfb; see [BUILDING.md](BUILDING.md).

```bash
npm run build:win -- --x64 --publish never
npm run icons:mac
npm run build:mac -- --arm64 --publish never
npm run build:linux -- --x64 --publish never
```

Build each platform on its native runner. Use `--x64` on an Intel macOS runner and a clean output directory per architecture. Build outputs are written to `dist/`.

## Architecture and documentation

| Location | Responsibility |
|---|---|
| `src/main/main.js` | Application lifecycle, trusted IPC handlers and indexing queue |
| `src/main/preload.js` | Restricted `window.mika5` bridge |
| `src/main/db.js` | SQLite/WAL, migrations, projects, chats and knowledge |
| `src/main/ai-providers.js` | Provider management and request dispatch |
| `src/main/provider-registry.js`, `src/main/providers/` | Provider registry and adapters |
| `src/main/ollama.js`, `src/main/rag.js` | Ollama operations and local retrieval |
| `src/renderer/` | Interface, translations and styles |
| `test/`, `scripts/ci/` | Regression tests and deterministic validation |
| `web/` | Website, model guide and white paper |

See [provider architecture](docs/provider-adapter-architecture.md) and the [availability contract](docs/provider-availability-contract.md). Older version-specific documents in `docs/` are historical audits, not a declaration of current release status.

Application data is stored under `%APPDATA%/MIKA5` on Windows, `~/Library/Application Support/MIKA5` on macOS and `~/.config/MIKA5` on Linux. The database is `mika5.db`; knowledge documents live in `knowledge/`. Developer tests use isolated profiles.

## CI and publication

`.github/workflows/_canonical.yml` validates source, audits production/full dependencies, runs Windows/Linux gates and builds four native producers when required. macOS checks use native icon and binary tools. Each producer records hashes, architecture and source commit; the aggregate verifier requires exactly nine packages.

A version tag triggers `.github/workflows/build.yml`. Publication consumes the verified artifact by immutable Actions ID, checks it again, adds corresponding source and documentation, and verifies uploaded bytes before making the release public. Integration and PR validation do not publish releases.

The existing `deploy-landing.yml` deploys `web/` on updates to `main`. Release download links are brought online after the corresponding public release is available.

## License

MIKA5 Community is licensed under [AGPL-3.0](LICENSE). See also the [privacy policy](PRIVACY.md) and the [code signing policy](CODE_SIGNING_POLICY.md); builds are not code-signed yet. Distributed releases include corresponding source and build instructions. Trademark rights are separate; see [TRADEMARK.md](TRADEMARK.md). Future Pro/Cloud editions and services are not included in Community.
