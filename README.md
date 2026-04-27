# Pintos Test Explorer

Standalone home for the `Pintos Test Explorer` VS Code extension and its companion CLI scripts.

## Repository Layout

- `extension/`: VS Code extension source and Marketplace metadata
- `scripts/`: companion CLI helpers plus the offline VSIX build script
- `dist/`: local VSIX build output (gitignored)
- `legacy/`: archived files from the earlier monorepo-oriented setup

## Build The VSIX

```bash
cd extension
python3 ../scripts/build-pintos-test-explorer-vsix.py
```

The script writes `dist/pintos-test-explorer-<version>.vsix`.
Generated VSIX files stay out of Git and should be published through Releases or the Marketplace instead of source control.

## CLI Shortcuts

The repository also ships a companion CLI. The official command is `pintos-tests`, and `pt` is provided as the shorter everyday shortcut.

Run from the repo:

```bash
./scripts/pt --help
./scripts/pt list threads
```

Install both wrappers into `~/.local/bin`:

```bash
bash scripts/install-pintos-cli.sh
```

## Documentation

- Usage and install guide: [`extension/README.md`](extension/README.md)
- Support flow: [`extension/SUPPORT.md`](extension/SUPPORT.md)
- Release notes: [`extension/CHANGELOG.md`](extension/CHANGELOG.md)
- Archived legacy files: [`legacy/README.md`](legacy/README.md)
