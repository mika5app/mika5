# Signing Windows builds with SignPath — integration plan

Status: **plan only**. Nothing in the workflows calls SignPath, no credential exists, and no release is signed. This document records how signing fits the existing pipeline so that it can be added without changing what the pipeline already verifies.

## What SignPath Foundation requires of the build

From <https://signpath.org/terms> and <https://docs.signpath.io/trusted-build-systems/github>:

- The artifact is built by a GitHub workflow from the source in the repository, and every job leading up to the signing request runs on a GitHub-hosted runner. `_canonical.yml` already does this.
- The artifact is uploaded with `actions/upload-artifact` v4 or later before signing. The pipeline already uses v4. The signing request refers to the artifact by its ID; SignPath fetches it from GitHub itself, so the bytes that are signed are the bytes the workflow produced.
- Every signing request is approved by hand.
- Signed binaries carry product name and version. `electron-builder.json` sets both.

## Where it goes

Today, for a version tag:

```
source → quality-gates → package (4 producers) → verify-artifacts → prepare-release → finalize-release
```

Signing sits between `package` and `verify-artifacts`, for the Windows producer only:

```
package (windows-x64, unpacked app)  → upload → SignPath signs MIKA5.exe and the other PE files
package (windows-x64, installers)    → built from the signed unpacked app with electron-builder --prepackaged
                                     → upload → SignPath signs the installer and the portable executable
verify-artifacts                     → as today, plus: every Windows executable carries a valid signature
```

Two rounds are needed because the installer is not a container SignPath can open: the application executable has to be signed before the installer wraps it. If only the installer were signed, the installed `MIKA5.exe` would still be unsigned and Smart App Control would still block it.

Nothing is compiled twice. The second step packages the already-built, now signed, application; it does not rebuild it. Hashes are computed after signing, as they must be: a signature changes the file.

`verify-artifacts` keeps its role as the single place that decides what may be published, and gains one check. The release then consumes the verified artifact by its immutable ID, exactly as it does now.

## The step

```yaml
- uses: signpath/github-action-submit-signing-request@v3
  with:
    api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
    organization-id: <from SignPath>
    project-slug: mika5
    signing-policy-slug: release-signing
    artifact-configuration-slug: <unpacked-app | installers>
    github-artifact-id: ${{ steps.upload.outputs.artifact-id }}
    wait-for-completion: true
    output-artifact-directory: signed
```

## Keeping the credential away from untrusted code

- The signing jobs run only for version tags (`if: github.ref_type == 'tag'`), like the release jobs today. Pull requests never reach them.
- Workflows triggered by `pull_request` from a fork receive no secrets. No workflow uses `pull_request_target`, and none may be added.
- The token lives in a GitHub environment (`release-signing`) with a required reviewer, so a tag alone does not release it.
- On SignPath's side, the signing policy is restricted to this repository and to tags, re-runs are disallowed, and each request waits for an approver.
- The token can only submit signing requests. It cannot read the certificate, which never leaves SignPath.

## What this does not cover

- **macOS.** SignPath Foundation certificates are for Windows. Notarization needs an Apple Developer ID.
- **Reputation.** A new certificate does not remove the SmartScreen prompt on the first day; reputation builds with downloads.
- **Linux packages** are not signed by this.

## Before it can be switched on

1. The repository is public and the project is accepted by SignPath Foundation.
2. Two-factor authentication is required for the GitHub organization.
3. A ruleset protects `main` and version tags (pull request with review, no force push).
4. The `release-signing` environment and its secret exist.
5. `CODE_SIGNING_POLICY.md` is updated to say signing is in effect, and the website links to it.
