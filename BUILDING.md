# Building MIKA5 Community

This document describes how to build MIKA5 Community from source.

## Requirements

- Git
- Node.js 20.x
- npm
- Windows 10 or later, macOS, or Linux
- Ollama is optional at runtime and is not bundled with MIKA5

Official GitHub Actions builds use Node.js 20.

## Obtain the corresponding source

Public users should download the corresponding source archive from:

https://github.com/mika5app/mika5-releases/releases

For version 0.2.0, use:

`MIKA5-0.2.0-source.tar.gz`

Maintainers with repository access may instead clone the development repository
and check out the exact release tag:

```bash
git clone https://github.com/mika5app/mika5.git
cd mika5
git checkout v0.2.0
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
npm run test:db
```

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
dist/MIKA5-Setup-0.2.0-win-x64.exe
dist/MIKA5-Portable-0.2.0-win-x64.exe
```

## Build macOS

Run on macOS:

```bash
npm run build:mac -- --publish never
```

Expected outputs include DMG and ZIP packages for Intel and Apple Silicon.

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

Use the exact source archive, Node.js major version, `package-lock.json`, and
documented commands when reproducing an official build.
