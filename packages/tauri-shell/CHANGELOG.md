# Changelog

## [Unreleased]

### Added

- Desktop shell polish: single-instance guard (named mutex; a second launch activates the running window and exits), close-to-tray with window-state persistence/restore, system tray icon with Show/Open Project/Quit menu, Help > About dialog, frontend commands (`project_list`/`project_open`/`project_switch`/`app_info`) and a static welcome page listing recent projects.
- Integrated the shared desktop UI with active-project reporting, random-port loopback command permissions restricted to the main window and existing project/app-info commands, and serialized project switching that preserves a single active core.

### Fixed

- Fixed Open Project and recent-project switching when the shell launches omp through a wrapper with its own working directory; the selected project is now passed explicitly through `--cwd` to the core process.
