# Legacy Archive

This folder keeps small reference files from the earlier monorepo-oriented setup.

- `vscode/launch.monorepo.json`: the original extension host launch configuration that assumed the extension lived two directories below the Pintos workspace root

Historical VSIX binaries are intentionally not kept in this repository anymore.
If a release artifact is needed later, rebuild it locally into `dist/` and publish it through GitHub Releases or the VS Code Marketplace.
