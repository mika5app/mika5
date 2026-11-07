# Building MIKA5 Community

This document describes how to build MIKA5 Community from source.

## Requirements

- Git
- The exact Node.js version in `.nvmrc`
- npm bundled with that Node.js distribution
- Windows 10 or later, macOS, or Linux
- Ollama is optional at runtime and is not bundled with MIKA5

Local and GitHub Actions builds use `.nvmrc` as the single Node.js version source.
Check `node --version` and `npm --version` before installing dependencies.

## Obtain the corresponding source

Public users should download the corresponding source archive from:

https://github.com/mika5app/mika5-releases/releases

For version 0.3.1, use:

`MIKA5-0.3.1-source.tar.gz`

Maintainers with repository access may instead clone the development repository
and check out the exact release tag:

```bash
git clone https://github.com/mika5app/mika5.git
cd mika5
git checkout v0.3.1
```

## Install dependencies

```bash
npm ci
```

The postinstall script rebuilds native Electron dependencies, including
`better-sqlite3`.

## Run tests

```bash
npm test
npm run test:all
```

The full battery contains nine gates, including Electron, SQLite, provider UI,
and security checks. On headless Linux, run it under Xvfb.

## Run in development mode

```bash
npm run dev
```

## Build Windows

Run on Windows:

```bash
npm run build:win -- --publish never
```

Expected outputs:

```text
dist/MIKA5-Setup-0.3.1-win-x64.exe
dist/MIKA5-Portable-0.3.1-win-x64.exe
```

## Build macOS

Run on macOS:

```bash
npm run icons:mac
bash scripts/ci/check-icon.sh
npm run build:mac -- --arm64 --publish never
bash scripts/ci/verify-macos-package.sh arm64
```

These commands produce the Apple Silicon DMG and ZIP. For Intel, use a native
Intel runner and replace `arm64` with `x64`. Use a clean output directory for
each architecture. Native verification requires macOS; filenames are not proof
of architecture.

## Build Linux

Run on Linux:

```bash
sudo apt-get update
sudo apt-get install -y rpm python3 make g++ libc6-dev
npm run build:linux -- --publish never
```

Expected outputs include AppImage, DEB, and RPM packages.

## Build output

Packaged applications are written to:

```text
dist/
```

## Corresponding source and release files

Every official MIKA5 Community release must include:

- The exact corresponding source archive
- `LICENSE`
- `BUILDING.md`
- `COMMUNITY.md`
- `SHA256SUMS.txt`
- Build metadata identifying the source commit

## Reproducibility notes

Build output can differ because of operating-system packaging tools, timestamps,
unsigned binaries, and upstream dependencies.

Use the exact source archive, Node.js version from `.nvmrc`, `package-lock.json`, and
documented commands when reproducing an official build.

## Canonical CI and release handoff

`_canonical.yml` validates source, audits dependencies, runs Linux/Windows gates,
and builds four native producers when packaging is required. Integration and
security branches always build all nine packages, without publishing.

Each producer emits `artifact-proof.json` with hashes and the source commit.
macOS architecture comes from the packaged executable. The aggregate verifier
rejects missing, additional, tampered, or mismatched artifacts. Tagged releases
download the verified Actions artifact by ID and verify it again before upload;
they do not rebuild it. A tag triggers publication, so create it only after
review and platform validation.

## Windows installation and upgrade QA

The Windows producer runs `scripts/ci/verify-windows-installation.js` against the
published 0.3.0 installer and the newly built 0.3.1 installer. The baseline is
pinned by SHA-256. Tests cover real installation, normal startup/shutdown,
registration, upgrade, restart, SQLite integrity and preservation of synthetic
AppData records and knowledge files. Results are saved as the separate
`windows-installation-report` Actions artifact.

This script refuses to run outside disposable GitHub-hosted Windows runners.
Do not run it against a personal installation. To prepare the old installer on
modern Windows, CI seeds only its owned `InstallLocation`; this avoids the
legacy electron-builder folder-lookup issue documented in upstream #8536.
The old installer must still install, register and run its original bytes.
The new release's clean installation is tested before that preparation.
