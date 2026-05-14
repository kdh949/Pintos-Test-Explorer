# Pintos Test Explorer

Languages: English | [한국어](README.ko.md)

Pintos Test Explorer is a VS Code sidebar extension plus a bundled terminal CLI for running Pintos tests with one shared workflow. This repository is the source tree for the extension, the bundled helpers, and the release packaging script.

## Snapshot

```text
1. Match the active build directory's project-owned TESTS list when a build Makefile exists.
2. Keep optional nested Make.tests suites such as userprog/dup2 visible without adding them to project-level all runs unless the build TESTS selected them.
3. Prefer the Pintos root implied by the terminal's current directory before falling back to pinned PINTOS_ROOT variables, so moving between build trees reads the right artifacts.
4. Use the same helper logic from the sidebar, pt, and pintos-tests.
5. Handle wrapper layouts such as pintos_22.04_lab_docker without hard-coding one folder name.
6. Ignore stale old group JSON so built-in folders like Alarm Clock keep their intended names.
7. Keep repeated checkbox selection fast by reusing discovered test data until a real refresh is needed.
8. Let VM project work reuse `vm/build` for User Programs run/debug/artifact status through one persistent checkbox inside Virtual Memory.
```

```mermaid
flowchart LR
    A["VS Code Sidebar"] --> C["bundled pintos-test-cli.py"]
    B["pt / pintos-tests"] --> C
    C --> D["build Makefile TESTS / tests/*/Make.tests"]
    C --> E["make / Pintos build tree"]
    C --> F["pintos-gdb-server.sh"]
    E --> G["output / result / errors artifacts"]
    F --> H["VS Code cppdbg / gdb"]
```

## User Workflow

The current release supports these workspace layouts:

- the Pintos root itself
- a wrapper repository that contains `pintos/`
- a `src/` root
- nested lab layouts such as `pintos_22.04_lab_docker`

Quick VS Code flow:

1. Install the extension or load the VSIX.
2. Reload the window once.
3. Open the `Pintos` activity-bar view.
4. For VM project work, expand Virtual Memory and enable `User Programs for VM` once.
5. Run or debug a test from its row.
6. Check folders or tests and use `Run Checked Tests`.
7. Open `output`, `result`, or `errors` artifacts directly from the tree when you need details.

Quick terminal flow:

```bash
pt projects
pt list threads
pt run threads alarm-zero
pt debug vm 4 --server-only
pt reset threads alarm-*
pt artifacts threads alarm-zero
```

If the extension is already active, a new integrated terminal should recognize both `pt` and `pintos-tests`. From a source checkout, you can also run:

```bash
./pt --help
./pintos-tests --help
```

## Repository Workflow

Important paths in this repository:

- `extension/`: extension source, packaged README files, bundled helpers, manifest
- `scripts/build-pintos-test-explorer-vsix.py`: offline VSIX builder used for release packaging
- `dist/`: generated VSIX artifacts

Build a release VSIX from this checkout with:

```bash
python3 scripts/build-pintos-test-explorer-vsix.py
```

The generated release artifact is written to `dist/pintos-test-explorer-<version>.vsix`.

Documentation is intentionally split by audience:

- GitHub README: `README.md` and `README.ko.md`
- Marketplace README source: `extension/README.md` and `extension/README.ko.md`
- Packaging rule: the VSIX builder rewrites relative links inside `extension/README.md` so Marketplace links point back to GitHub correctly

## Troubleshooting

### Test discovery looks wrong in a wrapper repo

Run terminal commands from inside the Pintos tree or its build directories when possible. The CLI uses the current directory's Pintos root first, then falls back to `PINTOS_ROOT` if the current directory is outside a Pintos tree:

```bash
PINTOS_ROOT=/path/to/pintos pt list threads
```

### A stale custom entry keeps breaking builds

If a run on something unrelated such as `priority-change` still fails while compiling `tests/threads/custom/...`, the workspace likely has an old custom registration left behind:

```bash
pt custom delete threads custom/new-test
```

If the error mentions a missing dependency file such as `tests/threads/custom/new-test.d`, reload the latest VSIX and rerun once so the extension can recreate the matching build subdirectory before the next build.

### `Alarm Clock` still shows up as `New Group`

Old files such as `.vscode/pintos-test-explorer/groups/threads/new-group.json` are ignored by default in the current release. If you still see the old label, reload onto the latest VSIX. Deleting that stale JSON file is also safe.

### Debug restart still feels stuck

The current release routes VS Code `Restart` through the same debug-preparation path as the first launch. If old behavior persists, reload the window and confirm you are actually on the newest VSIX.
