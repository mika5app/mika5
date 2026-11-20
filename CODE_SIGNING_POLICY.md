# Code signing policy

## Status

**MIKA5 Community builds are not code-signed yet.** Windows binaries carry no Authenticode signature and macOS builds are not notarized, so the operating system warns on first launch. Until signing is in place, verify a download against the `SHA256SUMS.txt` published with each release.

The project intends to apply to the SignPath Foundation programme for open source projects. The rest of this document is the policy that will apply once that application is accepted. It is not in effect before then, and nothing here claims that an existing release is signed.

## When signing is in effect

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

### What is signed

Only binaries built from the source in this repository, by the GitHub Actions workflows in this repository, on GitHub-hosted runners. No binary built on a developer machine is ever signed. Each signed release corresponds to a tagged commit, and the release records that commit and the workflow run that built it.

### Roles

| Role | Who | What they do |
|---|---|---|
| Authors (committers) | [@roxmell](https://github.com/roxmell) | May change the source code. |
| Reviewers | [@roxmell](https://github.com/roxmell) | Review every change proposed by anyone who is not a committer before it is merged. |
| Approvers | [@roxmell](https://github.com/roxmell) | Decide whether a release may be signed. Every signing request is approved by hand. |

All team members use multi-factor authentication for GitHub and for SignPath.

### Rules

- A release is signed only after its automated checks have passed and an approver has approved that specific signing request.
- Signing credentials are available only to the release workflow for version tags. They are never exposed to pull requests.
- Signed binaries carry the product name and version in their file metadata.
- The Windows installer includes an uninstaller.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. See the [privacy policy](PRIVACY.md).

## Reporting a problem

If you believe a binary signed for this project is malicious or was not built from this source, write to **security@mika5.dev**. See [SECURITY.md](SECURITY.md).
