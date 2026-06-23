#!/usr/bin/env python3
"""Thin entry: validate schema + coverage only (delegates to run_baseline --validate).

    cd eval && python -m runner.validate
    python eval/runner/validate.py
"""
from __future__ import annotations

import os
import sys

_EVAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EVAL_ROOT not in sys.path:
    sys.path.insert(0, _EVAL_ROOT)

from runner.run_baseline import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main(["--eval-root", _EVAL_ROOT, "--validate"]))
