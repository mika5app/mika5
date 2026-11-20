# Signing release builds — integration plan

Status: **prepared, not active**. No workflow calls SignPath, Apple or Sigstore, no credential or certificate exists, and no release is signed. SignPath Foundation has not accepted the project and there is no Apple Developer ID. This document records how signing fits the existing pipeline so that it can be switched on without changing what the pipeline already verifies.

What exists today:

- `scripts/signing/verify-signatures.js` — verifies the signature of a finished artifact on each platform and fails closed. No workflow runs it yet.
- `test/signing-readiness.test.js` (run from `test/ci-gates.test.js`) — drives the verifier against stand-ins for the native tools and proves it rejects what it must; keeps `id-token: write` to a single tag-only job; rejects a workflow that signs without verifying afterwards.
- Two existing guards make an accidental activation fail: `test/canonical-workflow.test.js` forbids any secret in `_canonical.yml`, and `test/public-readiness.test.js` requires every job that reads a secret to be limited to version tags. Changing either is a deliberate step, listed below.

The expected signer is never defaulted. The verifier takes the Windows publisher, the Apple Team ID and the workflow identity as arguments, and they are filled in when they exist.

## One rule for every platform

```
BUILD → VERIFY → SIGN / NOTARIZE → VERIFY THE SIGNATURE → SHA-256 OF THE FINAL BYTES → PUBLISH THOSE BYTES
```

`scripts/ci/stage-artifacts.js` writes `artifact-proof.json` once per producer, and `verify-artifacts.js` recomputes it before anything is published. Whatever changes a file has to happen before that proof is written:

| Platform | What changes bytes | Where the proof is taken |
|---|---|---|
| Windows | Authenticode on `MIKA5.exe`; packaging the signed app into installers; Authenticode on the installers | After the second signing round, on the signed installers |
| macOS | Signing, notarization and stapling of `MIKA5.app`, all inside the one build, before the DMG and ZIP exist | Where it is today: the DMG and ZIP are already final |
| Linux | Nothing. A Sigstore signature is a separate file | Where it is today; the unchanged SHA-256 afterwards is the evidence that signing did not touch the package |

A hash taken before signing is never published for a signed file, and nothing is rebuilt after it was verified: the unsigned Windows installers and their proof are discarded together when signed ones replace them.

## Windows — SignPath Foundation

From <https://signpath.org/terms> and <https://docs.signpath.io/trusted-build-systems/github>:

- The artifact is built by a GitHub workflow from the source in the repository, and every job leading up to the signing request runs on a GitHub-hosted runner. `_canonical.yml` already does this.
- The artifact is uploaded with `actions/upload-artifact` v4 or later before signing. The signing request refers to it by ID; SignPath fetches it from GitHub itself, so the bytes that are signed are the bytes the workflow produced.
- Every signing request is approved by hand.
- Signed binaries carry product name and version. Measured on an unsigned 0.3.1 build: `ProductName` is `MIKA5` on all three executables; `ProductVersion` is `0.3.1` on the installers and `0.3.1.0` on `MIKA5.exe`.
- The certificate is issued to SignPath Foundation, so that is the publisher Windows will show, not "MIKA5". Confirm the exact name against the real certificate before passing it to `--publisher`.
- Only our own executable is submitted as ours. Upstream binaries inside the package (Electron's libraries, the `better-sqlite3` prebuild) are not re-signed in the project's name.

### Two rounds, not electron-builder's hook

electron-builder 26.18.0 offers `win.signtoolOptions.sign`, a function it calls for every file while it builds. It does not fit: the call happens inside the build process, so the API token would sit next to the whole dependency tree; each file would be its own request and its own manual approval; and SignPath could not verify where the file came from, because origin verification works on an artifact uploaded by `actions/upload-artifact`, not on a file handed over by a script. The submit action with two rounds keeps the token in one step and lets SignPath check the origin.

```
package (windows-x64)  → as today, plus on tags: upload dist/win-unpacked            (no secret)
sign-windows (tags)    → SignPath signs MIKA5.exe inside the unpacked app
                       → electron-builder --win --x64 --prepackaged <signed app> --publish never
                       → upload → SignPath signs the installer and the portable executable
                       → verify-signatures.js windows --publisher=<…> on both, and on the installed MIKA5.exe
                       → verify-windows-installation.js on the signed installer
                       → stage-artifacts.js → artifact-proof.json of the signed bytes → upload
finalize-release       → needs sign-windows; takes windows-x64 from it; verify-artifacts.js on all nine again
```

`sign-windows` lives in `build.yml`, not in `_canonical.yml`, with `if: github.ref_type == 'tag'` and the `release-signing` environment. In the installed source `--prepackaged` packages the given directory and skips the build, so nothing is compiled twice.

Two rounds are needed because the installer is not a container SignPath can open. If only the installer were signed, the installed `MIKA5.exe` would still be unsigned.

**Open point — the uninstaller.** electron-builder generates the uninstaller while it builds the installer and signs it only through its own signing step (`NsisTarget.computeScriptAndSignUninstaller`). With signing done afterwards by SignPath, the uninstaller is embedded unsigned. Check it on the first signed build (run the verifier on the installed `Uninstall MIKA5.exe`) and decide whether that is acceptable before publishing.

```yaml
- uses: signpath/github-action-submit-signing-request@v3
  with:
    api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
    organization-id: <from SignPath>
    project-slug: <from SignPath>
    signing-policy-slug: <from SignPath>
    artifact-configuration-slug: <unpacked-app | installers>
    github-artifact-id: ${{ steps.upload.outputs.artifact-id }}
    wait-for-completion: true
    output-artifact-directory: signed
```

### Keeping the credential away from untrusted code

- The signing job runs only for version tags. Pull requests never reach it, and `_canonical.yml`, which pull requests do run, holds no secret.
- No workflow uses `pull_request_target`, and none may be added.
- The token is a secret of the `release-signing` environment, with a required reviewer and limited to version tags, and it is passed only to the submit step.
- On SignPath's side, the signing policy is restricted to this repository and to tags, re-runs are disallowed, and each request waits for an approver.
- The token can only submit signing requests. The certificate never leaves SignPath.

## macOS — Developer ID and notarization

Already in place: `hardenedRuntime: true`, the entitlements in `build/entitlements.mac.plist`, and one native runner per architecture, each with its own `lipo` check.

How electron-builder 26.18.0 decides, read in the installed source:

- It refuses to sign in a pull request (`GITHUB_BASE_REF` set).
- With `CSC_IDENTITY_AUTO_DISCOVERY=false` and no `CSC_NAME` it does not look for an identity at all, even if a certificate is present. That is the state of every build today.
- `--prepackaged` skips signing on macOS, so signing cannot be a later job as on Windows: it has to happen in the build, in the `package` job.
- After signing it notarizes with `notarytool` and staples the app when `APPLE_API_KEY` (path to the `.p8` file), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set. If they are missing it logs a warning and carries on, which is why the result is verified separately.
- The DMG and ZIP are built afterwards from the stapled app. The DMG itself is not signed (`dmg.sign` is off by default); Gatekeeper judges the app inside it.

**The single switch.** One step in the `package` job of `_canonical.yml`, before "Build once from clean output":

```yaml
- name: Enable macOS signing (version tags only)
  if: runner.os == 'macOS' && github.ref_type == 'tag'
  # exports CSC_LINK, CSC_KEY_PASSWORD, CSC_NAME, APPLE_API_KEY, APPLE_API_KEY_ID and
  # APPLE_API_ISSUER to $GITHUB_ENV from secrets, and fails if any is empty
```

`CSC_NAME` names the one identity to use, so automatic discovery stays off. The tag build adds `-c.forceCodeSigning=true`, so a missing certificate stops the build instead of producing an unsigned one. Then, before staging:

```
node scripts/signing/verify-signatures.js macos --team-id=<Team ID> dist/mac/MIKA5.app        # mac-arm64 on Apple Silicon
```

and the same on the app inside the mounted DMG and the extracted ZIP. It runs `codesign --verify --deep --strict`, checks the Developer ID, the team, the hardened runtime and that the signed entitlements are exactly the repository's, then `spctl --assess` (must report `Notarized Developer ID`) and `stapler validate`.

Because this step reads secrets inside `_canonical.yml`, the two guard tests named above have to be changed in the same commit to allow exactly that step and nothing else. The secrets are declared under `on.workflow_call.secrets` and passed by `build.yml` only.

## Linux — Sigstore

A job `sign-linux` in `build.yml`, `if: github.ref_type == 'tag'`, the only job in the repository with `id-token: write`. It holds no other secret; the job that publishes holds no OIDC token.

```
sign-linux        → download the verified artifact by ID; verify-artifacts.js
                  → cosign sign-blob --yes --bundle <file>.sigstore.json <file>     (AppImage, deb, rpm)
                  → verify-signatures.js linux --identity=<identity> <the three files>
                  → upload the three bundles
finalize-release  → needs sign-linux; puts each bundle next to its file
                  → verify-artifacts.js (same SHA-256 as before signing) and verify-signatures.js linux again
                  → SHA256SUMS.txt then covers packages and bundles; both are uploaded together
```

Expected identity, for a job defined in `build.yml`:

```
https://github.com/mika5app/mika5/.github/workflows/build.yml@refs/tags/v<version>
issuer: https://token.actions.githubusercontent.com
```

If the job were moved into `_canonical.yml` the certificate would name that file instead. The verifier accepts only an exact identity on a version tag: no branch, no pattern. Anyone can check a download:

```
cosign verify-blob MIKA5-<version>-linux-x86_64.AppImage \
  --bundle MIKA5-<version>-linux-x86_64.AppImage.sigstore.json \
  --certificate-identity https://github.com/mika5app/mika5/.github/workflows/build.yml@refs/tags/v<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Sigstore's transparency log is public: each signature records the repository, the workflow and the commit. Do not sign while the repository is private. Pin `sigstore/cosign-installer` to a commit.

## What this does not cover

- **Reputation.** A new certificate does not remove the SmartScreen prompt on the first day; reputation builds with downloads.
- **Package repositories.** The deb and rpm files are signed as files; there is no apt or yum repository with its own key.
- **A real signature.** No certificate, Mac or `cosign` binary was available. The Windows verifier was run against real signed and unsigned executables; the macOS and Linux ones only against stand-ins.

## Before it can be switched on

1. The repository is public; SignPath Foundation has accepted the project; an Apple Developer ID Application certificate and an App Store Connect API key exist.
2. Two-factor authentication is required for the GitHub organization.
3. A ruleset protects `main` and version tags (pull request with review, no force push).
4. The `release-signing` environment exists, limited to version tags, with a required reviewer and the secrets above.
5. The jobs and the step described here are added, with `scripts/signing/` added to the `packaging` scope in `scripts/ci/changed-scope.js` and the guard tests updated in the same change.
6. `CODE_SIGNING_POLICY.md`, the README and the release notes in `build.yml` stop saying that builds are unsigned and not notarized, and the website links to the policy.
