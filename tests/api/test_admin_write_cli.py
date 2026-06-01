"""admin WRITE endpoints — cleanup-dead-letter / dead-letter retry via cli_runner.

These endpoints fork the real `mailagent` CLI; here we monkeypatch
`src.api.routers.admin.run_cli` with an async spy (same technique as
test_email_write_cli_args.py) so no subprocess is spawned. We pin:

  - A1: a CLI ``partial_failure`` wrapper (exit 6) from cleanup-deadletter maps
    to HTTP 207 + ``status:'partial_failure'`` envelope (data passed through),
    while a plain success stays 200.
  - the always-on ``--allow-concurrent`` + dry-run flag wiring on cleanup.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

import src.api.routers.admin as admin_router
from src.api.cli_runner import CliResult, CliRunnerError


class _Spy:
    """Records run_cli(args, api_key=...) and returns a canned CliResult."""

    def __init__(
        self,
        *,
        data: Any = None,
        raises: Optional[CliRunnerError] = None,
        status: str = "success",
    ):
        self.calls: list[dict] = []
        self._data = data if data is not None else {"ok": True}
        self._raises = raises
        self._status = status

    async def __call__(
        self, args, *, api_key=None, timeout=60, extra_globals=None, cwd=None
    ):
        self.calls.append({"args": list(args), "api_key": api_key})
        if self._raises is not None:
            raise self._raises
        return CliResult(data=self._data, meta={"duration_ms": 1}, status=self._status)

    @property
    def last_args(self) -> list[str]:
        assert self.calls, "run_cli was never called"
        return self.calls[-1]["args"]


def _patch(monkeypatch, spy: _Spy) -> None:
    monkeypatch.setattr(admin_router, "run_cli", spy)


# ---------------------------------------------------------------------------
# A1: cleanup-dead-letter partial_failure → 207
# ---------------------------------------------------------------------------


def test_cleanup_dead_letter_partial_failure_207(client, monkeypatch):
    partial_data = {
        "succeeded": [{"internal_id": 1}],
        "failed": [
            {"internal_id": 2, "error": {"code": "E_GENERIC", "message": "boom"}}
        ],
        "summary": {"total": 2, "succeeded": 1, "failed": 1, "aborted_by": None},
    }
    spy = _Spy(data=partial_data, status="partial_failure")
    _patch(monkeypatch, spy)

    r = client.post("/api/admin/cleanup-dead-letter", params={"dry_run": False})

    assert r.status_code == 207
    body = r.json()
    assert body["status"] == "partial_failure"
    assert body["error"] is None  # per-item errors live in data.failed[].error.
    assert body["data"] == partial_data
    assert body["meta"]["source"] == "cli"


def test_cleanup_dead_letter_success_200(client, monkeypatch):
    ok_data = {
        "action": "cleanup-deadletter",
        "older_than_days": 30,
        "candidates": 0,
        "deleted": 0,
        "dry_run": True,
        "mode": "dry-run",
        "ok": True,
    }
    spy = _Spy(data=ok_data, status="success")
    _patch(monkeypatch, spy)

    r = client.post("/api/admin/cleanup-dead-letter")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["data"] == ok_data
    # default dry_run=true → --dry-run, no --no-dry-run/--yes; always --allow-concurrent.
    assert "--allow-concurrent" in spy.last_args
    assert "--dry-run" in spy.last_args
    assert "--no-dry-run" not in spy.last_args
    assert "--yes" not in spy.last_args


def test_cleanup_dead_letter_real_delete_flags(client, monkeypatch):
    spy = _Spy(data={"ok": True}, status="success")
    _patch(monkeypatch, spy)

    r = client.post(
        "/api/admin/cleanup-dead-letter",
        params={"dry_run": False, "older_than": 7},
    )

    assert r.status_code == 200
    args = spy.last_args
    assert "--no-dry-run" in args and "--yes" in args
    assert "--dry-run" not in args
    assert args[args.index("--older-than") + 1] == "7"
    assert "--allow-concurrent" in args


def test_cleanup_dead_letter_cli_error_maps_http(client, monkeypatch):
    """A CliRunnerError (e.g. CLI self-reported E_INVALID_ARG) → mapped HTTP, not 207."""
    spy = _Spy(
        raises=CliRunnerError(
            code="E_INVALID_ARG",
            exit_code=2,
            message="bad older_than",
            hint="use >=0",
        )
    )
    _patch(monkeypatch, spy)

    r = client.post("/api/admin/cleanup-dead-letter", params={"older_than": -5})

    assert r.status_code == 400
    body = r.json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "E_INVALID_ARG"


# ---------------------------------------------------------------------------
# dead-letter retry — single id, no partial-failure path (sanity guard)
# ---------------------------------------------------------------------------


def test_dead_letter_retry_success_passthrough(client, monkeypatch):
    spy = _Spy(
        data={"internal_id": 53675, "old_status": "dead_letter", "new_status": "pending"},
        status="success",
    )
    _patch(monkeypatch, spy)

    r = client.post("/api/admin/dead-letter/53675/retry")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["data"]["new_status"] == "pending"
    args = spy.last_args
    assert args[:4] == ["admin", "dead-letter", "retry", "53675"]
    assert "--allow-concurrent" in args
