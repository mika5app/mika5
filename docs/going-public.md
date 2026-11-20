# Making the repository public

A runbook for the owner. Nothing here runs by itself, and changing visibility is the owner's decision alone. Commands are for PowerShell with the GitHub CLI, run from the root of a clone.

## Before

1. Two-factor authentication is on for your account: <https://github.com/settings/security>.
2. The pull request that adds the privacy and code signing policies is merged, so they are there when the repository is first seen.

What becomes visible: the whole history and every branch, issues and pull requests, and the logs of past Actions runs. Secrets do not.

## 1. Change visibility

```powershell
gh repo edit mika5app/mika5 --visibility public --accept-visibility-change-consequences
```

## 2. Protect `main` and the release tags

Do this straight away. The three files are in `.github/rulesets/`.

```powershell
gh api -X POST repos/mika5app/mika5/rulesets --input .github/rulesets/main.json
gh api -X POST repos/mika5app/mika5/rulesets --input .github/rulesets/release-tags-immutable.json
gh api -X POST repos/mika5app/mika5/rulesets --input .github/rulesets/release-tags-create.json
```

- **`main`**: changes arrive by pull request, the three CI checks must pass on an up-to-date branch, no force-push, no deletion, and nobody bypasses it. Zero approvals are required because a pull request cannot be approved by its own author, and with a single maintainer one required approval would block every merge. Raise it when there is a second maintainer.
- **Tags `v*`**: only a repository administrator creates them, and nobody moves or deletes one. A release that fails takes a new version number.

## 3. Actions and security settings

```powershell
gh api -X PUT repos/mika5app/mika5/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors
gh api -X PATCH repos/mika5app/mika5 --input .github/repository-settings.json
gh api -X PUT repos/mika5app/mika5/private-vulnerability-reporting
gh api -X PUT repos/mika5app/mika5/vulnerability-alerts
```

The first makes every workflow run from an outside contributor wait for a maintainer. Secrets are not available to those runs either way.

## 4. Require two-factor authentication in the organization

Organization settings → Authentication security → Require two-factor authentication. Members without it lose access when this is switched on, so confirm step 1 of "Before" first.

## 5. Check

```powershell
gh api repos/mika5app/mika5 --jq '.visibility'
gh api repos/mika5app/mika5/rulesets --jq '.[].name'
gh api repos/mika5app/mika5/rulesets --jq '.[].enforcement'
gh pr checks 17 -R mika5app/mika5
```

Three rulesets, all `active`. Actions runs again for open pull requests once the repository is public: re-run their checks.

## Undo

```powershell
gh repo edit mika5app/mika5 --visibility private --accept-visibility-change-consequences
```

Anything copied or forked while it was public stays public.
