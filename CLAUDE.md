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
  It runs six gates and propagates a non-zero exit code; it does not tolerate failures.
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
| `npm-test` | node — chains every non-Electron suite, including `test:ci-gates` and `test:palette` |
| `db` | electron |
| `knowledge-scope` | electron |
| `electron-security` | electron |
| `electron-renderer-integration` | electron |
| `image-download-electron` | electron |

Every Electron suite builds its own temporary userData directory. None of them reads or
writes the real user profile.

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
signal the capability is not claimed.

`assertVisionSupported()` fails closed and returns a specific reason, so the UI can say
why an image was refused instead of failing generically.

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

## RAG and embeddings

`rag.js` chunks documents, embeds them through Ollama and searches by cosine similarity
with an in-memory cache. `checkEmbeddingModelAvailable()` is consulted before indexing, so
a missing embedding model produces an explicit availability error instead of empty
results.

The cache key covers all three scope components (project, chat, whether project-level
documents are included). Every route that changes indexed content invalidates it.

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
- Print-to-PDF is not integrated: it has no tests
- Cross-platform behaviour is verified locally on Windows only; the Ubuntu leg of the
  gates has not been run on this branch

## Requirements

- Node.js + npm
- Ollama running locally on `http://127.0.0.1:11434`
- Embedding model installed (recommended: `nomic-embed-text`)
- At least one Ollama chat model (llama, qwen, etc.)
