#!/usr/bin/env python3

from __future__ import annotations

import argparse
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
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

ROOT_LAYOUTS: tuple[tuple[str, ...], ...] = (
    (),
    ("pintos",),
    ("src",),
    ("pintos", "src"),
)
DESCENDANT_ROOT_SEARCH_MAX_DEPTH = 4
DESCENDANT_ROOT_IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".vscode",
    ".idea",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "build",
    "dist",
    "out",
}


def iter_root_candidates(base: Path) -> list[Path]:
    return [base.joinpath(*segments) for segments in ROOT_LAYOUTS]


def is_pintos_root(candidate: Path) -> bool:
    return (
        (candidate / "utils" / "pintos").exists()
        and (candidate / "threads" / "Make.vars").exists()
        and (candidate / "userprog" / "Make.vars").exists()
        and (candidate / "vm" / "Make.vars").exists()
        and (candidate / "tests" / "Make.tests").exists()
    )


def find_descendant_root(start: Path, *, max_depth: int = DESCENDANT_ROOT_SEARCH_MAX_DEPTH) -> Path | None:
    queue: deque[tuple[Path, int]] = deque([(start.resolve(), 0)])
    visited: set[Path] = set()

    while queue:
        current, depth = queue.popleft()
        if current in visited:
            continue
        visited.add(current)

        for root_candidate in iter_root_candidates(current):
            if is_pintos_root(root_candidate):
                return root_candidate

        if depth >= max_depth:
            continue

        try:
            children = sorted(current.iterdir(), key=lambda child: child.name)
        except OSError:
            continue

        for child in children:
            if not child.is_dir():
                continue
            if child.is_symlink():
                continue
            if child.name in DESCENDANT_ROOT_IGNORED_DIRS:
                continue
            queue.append((child, depth + 1))

    return None


def discover_repo_root() -> Path:
    candidates: list[Path] = []
    direct_root = os.environ.get("PINTOS_ROOT")
    if direct_root:
        candidates.append(Path(direct_root))
    env_root = os.environ.get("PINTOS_WORKSPACE_ROOT")
    if env_root:
        candidates.append(Path(env_root))
    candidates.append(Path.cwd())
    candidates.append(Path(__file__).resolve().parent)

    for candidate in candidates:
        for current in [candidate, *candidate.parents]:
            for root_candidate in iter_root_candidates(current):
                if is_pintos_root(root_candidate):
                    return root_candidate
        descendant_root = find_descendant_root(candidate)
        if descendant_root is not None:
            return descendant_root

    raise CliError(
        "Could not find a Pintos project root. "
        "Open the Pintos root, a nested folder like `*/pintos/` or `*/pintos/src/`, "
        "or set PINTOS_ROOT."
    )


GDB_SERVER_SCRIPT = Path(__file__).resolve().with_name("pintos-gdb-server.sh")
ARTIFACT_KINDS = ("output", "result", "errors")
BUILD_ERROR_RESULT = "BUILD_ERROR"
DEFAULT_PARALLEL_TEST_JOBS = 4
CUSTOM_TESTS_DIR_NAME = "custom"
CUSTOM_SCAFFOLD_MARKER_LINE = "# Added by Pintos Test Explorer"
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
    source_path: str | None = None


@dataclass(frozen=True)
class TestRunResult:
    selected_index: int
    entry: TestEntry
    cleanup_failures: tuple[str, ...]
    run_log: str
    return_code: int | None
    passed: bool
    status: str


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


def normalize_custom_relative_path(value: str, *, require_custom_prefix: bool = True) -> str:
    normalized = str(value or "").strip().replace("\\", "/").strip("/")
    if normalized.lower().endswith(".c"):
        normalized = normalized[:-2]
    elif normalized.lower().endswith(".ck"):
        normalized = normalized[:-3]

    if not normalized:
        raise CliError("Enter at least one file or folder name.")
    parts = [part for part in normalized.split("/") if part]
    if any(part == ".." for part in parts):
        raise CliError("Parent directory segments are not allowed.")
    if not all(re.fullmatch(r"[A-Za-z0-9_-]+", part) for part in parts):
        raise CliError("Use only letters, numbers, hyphens, underscores, and /.")
    if require_custom_prefix and (parts[0] != CUSTOM_TESTS_DIR_NAME):
        raise CliError(f"Custom paths must live under `{CUSTOM_TESTS_DIR_NAME}/...`.")
    return "/".join(parts)


def is_threads_project(meta: ProjectMeta) -> bool:
    return meta.name == "threads"


def custom_test_base_path(meta: ProjectMeta, relative_path: str) -> Path:
    return ROOT_DIR / "tests" / meta.name / Path(relative_path)


def custom_test_source_path(meta: ProjectMeta, relative_path: str) -> Path:
    return custom_test_base_path(meta, relative_path).with_suffix(".c")


def custom_test_checker_path(meta: ProjectMeta, relative_path: str) -> Path:
    return custom_test_base_path(meta, relative_path).with_suffix(".ck")


def custom_test_make_tests_path(meta: ProjectMeta) -> Path:
    return ROOT_DIR / "tests" / meta.name / "Make.tests"


def custom_test_full_name(meta: ProjectMeta, relative_path: str) -> str:
    return f"tests/{meta.name}/{relative_path}"


def custom_test_registration_lines(meta: ProjectMeta, relative_path: str) -> list[str]:
    full_name = custom_test_full_name(meta, relative_path)
    if is_threads_project(meta):
        return [
            f"tests/{meta.name}_TESTS += {full_name}",
            f"tests/{meta.name}_SRC += {full_name}.c",
        ]
    return [
        f"tests/{meta.name}_TESTS += {full_name}",
        f"{full_name}_SRC = {full_name}.c",
    ]


def thread_test_function_name(relative_path: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]+", "_", relative_path).strip("_")
    return f"test_{normalized or 'custom'}"


def render_thread_test_template(relative_path: str) -> str:
    function_name = thread_test_function_name(relative_path)
    return f"""/* TODO: describe this custom thread test. */

#include "tests/threads/tests.h"

void
{function_name} (void)
{{
  pass ();
}}
"""


def render_user_style_c_template(meta: ProjectMeta, relative_path: str) -> str:
    label = relative_path.split("/")[-1]
    return f"""/* TODO: describe this custom {meta.name} test. */

#include "tests/lib.h"
#include "tests/main.h"

void
test_main (void)
{{
  msg ("TODO: implement {label}");
}}
"""


def render_user_style_checker_template() -> str:
    return """# -*- perl -*-
use strict;
use warnings;
use tests::tests;

# TODO: tighten this checker with check_expected(), check_archive(), etc.
pass;
"""


def is_managed_custom_test(meta: ProjectMeta, relative_path: str) -> bool:
    make_tests_path = custom_test_make_tests_path(meta)
    if not make_tests_path.exists():
        return False
    text = make_tests_path.read_text(encoding="utf-8")
    return (
        CUSTOM_SCAFFOLD_MARKER_LINE in text
        and all(line in text for line in custom_test_registration_lines(meta, relative_path))
    )


def is_deletable_custom_test(meta: ProjectMeta, relative_path: str) -> bool:
    return relative_path == CUSTOM_TESTS_DIR_NAME or relative_path.startswith(f"{CUSTOM_TESTS_DIR_NAME}/") or is_managed_custom_test(meta, relative_path)


def has_partial_custom_definition(meta: ProjectMeta, relative_path: str) -> bool:
    source_path = custom_test_source_path(meta, relative_path)
    checker_path = custom_test_checker_path(meta, relative_path)
    make_tests_path = custom_test_make_tests_path(meta)

    if source_path.exists() or checker_path.exists():
        return True

    if make_tests_path.exists():
        make_text = make_tests_path.read_text(encoding="utf-8")
        if any(line in make_text for line in custom_test_registration_lines(meta, relative_path)):
            return True

    if is_threads_project(meta):
        tests_h_path = ROOT_DIR / "tests" / "threads" / "tests.h"
        tests_c_path = ROOT_DIR / "tests" / "threads" / "tests.c"
        function_name = thread_test_function_name(relative_path)
        if tests_h_path.exists() and f"void {function_name} (void);" in tests_h_path.read_text(encoding="utf-8"):
            return True
        if tests_c_path.exists() and f'"{relative_path}", {function_name}' in tests_c_path.read_text(encoding="utf-8"):
            return True

    return False


def append_block_if_missing(file_path: Path, sentinel: str, block_text: str) -> bool:
    text = file_path.read_text(encoding="utf-8")
    if sentinel in text:
        return False
    prefix = text if text.endswith("\n") else f"{text}\n"
    file_path.write_text(f"{prefix}{block_text.rstrip()}\n", encoding="utf-8")
    return True


def remove_exact_line_if_present(file_path: Path, line_text: str) -> bool:
    if not file_path.exists():
        return False
    normalized_line = line_text.lstrip()
    pattern = re.compile(rf"^[ \t]*{re.escape(normalized_line)}\r?\n?", re.MULTILINE)
    text = file_path.read_text(encoding="utf-8")
    if not pattern.search(text):
        return False
    file_path.write_text(re.sub(r"\n{3,}", "\n\n", pattern.sub("", text)), encoding="utf-8")
    return True


def remove_custom_test_from_make_tests(meta: ProjectMeta, relative_path: str) -> bool:
    make_tests_path = custom_test_make_tests_path(meta)
    if not make_tests_path.exists():
        return False

    lines = custom_test_registration_lines(meta, relative_path)
    block_lines = [CUSTOM_SCAFFOLD_MARKER_LINE, *lines]
    block_pattern = re.compile(
        r"(?:^|\n)" + r"\n".join(re.escape(line) for line in block_lines) + r"\n?",
        re.MULTILINE,
    )
    text = make_tests_path.read_text(encoding="utf-8")
    changed = False

    if block_pattern.search(text):
        text = block_pattern.sub("\n", text, count=1)
        changed = True

    for line in lines:
        pattern = re.compile(rf"^{re.escape(line)}\r?\n?", re.MULTILINE)
        if pattern.search(text):
            text = pattern.sub("", text)
            changed = True

    if changed:
        make_tests_path.write_text(re.sub(r"\n{3,}", "\n\n", text), encoding="utf-8")
    return changed


def move_artifact_paths(meta: ProjectMeta, old_entry: TestEntry, new_entry: TestEntry) -> None:
    old_paths = artifact_paths(meta, old_entry)
    new_paths = artifact_paths(meta, new_entry)
    for kind in ARTIFACT_KINDS:
        old_path = old_paths[kind]
        new_path = new_paths[kind]
        if not old_path.exists():
            continue
        new_path.parent.mkdir(parents=True, exist_ok=True)
        if new_path.exists():
            new_path.unlink()
        old_path.rename(new_path)


def ensure_test_output_dirs(meta: ProjectMeta, entries: list[TestEntry]) -> None:
    if not meta.build_dir.exists():
        return

    for entry in entries:
        output_dir = meta.build_dir / Path(entry.full_name).parent
        output_dir.mkdir(parents=True, exist_ok=True)


def ensure_registered_test_output_dirs(meta: ProjectMeta) -> None:
    ensure_test_output_dirs(meta, parse_tests_from_makefiles(meta))


def prune_empty_directories(start_dir: Path, stop_dir: Path) -> None:
    current = start_dir.resolve()
    stop = stop_dir.resolve()
    while current != stop and stop in current.parents:
        if not current.exists():
            current = current.parent
            continue
        if current.exists() and any(current.iterdir()):
            break
        current.rmdir()
        current = current.parent

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
    env["PATH"] = os.pathsep.join(
        part
        for part in (str(UTILS_DIR), env.get("PATH", ""))
        if part
    )
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
        ensure_project_build_subdirs(meta)
        ensure_registered_test_output_dirs(meta)
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
    ensure_project_build_subdirs(meta)
    ensure_registered_test_output_dirs(meta)


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


def load_make_variable_assignments(path: Path) -> dict[str, str]:
    assignments: dict[str, str] = {}
    if not path.exists():
        return assignments

    for line in read_make_logical_lines(path):
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


def split_top_level_words(text: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    depth = 0

    for char in text.strip():
        if char.isspace() and depth == 0:
            if current:
                parts.append("".join(current))
                current = []
            continue

        current.append(char)
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)

    if current:
        parts.append("".join(current))

    return parts


def build_subdirs_for_project(meta: ProjectMeta) -> list[str]:
    assignments = load_make_variable_assignments(meta.project_dir / "Make.vars")
    subdirs: list[str] = []
    for variable_name in ("KERNEL_SUBDIRS", "TEST_SUBDIRS"):
        subdirs.extend(evaluate_make_expression(assignments.get(variable_name, ""), assignments))
    subdirs.append("lib/user")
    return list(dict.fromkeys(subdir for subdir in subdirs if subdir))


def ensure_project_build_subdirs(meta: ProjectMeta) -> None:
    if not meta.build_dir.exists():
        return

    for subdir in build_subdirs_for_project(meta):
        (meta.build_dir / Path(subdir)).mkdir(parents=True, exist_ok=True)


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
    expr = expr.strip()
    if not expr:
        return []

    top_level_words = split_top_level_words(expr)
    if len(top_level_words) > 1:
        results: list[str] = []
        for word in top_level_words:
            results.extend(evaluate_make_expression(word, assignments))
        return results

    token = top_level_words[0] if top_level_words else expr

    if token.startswith("$(") and token.endswith(")"):
        inner = token[2:-1].strip()
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

    return [token]


SOURCE_FILE_SUFFIXES = (".c", ".cc", ".cpp", ".cxx", ".s", ".S")


def resolve_root_relative_path(value: str) -> Path:
    candidate = Path(value)
    return candidate if candidate.is_absolute() else ROOT_DIR / candidate


def source_files_for_project(
    meta: ProjectMeta,
    assignments: dict[str, str] | None = None,
) -> list[str]:
    resolved_assignments = assignments if assignments is not None else load_make_assignments(meta)
    candidates: list[str] = []
    seen: set[str] = set()
    variable_prefix = f"tests/{meta.name}"

    for variable_name, expression in resolved_assignments.items():
        if not variable_name.endswith("_SRC"):
            continue
        if not variable_name.startswith(variable_prefix):
            continue
        for item in evaluate_make_expression(expression, resolved_assignments):
            if Path(item).suffix not in SOURCE_FILE_SUFFIXES:
                continue
            if item in seen:
                continue
            seen.add(item)
            candidates.append(item)

    project_tests_dir = ROOT_DIR / "tests" / meta.name
    if project_tests_dir.exists():
        for path in sorted(project_tests_dir.rglob("*")):
            if not path.is_file() or path.suffix not in SOURCE_FILE_SUFFIXES:
                continue
            relative = str(path.relative_to(ROOT_DIR))
            if relative in seen:
                continue
            seen.add(relative)
            candidates.append(relative)

    return candidates


def read_text_if_exists(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def find_threads_registered_function(short_name: str) -> str | None:
    tests_c_path = ROOT_DIR / "tests" / "threads" / "tests.c"
    text = read_text_if_exists(tests_c_path)
    if not text:
        return None

    pattern = re.compile(
        rf'\{{\s*"{re.escape(short_name)}"\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}}'
    )
    match = pattern.search(text)
    return match.group(1) if match else None


def find_source_file_containing_symbol(
    meta: ProjectMeta,
    symbol: str,
    assignments: dict[str, str] | None = None,
    *,
    require_definition: bool = False,
) -> str | None:
    if not symbol:
        return None

    candidates = source_files_for_project(meta, assignments)
    if require_definition:
        pattern = re.compile(rf"\b{re.escape(symbol)}\s*\(")
    else:
        pattern = re.compile(rf'("{re.escape(symbol)}"|\b{re.escape(symbol)}\b)')

    matches: list[tuple[tuple[int, int, int], str]] = []
    for candidate in candidates:
        absolute_path = resolve_root_relative_path(candidate)
        text = read_text_if_exists(absolute_path)
        if not text or not pattern.search(text):
            continue
        match_score = (
            int(absolute_path.name != "tests.c"),
            int(absolute_path.name != "tests.h"),
            int(symbol.replace("-", "_") in absolute_path.stem),
        )
        matches.append((match_score, candidate))

    if not matches:
        return None

    matches.sort(key=lambda item: item[0], reverse=True)
    return matches[0][1]


def score_source_candidate(meta: ProjectMeta, full_name: str, candidate: str) -> tuple[int, int, int, int, int, int]:
    candidate_path = Path(candidate)
    absolute_path = resolve_root_relative_path(candidate)
    full_name_path = Path(full_name)
    expected_c_path = full_name_path.with_suffix(".c")
    expected_any_path = full_name_path.with_suffix(candidate_path.suffix)

    return (
        int(absolute_path.exists()),
        int(candidate_path == expected_c_path),
        int(candidate_path == expected_any_path),
        int(candidate_path.stem == full_name_path.name),
        int(candidate_path.parent == full_name_path.parent),
        int(candidate.startswith(f"tests/{meta.name}/")),
    )


def resolve_test_source_path(
    meta: ProjectMeta,
    full_name: str,
    short_name: str,
    assignments: dict[str, str] | None = None,
) -> str | None:
    resolved_assignments = assignments if assignments is not None else load_make_assignments(meta)
    source_var = f"{full_name}_SRC"
    candidates: list[str] = []

    if source_var in resolved_assignments:
        for item in evaluate_make_expression(resolved_assignments[source_var], resolved_assignments):
            if Path(item).suffix not in SOURCE_FILE_SUFFIXES:
                continue
            candidates.append(item)

    default_candidate = f"{full_name}.c"
    if default_candidate not in candidates:
        candidates.append(default_candidate)

    if meta.name == "threads":
        thread_function_candidates = []
        registered_function = find_threads_registered_function(short_name)
        if registered_function:
            thread_function_candidates.append(registered_function)
        derived_function = thread_test_function_name(short_name)
        if derived_function not in thread_function_candidates:
            thread_function_candidates.append(derived_function)

        for symbol in thread_function_candidates:
            thread_source = find_source_file_containing_symbol(
                meta,
                symbol,
                resolved_assignments,
                require_definition=True,
            )
            if thread_source:
                return thread_source

    existing = [candidate for candidate in candidates if resolve_root_relative_path(candidate).exists()]
    if not existing:
        return None

    return max(existing, key=lambda candidate: score_source_candidate(meta, full_name, candidate))


def build_test_entries(
    meta: ProjectMeta,
    full_names: list[str],
    assignments: dict[str, str] | None = None,
) -> list[TestEntry]:
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
                source_path=resolve_test_source_path(meta, full_name, short_name, assignments),
            )
        )
    return entries


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

    return build_test_entries(meta, full_names, assignments)


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

    return build_test_entries(meta, full_names, load_make_assignments(meta))


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
        "source_path": entry.source_path,
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


def existing_artifact_paths(meta: ProjectMeta, entry: TestEntry) -> list[Path]:
    return [
        path
        for path in artifact_paths(meta, entry).values()
        if path.exists()
    ]


def remove_artifact_paths(paths: list[Path]) -> tuple[int, list[str]]:
    removed_count = 0
    failures: list[str] = []
    seen: set[Path] = set()

    for path in paths:
        if path in seen or not path.exists():
            continue
        seen.add(path)
        try:
            path.unlink()
            removed_count += 1
        except OSError as exc:
            failures.append(f"{path}: {exc}")

    return removed_count, failures


def ensure_failed_run_artifacts(meta: ProjectMeta, entry: TestEntry, *, details: str) -> None:
    paths = artifact_paths(meta, entry)
    paths["result"].parent.mkdir(parents=True, exist_ok=True)
    paths["result"].write_text(f"{BUILD_ERROR_RESULT}\n", encoding="utf-8")

    if not paths["errors"].exists():
        text = details.strip() or "Run failed before Pintos could produce an errors artifact."
        paths["errors"].write_text(f"{text}\n", encoding="utf-8")


def collect_workspace_artifact_paths() -> list[Path]:
    ensure_runtime()
    files: list[Path] = []

    for meta in PROJECTS.values():
        tests_dir = meta.build_dir / "tests"
        if not tests_dir.exists():
            continue
        for path in tests_dir.rglob("*"):
            if path.is_file() and path.suffix.lstrip(".") in ARTIFACT_KINDS:
                files.append(path)

    return files


def summarize_result(meta: ProjectMeta, entry: TestEntry) -> tuple[bool, str]:
    result_path = artifact_paths(meta, entry)["result"]
    if not result_path.exists():
        return False, "missing result file"
    result_text = result_path.read_text(encoding="utf-8").strip()
    if result_text == "PASS":
        return True, "PASS"
    if result_text == BUILD_ERROR_RESULT:
        return False, "BUILD ERROR"
    if result_text == "FAIL":
        return False, "FAIL"
    return False, result_text or "unknown result"


def parse_positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def run_single_test(meta: ProjectMeta, entry: TestEntry, selected_index: int) -> TestRunResult:
    _removed, cleanup_failures = remove_artifact_paths(existing_artifact_paths(meta, entry))
    if cleanup_failures:
        ensure_failed_run_artifacts(
            meta,
            entry,
            details="\n".join(
                [
                    "Run failed before execution because existing artifacts could not be removed.",
                    *[f"- {failure}" for failure in cleanup_failures],
                ]
            ),
        )
        return TestRunResult(
            selected_index=selected_index,
            entry=entry,
            cleanup_failures=tuple(cleanup_failures),
            run_log="",
            return_code=1,
            passed=False,
            status="BUILD ERROR",
        )

    completed = subprocess.run(
        ["make", "-C", str(meta.build_dir), "--no-print-directory", f"{entry.full_name}.result"],
        env=make_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    run_log = completed.stdout or ""

    if completed.returncode != 0:
        ensure_failed_run_artifacts(
            meta,
            entry,
            details=(run_log.strip() or f"make exited with {completed.returncode}"),
        )

    passed, status = summarize_result(meta, entry)
    if completed.returncode != 0:
        passed = False
        status = "BUILD ERROR"

    return TestRunResult(
        selected_index=selected_index,
        entry=entry,
        cleanup_failures=(),
        run_log=run_log,
        return_code=completed.returncode,
        passed=passed,
        status=status,
    )


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


def ensure_custom_test_targets_available(meta: ProjectMeta, relative_path: str) -> None:
    source_path = custom_test_source_path(meta, relative_path)
    checker_path = custom_test_checker_path(meta, relative_path)
    make_tests_path = custom_test_make_tests_path(meta)

    if source_path.exists():
        raise CliError(f"A test source file already exists at {source_path}")
    if not is_threads_project(meta) and checker_path.exists():
        raise CliError(f"A checker file already exists at {checker_path}")
    if not make_tests_path.exists():
        raise CliError(f"Could not find {make_tests_path}")

    if is_threads_project(meta):
        header_path = ROOT_DIR / "tests" / "threads" / "tests.h"
        source_registry_path = ROOT_DIR / "tests" / "threads" / "tests.c"
        if not header_path.exists():
            raise CliError(f"Could not find {header_path}")
        if not source_registry_path.exists():
            raise CliError(f"Could not find {source_registry_path}")


def register_custom_test_in_make_tests(meta: ProjectMeta, relative_path: str) -> None:
    make_tests_path = custom_test_make_tests_path(meta)
    block = "\n".join([CUSTOM_SCAFFOLD_MARKER_LINE, *custom_test_registration_lines(meta, relative_path)])
    append_block_if_missing(make_tests_path, custom_test_full_name(meta, relative_path), block)


def ensure_thread_prototype(relative_path: str) -> None:
    header_path = ROOT_DIR / "tests" / "threads" / "tests.h"
    function_name = thread_test_function_name(relative_path)
    prototype = f"void {function_name} (void);"
    text = header_path.read_text(encoding="utf-8")
    if prototype in text:
        return
    endif_index = text.rfind("#endif")
    if endif_index >= 0:
        next_text = f"{text[:endif_index]}{prototype}\n{text[endif_index:]}"
    else:
        suffix = "" if text.endswith("\n") else "\n"
        next_text = f"{text}{suffix}{prototype}\n"
    header_path.write_text(next_text, encoding="utf-8")


def ensure_thread_registration(relative_path: str) -> None:
    source_path = ROOT_DIR / "tests" / "threads" / "tests.c"
    function_name = thread_test_function_name(relative_path)
    entry_text = f'{{"{relative_path}", {function_name}}}'
    text = source_path.read_text(encoding="utf-8")
    if entry_text in text:
        return
    array_start = text.find("static const struct test tests[]")
    if array_start < 0:
        raise CliError(f"Could not find the thread test registry in {source_path}.")
    array_end = text.find("};", array_start)
    if array_end < 0:
        raise CliError(f"Could not find the end of the thread test registry in {source_path}.")
    insertion = f'    {entry_text},\n'
    source_path.write_text(f"{text[:array_end]}{insertion}{text[array_end:]}", encoding="utf-8")


def replace_exact_text(file_path: Path, old: str, new: str) -> bool:
    text = file_path.read_text(encoding="utf-8")
    if old not in text:
        return False
    file_path.write_text(text.replace(old, new), encoding="utf-8")
    return True


def create_custom_test(meta: ProjectMeta, relative_path: str) -> dict[str, object]:
    relative_path = normalize_custom_relative_path(relative_path)
    ensure_custom_test_targets_available(meta, relative_path)

    source_path = custom_test_source_path(meta, relative_path)
    created_files = [str(source_path)]
    source_path.parent.mkdir(parents=True, exist_ok=True)

    if is_threads_project(meta):
        source_path.write_text(render_thread_test_template(relative_path), encoding="utf-8")
        ensure_thread_prototype(relative_path)
        ensure_thread_registration(relative_path)
    else:
        checker_path = custom_test_checker_path(meta, relative_path)
        source_path.write_text(render_user_style_c_template(meta, relative_path), encoding="utf-8")
        checker_path.write_text(render_user_style_checker_template(), encoding="utf-8")
        created_files.append(str(checker_path))

    register_custom_test_in_make_tests(meta, relative_path)
    ensure_test_output_dirs(
        meta,
        [
            TestEntry(
                index=0,
                full_name=custom_test_full_name(meta, relative_path),
                short_name=relative_path,
                group=relative_path.split("/", 1)[0] if "/" in relative_path else "main",
            )
        ],
    )
    return {
        "action": "create",
        "project": meta.name,
        "target": relative_path,
        "files": created_files,
        "full_name": custom_test_full_name(meta, relative_path),
    }


def delete_custom_test_definition(meta: ProjectMeta, relative_path: str) -> dict[str, object]:
    source_path = custom_test_source_path(meta, relative_path)
    checker_path = custom_test_checker_path(meta, relative_path)
    deleted_files: list[str] = []

    if source_path.exists():
        source_path.unlink()
        deleted_files.append(str(source_path))
    if not is_threads_project(meta) and checker_path.exists():
        checker_path.unlink()
        deleted_files.append(str(checker_path))

    if is_threads_project(meta):
        old_function_name = thread_test_function_name(relative_path)
        remove_exact_line_if_present(ROOT_DIR / "tests" / "threads" / "tests.h", f"void {old_function_name} (void);")
        remove_exact_line_if_present(ROOT_DIR / "tests" / "threads" / "tests.c", f'    {{"{relative_path}", {old_function_name}}},')

    remove_custom_test_from_make_tests(meta, relative_path)

    synthetic_entry = TestEntry(
        index=0,
        full_name=custom_test_full_name(meta, relative_path),
        short_name=relative_path,
        group=relative_path.split("/", 1)[0] if "/" in relative_path else "main",
    )
    for artifact_path in existing_artifact_paths(meta, synthetic_entry):
        artifact_path.unlink()
        deleted_files.append(str(artifact_path))

    prune_empty_directories(source_path.parent, ROOT_DIR / "tests" / meta.name)
    return {
        "action": "delete-test",
        "project": meta.name,
        "target": relative_path,
        "deleted_files": deleted_files,
    }


def rename_custom_test_definition(meta: ProjectMeta, old_relative_path: str, new_relative_path: str) -> dict[str, object]:
    old_relative_path = normalize_custom_relative_path(old_relative_path, require_custom_prefix=False)
    new_relative_path = normalize_custom_relative_path(new_relative_path)
    if old_relative_path == new_relative_path:
        raise CliError("The new path must be different from the current path.")

    old_source_path = custom_test_source_path(meta, old_relative_path)
    if not old_source_path.exists():
        raise CliError(f"Could not find {old_source_path}")
    ensure_custom_test_targets_available(meta, new_relative_path)

    new_source_path = custom_test_source_path(meta, new_relative_path)
    new_source_path.parent.mkdir(parents=True, exist_ok=True)
    old_source_path.rename(new_source_path)

    moved_files = [str(new_source_path)]

    if is_threads_project(meta):
        old_function = thread_test_function_name(old_relative_path)
        new_function = thread_test_function_name(new_relative_path)
        replace_exact_text(new_source_path, old_function, new_function)
        replace_exact_text(ROOT_DIR / "tests" / "threads" / "tests.h", f"void {old_function} (void);", f"void {new_function} (void);")
        replace_exact_text(ROOT_DIR / "tests" / "threads" / "tests.c", f'{{"{old_relative_path}", {old_function}}}', f'{{"{new_relative_path}", {new_function}}}')
    else:
        old_checker_path = custom_test_checker_path(meta, old_relative_path)
        if old_checker_path.exists():
            new_checker_path = custom_test_checker_path(meta, new_relative_path)
            new_checker_path.parent.mkdir(parents=True, exist_ok=True)
            old_checker_path.rename(new_checker_path)
            moved_files.append(str(new_checker_path))

    remove_custom_test_from_make_tests(meta, old_relative_path)
    register_custom_test_in_make_tests(meta, new_relative_path)

    old_entry = TestEntry(0, custom_test_full_name(meta, old_relative_path), old_relative_path, old_relative_path.split("/", 1)[0])
    new_entry = TestEntry(0, custom_test_full_name(meta, new_relative_path), new_relative_path, new_relative_path.split("/", 1)[0])
    ensure_test_output_dirs(meta, [new_entry])
    move_artifact_paths(meta, old_entry, new_entry)

    prune_empty_directories(old_source_path.parent, ROOT_DIR / "tests" / meta.name)

    return {
        "action": "rename-test",
        "project": meta.name,
        "old_target": old_relative_path,
        "new_target": new_relative_path,
        "files": moved_files,
        "full_name": custom_test_full_name(meta, new_relative_path),
    }


def resolve_custom_target_entries(meta: ProjectMeta, target: str) -> tuple[str, list[TestEntry]]:
    normalized = normalize_custom_relative_path(target, require_custom_prefix=False)
    entries = fetch_tests(meta)
    exact = [entry for entry in entries if entry.short_name == normalized and is_deletable_custom_test(meta, entry.short_name)]
    if exact:
        return normalized, exact

    prefix = f"{normalized}/"
    descendants = [
        entry
        for entry in entries
        if entry.short_name.startswith(prefix) and is_deletable_custom_test(meta, entry.short_name)
    ]
    if descendants:
        return normalized, descendants

    if has_partial_custom_definition(meta, normalized):
        return normalized, [
            TestEntry(
                index=0,
                full_name=custom_test_full_name(meta, normalized),
                short_name=normalized,
                group=normalized.split("/", 1)[0] if "/" in normalized else "main",
            )
        ]

    raise CliError(f"No custom test or folder matched '{target}'.")


def delete_custom_target(meta: ProjectMeta, target: str) -> dict[str, object]:
    normalized, entries = resolve_custom_target_entries(meta, target)
    deleted_tests: list[str] = []
    deleted_files: list[str] = []

    for entry in sorted(entries, key=lambda item: len(item.short_name), reverse=True):
        result = delete_custom_test_definition(meta, entry.short_name)
        deleted_tests.append(entry.short_name)
        deleted_files.extend(result["deleted_files"])

    return {
        "action": "delete",
        "project": meta.name,
        "target": normalized,
        "deleted_tests": deleted_tests,
        "deleted_files": deleted_files,
    }


def rename_custom_target(meta: ProjectMeta, old_target: str, new_target: str) -> dict[str, object]:
    normalized_old, entries = resolve_custom_target_entries(meta, old_target)
    normalized_new = normalize_custom_relative_path(new_target)

    if normalized_old == normalized_new:
        raise CliError("The new path must be different from the current path.")

    if len(entries) == 1 and entries[0].short_name == normalized_old:
        result = rename_custom_test_definition(meta, normalized_old, normalized_new)
        return {
            "action": "rename",
            "project": meta.name,
            "old_target": normalized_old,
            "new_target": normalized_new,
            "renamed_tests": [{"from": normalized_old, "to": normalized_new}],
            "files": result["files"],
        }

    if normalized_new.startswith(f"{normalized_old}/"):
        raise CliError("A folder cannot be renamed into one of its own descendants.")

    planned: list[tuple[TestEntry, str]] = []
    for entry in entries:
        suffix = entry.short_name[len(normalized_old):].lstrip("/")
        next_short_name = normalized_new if not suffix else f"{normalized_new}/{suffix}"
        normalize_custom_relative_path(next_short_name)
        planned.append((entry, next_short_name))

    targets = {next_short_name for _entry, next_short_name in planned}
    if len(targets) != len(planned):
        raise CliError("The new folder name would produce duplicate test paths.")

    entries_by_short_name = {entry.short_name for entry in fetch_tests(meta)}
    for entry, next_short_name in planned:
        if next_short_name != entry.short_name and next_short_name in entries_by_short_name:
            raise CliError(f"Another test already exists at {next_short_name}.")

    renamed_tests: list[dict[str, str]] = []
    moved_files: list[str] = []
    for entry, next_short_name in sorted(planned, key=lambda item: len(item[0].short_name), reverse=True):
        result = rename_custom_test_definition(meta, entry.short_name, next_short_name)
        renamed_tests.append({"from": entry.short_name, "to": next_short_name})
        moved_files.extend(result["files"])

    return {
        "action": "rename",
        "project": meta.name,
        "old_target": normalized_old,
        "new_target": normalized_new,
        "renamed_tests": renamed_tests,
        "files": moved_files,
    }


def reset_selected_tests(meta: ProjectMeta, entries: list[TestEntry], *, json_mode: bool) -> int:
    paths = [
        path
        for entry in entries
        for path in existing_artifact_paths(meta, entry)
    ]
    removed_count, failures = remove_artifact_paths(paths)

    summary = {
        "scope": "project",
        "project": meta.name,
        "tests": [entry.short_name for entry in entries],
        "removed_artifacts": removed_count,
        "errors": failures,
    }
    if json_mode:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print("", file=sys.stderr)
        print(
            f"[{meta.name}] Reset {len(entries)} test(s): removed {removed_count} artifact file(s)",
            file=sys.stderr,
        )
        if failures:
            print("Some artifacts could not be removed:", file=sys.stderr)
            for failure in failures:
                print(f"- {failure}", file=sys.stderr)

    return 0 if not failures else 1


def reset_all_tests(*, json_mode: bool) -> int:
    paths = collect_workspace_artifact_paths()
    removed_count, failures = remove_artifact_paths(paths)

    summary = {
        "scope": "workspace",
        "projects": [meta.name for meta in PROJECTS.values()],
        "removed_artifacts": removed_count,
        "errors": failures,
    }
    if json_mode:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print("", file=sys.stderr)
        print(
            f"[workspace] Reset all tests: removed {removed_count} artifact file(s)",
            file=sys.stderr,
        )
        if failures:
            print("Some artifacts could not be removed:", file=sys.stderr)
            for failure in failures:
                print(f"- {failure}", file=sys.stderr)

    return 0 if not failures else 1


def prepare_build_for_test_run(meta: ProjectMeta, test_count: int) -> None:
    build_makefile_existed = (meta.build_dir / "Makefile").exists()
    ensure_build_tree(meta)
    if test_count <= 1 or not build_makefile_existed:
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
            f"Could not build {meta.name} before running tests. "
            f"`make -C {meta.project_dir}` failed."
        ) from exc
    ensure_project_build_subdirs(meta)
    ensure_registered_test_output_dirs(meta)


def run_selected_tests(meta: ProjectMeta, entries: list[TestEntry], *, jobs: int) -> int:
    prepare_build_for_test_run(meta, len(entries))
    record_history(meta, entries, action="run")
    print("", file=sys.stderr)
    print(f"[{meta.name}] Running {len(entries)} test(s)", file=sys.stderr)
    print(f"[{meta.name}] Using up to {min(jobs, len(entries))} parallel job(s)", file=sys.stderr)
    print("", file=sys.stderr)

    failures = 0
    results: dict[int, TestRunResult] = {}
    worker_count = max(1, min(jobs, len(entries)))
    if worker_count > 1:
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(run_single_test, meta, entry, selected_index=index): index
                for index, entry in enumerate(entries, start=1)
            }
            for future in as_completed(futures):
                result = future.result()
                results[result.selected_index] = result
    else:
        for index, entry in enumerate(entries, start=1):
            result = run_single_test(meta, entry, selected_index=index)
            results[result.selected_index] = result

    for index, entry in enumerate(entries, start=1):
        result = results[index]
        if result.cleanup_failures:
            failures += 1
            print(f"[{index}/{len(entries)}] {entry.short_name}", file=sys.stderr, flush=True)
            print("Could not remove existing artifacts before rerun:", file=sys.stderr)
            for failure in result.cleanup_failures:
                print(f"- {failure}", file=sys.stderr)
            print("", file=sys.stderr)
            continue

        print(f"[{index}/{len(entries)}] {entry.short_name}", file=sys.stderr, flush=True)
        for line in result.run_log.splitlines(keepends=True):
            sys.stderr.write(line)
        if result.run_log:
            sys.stderr.flush()

        passed = result.passed
        if passed:
            print(f"PASS  {entry.short_name}", file=sys.stderr)
        else:
            failures += 1
            print(f"FAIL  {entry.short_name} ({result.status})", file=sys.stderr)
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
            "  pintos-tests reset threads 4 7-9 alarm-zero\n"
            "  pintos-tests reset threads all\n"
            "  pintos-tests reset-all\n"
            "  pintos-tests run threads 1 3-5 alarm-zero\n"
            "  pintos-tests run threads 11-20\n"
            "  pintos-tests run filesys all\n"
            "  pintos-tests debug threads alarm-zero\n"
            "  pintos-tests debug vm 4 --server-only\n"
            "  pintos-tests custom create threads custom/alarm/new-test\n"
            "  pintos-tests custom rename threads custom/alarm custom/alarm-clock\n"
            "  pintos-tests custom delete threads custom/alarm-clock\n"
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
    run_parser.add_argument(
        "--jobs",
        type=parse_positive_int,
        default=DEFAULT_PARALLEL_TEST_JOBS,
        help=f"Maximum number of tests to run in parallel (default: {DEFAULT_PARALLEL_TEST_JOBS})",
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

    reset_parser = subparsers.add_parser("reset", help="Delete test artifacts for selected tests")
    reset_parser.add_argument("project", choices=project_names)
    reset_parser.add_argument(
        "selectors",
        nargs="*",
        help="Number, range, name, pattern, or all",
    )
    reset_parser.add_argument("--recent-first", action="store_true", help="Sort most recently used tests first during interactive selection")
    reset_parser.add_argument("--json", action="store_true", help="Print a JSON summary")

    reset_all_parser = subparsers.add_parser("reset-all", help="Delete every test artifact in the workspace")
    reset_all_parser.add_argument("--json", action="store_true", help="Print a JSON summary")

    artifacts_parser = subparsers.add_parser("artifacts", help="Show test artifact paths")
    artifacts_parser.add_argument("project", choices=project_names)
    artifacts_parser.add_argument("selectors", nargs="+", help="Exactly one number or test name")
    artifacts_parser.add_argument("--json", action="store_true", help="Print as JSON")
    artifacts_parser.add_argument("--recent-first", action="store_true", help="Sort most recently used tests first")

    custom_parser = subparsers.add_parser("custom", help="Manage custom test files and folders")
    custom_subparsers = custom_parser.add_subparsers(dest="custom_command", required=True)

    custom_create_parser = custom_subparsers.add_parser("create", help="Create a custom test case")
    custom_create_parser.add_argument("project", choices=project_names)
    custom_create_parser.add_argument("path", help="Relative custom test path, usually custom/<folder>/<name>")
    custom_create_parser.add_argument("--json", action="store_true", help="Print as JSON")

    custom_rename_parser = custom_subparsers.add_parser("rename", help="Rename a custom test or custom folder")
    custom_rename_parser.add_argument("project", choices=project_names)
    custom_rename_parser.add_argument("old_path", help="Current custom test or folder path")
    custom_rename_parser.add_argument("new_path", help="New custom test or folder path")
    custom_rename_parser.add_argument("--json", action="store_true", help="Print as JSON")

    custom_delete_parser = custom_subparsers.add_parser("delete", help="Delete a custom test or custom folder")
    custom_delete_parser.add_argument("project", choices=project_names)
    custom_delete_parser.add_argument("path", help="Custom test or folder path to delete")
    custom_delete_parser.add_argument("--json", action="store_true", help="Print as JSON")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "projects":
            return list_projects(args.json)

        if args.command == "reset-all":
            ensure_runtime()
            return reset_all_tests(json_mode=args.json)

        if args.command == "custom":
            ensure_runtime()
            meta = PROJECTS[args.project]
            if args.custom_command == "create":
                payload = create_custom_test(meta, args.path)
            elif args.custom_command == "rename":
                payload = rename_custom_target(meta, args.old_path, args.new_path)
            elif args.custom_command == "delete":
                payload = delete_custom_target(meta, args.path)
            else:
                parser.error(f"Unknown custom command: {args.custom_command}")

            if args.json:
                print(json.dumps(payload, ensure_ascii=False))
            else:
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0

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
            return run_selected_tests(meta, entries, jobs=args.jobs)

        if args.command == "debug":
            entries = pick_entries(
                meta,
                single=True,
                selectors=args.selectors,
                recent_first=args.recent_first,
                stream=sys.stderr,
            )
            return debug_test(meta, entries[0], server_only=args.server_only)

        if args.command == "reset":
            entries = pick_entries(
                meta,
                single=False,
                selectors=args.selectors,
                allow_all=True,
                recent_first=args.recent_first,
                stream=sys.stderr,
            )
            return reset_selected_tests(meta, entries, json_mode=args.json)

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
