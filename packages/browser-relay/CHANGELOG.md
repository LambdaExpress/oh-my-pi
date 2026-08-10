# Changelog

## [Unreleased]

### Fixed

- Fixed the extension build script failing on Windows when the checkout path contains spaces (Bun Shell could not spawn with a space-containing working directory; zipping now runs through `Bun.spawnSync`).

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
