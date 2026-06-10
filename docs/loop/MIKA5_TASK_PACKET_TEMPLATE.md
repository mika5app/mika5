# MIKA5 Task Packet Template

## TASK

...

## RISK_CLASS

...

## CONTEXT

...

## ALLOWED_FILES

- ...

## FORBIDDEN_FILES

- `.env`
- secrets
- local databases
- user data
- unrelated build/release files
- unrelated provider config

## COMMANDS_ALLOWED

```bash
...
```

## COMMANDS_FORBIDDEN

```bash
...
```

## ACCEPTANCE_CRITERIA

- ...

## EXPECTED_GATES

```bash
npm test
```

## STOP_CONDITIONS

Return `NEEDS_MORE_CONTEXT` if evidence is insufficient.

Return `SCOPE_EXPANSION_REQUIRED` if the fix requires files outside `ALLOWED_FILES`.

## REQUIRED_FINAL_FORMAT

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
