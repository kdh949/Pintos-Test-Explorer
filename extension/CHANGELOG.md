# Changelog

## 0.1.7

- Swapped the sort toggle to a gray funnel icon so the toolbar meaning is clearer at a glance.
- Moved the red `Reset All Tests` action to the far left of the `Pintos Tests` toolbar and kept `Reset Checked Tests` as the scoped reset next to it.
- Moved `Run Checked Tests` to the far right of the custom toolbar actions and replaced the built-in collapse control with an explicit toolbar button.
- Marked build-time run failures as `FAIL` in both the VS Code tree and the companion CLI, even when Pintos never produced a normal `.result` file.
- Added better debug startup diagnostics when port `1234` is already occupied before the GDB server starts.
- Added packaged Korean README files and refreshed the public README, packaged README, and release notes so the shipped VSIX matches the current UI and CLI behavior.

## 0.1.6

- Added the toolbar sort toggle to the published package so the `Pintos Tests` view can switch between `Number order` and `Latest first`.
- Split reset actions so checked tests can be reset without wiping the whole workspace, and kept a separate full reset action for all checks and artifacts.
- Updated the toolbar ordering so the trash icon sits first, and replaced the sort artwork with a more recognizable sort glyph.
- Added matching CLI reset commands for selected tests and whole-workspace cleanup, and made reruns delete old artifacts first so stale FAIL results are less likely to stick around.
- Updated the Activity Bar `Pintos` icon so the `P` mark is filled for better visibility.
- Rebuilt the packaged README and extension metadata so the shipped VSIX matches the current public documentation.

## 0.1.5

- Refreshed the unpublished `0.1.5` package metadata so the repository, homepage, and issue links all point to the standalone `Pintos-Test-Explorer` GitHub repository.
- Added a toolbar sort toggle so the Pintos test tree can switch between `Number order` and `Latest first`.
- Changed recent-first ordering to prioritize the most recently run or debugged tests, and tightened the clear-checked flow so it fully refreshes the tree state.
- Cleaned up the CLI setup and public documentation so `pt` is easier to enable and use from the terminal.
- Switched the CLI help text and user-facing extension messages to English for global users.
- Added documented range and mixed-selector examples to the README, including `11-20` style multi-test runs.
- Kept the debug-path improvements from earlier patches while making the public UX fully English.

## 0.1.4

- Improved the missing-`gdb` error message so it clearly says debug requires `gdb` on the active environment `PATH`.
- Expanded the CLI to document and support common multi-test selectors such as numeric ranges, mixed selectors, and recent-first ordering.
- Added local test usage history so `pintos-tests list <project> --recent-first` can move frequently used tests to the top.

## 0.1.3

- Fixed a debug startup bug where the GDB helper only recognized `pintos ...` commands and failed when `make -n` emitted an absolute path such as `/workspaces/.../pintos/utils/pintos ...`.
- Kept the debug flow the same, but made the command extraction logic accept both bare `pintos` and path-based invocations.
- Refined the README wording around `gdb` so it reflects the actual requirement more clearly.

## 0.1.2

- Reworked test discovery to parse `Make.tests` directly instead of invoking `make` for every project, which makes the sidebar load much faster on first open.
- Updated the repository CLI scripts to use the same bundled helper logic as the extension, so `./scripts/pintos-tests` and related commands behave consistently.
- Added a terminal installer script for `pintos-tests` and documented where the CLI lives.
- Improved debug failure reporting so missing `gdb` and early GDB server exits show clearer messages with recent log lines.

## 0.1.1

- Bundled the Pintos test discovery and GDB helper scripts into the extension so Marketplace installs no longer depend on workspace-local helper versions.
- Improved workspace root discovery so the extension can find both a direct Pintos root and a wrapper repository that contains `pintos/`.
- Kept the existing sidebar, batch run, and artifact workflow unchanged while making the packaged extension more reliable across machines.

## 0.1.0

- Added a dedicated `Pintos` activity bar view for `threads`, `userprog`, `vm`, and `filesys`.
- Added per-test `Run` and `Debug` actions with GDB remote attach support.
- Added checkbox-based multi-run support and artifact links for `output`, `result`, and `errors`.
- Added marketplace-ready packaging metadata, icon, and publisher configuration.
- Refined the marketplace icon and the in-product `Pintos` activity bar logo to use a cleaner blue-and-white `P os` mark.
