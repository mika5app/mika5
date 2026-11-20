# MIKA5 Community

MIKA5 Community is the free and open-source edition of MIKA5.

## License

MIKA5 Community is distributed under the GNU Affero General Public License,
version 3.0 (AGPL-3.0).

The corresponding source code for every distributed Community release is made
available together with its installers.

## Community edition

MIKA5 Community includes the features contained in this repository and in the
published Community release.

Users may:

- Run MIKA5 for personal or commercial purposes.
- Inspect and modify the source code.
- Redistribute the application under the terms of the AGPL-3.0.
- Build their own versions from the corresponding source code.

## Commercial editions and services

Future paid functionality may be offered separately through MIKA5 Pro,
MIKA5 Cloud, managed services, subscriptions, or enterprise licenses.

Those future commercial components and services are not part of this
Community repository unless explicitly stated.

The Community edition remains licensed under the AGPL-3.0.

## Trademarks

The MIKA5 name, logo, and branding are governed separately from the software
license. See `TRADEMARK.md`.

## Source and releases

Official Community installers and corresponding source archives are published
through the public MIKA5 releases repository:

https://github.com/mika5app/mika5-releases

Every release carries `MIKA5-<version>-source.tar.gz`, the complete source that
produced its installers, together with `BUILDING.md`, `LICENSE` and
`SHA256SUMS.txt`.

Report problems and propose changes at
https://github.com/mika5app/mika5-releases/issues. `CONTRIBUTING.md` explains
how to send a change. Licenses of the bundled third-party software are listed in
`THIRD_PARTY_NOTICES.md`.

Inside the application, the version dialog (More actions → Check for a new
version) links to the source, the issue tracker and the license.

## Current release: 0.3.1

Download Windows, macOS Intel/Apple Silicon and Linux packages, corresponding
source and checksums from:

https://github.com/mika5app/mika5-releases/releases/tag/v0.3.1

This release updates provider handling, cloud consent, document/image handling
and native packaging validation. Ollama local and cloud models are supported;
cloud use retains explicit privacy notices and consent. Pro and Cloud services
remain future editions, separate from Community.

MIKA5 can tell you when a newer stable version has been published, on request or
when it opens if you turn that on; it never downloads or installs anything by
itself. Updates are manual. Close the application and keep a backup of its data
before installing a newer version. Windows builds are not Authenticode-signed and
macOS builds are not notarized. Verify downloads using `SHA256SUMS.txt`.
