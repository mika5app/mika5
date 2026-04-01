# Contributing to MIKA5

Thank you for your interest in contributing to MIKA5! Every contribution -- whether it is code, documentation, bug reports, or ideas -- helps make the project better.

## Prerequisites

- **Node.js** (LTS recommended) and **npm**
- **Ollama** running locally on `http://127.0.0.1:11434`
- At least one Ollama chat model installed (e.g., `llama`, `qwen`)
- An embedding model installed (recommended: `nomic-embed-text`)

## Getting Started

```bash
# 1. Fork the repository on GitHub

# 2. Clone your fork
git clone https://github.com/<your-username>/MIKA5.git
cd MIKA5

# 3. Install dependencies (also rebuilds native modules for Electron)
npm install

# 4. Start the app in development mode
npm run dev
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

## Pull Request Process

1. Describe what your PR changes and why.
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
