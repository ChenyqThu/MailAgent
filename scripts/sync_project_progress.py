#!/usr/bin/env python3
"""DEPRECATED — use ``mailagent project-progress sync`` instead.

This wrapper will be removed in PR-6 (release window 2-4 weeks after PR-5 ship).
"""

from __future__ import annotations

import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

warnings.warn(
    "scripts/sync_project_progress.py is deprecated; use "
    "'mailagent project-progress sync' instead. Will be removed in PR-6.",
    DeprecationWarning,
    stacklevel=2,
)

if __name__ == "__main__":
    from src.cli.main import app

    app(["project-progress", "sync", *sys.argv[1:]])
