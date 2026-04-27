#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${HOME}/.local/bin"
COMMANDS=("pintos-tests" "pt")

mkdir -p "$BIN_DIR"

for command in "${COMMANDS[@]}"; do
  TARGET="${BIN_DIR}/${command}"
  cat >"$TARGET" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${ROOT_DIR}/scripts/pintos-tests" "\$@"
EOF

  chmod +x "$TARGET"
done

cat <<EOF
Installed CLI wrappers to:
  ${BIN_DIR}/pintos-tests
  ${BIN_DIR}/pt

Both commands accept the same arguments.
Examples:
  pt --help
  pintos-tests list threads

Make sure \$HOME/.local/bin is on your PATH.
Example:
  export PATH="\$HOME/.local/bin:\$PATH"
EOF
