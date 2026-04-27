#!/usr/bin/env python3

from __future__ import annotations

import argparse
import difflib
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Thread


class CliError(Exception):
    pass


PROJECT_SPECS: tuple[tuple[str, str], ...] = (
    ("threads", "Threads"),
    ("userprog", "User Programs"),
    ("vm", "Virtual Memory"),
    ("filesys", "File System"),
)


def discover_repo_root() -> Path:
    candidates: list[Path] = []
    direct_root = os.environ.get("PINTOS_ROOT")
    if direct_root:
        candidates.append(Path(direct_root))
    env_root = os.environ.get("PINTOS_WORKSPACE_ROOT")
    if env_root:
        candidates.append(Path(env_root))
    candidates.append(Path.cwd())
    # Local development fallback when the extension folder lives inside the repo.
    candidates.append(Path(__file__).resolve().parents[3])

    for candidate in candidates:
        for current in [candidate, *candidate.parents]:
            if (
                (current / "utils" / "pintos").exists()
                and (current / "threads" / "Make.vars").exists()
                and (current / "userprog" / "Make.vars").exists()
                and (current / "vm" / "Make.vars").exists()
                and (current / "tests" / "Make.tests").exists()
            ):
                return current
            nested = current / "pintos"
            if (
                (nested / "utils" / "pintos").exists()
                and (nested / "threads" / "Make.vars").exists()
                and (nested / "userprog" / "Make.vars").exists()
                and (nested / "vm" / "Make.vars").exists()
                and (nested / "tests" / "Make.tests").exists()
            ):
                return nested

    raise CliError(
        "Could not find a Pintos project root. "
        "Open the repository root, the `pintos/` folder, or set PINTOS_ROOT."
    )


GDB_SERVER_SCRIPT = Path(__file__).resolve().with_name("pintos-gdb-server.sh")
ARTIFACT_KINDS = ("output", "result", "errors")
ROOT_DIR: Path | None = None
UTILS_DIR: Path | None = None
HISTORY_FILE: Path | None = None


@dataclass(frozen=True)
class ProjectMeta:
    name: str
    label: str
    project_dir: Path
    build_dir: Path
    kernel_path: Path
    prefixes: tuple[str, ...]


@dataclass(frozen=True)
class TestEntry:
    index: int
    full_name: str
    short_name: str
    group: str


PROJECTS: dict[str, ProjectMeta] = {}


def build_projects(root_dir: Path) -> dict[str, ProjectMeta]:
    return {
        "threads": ProjectMeta(
            name="threads",
            label="Threads",
            project_dir=root_dir / "threads",
            build_dir=root_dir / "threads" / "build",
            kernel_path=root_dir / "threads" / "build" / "kernel.o",
            prefixes=("tests/threads/",),
        ),
        "userprog": ProjectMeta(
            name="userprog",
            label="User Programs",
            project_dir=root_dir / "userprog",
            build_dir=root_dir / "userprog" / "build",
            kernel_path=root_dir / "userprog" / "build" / "kernel.o",
            prefixes=("tests/userprog/",),
        ),
        "vm": ProjectMeta(
            name="vm",
            label="Virtual Memory",
            project_dir=root_dir / "vm",
            build_dir=root_dir / "vm" / "build",
            kernel_path=root_dir / "vm" / "build" / "kernel.o",
            prefixes=("tests/vm/",),
        ),
        "filesys": ProjectMeta(
            name="filesys",
            label="File System",
            project_dir=root_dir / "filesys",
            build_dir=root_dir / "filesys" / "build",
            kernel_path=root_dir / "filesys" / "build" / "kernel.o",
            prefixes=("tests/filesys/",),
        ),
    }


def ensure_runtime() -> None:
    global ROOT_DIR, UTILS_DIR, HISTORY_FILE, PROJECTS
    if ROOT_DIR is not None:
        return

    ROOT_DIR = discover_repo_root()
    UTILS_DIR = ROOT_DIR / "utils"
    HISTORY_FILE = ROOT_DIR / ".vscode" / "pintos-test-history.json"
    PROJECTS = build_projects(ROOT_DIR)


def make_env() -> dict[str, str]:
    ensure_runtime()
    assert ROOT_DIR is not None
    assert UTILS_DIR is not None
    env = os.environ.copy()
    env["PATH"] = f"{UTILS_DIR}:{env.get('PATH', '')}"
    env["PINTOS_ROOT"] = str(ROOT_DIR)
    env["PINTOS_WORKSPACE_ROOT"] = str(ROOT_DIR)
    return env


def load_history() -> dict[str, dict[str, dict[str, float | int]]]:
    ensure_runtime()
    assert HISTORY_FILE is not None
    if not HISTORY_FILE.exists():
        return {}
    try:
        data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def save_history(data: dict[str, dict[str, dict[str, float | int]]]) -> None:
    try:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        HISTORY_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    except OSError:
        pass


def record_history(meta: ProjectMeta, entries: list[TestEntry], *, action: str) -> None:
    history = load_history()
    project_history = history.setdefault(meta.name, {})
    now = time.time()

    for entry in entries:
        item = project_history.setdefault(entry.full_name, {})
        item["count"] = int(item.get("count", 0)) + 1
        item["last_used"] = now
        item["last_action"] = action

    save_history(history)


def sort_entries_by_history(meta: ProjectMeta, entries: list[TestEntry], *, recent_first: bool) -> list[TestEntry]:
    if not recent_first:
        return entries

    history = load_history().get(meta.name, {})

    def sort_key(entry: TestEntry) -> tuple[float, float, int]:
        item = history.get(entry.full_name, {})
        count = float(item.get("count", 0))
        last_used = float(item.get("last_used", 0))
        return (-last_used, -count, entry.index)

    return sorted(entries, key=sort_key)


def ensure_build_tree(meta: ProjectMeta) -> None:
    if (meta.build_dir / "Makefile").exists():
        return
    try:
        subprocess.run(
            ["make", "-C", str(meta.project_dir)],
            check=True,
            env=make_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as exc:
        raise CliError(
            f"Could not prepare the {meta.name} build directory. "
            f"`make -C {meta.project_dir}` failed."
        ) from exc


def read_make_logical_lines(path: Path) -> list[str]:
    logical_lines: list[str] = []
    pending = ""

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line and not pending:
            continue
        if line.endswith("\\"):
            pending += line[:-1] + " "
            continue
        combined = (pending + line).strip()
        pending = ""
        if combined:
            logical_lines.append(combined)

    if pending.strip():
        logical_lines.append(pending.strip())

    return logical_lines


def split_top_level_args(text: str, expected_parts: int) -> list[str]:
    parts: list[str] = []
    depth = 0
    start = 0

    for index, char in enumerate(text):
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0 and len(parts) < expected_parts - 1:
            parts.append(text[start:index].strip())
            start = index + 1

    parts.append(text[start:].strip())
    return parts


def load_make_assignments(meta: ProjectMeta) -> dict[str, str]:
    assignments: dict[str, str] = {}
    test_dir = ROOT_DIR / "tests" / meta.name
    for make_file in sorted(test_dir.rglob("Make.tests")):
        for line in read_make_logical_lines(make_file):
            if "+=" in line:
                var, rhs = line.split("+=", 1)
                var = var.strip()
                rhs = rhs.strip()
                assignments[var] = f"{assignments.get(var, '')} {rhs}".strip()
                continue
            if "=" in line:
                var, rhs = line.split("=", 1)
                assignments[var.strip()] = rhs.strip()
    return assignments


def evaluate_make_expression(expr: str, assignments: dict[str, str]) -> list[str]:
    expr = " ".join(expr.split())
    if not expr:
        return []

    if expr.startswith("$(") and expr.endswith(")"):
        inner = expr[2:-1].strip()
        if inner.startswith("addprefix "):
            args = split_top_level_args(inner[len("addprefix ") :], 2)
            if len(args) != 2:
                return []
            prefix = args[0]
            words = evaluate_make_expression(args[1], assignments)
            return [f"{prefix}{word}" for word in words]
        if inner.startswith("patsubst "):
            args = split_top_level_args(inner[len("patsubst ") :], 3)
            if len(args) != 3:
                return []
            pattern, replacement, words_expr = args
            words = evaluate_make_expression(words_expr, assignments)
            if pattern != "%":
                return words
            return [replacement.replace("%", word) for word in words]
        if inner in assignments:
            return evaluate_make_expression(assignments[inner], assignments)
        return [inner]

    return expr.split()


def parse_tests_from_makefiles(meta: ProjectMeta) -> list[TestEntry]:
    assignments = load_make_assignments(meta)
    full_names: list[str] = []
    seen: set[str] = set()
    variable_prefix = f"tests/{meta.name}"

    for variable_name, expression in assignments.items():
        if not variable_name.endswith("_TESTS"):
            continue
        if not variable_name.startswith(variable_prefix):
            continue
        for item in evaluate_make_expression(expression, assignments):
            if not item.startswith(meta.prefixes):
                continue
            if item in seen:
                continue
            seen.add(item)
            full_names.append(item)

    entries: list[TestEntry] = []
    for index, full_name in enumerate(full_names, start=1):
        prefix = next(prefix for prefix in meta.prefixes if full_name.startswith(prefix))
        short_name = full_name[len(prefix):]
        group = short_name.split("/", 1)[0] if "/" in short_name else "main"
        entries.append(
            TestEntry(
                index=index,
                full_name=full_name,
                short_name=short_name,
                group=group,
            )
        )

    return entries


def fetch_tests_via_make(meta: ProjectMeta) -> list[TestEntry]:
    ensure_build_tree(meta)

    with tempfile.NamedTemporaryFile("w", suffix=".mk", delete=False) as tmp:
        tmp.write("print-tests:\n")
        tmp.write("\t@printf \"%s\\n\" '$(TESTS)'\n")
        tmp_path = Path(tmp.name)

    try:
        result = subprocess.run(
            [
                "make",
                "-C",
                str(meta.build_dir),
                "--no-print-directory",
                "-f",
                "Makefile",
                "-f",
                str(tmp_path),
                "print-tests",
            ],
            check=True,
            env=make_env(),
            text=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        raise CliError(
            f"Could not read the {meta.name} test list.\n{exc.stderr.strip() or exc.stdout.strip()}"
        ) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    full_names: list[str] = []
    seen: set[str] = set()
    for item in result.stdout.split():
        if not item.startswith(meta.prefixes):
            continue
        if item in seen:
            continue
        seen.add(item)
        full_names.append(item)

    entries: list[TestEntry] = []
    for index, full_name in enumerate(full_names, start=1):
        prefix = next(prefix for prefix in meta.prefixes if full_name.startswith(prefix))
        short_name = full_name[len(prefix):]
        group = short_name.split("/", 1)[0] if "/" in short_name else "main"
        entries.append(
            TestEntry(
                index=index,
                full_name=full_name,
                short_name=short_name,
                group=group,
            )
        )

    return entries


def fetch_tests(meta: ProjectMeta, *, recent_first: bool = False) -> list[TestEntry]:
    parsed_entries = parse_tests_from_makefiles(meta)
    entries = parsed_entries if parsed_entries else fetch_tests_via_make(meta)
    return sort_entries_by_history(meta, entries, recent_first=recent_first)


def print_test_list(entries: list[TestEntry], stream: object) -> None:
    current_group: str | None = None
    for entry in entries:
        if entry.group != current_group:
            if current_group is not None:
                print("", file=stream)
            if entry.group != "main":
                print(f"[{entry.group}]", file=stream)
            current_group = entry.group
        print(f"{entry.index:>3}. {entry.short_name}", file=stream)


def project_choices_text() -> str:
    return ", ".join(name for name, _label in PROJECT_SPECS)


def list_projects(json_mode: bool) -> int:
    build_dir_by_name: dict[str, str] = {}
    try:
        ensure_runtime()
    except CliError:
        pass
    else:
        build_dir_by_name = {
            meta.name: str(meta.build_dir)
            for meta in PROJECTS.values()
        }

    if json_mode:
        payload = [
            {
                "name": name,
                "label": label,
                "build_dir": build_dir_by_name.get(name),
            }
            for name, label in PROJECT_SPECS
        ]
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    for name, label in PROJECT_SPECS:
        print(f"{name:<8} {label}")
    return 0


def selector_examples() -> str:
    return "Example: 4 7-9 alarm-zero mlfqs-load-1 alarm-*"


def entry_payload(entry: TestEntry) -> dict[str, object]:
    return {
        "index": entry.index,
        "full_name": entry.full_name,
        "short_name": entry.short_name,
        "group": entry.group,
    }


def matches_name_token(entry: TestEntry, token: str) -> bool:
    if token in {entry.short_name, entry.full_name, entry.short_name.split("/")[-1]}:
        return True
    return fnmatch_name(entry, token)


def fnmatch_name(entry: TestEntry, pattern: str) -> bool:
    if any(ch in pattern for ch in "*?[]"):
        return (
            fnmatch.fnmatch(entry.short_name, pattern)
            or fnmatch.fnmatch(entry.full_name, pattern)
            or fnmatch.fnmatch(entry.short_name.split("/")[-1], pattern)
        )
    return False


def parse_numeric_token(token: str, max_index: int) -> list[int] | None:
    if re.fullmatch(r"\d+", token):
        value = int(token)
        if value < 1 or value > max_index:
            raise CliError(f"Test number {value} is out of range. (1-{max_index})")
        return [value]

    if re.fullmatch(r"\d+-\d+", token):
        start_str, end_str = token.split("-", 1)
        start = int(start_str)
        end = int(end_str)
        if start > end:
            raise CliError(f"Invalid range: {token}")
        if start < 1 or end > max_index:
            raise CliError(f"Range {token} is out of bounds. (1-{max_index})")
        return list(range(start, end + 1))

    return None


def suggest_names(entries: list[TestEntry], token: str) -> str | None:
    candidates = sorted(
        {
            entry.short_name
            for entry in entries
        }
        | {
            entry.short_name.split("/")[-1]
            for entry in entries
        }
    )
    matches = difflib.get_close_matches(token, candidates, n=3, cutoff=0.45)
    if not matches:
        return None
    return ", ".join(matches)


def resolve_selection_tokens(
    entries: list[TestEntry],
    tokens: list[str],
    *,
    single: bool,
) -> list[TestEntry]:
    if not entries:
        raise CliError("No tests are available to select.")

    if not tokens:
        raise CliError(f"Select at least one test. {selector_examples()}")

    selected: list[TestEntry] = []
    seen: set[str] = set()

    for token in tokens:
        if token == "all":
            matches = entries
        else:
            numeric = parse_numeric_token(token, len(entries))
            if numeric is not None:
                matches = [entries[index - 1] for index in numeric]
            else:
                matches = [entry for entry in entries if matches_name_token(entry, token)]
                if not matches:
                    suggestion = suggest_names(entries, token)
                    if suggestion:
                        raise CliError(
                            f"No test matched '{token}'. "
                            f"Similar names: {suggestion}"
                        )
                    raise CliError(f"No test matched '{token}'.")

        for entry in matches:
            if entry.full_name not in seen:
                selected.append(entry)
                seen.add(entry.full_name)

    if single and len(selected) != 1:
        raise CliError("Debug requires exactly one selected test.")

    return selected


def interactive_pick(entries: list[TestEntry], *, single: bool, stream: object) -> list[TestEntry]:
    print_test_list(entries, stream)
    print("", file=stream)

    prompt = (
        "Enter a test to debug: "
        if single
        else "Enter tests to run: "
    )
    print(selector_examples(), file=stream)

    while True:
        print(prompt, end="", file=stream, flush=True)
        raw = sys.stdin.readline()
        if raw == "":
            raise SystemExit(1)

        try:
            tokens = raw.strip().split()
            return resolve_selection_tokens(entries, tokens, single=single)
        except CliError as exc:
            print(f"\nInput error: {exc}\n", file=stream)


def pick_entries(
    meta: ProjectMeta,
    *,
    single: bool,
    selectors: list[str] | None,
    allow_all: bool = False,
    recent_first: bool = False,
    stream: object,
) -> list[TestEntry]:
    entries = fetch_tests(meta, recent_first=recent_first)
    if selectors:
        if not allow_all and any(token == "all" for token in selectors):
            raise CliError("`all` is not allowed with this command.")
        return resolve_selection_tokens(entries, selectors, single=single)
    return interactive_pick(entries, single=single, stream=stream)


def artifact_paths(meta: ProjectMeta, entry: TestEntry) -> dict[str, Path]:
    return {
        kind: meta.build_dir / f"{entry.full_name}.{kind}"
        for kind in ARTIFACT_KINDS
    }


def summarize_result(meta: ProjectMeta, entry: TestEntry) -> tuple[bool, str]:
    result_path = artifact_paths(meta, entry)["result"]
    if not result_path.exists():
        return False, "missing result file"
    result_text = result_path.read_text(encoding="utf-8").strip()
    if result_text == "PASS":
        return True, "PASS"
    if result_text == "FAIL":
        return False, "FAIL"
    return False, result_text or "unknown result"


def print_artifacts(meta: ProjectMeta, entry: TestEntry, json_mode: bool) -> int:
    paths = artifact_paths(meta, entry)
    existing = {kind: str(path) for kind, path in paths.items() if path.exists()}
    if json_mode:
        print(json.dumps(existing, ensure_ascii=False))
        return 0
    if not existing:
        raise CliError(f"No output/result/errors files are available yet for {entry.short_name}.")
    for kind in ARTIFACT_KINDS:
        path = existing.get(kind)
        if path:
            print(f"{kind:<6} {path}")
    return 0


def run_selected_tests(meta: ProjectMeta, entries: list[TestEntry]) -> int:
    ensure_build_tree(meta)
    record_history(meta, entries, action="run")
    print("", file=sys.stderr)
    print(f"[{meta.name}] Running {len(entries)} test(s)", file=sys.stderr)
    print("", file=sys.stderr)

    failures = 0
    for offset, entry in enumerate(entries, start=1):
        print(f"[{offset}/{len(entries)}] {entry.short_name}", file=sys.stderr, flush=True)
        target = f"{entry.full_name}.result"
        completed = subprocess.run(
            ["make", "-C", str(meta.build_dir), "--no-print-directory", target],
            env=make_env(),
        )

        passed, status = summarize_result(meta, entry)
        if completed.returncode != 0:
            passed = False
            status = f"make exited with {completed.returncode}"

        if passed:
            print(f"PASS  {entry.short_name}", file=sys.stderr)
        else:
            failures += 1
            print(f"FAIL  {entry.short_name} ({status})", file=sys.stderr)
        print("", file=sys.stderr)

    passed_count = len(entries) - failures
    print(
        f"Summary: {passed_count} passed, {failures} failed, {len(entries)} total",
        file=sys.stderr,
    )
    return 0 if failures == 0 else 1


def _relay_stream(stream: object) -> None:
    for line in iter(stream.readline, ""):
        sys.stderr.write(line)
        sys.stderr.flush()


def stop_gdb_server() -> None:
    subprocess.run(
        ["bash", str(GDB_SERVER_SCRIPT), "stop"],
        cwd=ROOT_DIR,
        env=make_env(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def debug_test(meta: ProjectMeta, entry: TestEntry, *, server_only: bool) -> int:
    ensure_build_tree(meta)
    record_history(meta, [entry], action="debug")
    stop_gdb_server()

    server = subprocess.Popen(
        ["bash", str(GDB_SERVER_SCRIPT), "start", meta.name, entry.short_name],
        cwd=ROOT_DIR,
        env=make_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    assert server.stdout is not None

    ready = False
    try:
        for line in iter(server.stdout.readline, ""):
            sys.stderr.write(line)
            sys.stderr.flush()
            if "PINTOS_GDB_SERVER_READY" in line:
                ready = True
                break

        if not ready:
            raise CliError("The Pintos GDB server exited before it became ready.")

        if server_only:
            for line in iter(server.stdout.readline, ""):
                sys.stderr.write(line)
                sys.stderr.flush()
            return server.wait()

        gdb_path = shutil.which("gdb")
        if not gdb_path:
            raise CliError(
                "`gdb` was not found on PATH. Run inside a Dev Container or use "
                "`debug --server-only` to start only the Pintos GDB server."
            )

        relay = Thread(target=_relay_stream, args=(server.stdout,), daemon=True)
        relay.start()

        gdb_return = subprocess.run(
            [
                gdb_path,
                str(meta.kernel_path),
                "-ex",
                "target remote 127.0.0.1:1234",
            ],
            cwd=meta.build_dir,
            env=make_env(),
            check=False,
        )
        return gdb_return.returncode
    finally:
        stop_gdb_server()
        try:
            server.wait(timeout=3)
        except subprocess.TimeoutExpired:
            server.kill()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pintos-tests",
        description="CLI for listing, running, and debugging Pintos tests",
        epilog=(
            "Examples:\n"
            "  pintos-tests projects\n"
            "  pintos-tests list threads\n"
            "  pintos-tests list threads --recent-first\n"
            "  pintos-tests run threads 1 3-5 alarm-zero\n"
            "  pintos-tests run threads 11-20\n"
            "  pintos-tests run filesys all\n"
            "  pintos-tests debug threads alarm-zero\n"
            "  pintos-tests debug vm 4 --server-only\n"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    projects_parser = subparsers.add_parser("projects", help="Show available Pintos projects")
    projects_parser.add_argument("--json", action="store_true", help="Print as JSON")

    list_parser = subparsers.add_parser("list", help="Show the test list for a project")
    project_names = [name for name, _label in PROJECT_SPECS]
    list_parser.add_argument("project", choices=project_names, help=f"Project ({project_choices_text()})")
    list_parser.add_argument("--json", action="store_true", help="Print as JSON")
    list_parser.add_argument(
        "--recent-first",
        action="store_true",
        help="Sort most recently used tests first",
    )

    pick_parser = subparsers.add_parser(
        "pick",
        help="Print selected tests by name (automation)",
        description="Select tests and print only their names (internal/script use)",
    )
    pick_parser.add_argument("project", choices=project_names)
    pick_parser.add_argument("selectors", nargs="*", help="Number, range, name, or pattern")
    pick_parser.add_argument("--single", action="store_true", help="Require exactly one match")
    pick_parser.add_argument("--recent-first", action="store_true", help="Sort most recently used tests first")

    run_parser = subparsers.add_parser("run", help="Run tests")
    run_parser.add_argument("project", choices=project_names)
    run_parser.add_argument(
        "selectors",
        nargs="*",
        help="Number, range, name, pattern, or all",
    )
    run_parser.add_argument("--recent-first", action="store_true", help="Sort most recently used tests first during interactive selection")

    debug_parser = subparsers.add_parser("debug", help="Debug a test")
    debug_parser.add_argument("project", choices=project_names)
    debug_parser.add_argument("selectors", nargs="*", help="Exactly one number or test name")
    debug_parser.add_argument("--recent-first", action="store_true", help="Sort most recently used tests first during interactive selection")
    debug_parser.add_argument(
        "--server-only",
        action="store_true",
        help="Start only the Pintos GDB server without attaching GDB",
    )

    artifacts_parser = subparsers.add_parser("artifacts", help="Show test artifact paths")
    artifacts_parser.add_argument("project", choices=project_names)
    artifacts_parser.add_argument("selectors", nargs="+", help="Exactly one number or test name")
    artifacts_parser.add_argument("--json", action="store_true", help="Print as JSON")
    artifacts_parser.add_argument("--recent-first", action="store_true", help="Sort most recently used tests first")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "projects":
            return list_projects(args.json)

        ensure_runtime()
        meta = PROJECTS[args.project]

        if args.command == "list":
            entries = fetch_tests(meta, recent_first=args.recent_first)
            if args.json:
                print(json.dumps([entry_payload(entry) for entry in entries], ensure_ascii=False))
                return 0
            print_test_list(entries, sys.stdout)
            return 0

        if args.command == "pick":
            entries = pick_entries(
                meta,
                single=args.single,
                selectors=args.selectors,
                recent_first=args.recent_first,
                stream=sys.stderr,
            )
            for entry in entries:
                print(entry.short_name)
            return 0

        if args.command == "run":
            entries = pick_entries(
                meta,
                single=False,
                selectors=args.selectors,
                allow_all=True,
                recent_first=args.recent_first,
                stream=sys.stderr,
            )
            return run_selected_tests(meta, entries)

        if args.command == "debug":
            entries = pick_entries(
                meta,
                single=True,
                selectors=args.selectors,
                recent_first=args.recent_first,
                stream=sys.stderr,
            )
            return debug_test(meta, entries[0], server_only=args.server_only)

        if args.command == "artifacts":
            entries = pick_entries(
                meta,
                single=True,
                selectors=args.selectors,
                recent_first=args.recent_first,
                stream=sys.stderr,
            )
            return print_artifacts(meta, entries[0], args.json)

        parser.error(f"Unknown command: {args.command}")
        return 2
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
