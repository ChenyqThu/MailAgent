"""pytest bootstrap for the eval runner: put eval/ on sys.path so `import runner`
resolves to THIS package regardless of repo-root cwd. Zero LLM in this lane.
"""
import os
import sys

# eval/runner/tests/conftest.py -> eval/
EVAL_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if EVAL_ROOT not in sys.path:
    sys.path.insert(0, EVAL_ROOT)

import pytest  # noqa: E402

from runner import loader  # noqa: E402


@pytest.fixture(scope="session")
def eval_root() -> str:
    return EVAL_ROOT


@pytest.fixture(scope="session")
def catalog():
    return loader.load_catalog(os.path.join(EVAL_ROOT, "tool_catalog.json"))
