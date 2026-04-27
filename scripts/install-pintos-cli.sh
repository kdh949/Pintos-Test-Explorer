#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
BIN_DIR="${HOME}/.local/bin"
COMMANDS=("pintos-tests" "pt")
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
PROFILE_MARKER="# Added by Pintos Test Explorer CLI installer"

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

detect_profile_file() {
  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"

  case "$shell_name" in
    zsh)
      printf '%s\n' "${HOME}/.zshrc"
      ;;
    bash)
      if [[ -f "${HOME}/.bash_profile" || ! -f "${HOME}/.bashrc" ]]; then
        printf '%s\n' "${HOME}/.bash_profile"
      else
        printf '%s\n' "${HOME}/.bashrc"
      fi
      ;;
    *)
      printf '%s\n' "${HOME}/.profile"
      ;;
  esac
}

ensure_path_line() {
  local profile_file="$1"

  mkdir -p "$(dirname "$profile_file")"
  touch "$profile_file"

  if ! grep -Fqx "$PATH_LINE" "$profile_file" 2>/dev/null; then
    {
      printf '\n%s\n' "$PROFILE_MARKER"
      printf '%s\n' "$PATH_LINE"
    } >>"$profile_file"
  fi
}

PROFILE_FILE="$(detect_profile_file)"
ensure_path_line "$PROFILE_FILE"

CURRENT_SHELL_UPDATED="no"
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) export PATH="$BIN_DIR:$PATH" ;;
  esac
  CURRENT_SHELL_UPDATED="yes"
fi

cat <<EOF
Installed CLI wrappers to:
  ${BIN_DIR}/pintos-tests
  ${BIN_DIR}/pt

Both commands accept the same arguments.
Examples:
  pt --help
  pintos-tests list threads

PATH setup:
  Added to: ${PROFILE_FILE}
  Line: ${PATH_LINE}

EOF

if [[ "$CURRENT_SHELL_UPDATED" == "yes" ]]; then
  cat <<EOF
Current shell updated too, so you can use it right away:
  pt --help
EOF
else
  cat <<EOF
Open a new shell, or run:
  exec "\$SHELL" -l

Then you can use:
  pt --help
EOF
fi
