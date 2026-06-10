---
name: mika5-loop
description: Use this skill for any MIKA5 codebase task that requires discovery, planning, implementation, review, gates, or handoff. It enforces the MIKA5 controlled agent loop and prevents silent scope expansion.
---

# MIKA5 Controlled Loop Skill

Use this workflow for MIKA5 tasks.

## L0_TRIAGE

Classify the task before doing work.

Return one of:

- `DOCS_ONLY`
- `READ_ONLY_DISCOVERY`
- `LOW_RISK_UI`
- `MAIN_PROCESS_CHANGE`
- `IPC_SECURITY_CHANGE`
- `DB_MIGRATION_CHANGE`
- `AI_PROVIDER_CHANGE`
- `RAG_CHANGE`
- `BUILD_RELEASE_CHANGE`
- `UNKNOWN_RISK`

If risk is unknown, default to stricter handling.

## L1_DISCOVERY_READ_ONLY

Before editing:

1. Inspect relevant files.
2. Identify existing patterns.
3. Identify exact files needed.
4. Identify tests or gates.
5. Identify unknowns.

Allowed read-only commands include:

```bash
pwd
git status --short
find . -maxdepth 3 -type f
grep -R "pattern" -n src package.json
npm test
```

Do not edit during discovery.

## L2_SCOPE_PACKET

Before implementation, produce a scope packet:

```text
TASK:
...

RISK_CLASS:
...

ALLOWED_FILES:
- ...

FORBIDDEN_FILES:
- ...

COMMANDS_ALLOWED:
- ...

COMMANDS_FORBIDDEN:
- ...

ACCEPTANCE_CRITERIA:
- ...

EXPECTED_GATES:
- ...

STOP_CONDITIONS:
- NEEDS_MORE_CONTEXT if ...
- SCOPE_EXPANSION_REQUIRED if ...
```

Do not proceed if the task lacks enough context.

## L3_IMPLEMENTATION

Implement only inside `ALLOWED_FILES`.

Rules:

- Make the smallest correct change.
- Follow existing architecture.
- Do not refactor unrelated code.
- Do not add dependencies unless explicitly approved.
- Do not change package/build/runtime behavior unless in scope.
- Do not touch secrets or user data.
- Preserve privacy indicators and local/cloud provider separation.
- Preserve Electron context isolation and preload boundaries.
- Preserve SQLite migration safety.
- Preserve RAG project isolation.

## L4_LOCAL_GATES

Run the gates identified in L2.

Default:

```bash
npm test
```

If packaging or Electron build is affected:

```bash
npm run build
```

If a gate cannot run, report:

```text
GATE_NOT_RUN:
- command:
- reason:
```

Never claim a gate passed if it was not run.

## L5_REVIEW_VERDICT

Review the final diff.

Required checks:

- Scope respected
- No unrelated files changed
- No secrets touched
- No broad refactor
- No invented imports/routes/IPC channels
- No weakened privacy/security boundary
- Tests/gates reported honestly

Return exactly one verdict:

```text
VERDICT: PASS
VERDICT: FAIL
VERDICT: NEEDS_MORE_CONTEXT
VERDICT: SCOPE_EXPANSION_REQUIRED
```

## L6_HANDOFF

Final response format:

```text
VERDICT: ...

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
