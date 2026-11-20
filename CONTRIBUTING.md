# Contributing to MIKA5

Thank you for your interest in contributing to MIKA5! Every contribution -- whether it is code, documentation, bug reports, or ideas -- helps make the project better.

## Prerequisites

- **Node.js** (LTS recommended) and **npm**
- **Ollama** running locally on `http://127.0.0.1:11434`
- At least one Ollama chat model installed (e.g., `llama`, `qwen`)
- An embedding model installed (recommended: `nomic-embed-text`)

## Where things live

- **Source code and pull requests:** https://github.com/mika5app/mika5 (this repository)
- **Issues about the code:** https://github.com/mika5app/mika5/issues
- **Installers, checksums and the source archive of every release:**
  https://github.com/mika5app/mika5-releases/releases
- **Questions and ideas:** https://github.com/mika5app/mika5-releases/discussions
- **License:** AGPL-3.0, see `LICENSE`. Third-party notices are in
  `THIRD_PARTY_NOTICES.md`.

The repository is public. Each release also carries
`MIKA5-<version>-source.tar.gz`, the exact source that release was built from.

## Getting Started

```bash
# 1. Fork https://github.com/mika5app/mika5 and clone your fork
git clone https://github.com/<your-username>/mika5.git
cd mika5

# 2. Install dependencies with the pinned Node (see .nvmrc and BUILDING.md)
npm install

# 3. Run the application and the tests
npm run dev
npm test
```

## Branch Naming

Create branches from `main` using one of these prefixes:

- `feature/short-description` -- new functionality
- `fix/short-description` -- bug fixes
- `docs/short-description` -- documentation changes

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Anthropic provider support
fix: prevent XSS in rendered chat messages
docs: update README setup instructions
test: add RAG cosine similarity edge cases
```

## Sending a change

1. For anything larger than a small fix, open an issue at
   https://github.com/mika5app/mika5/issues first, so the change can be
   discussed before you write it.
2. Create a branch from `main` in your fork and make the change there, with
   tests and with the DCO sign-off described below.
3. Open a pull request against `main`.

What to expect:

- `main` only changes through pull requests, and the CI checks have to pass.
- Workflow runs for a pull request from outside the project wait for a
  maintainer to approve them. They never have access to the project's secrets.
- Never commit credentials. Local configuration belongs in a `.env` file, which
  is ignored; `.env.example` may be committed, without real values.

## Review

1. Describe what your change does and why.
2. Reference any related issues (e.g., `Closes #42`).
3. Make sure tests pass: `npm test`.
4. Keep PRs focused -- one logical change per PR.
5. A maintainer will review your PR and may request changes.

## Code Style

- There is no linter configured yet. Follow the patterns in the existing codebase.
- **UI text** is in **Spanish**. Keep user-facing strings in Spanish (see `src/renderer/i18n.js` for the internationalization module).
- **Code comments** should be in **English**.
- Most CSS lives inline in `src/renderer/index.html`; supplemental styles go in `src/renderer/styles.css`.

## DCO Sign-Off (Required)

All commits must include a Developer Certificate of Origin sign-off line certifying that you have the right to submit the contribution under the project's license.

Add the following line to the end of every commit message:

```
Signed-off-by: Your Name <your-email@example.com>
```

You can do this automatically with:

```bash
git commit -s -m "feat: your commit message"
```

The full text of the DCO is available at <https://developercertificate.org/>.

## Areas Where Help Is Welcome

- **Tests** -- expanding coverage for RAG, DB operations, and provider logic.
- **Documentation** -- improving setup guides, architecture docs, and inline comments.
- **Internationalization (i18n)** -- adding new language translations.
- **New AI providers** -- integrating additional cloud or local model backends.
- **Accessibility and UX** -- improving keyboard navigation, screen reader support, and general usability.

## License

By contributing to MIKA5, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). This means any distributed modifications -- including use over a network -- must also be made available under the AGPL-3.0.
