"""cli_runner.run_cli — C4 security: unstructured CLI stderr must NOT reach the
wire (it can carry absolute paths / argv / env from a crash or Config() failure).

We fake `asyncio.create_subprocess_exec` so no real `mailagent` is forked: a tiny
stub process returns a chosen (returncode, stdout, stderr). The assertions pin
the SOURCE-level contract that the routers rely on:

  * unstructured failure  → `exc.message` is a generic, path/argv/env-free
    string ("CLI command failed (exit N)"); the raw stderr is logged
    server-side and retained on `exc.stderr` for server-side recovery only.
  * STRUCTURED CLI wrapper → the CLI's self-reported `error.message` is the
    designed, user-readable string and MUST still surface verbatim.

The router-level half (exc.message → error envelope, with traceback redaction)
is covered in test_admin_davmail_selftest.py::test_llm_selftest_no_bin_redacts_traceback.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from src.api import cli_runner
from src.api.cli_runner import CliRunnerError, run_cli

# A stderr blob shaped like a real Python crash from the forked CLI: it leaks
# the absolute project path, the venv interpreter, and an env-derived secret —
# exactly the kind of thing C4 forbids on the wire.
_LEAKY_STDERR = (
    "Traceback (most recent call last):\n"
    '  File "/Users/chenyuanquan/Documents/MailAgent/src/cli/main.py", line 42\n'
    "pydantic.ValidationError: NOTION_TOKEN field required "
    "(env=/Users/chenyuanquan/Documents/MailAgent/.env)\n"
    "argv=['/Users/chenyuanquan/Documents/MailAgent/venv/bin/mailagent', "
    "'-o', 'json', '--api-key', 'super-secret-key', 'email', 'get', '1']\n"
)


class _StubProc:
    """Minimal stand-in for an asyncio subprocess returning canned streams."""

    def __init__(self, *, returncode: int, stdout: bytes, stderr: bytes) -> None:
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, self._stderr

    def kill(self) -> None:  # pragma: no cover - only used on timeout path
        pass

    async def wait(self) -> int:  # pragma: no cover
        return self.returncode


def _patch_proc(monkeypatch, *, returncode: int, stdout: bytes, stderr: bytes) -> None:
    """Replace create_subprocess_exec so run_cli never forks a real CLI."""

    async def _fake_exec(*_args, **_kwargs):
        return _StubProc(returncode=returncode, stdout=stdout, stderr=stderr)

    monkeypatch.setattr(cli_runner.asyncio, "create_subprocess_exec", _fake_exec)


@pytest.mark.asyncio
async def test_unstructured_stderr_is_sanitized_and_logged(monkeypatch, caplog):
    # CLI crashed (exit 1) with a leaky, NON-JSON stderr and empty stdout.
    _patch_proc(monkeypatch, returncode=1, stdout=b"", stderr=_LEAKY_STDERR.encode())

    with caplog.at_level(logging.ERROR, logger="mailagent.api.cli_runner"):
        with pytest.raises(CliRunnerError) as ei:
            await run_cli(["email", "get", "1"])

    exc = ei.value
    # The wire-bound message is generic — none of the leaked fragments appear.
    assert exc.message == "CLI command failed (exit 1)"
    for leak in ("Traceback", "/Users/chenyuanquan", "NOTION_TOKEN",
                 ".env", "super-secret-key", "argv=", "venv/bin/mailagent"):
        assert leak not in exc.message
    # Code still derives from the exit-code map (exit 1 → E_GENERIC).
    assert exc.code == "E_GENERIC"
    assert exc.exit_code == 1
    # Raw stderr is retained on the exception for SERVER-SIDE recovery only.
    assert "Traceback" in exc.stderr
    # …and was logged server-side (so operators can still diagnose the crash).
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "/Users/chenyuanquan/Documents/MailAgent/src/cli/main.py" in logged
    assert "super-secret-key" in logged


@pytest.mark.asyncio
async def test_structured_wrapper_message_surfaces_verbatim(monkeypatch, caplog):
    # The CLI emitted a STRUCTURED error wrapper on stderr (its documented
    # contract for non-zero exits) — that message is designed & user-readable.
    wrapper = (
        '{"status":"error","error":{"code":"E_NOT_FOUND",'
        '"message":"email 1 not found","hint":"check the id"}}'
    )
    _patch_proc(monkeypatch, returncode=1, stdout=b"", stderr=wrapper.encode())

    with caplog.at_level(logging.ERROR, logger="mailagent.api.cli_runner"):
        with pytest.raises(CliRunnerError) as ei:
            await run_cli(["email", "get", "1"])

    exc = ei.value
    # Designed message preserved exactly; code/hint come from the wrapper.
    assert exc.message == "email 1 not found"
    assert exc.code == "E_NOT_FOUND"
    assert exc.hint == "check the id"
    # The sanitization branch's server-side dump must NOT fire on the structured
    # path (no raw-stream leak log for a clean, designed error).
    assert not any(
        "raw stdout/stderr" in r.getMessage() for r in caplog.records
    )


@pytest.mark.asyncio
async def test_unstructured_empty_stderr_still_generic(monkeypatch):
    # A bare crash with NO output at all on a non-mapped exit code → still a
    # generic message (and a synthesised E_EXIT_<n> code), never a raw echo.
    _patch_proc(monkeypatch, returncode=42, stdout=b"", stderr=b"")

    with pytest.raises(CliRunnerError) as ei:
        await run_cli(["email", "get", "1"])

    exc = ei.value
    assert exc.message == "CLI command failed (exit 42)"
    assert exc.code == "E_EXIT_42"
    assert exc.exit_code == 42
