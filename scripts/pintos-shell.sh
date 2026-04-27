#!/usr/bin/env bash

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

case ":$PATH:" in
  *":$ROOT_DIR/scripts:"*) ;;
  *) export PATH="$ROOT_DIR/scripts:$PATH" ;;
esac

case ":$PATH:" in
  *":$ROOT_DIR/pintos/utils:"*) ;;
  *) export PATH="$ROOT_DIR/pintos/utils:$PATH" ;;
esac
