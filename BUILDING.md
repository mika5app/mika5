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

## BitNet engine (bitnet.cpp) on Windows

MIKA5 uses the `llama-server` that bitnet.cpp builds. Microsoft publishes no binaries, so
it has to be built. This is what was measured to work on Windows x64 with the official
model `microsoft/bitnet-b1.58-2B-4T-gguf` (`ggml-model-i2_s.gguf`); it is a recipe for
developers, not something a user of MIKA5 is asked to do.

Requirements: Visual Studio 2022 Build Tools with "C++ Clang Compiler for Windows",
"MSBuild support for LLVM (clang-cl) toolset" and "C++ CMake tools", plus Git and Python.

```bat
git clone --recursive https://github.com/microsoft/BitNet.git
cd BitNet
git checkout 01eb415
git submodule sync && git submodule update --init --recursive
python utils\codegen_tl2.py --model bitnet_b1_58-3B --BM 160,320,320 --BK 96,96,96 --bm 32,32,32
cmake -B build -DBITNET_X86_TL2=OFF -T ClangCL -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ ^
  -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON
cmake --build build --config Release --target llama-server
```

Why each deviation from the official `setup_env.py`:

- **Commit `01eb415`.** The repository changed the I2_S format and engine in July 2026. With
  the current head the published model loads but answers are degraded and never stop.
- **`-DBUILD_SHARED_LIBS=OFF`.** With shared libraries the current head fails to link on
  Windows (`undefined symbol: quantize_i2_s`); static linking is also what a redistributable
  engine needs.
- **Explicit AVX2 flags.** The configure-time CPU checks can report "Failed" on Windows, and
  the engine is then built without AVX2: it runs at about 1 token per second and outputs
  garbage. With AVX2 it reaches about 30 tokens per second.
- **Two source fixes** for current compilers: `const int8_t * y_col` at
  `src/ggml-bitnet-mad.cpp:811`, and `#include <chrono>` in
  `3rdparty/llama.cpp/common/common.cpp` and `common/log.cpp`.

The engine MIKA5 offers to install (`bitnet-runtime-1` in the public releases repository)
is this same build with two more flags, so it needs no Visual C++ or OpenMP runtime, and
compiled from a neutral path so no local user name ends up inside the binary:

```bat
-DGGML_OPENMP=OFF -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
```

Publishing a new one means: build, check `dumpbin /dependents` lists only system DLLs,
upload it with `gh release create <tag> --latest=false` (the update notice reads
`releases/latest`, which has to stay an application version), and put the exact URL, size
and SHA-256 in `runtimes` in `src/main/providers/bitnet.js`.

This engine must be started with a small batch (`-b 32`, which MIKA5 passes). With the
default it overflows the stack and exits with `0xC00000FD` on inputs longer than a few
hundred tokens.

MIKA5 finds a local build at `<home>\BitNet\build\bin\Release\llama-server.exe` and the
model under `<home>\BitNet\models`. The executable is unsigned, so Windows Smart App
Control may block it.
