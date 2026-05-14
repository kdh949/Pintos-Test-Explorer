# Changelog

## 0.3.0

- Added a `User Programs for VM` checkbox inside the Virtual Memory project that persists per workspace.
- When enabled, User Programs run/debug actions and PASS/FAIL artifact reads use `vm/build` instead of `userprog/build`, making VM project work smoother without choosing a mode for every test.
- Marked the User Programs project row and view description with the active VM build mode so the current run target is visible before launching tests.

## 0.2.9

- Matched sidebar and CLI discovery to the build Makefile's final `TESTS` list when available while preserving project-owned suite filtering, so `alarm-*` and `priority-*` stay under Threads instead of leaking into User Programs.
- Restored project-owned nested `Make.tests` discovery for optional User Programs suites such as `tests/userprog/dup2`, so folders like `dup2` and tests like `dup2/duplicate` remain visible even when templates omit them from `TEST_SUBDIRS`.
- Kept project-level Run All, project checkbox selection, project pass/fail summaries, and CLI `all` aligned with the build `TESTS` subset while still allowing supplemental tests to run explicitly.
- Made terminal CLI runs prefer the Pintos root implied by the current directory before falling back to pinned terminal root variables, so moving into another build tree cannot read stale PASS/FAIL artifacts from the wrong root.
- Accepted common Make assignment variants such as `:=`, `?=`, and direct `TESTS += ...` registrations while still filtering entries to the owning sidebar project.
- Passed full test targets into debug preparation, keeping debug runs in the same build tree as the sidebar run action.
- Pinned the bundled `pt` / `pintos-tests` commands in new VS Code integrated terminals to the Pintos root discovered by the extension, so changing directories inside a wrapper workspace no longer makes the CLI read a different build tree and show different PASS/FAIL artifacts.
- Made descendant Pintos root discovery deterministic in the sidebar by scanning child directories in name order, matching the bundled CLI.

## 0.2.4

- Kept checkbox selection responsive by reusing already discovered test data instead of clearing discovery caches after every checkbox event.
- Preserved fast checkbox clicks made while test discovery is still loading by showing pending checkbox state immediately and applying folder cascades in event order.
- Shared in-flight project discovery so repeated clicks do not spawn duplicate helper processes while a project is still loading.
- Removed the install-time Microsoft C/C++ dependency prompt; Pintos run/list features no longer ask for it, and Debug now explains the requirement only when the user starts a debug session.

## 0.2.3

- Fixed stale Pintos build directories where `build/Makefile` existed but required subdirectories such as `threads/` were missing, causing run/debug actions to fail while generating `threads/kernel.lds.s`.
- Mirrored the build-directory repair in the bundled `pt` / `pintos-tests` CLI so sidebar and terminal workflows behave consistently.

## 0.2.2

- Added an inline `Open Test Source` button to each test row and placed it to the left of the debug action.
- Resolved source jumps from real test definitions instead of only guessed filenames, including `Make.tests` `_SRC` mappings and thread-test registrations such as `alarm-single -> alarm-wait.c`.

## 0.2.1

- Fixed `Make.tests` parsing for mixed expressions such as `$(addprefix ...)` plus later `+=` entries, which restores correct discovery in wrapper workspaces like `pintos_22.04_lab_docker`.
- Ignored stale legacy group JSON files such as `new-group.json` by default so built-in folders like `Alarm Clock` are no longer renamed unexpectedly.
- Routed custom create, rename, and delete flows through the bundled CLI, and now recreate matching build output directories for custom paths to reduce `tests/.../custom/*.d` build failures.
- Routed Pintos debug restarts through the same launch-preparation path as first-time debug starts.
- Kept detailed compiler output in the `errors` artifact while removing the extra `Build error` text from test and aggregate row descriptions.
- Replaced the long create-test toolbar label with a dedicated gray icon button positioned next to the sort funnel.

## 0.2.0

- Shipped the integrated companion CLI so new VS Code terminals can use `pt` and `pintos-tests` without extra workspace-local setup.
- Added installable shell wrappers for non-VS-Code terminals and bundled dedicated launcher scripts into the packaged extension.
- Expanded Pintos root discovery across direct roots, `pintos/`, `src/`, and nested wrapper layouts.
- Hardened helper runtime resolution so Python, bash, and gdb are resolved from the active environment instead of one fixed path.
- Refreshed packaged documentation and release metadata around terminal usage, selector rules, artifacts, and mixed `pt` / `pintos-tests` workflows.

## 0.1.9

- Fixed Pintos root discovery so the extension, bundled CLI, and GDB helper all recognize workspace layouts rooted at `src/`, `pintos/`, and `pintos/src/`.
- Fixed bundled command launching on more Linux and Windows machines by resolving `python3`/`python`/`py`, `bash`, and `gdb` from the active environment instead of assuming one exact executable path.
- Added Windows terminal wrapper generation for the bundled `pt` and `pintos-tests` commands so the integrated terminal can find them reliably after activation.

## 0.1.8

- Made the bundled companion CLI available automatically in the VS Code integrated terminal, so users can open a new terminal and run `pt --help` without sourcing a workspace-local script.
- Added a `Pintos: Install CLI Wrappers to Shell` command that installs `pt` and `pintos-tests` into `~/.local/bin` for non-VS-Code shells.
- Packaged dedicated `bundled/pt` and `bundled/pintos-tests` launchers with the extension and refreshed the activation events so the terminal CLI is ready as soon as a Pintos workspace is detected.
- Updated the public and packaged README files to distinguish the Marketplace-installed flow from the source-checkout helper scripts, especially for `pintos_22.04_lab_docker` style lab environments.

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
