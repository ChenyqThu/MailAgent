#!/usr/bin/env python3
"""DEPRECATED — use ``mailagent backfill derivatives`` instead.

This wrapper will be removed in PR-6 (release window 2-4 weeks after PR-5 ship).
"""
from __future__ import annotations

import sys
import warnings

warnings.warn(
    "scripts/backfill_derivatives.py is deprecated; use 'mailagent backfill derivatives' instead. "
    "Will be removed in PR-6.",
    DeprecationWarning,
    stacklevel=2,
)

if __name__ == "__main__":
    from src.cli.main import app
    app(["backfill", "derivatives", *sys.argv[1:]])
