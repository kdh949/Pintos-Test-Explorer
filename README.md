# Pintos Test Explorer

Languages: English | [한국어](README.ko.md)

Run, debug, reset, and inspect Pintos tests from VS Code, and use the same workflow from the terminal with `pt`.

## Install

### VS Code Extension

1. Open `Extensions` in VS Code.
2. Search for `Pintos Test Explorer`.
3. Click `Install`.
4. If you are using a Dev Container, install it into the container too.
5. Run `Developer: Reload Window` once after installation.

### CLI

If you want the natural everyday command form:

```bash
source scripts/install-pintos-cli.sh
pt --help
```

That is the recommended setup. After this one-time step, `pt` and `pintos-tests` work like normal commands.

If you only want to enable the commands for the current shell session:

```bash
source scripts/pintos-shell.sh
pt --help
```

## Quick Start

### In VS Code

1. Open your Pintos workspace in a Dev Container or Linux environment.
2. Click the `P os` icon in the Activity Bar.
3. Expand `Threads`, `User Programs`, `Virtual Memory`, or `File System`.
4. Click the green `Run` action next to a test to execute it.
5. Click the orange `Debug` action to start a GDB session for one test.
6. Check multiple tests and use `Run Checked Tests` from the toolbar.
7. Use the sort button to switch between `Number order` and `Latest first`.
8. Use the leftmost red `Reset All Tests` button to clear the whole workspace, or use `Reset Checked Tests` to reset only the selected tests.

When a test already has artifacts, the tree shows links for `output`, `result`, and `errors`.

### In The Terminal

Inside a Pintos workspace:

```bash
pt projects
pt list threads
pt reset threads alarm-zero
pt reset-all
pt run threads alarm-zero
pt run threads 11-20
pt debug vm 4 --server-only
```

Outside the workspace, point to it explicitly:

```bash
PINTOS_ROOT=/path/to/pintos pt list threads
PINTOS_ROOT=/path/to/pintos pt run filesys all
```

`pt` is the short everyday command. `pintos-tests` does the same thing.

## What This Supports

- Browse `threads`, `userprog`, `vm`, and `filesys` tests from the VS Code sidebar
- Run one test directly from the UI or the terminal
- Debug one test with a GDB-backed workflow
- Run multiple tests at once with checkbox selection or CLI selectors
- Open test artifacts such as `output`, `result`, and `errors`
- Reorder the test list with `Number order` or `Latest first`
- Reset only checked tests or clear every check and artifact from the toolbar
- Mark build-time run failures as `FAIL` in the test tree instead of leaving them as `Not run`
- Reset selected tests or the whole workspace from the CLI
- Use `--recent-first` in the CLI to prioritize recently used tests

## CLI Examples

Common commands:

```bash
pt list threads --recent-first
pt reset threads 4 7-9 alarm-zero
pt reset threads all
pt reset-all
pt run threads 1 3-5 alarm-zero alarm-*
pt run filesys all
pt debug threads 12
pt artifacts threads alarm-zero
```

Selector rules:

- `11-20` runs an inclusive numeric range.
- `alarm-zero` selects by exact short name.
- `tests/threads/alarm-zero` also works.
- `alarm-*` works as a wildcard pattern.
- `all` selects every test for `run` and project-scoped `reset`.
- `debug` must resolve to exactly one test.

## Requirements

- VS Code `1.85.0` or newer
- A Pintos workspace in either of these layouts:
  - `<workspace>/threads`, `<workspace>/userprog`, `<workspace>/vm`, `<workspace>/tests`
  - `<workspace>/pintos/threads`, `<workspace>/pintos/userprog`, `<workspace>/pintos/vm`, `<workspace>/pintos/tests`
- A Linux or Dev Container environment with `make`
- `gdb` on your `PATH` for debug sessions
- `ms-vscode.cpptools`

## Troubleshooting

- If `pt list ...` says it cannot find a Pintos project root, open the real Pintos workspace or set `PINTOS_ROOT=/path/to/pintos`.
- If VS Code debug startup fails, open the `Pintos Tests` output channel first.
- If a run stops at a compile or build error, the extension now marks that test as `FAIL` and keeps the captured error output in the artifacts.
- If debugging does not start, confirm that `gdb` is installed in the active environment.

## More Details

- [`extension/README.md`](extension/README.md)
- [`extension/SUPPORT.md`](extension/SUPPORT.md)
- [`extension/CHANGELOG.md`](extension/CHANGELOG.md)
