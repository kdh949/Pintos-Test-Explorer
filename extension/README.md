# Pintos Test Explorer

Run and debug Pintos test cases from a dedicated VS Code sidebar.

`Pintos Test Explorer` is a workspace-focused extension for common Pintos lab environments, including the `pintos_22.04_lab_docker` workflow. It shows the built-in Pintos test suites in a tree, lets you run one test or many tests without memorizing names, and starts GDB-backed debugging directly from the UI.

## Install

1. Open `Extensions` in VS Code.
2. Search for `Pintos Test Explorer`.
3. Click `Install`.
4. If you are using a Dev Container, install it into the container.
5. Run `Developer: Reload Window` once after installation.

After installation, look for the `P os` icon in the Activity Bar.

## Quick Start

1. Open the Pintos workspace in a Dev Container or Linux environment.
2. Click the `P os` Activity Bar icon.
3. Expand `Threads`, `User Programs`, `Virtual Memory`, or `File System`.
4. Click the green `Run` button next to a test to execute it.
5. Click the orange `Debug` button to start a GDB debug session for a single test.
6. Check multiple tests and use `Run Checked Tests` from the view toolbar for batch execution.
7. Use the toolbar sort button to switch between `Number order` and `Latest first`.

When a test has artifacts, the tree shows quick links for `output`, `result`, and `errors`.

## Requirements

- VS Code `1.85.0` or newer
- A Pintos workspace in either of these layouts:
  - `<workspace>/threads`, `<workspace>/userprog`, `<workspace>/vm`, `<workspace>/tests`
  - `<workspace>/pintos/threads`, `<workspace>/pintos/userprog`, `<workspace>/pintos/vm`, `<workspace>/pintos/tests`
- A Linux or Dev Container environment with `make`
- `gdb` installed and available on your `PATH` for debug sessions
- `ms-vscode.cpptools`

This extension is designed for common Pintos lab workflows and is most reliable inside a matching Dev Container or Linux environment.

## Features

- Browse `threads`, `userprog`, `vm`, and `filesys` tests from a dedicated tree view
- Run one test directly from its row
- Debug one test with a GDB remote attach flow
- Check multiple tests and run them as a batch
- Toggle the tree between `Number order` and `Latest first`
- Open `output`, `result`, and `errors` files directly from the tree
- Build the visible test list dynamically from `Make.tests`

## Debugging Notes

Debug sessions use the helper scripts bundled inside the extension together with VS Code C/C++ debugging. The extension passes your current Pintos workspace root into those helpers, so Marketplace installs do not depend on a matching `scripts/` directory in the repo checkout.

The expected flow is:

1. Start the Pintos GDB server for the selected test.
2. Wait for the debug server to become ready.
3. Attach `gdb` through `cppdbg`.
4. Continue, step, inspect variables, and use breakpoints from the normal VS Code debug UI.

If debug startup fails, open the `Pintos Tests` output channel first. The extension prints recent helper logs there, which usually show whether the problem is a missing `gdb`, a build failure, or a test command resolution issue.

## Companion CLI

This repository also includes a terminal-first companion CLI in the repository's `scripts/` directory. The official command name is `pintos-tests`, and a shorter `pt` shortcut is available for day-to-day use. It is a repo companion, so installing the VS Code extension alone does not add either command to your shell automatically.

Recommended setup:

```bash
source scripts/install-pintos-cli.sh
pt --help
```

Common selector examples:

```bash
# Run tests 11 through 20
pt run threads 11-20

# Mix ranges, exact names, and patterns
pt run threads 1 3-5 alarm-zero alarm-*

# Run every filesys test
pt run filesys all

# Debug exactly one test by number
pt debug threads 12

# Show most recently used tests first
pt list threads --recent-first
```

Selector rules:

- `11-20` runs an inclusive numeric range.
- `alarm-zero` selects by exact short name.
- `tests/threads/alarm-zero` also works.
- `alarm-*` works as a wildcard pattern.
- `all` selects every test for `run`.
- `debug` must resolve to exactly one test.

`--recent-first` uses your local run/debug history and moves the most recently used tests to the top of the list. The history is stored in `.vscode/pintos-test-history.json` inside the Pintos workspace.

If you want `pintos-tests` and `pt` available from any terminal:

```bash
source scripts/install-pintos-cli.sh
```

That installs small wrappers at `~/.local/bin/pintos-tests` and `~/.local/bin/pt`.
It also adds `~/.local/bin` to your shell profile so the commands keep working in future shells.

Examples after install:

```bash
pt --help
pt list threads
pintos-tests debug vm 4 --server-only
```

If you prefer shell integration without installing a wrapper:

```bash
source scripts/pintos-shell.sh
```

That makes both `pintos-tests` and `pt` available in the current shell only.

## License

MIT. See [LICENSE.txt](LICENSE.txt).
