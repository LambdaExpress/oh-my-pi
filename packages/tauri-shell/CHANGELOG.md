# Changelog

## [Unreleased]

### Added

- Added `scripts/build-tauri.ps1` for reproducible locked Windows release builds with a stable `dist/omp-shell.exe` output and an updated desktop shortcut; rebuilding while the shell is open now retires the running image and installs the new executable without closing the active window.
- Desktop shell polish: single-instance guard (named mutex; a second launch activates the running window and exits), close-to-tray with window-state persistence/restore, system tray icon with Show/Open Project/Quit menu, capability-gated project/app/window commands, and a static welcome page listing recent projects.
- Integrated the shared desktop UI with active-project reporting, random-port loopback command permissions restricted to the main window and existing project/app-info commands, and serialized project switching that preserves a single active core.
- Replaced the native title bar and File/Help menu with matching custom chrome on both the embedded welcome page and the collab UI, including draggable regions, double-click maximize, minimize, maximize/restore, and close-to-tray controls exposed through capability-gated commands.

### Fixed

- Fixed Open Project and recent-project switching when the shell launches omp through a wrapper with its own working directory; the selected project is now passed explicitly through `--cwd` to the core process.
