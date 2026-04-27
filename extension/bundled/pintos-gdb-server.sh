#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

find_repo_root_from() {
  local start="$1"
  local current
  local parent

  [[ -n "$start" ]] || return 1
  if [[ -d "$start" ]]; then
    current="$(cd "$start" >/dev/null 2>&1 && pwd)" || return 1
  else
    current="$(cd "$(dirname "$start")" >/dev/null 2>&1 && pwd)" || return 1
  fi

  while true; do
    if [[ -x "$current/utils/pintos" && -f "$current/threads/Make.vars" && -f "$current/userprog/Make.vars" && -f "$current/vm/Make.vars" && -f "$current/tests/Make.tests" ]]; then
      printf '%s\n' "$current"
      return 0
    fi
    if [[ -x "$current/pintos/utils/pintos" && -f "$current/pintos/threads/Make.vars" && -f "$current/pintos/userprog/Make.vars" && -f "$current/pintos/vm/Make.vars" && -f "$current/pintos/tests/Make.tests" ]]; then
      printf '%s\n' "$current/pintos"
      return 0
    fi
    parent="$(dirname "$current")"
    if [[ "$parent" == "$current" ]]; then
      return 1
    fi
    current="$parent"
  done
}

discover_root_dir() {
  local candidate
  local root
  local -a candidates=()

  if [[ -n "${PINTOS_ROOT:-}" ]]; then
    candidates+=("$PINTOS_ROOT")
  fi
  if [[ -n "${PINTOS_WORKSPACE_ROOT:-}" ]]; then
    candidates+=("$PINTOS_WORKSPACE_ROOT")
  fi
  candidates+=("$PWD")
  candidates+=("$SCRIPT_DIR/../../..")

  for candidate in "${candidates[@]}"; do
    root="$(find_repo_root_from "$candidate" || true)"
    if [[ -n "$root" ]]; then
      printf '%s\n' "$root"
      return 0
    fi
  done

  echo "Could not locate the Pintos project root. Set PINTOS_ROOT or open the Pintos repository." >&2
  return 1
}

ROOT_DIR="$(discover_root_dir)"
STATE_DIR="$ROOT_DIR/.vscode/.pintos-gdb"
PID_FILE="$STATE_DIR/server.pid"

usage() {
  cat <<'EOF'
Usage:
  pintos-gdb-server.sh start <threads|userprog|vm|filesys> <test-name>
  pintos-gdb-server.sh stop
EOF
}

extract_pintos_command_line() {
  local text="$1"

  printf '%s\n' "$text" | awk '
    {
      cmd = $1
      count = split(cmd, parts, "/")
      if (parts[count] == "pintos") {
        print
      }
    }
  ' | tail -n 1
}

ensure_pintos_path() {
  export PATH="$ROOT_DIR/utils:$PATH"
}

cleanup_pid_file() {
  rm -f "$PID_FILE"
}

stop_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 0
  fi

  local server_pid
  server_pid="$(<"$PID_FILE")"

  if kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM -- "-$server_pid" 2>/dev/null || true

    for _ in $(seq 1 30); do
      if ! kill -0 "$server_pid" 2>/dev/null; then
        cleanup_pid_file
        return 0
      fi
      sleep 0.1
    done

    kill -KILL -- "-$server_pid" 2>/dev/null || true
  fi

  cleanup_pid_file
}

resolve_output_target() {
  local project="$1"
  local test_name="$2"
  local build_dir="$3"
  local -a candidates=()
  local candidate
  local output
  local run_line
  local last_output=""

  case "$project" in
    threads)
      candidates=("tests/threads/${test_name}.output")
      if [[ "$test_name" != */* ]]; then
        candidates+=("tests/threads/mlfqs/${test_name}.output")
      fi
      ;;
    userprog)
      candidates=("tests/userprog/${test_name}.output")
      ;;
    vm)
      candidates=("tests/vm/${test_name}.output")
      ;;
    filesys)
      candidates=("tests/filesys/${test_name}.output")
      ;;
    *)
      return 1
      ;;
  esac

  for candidate in "${candidates[@]}"; do
    output="$(make -C "$build_dir" -B -n "$candidate" 2>&1 || true)"
    last_output="$output"
    run_line="$(extract_pintos_command_line "$output" || true)"
    if [[ -n "$run_line" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if [[ -n "$last_output" ]]; then
    echo "Failed to resolve the Pintos run command for '$project/$test_name'." >&2
    echo "Recent make output:" >&2
    printf '%s\n' "$last_output" | tail -n 20 >&2
  fi

  return 1
}

extract_run_command() {
  local build_dir="$1"
  local output_target="$2"
  local output
  local cmd

  output="$(make -C "$build_dir" -B -n "$output_target" 2>&1)"
  cmd="$(extract_pintos_command_line "$output" || true)"
  if [[ -z "$cmd" ]]; then
    echo "Could not resolve a Pintos run command for $output_target." >&2
    echo "Recent make output:" >&2
    printf '%s\n' "$output" | tail -n 20 >&2
    exit 1
  fi

  printf '%s\n' "$cmd"
}

parse_command() {
  local command_line="$1"
  local source_array_name="$2"
  local debug_array_name="$3"
  local -n source_array="$source_array_name"
  local -n debug_array="$debug_array_name"
  local stripped

  stripped="${command_line%% < /dev/null*}"
  source_array=()
  debug_array=()

  eval "set -- $stripped"

  while (($#)); do
    case "$1" in
      -k)
        shift
        ;;
      -T)
        shift 2
        ;;
      -p)
        source_array+=("${2%%:*}")
        debug_array+=("$1" "$2")
        shift 2
        ;;
      --)
        debug_array+=("--gdb" "--")
        shift
        break
        ;;
      *)
        debug_array+=("$1")
        shift
        ;;
    esac
  done

  while (($#)); do
    debug_array+=("$1")
    shift
  done
}

is_tcp_port_listening() {
  local port="$1"
  local port_hex
  port_hex="$(printf '%04X' "$port")"

  if [[ -r /proc/net/tcp ]] && awk 'NR > 1 {print $2, $4}' /proc/net/tcp | grep -q ":${port_hex} 0A\$"; then
    return 0
  fi

  if [[ -r /proc/net/tcp6 ]] && awk 'NR > 1 {print $2, $4}' /proc/net/tcp6 | grep -q ":${port_hex} 0A\$"; then
    return 0
  fi

  return 1
}

describe_listening_port() {
  local port="$1"

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  local details
  details="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 || true)"
  if [[ -n "$details" ]]; then
    echo "Current listener(s) on port $port:" >&2
    printf '%s\n' "$details" >&2
  fi
}

ensure_gdb_port_available() {
  if ! is_tcp_port_listening 1234; then
    return 0
  fi

  echo "Port 1234 is already in use, so the Pintos GDB server cannot start." >&2
  echo "Stop the existing listener on 127.0.0.1:1234 and try again." >&2
  describe_listening_port 1234
  return 1
}

wait_for_gdb_port() {
  local server_pid="$1"

  for _ in $(seq 1 100); do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "Pintos debug server exited before GDB could attach." >&2
      return 1
    fi

    if is_tcp_port_listening 1234; then
      return 0
    fi

    sleep 0.1
  done

  echo "Timed out while waiting for the Pintos GDB server on port 1234." >&2
  return 1
}

start_server() {
  local project="$1"
  local test_name="$2"
  local project_dir="$ROOT_DIR/$project"
  local build_dir="$project_dir/build"
  local output_target
  local run_command
  local main_target
  local -a put_sources=()
  local -a debug_command=()
  local server_pid
  local status

  mkdir -p "$STATE_DIR"
  stop_server || true
  ensure_pintos_path
  ensure_gdb_port_available

  make -C "$project_dir" >/dev/null

  output_target="$(resolve_output_target "$project" "$test_name" "$build_dir")" || {
    echo "Could not prepare a debug run for test '$test_name' in project '$project'." >&2
    exit 1
  }

  run_command="$(extract_run_command "$build_dir" "$output_target")"
  parse_command "$run_command" put_sources debug_command

  make -C "$build_dir" os.dsk >/dev/null

  main_target="${output_target%.output}"
  if [[ "$project" != "threads" ]]; then
    make -C "$build_dir" "$main_target" >/dev/null
  fi

  for source_path in "${put_sources[@]}"; do
    make -C "$build_dir" "$source_path" >/dev/null
  done

  echo "PINTOS_GDB_SERVER_STARTING"
  printf 'Resolved command (cwd=%q):' "$build_dir"
  printf ' %q' "${debug_command[@]}"
  printf '\n'

  trap 'stop_server || true' INT TERM
  (
    cd "$build_dir"
    exec setsid "${debug_command[@]}"
  ) &
  server_pid=$!
  printf '%s\n' "$server_pid" >"$PID_FILE"

  if ! wait_for_gdb_port "$server_pid"; then
    stop_server || true
    exit 1
  fi
  echo "PINTOS_GDB_SERVER_READY"

  set +e
  wait "$server_pid"
  status=$?
  set -e

  cleanup_pid_file

  case "$status" in
    0|129|130|143)
      exit 0
      ;;
    *)
      exit "$status"
      ;;
  esac
}

main() {
  if (($# == 0)); then
    usage
    exit 1
  fi

  case "$1" in
    start)
      if (($# != 3)); then
        usage
        exit 1
      fi
      start_server "$2" "$3"
      ;;
    stop)
      if (($# != 1)); then
        usage
        exit 1
      fi
      stop_server
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
