#!/usr/bin/env python3

from __future__ import annotations

import os
import runpy
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent

def is_pintos_workspace(path: Path) -> bool:
    return (
        (path / "utils" / "pintos").exists()
        and (path / "threads" / "Make.vars").exists()
        and (path / "userprog" / "Make.vars").exists()
        and (path / "vm" / "Make.vars").exists()
        and (path / "tests" / "Make.tests").exists()
    )


def discover_target(root_dir: Path) -> Path:
    candidates = (
        root_dir / "extension" / "bundled" / "pintos-test-cli.py",
        root_dir / "tools" / "pintos-test-explorer" / "bundled" / "pintos-test-cli.py",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError(
        "Could not find the bundled Pintos CLI helper. "
        f"Checked: {', '.join(str(candidate) for candidate in candidates)}"
    )


TARGET = discover_target(ROOT_DIR)

if is_pintos_workspace(ROOT_DIR):
    os.environ.setdefault("PINTOS_WORKSPACE_ROOT", str(ROOT_DIR))
runpy.run_path(str(TARGET), run_name="__main__")
