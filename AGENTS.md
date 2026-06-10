# AGENTS.md — MIKA5 Sovereign AI Desktop Platform

## Project identity

MIKA5 is a sovereign AI desktop platform built with Electron 31, vanilla JavaScript, better-sqlite3, marked, highlight.js, Ollama/local providers, and optional cloud providers.

Primary architecture:

- Main process: `src/main/`
- Renderer process: `src/renderer/`
- Database: `src/main/db.js`
- AI provider management: `src/main/ai-providers.js`
- Local Ollama client: `src/main/ollama.js`
- RAG engine: `src/main/rag.js`
- Secure preload bridge: `src/main/preload.js`

## Non-negotiable working rules

1. Do not invent files, routes, imports, commands, IPC channels, schemas, providers, or scripts.
2. Before editing, perform read-only discovery.
3. Never touch secrets, credentials, `.env`, private keys, API keys, tokens, local databases, or user data unless explicitly authorized.
4. Never expand scope silently.
5. If the requested task requires files outside the allowed scope, stop and return `SCOPE_EXPANSION_REQUIRED`.
6. If the codebase does not contain enough evidence, stop and return `NEEDS_MORE_CONTEXT`.
7. Prefer small, auditable changes over broad refactors.
8. Preserve the local-first/privacy-first design of MIKA5.
9. Do not weaken context isolation, preload boundaries, IPC validation, provider privacy indicators, encryption, PII sanitization, RAG isolation, or SQLite safety.
10. Do not modify build/release configuration unless the task explicitly targets packaging or release.

## Required loop

Every task must follow:

1. L0_TRIAGE
2. L1_DISCOVERY_READ_ONLY
3. L2_SCOPE_PACKET
4. L3_IMPLEMENTATION
5. L4_LOCAL_GATES
6. L5_REVIEW_VERDICT
7. L6_HANDOFF

## Required output format

Every non-trivial task must end with:

```text
VERDICT: PASS | FAIL | NEEDS_MORE_CONTEXT | SCOPE_EXPANSION_REQUIRED

SUMMARY:
- ...

FILES_CHANGED:
- ...

COMMANDS_RUN:
- ...

GATES:
- ...

RISKS:
- ...

NEXT_STEP:
- ...
```

## MIKA5 risk zones

High-risk files:

- `src/main/main.js`
- `src/main/preload.js`
- `src/main/db.js`
- `src/main/ai-providers.js`
- `src/main/ollama.js`
- `src/main/rag.js`
- `src/renderer/app.js`
- `package.json`
- Electron builder / packaging config
- Any file touching IPC, provider keys, encryption, local storage, RAG indexing, attachment parsing, export, or database migrations

High-risk changes require explicit scope and local gates.

## Default gates

For JavaScript or Electron changes:

```bash
npm test
```

When relevant:

```bash
npm run build
```

If a command is unavailable or fails because of environment limits, report it explicitly. Do not mark as passed.
