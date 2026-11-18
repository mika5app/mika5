# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.2 (latest) | Yes |
| Earlier releases | No |

Only the latest Community release receives security updates. Install 0.3.2 to use the current provider, IPC, download and packaged-runtime protections.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please email **security@mika5.dev** with:

- A clear description of the vulnerability.
- Steps to reproduce the issue.
- The potential impact (data exposure, privilege escalation, remote code execution, etc.).
- Any suggested fix, if you have one.

## Response Timeline

- **Acknowledgment:** within 48 hours of your report.
- **Fix target:** within 90 days of confirmation.
- **Disclosure:** we follow coordinated disclosure. Details are published only after a fix is available and users have had reasonable time to update.

## Scope

The following areas are of particular interest:

- **Electron security** -- context isolation, `nodeIntegration`, sandbox bypass.
- **IPC channel safety** -- unauthorized access to main-process handlers via `window.mika5.*`.
- **Encryption** -- AES-256-GCM key management in `provider-credentials.js` and provider request handling in `ai-providers.js`.
- **File system access** -- path traversal or unauthorized reads/writes through knowledge document handling or `saveFile`.
- **Cross-site scripting (XSS)** -- injection via chat messages, knowledge documents, or rendered HTML exports.

Reports outside this scope (e.g., vulnerabilities in Ollama itself) are appreciated but should also be reported to the relevant upstream project.

## Acknowledgment

We are happy to credit reporters in release notes unless you prefer to remain anonymous.
