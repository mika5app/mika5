# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MIKA5 is an Electron desktop app for working with local AI models (Ollama), organized by projects, chats, and knowledge documents, with a fully local RAG engine backed by SQLite. It also supports cloud AI providers with explicit consent before anything leaves the machine.

Language: Spanish (UI text, comments, and README are in Spanish).

## Commands

Standard scripts (`dev`, `build`, `test`) live in `package.json`. Non-obvious:

- `npm install` runs a postinstall (`electron-builder install-app-deps`) that rebuilds
  native modules against Electron — a plain `npm ci` is not enough.
- `npm run test:db` and every `test:electron-*` script need `npx electron`, not plain node.
- `npm run test:all` is the canonical local gate battery (`scripts/run-stage0a-gates.sh`).
  It runs seven gates and propagates a non-zero exit code; it does not tolerate failures.
- `npm run knowledge:preflight` and `npm run knowledge:repair` both point at
  `scripts/knowledge-scope-repair.js`. The script decides what to do from its
  arguments — see "Knowledge scope tooling" below.

No linter is set up.

## Quality gates — NO GREEN, NO MERGE

Nothing merges unless every applicable gate is green. It is forbidden to force a merge,
skip a gate, disable a test, mark a job as allowed-to-fail, reduce coverage, change an
expectation so a failure disappears, classify a failure as flaky without evidence, or
promise a fix in a later commit.

Local battery (`npm run test:all`):

| Gate | Runner |
|---|---|
| `npm-test` | node — chains every non-Electron suite, including `test:ci-gates`, `test:palette` and `test:ipc-contracts` |
| `db` | electron |
| `knowledge-scope` | electron |
| `electron-security` | electron |
| `electron-renderer-integration` | electron |
| `image-download-electron` | electron |
| `print-pdf-electron` | electron |

Every Electron suite builds its own temporary userData directory. None of them reads or
writes the real user profile.

`test/ipc-contracts.test.js` checks that every channel `preload.js` invokes has
exactly one `ipcMain.handle` registration. It exists because the opposite
already happened: a reorganisation of `main.js` dropped `app:printToPDF` while
preload kept exposing it, and PDF export silently degraded to HTML with every
gate green. One pre-existing exception is listed explicitly in the test —
`debug:ragState`, exposed since before this branch, never handled and never
called; it has to be removed in its own commit.

`test/ci-gates.test.js` is the gate that guards the gates: it checks that the scripts still
exist, that `npm test` still chains them, that the canonical script has no
`continue-on-error` / `|| true` escape hatch, and that the packaging jobs in
`.github/workflows/build.yml` depend on the `quality-gates` job.

CI runs `quality-gates` on `ubuntu-latest` and `windows-latest` with `fail-fast: false`,
and release packaging depends on it. **The remote CI has not been run for the current
branch** — treat cross-platform results as unverified until it is.

## Architecture — non-obvious wiring

Standard Electron two-process split (`src/main/`, `src/renderer/`). What the file layout
does *not* tell you:

- `preload.js` is the **only** bridge to Node. Nothing in the renderer may reach Node
  directly — every new capability goes through a `window.mika5.*` channel defined there.
- Cloud API keys are encrypted at rest with AES-256-GCM in `ai-providers.js`.
- `db.js` runs SQLite in WAL mode with foreign keys ON — both are required, not defaults.

## Cloud requests — policy (do not "fix" this)

- Cloud requests preserve the exact accepted content after informed consent.
  Automatic PII redaction is disabled by default. Any future redaction must be
  opt-in, visible and auditable, and must never silently alter code, logs or documents.
- Cloud consent must disclose whether the request includes conversation history,
  project instructions, attachments, images or local RAG context.

`AIProviderManager` sets `this.sanitizeCloud = false` and passes it to every provider;
the `sanitize = true` defaults in the provider `chat()` signatures are dead defaults,
never reached. Do not re-enable sanitization by default and do not describe MIKA5 as
sanitizing prompts.

`src/renderer/cloud-consent.js` builds the disclosure from an explicit scope
(`message`, `history`, `projectInstructions`, `textAttachments`, `imageAttachments`,
`ragContext`) and reports counts and RAG document titles. Adding a new kind of payload
means adding it to that scope, otherwise the consent dialog silently understates what
leaves the machine.

## Provider capabilities

`src/main/provider-capabilities.js` holds one contract per provider instead of scattered
`if (provider === ...)` checks. A capability the contract does not declare is false.

Vision resolution is driven by a per-provider policy (`none`, `probe`, `catalog`,
`allowlist`, `pending`), not by a single hardcoded model list. Alibaba Cloud Model Studio
uses the `catalog` policy: the model catalogue decides, so a newly released model works
without editing a closed allowlist. `llamacpp` declares `vision: false` on purpose — the
server does not expose whether a multimodal projector is loaded, and without a reliable
signal the capability is not claimed. `bitnet` shares that client (`providers/llama-server.js`)
and that policy; it listens on `127.0.0.1:8081/v1`, not BitNet's default 8080, so llama.cpp
and BitNet never answer each other's probes.

`assertVisionSupported()` fails closed and returns a specific reason, so the UI can say
why an image was refused instead of failing generically.

## Provider readiness and local engines

`getReadiness()` in `ai-providers.js` is a view over `getAvailability()`, not a second
model: the eight `UI_STATE` values still say what happened, and `readiness`
(`available`, `needs-setup`, `starting`, `loading-model`, `ready`, `unavailable`,
`error`) plus `action` say where the user stands and what they can do. It is the same
for a local engine and a remote API.

Local adapters declare their own `engine`; there is no second provider registry.
`src/main/local-engines.js` only locates an executable, starts it and stops what it
started:

- the executable name comes from a closed list (`ollama`, `llama-server`); a path the
  user picks is accepted only if its file name is on that list
- `spawn` with separate arguments and `shell: false`, loopback only
- nothing is started if something already listens on the port, so a server the user
  launched by hand is reused and never duplicated
- only processes MIKA5 started are stopped, on `will-quit`; switching provider does not
  stop an engine
- a failed start is not retried by polling, only by the user
- nothing is downloaded or installed without a native confirmation dialog

llama.cpp and BitNet are managed engines. `src/main/engine-discovery.js` finds
`llama-server` (PATH, winget, scoop, Homebrew, `~/<repo>/build/bin`) and GGUF models
(llama.cpp cache, Hugging Face cache, LM Studio, Jan, a `models` folder in a clone, and
the blobs Ollama already downloaded). It only reads known folders, with depth and entry
caps, and validates the GGUF magic bytes instead of trusting the extension. Discovered
models are offered in the model selector; picking one starts the engine with it, and
picking another restarts an engine MIKA5 owns. The renderer only sees model names — paths
stay in the main process, and a model or executable that was not discovered is rejected.
A manual choice still goes through a native dialog. The choice is stored in `app_state`
as `engine_<providerId>`. An Ollama blob is not guaranteed to load in llama.cpp: some use
architectures only Ollama understands, and that is only known when loading.

Installing an engine (`winget`/`brew`, llama.cpp only) and downloading a model
(`llama-server -hf`, llama.cpp only) each require a native confirmation dialog opened by
the main process. BitNet has no package, so only its official guide is offered. Ollama is an external service: MIKA5
reuses it and starts `ollama serve` only when it is installed, stopped, not managed by
systemd and `OLLAMA_HOST` is unset or points at loopback on 11434. `OLLAMA_HOST` is never
overridden.

`autoStart` is honoured only for the provider being queried and only when the IPC
argument is literally `true`. `MIKA5_ENGINE_AUTOSTART=0` turns every automatic start off.

Not verified: a real `llama-server` or bitnet.cpp binary. `test/provider-readiness.test.js`
drives the real manager and adapters against `test/helpers/fake-llama-server.js`, a child
process that speaks the same protocol including the 503 while loading.

An engine executable is never spawned without the user's approval. `ai:approve-engine`
shows a native dialog with the real path, size and SHA-256; the approval is stored with
that identity and `diagnosticar()` recomputes the hash right before spawning, so a
replaced file or a retargeted link is not executed. A discovered or hand-picked
executable has no approval until the user gives it.

Each discovered model carries a compatibility verdict for the engine (`compatible`,
`incompatible`, `unverified`), from the architecture the GGUF declares and, above that,
from what happened when the engine loaded it. `unverified` means nobody checked — it is
not "probably fine". Incompatible models are not offered.

Starting an engine. `llama-server` is always given `--host`, `--port`, `-c` and `-np 1`:
its default port changes between builds (8080, 9931) and without `-c` it reserves the
model's maximum context, which exhausts an integrated GPU. The adapter declares launch
variants from most to least demanding (`{ctx:16384}`, `{ctx:8192}`, `{ctx:8192, cpu}`); if
the process exits before the model is served, the next variant is tried, and the one that
worked is stored per model. stderr is kept (bounded) to classify the exit:
`ENGINE_OUT_OF_MEMORY`, `ENGINE_MODEL_UNSUPPORTED` (not retried) or `ENGINE_EXITED`. Only
the last two mark a model incompatible. A load deadline withdraws an engine that never
finishes loading, so the interface never waits forever. A 503 is never treated as ready.

BitNet's engine is the `llama-server` built by bitnet.cpp. It is recognised by living
inside a bitnet.cpp checkout (`run_inference_server.py` in an ancestor), not by its name.

`src/main/model-download.js` downloads only what an adapter's catalogue declares
(repository, exact revision, file, size, SHA-256). The renderer sends a catalogue id,
never a URL. The file goes to `<userData>/models` through a `.part` file and is kept only
if size and SHA-256 match. One download at a time, with progress and cancel, behind a
native confirmation dialog.

Measured on Windows with the real winget `llama-server` and a GGUF Ollama had already
downloaded: ready in about 11 s and a chat answered. Not measured: a real bitnet.cpp
engine, a real catalogue download, Linux and macOS.

Three identities, never merged. For a managed engine the model id is `<engine> · <model>`
(`llama.cpp · llama3.2:3b`), `label` is the model name and `source` is where the file came
from (Ollama, Hugging Face, LM Studio, MIKA5, manual). That id is what is stored with a
message, so history shows which engine answered. A GGUF from Ollama is not "an Ollama
model" and is not assumed incompatible because of its origin. `engine.selectedModel` is
looked up by file path; if that file is no longer offered there is no selected model, and
the renderer shows "pick a model" instead of the first entry or the last model used with
another provider.

`engine.status` (`not-installed`, `needs-approval`, `needs-model`, `stopped`, `starting`,
`loading`, `ready`, `error`) is what the status pill shows for a managed engine. "Offline"
says nothing about an engine MIKA5 starts on demand. `ready` requires one real inference
against the engine MIKA5 started (`_probarInferencia`, once per start, non-blocking);
until it answers the state is `loading`, and if it fails the engine is withdrawn with
`ENGINE_INFERENCE_FAILED`. Verdicts are versioned (`verdicts`): an `incompatible` stored
by an older rule is dropped on load, because it was recorded for any exit, including
running out of memory. Only `ENGINE_MODEL_UNSUPPORTED` marks a model now.

llama-server requests carry `max_tokens: 4096` and `enable_thinking: false`, the same
limits as the Ollama path. Measured without them: a small reasoning model generated until
the five-minute timeout.

## Model libraries and catalogues

Each adapter declares `libraryUrl`, the provider's own official page for browsing models.
The renderer holds no library URL: it opens the one the main process returned for the
selected provider, so no provider can inherit another's. A test asserts that only Ollama
links to ollama.com and that the renderer contains no such URL.

Catalogues are asked from the provider, never hardcoded: Ollama `/api/tags`, OpenAI, Groq,
Moonshot `GET /models`, Anthropic `GET /v1/models` (paginated with `after_id`), llama.cpp
and BitNet `/v1/models` plus the GGUF files found on disk. Listing is not an inference.
Moonshot is queried at the same base URL the chat uses; a key is never sent to another
host. Alibaba keeps its user-configured catalogue: its list-models API needs a workspace
id and region that MIKA5 does not have. When a catalogue cannot be read the provider shows
its error; there is no fallback list and no fallback to another provider.

BitNet is experimental. `engine.runtimes` lists prebuilt engines MIKA5 may install
(exact URL under the public releases, size, SHA-256). One is published: Windows x64, a
static AVX2 build of bitnet.cpp's `llama-server`, unsigned, so Smart App Control may block
it and MIKA5 does not work around that. Linux and macOS have none.
`prepareEngine()` is "Install and start": one native confirmation, then engine and model
are downloaded through `model-download.js`, verified, approved with the verified hash and
started. Without a runtime for the system the dialog says so and offers nothing. A local
bitnet.cpp build is still discovered. Measured with the real engine: it needs its own
launch arguments, an ASCII-only `--alias` (a non-ASCII one makes `/v1/models` answer 500),
and it lists the model before it finishes loading, so the readiness probe treats a 503 as
"still loading". `BUILDING.md` records the build that works on Windows and why.

BitNet's window is 4,096 tokens and its engine has two failure modes MIKA5 has to avoid,
both measured. With the default batch size it overflows the stack and exits (`0xC00000FD`)
once the input passes a few hundred tokens, so it is launched with `-b 32`. And what does
not fit in the window it cuts from the middle without saying so. So the adapter declares
`engine.contexto`; `getCapabilities()` exposes it as `contextBudget`, the renderer picks
fewer document fragments and less history for that provider (it can only lower the general
budget), and before sending, the adapter asks the engine itself (`/tokenize`, `/props`) and
refuses with `PROVIDER_CONTEXT_EXCEEDED` what still does not fit. The answer is capped to
what is left of the window. A provider without `contexto` is untouched.

BitNet has no installer and no prebuilt binaries. `comprobarRequisitos()` reports which
build tools are present (Git, Python, CMake, Clang, including the ones Visual Studio
installs) without running any of them, and the dialog shows what is missing.

## Update notice

`src/main/update-check.js` only informs. It asks the public releases repository for the
latest stable release, compares `x.y.z` numerically, and accepts a result only if the tag
is a version and the link points at the official repository. It sends no user data. The
request happens when the user presses "Check for a new version", or when MIKA5 opens if
they turned that on (`updates.autoCheck`, off by default). There is no `electron-updater`
and nothing is downloaded or installed: builds are not signed, so an automatic install
could not verify the package.

## Cancellation

`src/main/request-registry.js` keeps one `AbortController` per request id
(`start` / `finish` / `abort` / `has`). The renderer generates the id in
`src/renderer/request-context.js` and must pass **the same id** to `ai:abort` that it
passed to `ai:chat` — the renderer integration suite asserts exactly that, because an
abort with the wrong id silently does nothing.

## Attachments

`db.js` accepts a closed set of media types (`image/png`, `image/jpeg`, `image/jpg`,
`image/webp`) and serializes attachments with the message. Anything else is rejected as
`ATTACHMENT_INVALID`.

## Outbound requests and image downloads

`src/main/network-security.js` validates every outbound URL before it is used:

- HTTPS only, no credentials embedded in the URL
- private, loopback, link-local and unique-local IPv4/IPv6 ranges are refused
- redirects are followed manually and **revalidated on each hop**
- response size and total timeout are bounded
- the media type is decided from the magic bytes, not from `Content-Type`
- the destination path is validated before anything is written

Limits worth knowing, because the code does not pretend otherwise:

- This is **not** complete SSRF protection.
- There is **no** protection against DNS rebinding: the address is resolved and validated,
  but the effective IP used by the request is not pinned.
- `downloadHttpsPinned()` does pin the resolved address, but it is **not** the production
  download path; `fetchElectronImage()` is.
- Generated images are not durably persisted. Do not describe them as saved.

## PDF export

`app:printToPDF` renders into an isolated local window (`print.html`, offscreen,
`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`), sanitizes
the payload with the vendored DOMPurify, blocks `window.open` and navigation,
and prints with `webContents.printToPDF`. The body lives in
`src/main/print-export.js` so the Electron suite can drive the exact handler
`main.js` registers without booting the app.

Printable content can contain generated images whose URL is a signed remote link
(`?OSSAccessKeyId=…&Signature=…`). If the print window loaded those, every export
would emit an outbound request carrying that signature. So the flow runs in two
phases:

1. `MIKA5Print.inspect(html)` sanitizes in memory and returns the distinct remote
   image URLs **without touching the document**, so nothing is requested.
2. The main process downloads each one through `fetchElectronImage` — the same
   primitive the image-download path uses — and hands back `url → data:` URIs.
   `MIKA5Print.render()` sanitizes again, substitutes, verifies no `http:`/
   `https:` survives, and only then writes to the DOM.

`print.html` declares `img-src 'self' data:` with no network origin. The print
window performs no outbound requests; the suite asserts that with a session
request counter.

Failures are not silent: a remote image that expired, was refused by policy,
exceeded a limit or returned an invalid type fails the whole export with a
normalized code. There is no partial PDF. The renderer only ever receives a code
from `PRINT_ERRORS`, never an internal message, path or signed URL, and the log
records origin plus pathname with the query stripped.

Limits are exported constants: at most 20 distinct remote images, 8 MiB each,
32 MiB in total, concurrency 2, and a shared 60 s deadline. Identical URLs are
deduplicated and counted once.

The print window is closed by awaiting its `closed` event, with `destroy()` as a
bounded fallback. A bare `destroy()` looks safer but breaks the *next* offscreen
window's `loadFile` with `ERR_FAILED (-2)`, so the second export of a session
would fail — measured, not assumed.

What this does **not** solve: images are converted to `data:` only for the
duration of the export and never cached or persisted, so durable storage of
generated images is still pending; chats whose signed links already expired
cannot be exported; and the limitations of the reused network primitive still
apply — no protection against DNS rebinding, the effective IP is not pinned, and
system proxies are outside its control.

## RAG and embeddings

`rag.js` chunks documents, embeds them through Ollama and searches by cosine similarity
with an in-memory cache. `checkEmbeddingModelAvailable()` is consulted before indexing, so
a missing embedding model produces an explicit availability error instead of empty
results.

The cache key covers all three scope components (project, chat, whether project-level
documents are included). Every route that changes indexed content invalidates it.

## Which fragments go with a question

A long document does not fit in the model's context, so the send path picks fragments.
`src/main/knowledge-retrieval.js` scores every fragment in scope against the words of the
question (accent-insensitive, numbers never dropped, exact references such as
"artículo 380" matched with word boundaries) and returns the best ones in document order,
within the character budget. It is lexical on purpose: it does not depend on an embedding
model being loaded. If the words find nothing, the renderer falls back to the existing
embedding search (`rag.query`) over the same scope, and only then to the first fragments.

Scope is applied before ranking: a question never widens what a request may see. Each
fragment carries `doc_chunks`, and the prompt tells the model when it is seeing part of a
document, so it does not claim that what it was not shown does not exist.

Not solved: a task that needs the whole of a long document at once (a full summary, a
complete comparison) still receives only the fragments that fit. Scanned PDFs are OCR'd
up to 20 pages.

## Knowledge/RAG scope

A knowledge document belongs to a project, and optionally to one chat. Retrieval returns
project-level documents plus the current chat's documents — never a sibling chat's.

- The scope query joins `knowledge_items` and `knowledge_chunks` on project **and** chat,
  and requires the chat to belong to the project.
- Moving a chat to another project is transactional: chats, knowledge items, knowledge
  chunks and the files on disk move together, or nothing moves.
- Files are staged with `COPYFILE_EXCL` to deterministic unique destinations and verified
  by SHA-256 before the originals are removed. The filesystem and SQLite cannot be updated
  atomically together, so the order is: copy, verify, commit the transaction, then clean up.
- A chat/project mismatch throws `INVALID_CHAT_PROJECT_SCOPE`. Validation fails closed.
- Quick Chat has no unambiguous destination project. The tooling reports
  `QUICK_CHAT_DESTINATION_POLICY: AMBIGUOUS` and does not invent one.

### Knowledge scope tooling

`inspectKnowledgeScopeRepair()` is read-only and reports what is misaligned.
`executeKnowledgeScopeRepair()` is the only function that writes, and it is never called
from `initDb()` — startup must not migrate a user's data behind their back.

`scripts/knowledge-scope-repair.js` is the CLI in front of both. Its arguments are strict:
inspection is the default, writing requires an explicit confirmation token, and operating
on the real user profile requires an explicit opt-in flag. Missing or malformed arguments
fail closed rather than defaulting to a write.

## Key data flow

1. User sends message → renderer saves to DB, queries RAG (`rag.query(projectId, text, k=3)`),
   injects matching chunks as a `system` message
2. Calls the active provider via `window.mika5.ai.chat()` or legacy `window.mika5.ollama.chat()`
3. Response displayed and saved to DB
4. Knowledge documents: saved → written to disk → indexed in background (chunked +
   embedded) → available for RAG queries

## Known limits

- `mika5-desktop/` has different Electron/builder versions (experimental, unused)
- Most CSS lives inline in `index.html`; `styles.css` holds shared rules, and the renderer
  also sets colors inline — a palette change has to be applied in all three places, which
  is what `test/palette.test.js` enforces
- Generated images are not durably persisted, so exporting an old chat whose
  signed links have expired fails instead of printing
- Cross-platform behaviour is verified locally on Windows only; the Ubuntu leg of the
  gates has not been run on this branch

## Requirements

- Node.js + npm
- Ollama running locally on `http://127.0.0.1:11434`
- Embedding model installed (recommended: `nomic-embed-text`)
- At least one Ollama chat model (llama, qwen, etc.)
