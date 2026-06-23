"""Top-level conftest for tests/agent_eval/.

Import-isolation: insert tests/agent_eval/ at the front of sys.path so that
`import runner` resolves to THIS eval copy, not anything else the root conftest
may have added.  The inner runner/tests/conftest.py performs the same insertion
(computing EVAL_ROOT via __file__), so this is belt-and-suspenders.

No LLM credentials are required to collect or run the rule-gate tests.
"""
import os
import sys

AGENT_EVAL_ROOT = os.path.dirname(os.path.abspath(__file__))
if AGENT_EVAL_ROOT not in sys.path:
    sys.path.insert(0, AGENT_EVAL_ROOT)
