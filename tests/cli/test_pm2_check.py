"""pm2_check unit tests (PR-4 US-003).

Mock subprocess.run, cover:
- mail-sync online → raise CliPM2ConflictError (exit 9)
- mail-sync stopped / errored → 通过
- pm2 not installed (FileNotFoundError) → 通过
- pm2 timeout (TimeoutExpired) → 通过
- pm2 jlist non-JSON → 通过
- allow_concurrent=True bypass
- env MAILAGENT_CLI_ALLOW_CONCURRENT=true bypass
"""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

import pytest

from src.cli.exceptions import CliPM2ConflictError
from src.cli.pm2_check import check_pm2_conflict, ENV_BYPASS


class _FakeRun:
    """subprocess.run stand-in — 单参数返回固定 result, 或 raise."""

    def __init__(self, *, stdout=None, returncode=0, exc=None):
        self.stdout = stdout
        self.returncode = returncode
        self.exc = exc
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.calls += 1
        if self.exc is not None:
            raise self.exc
        return SimpleNamespace(stdout=self.stdout, returncode=self.returncode)


def _payload(name="mail-sync", status="online"):
    return json.dumps([{"name": name, "pm2_env": {"status": status}}])


def test_mailsync_online_raises():
    fake = _FakeRun(stdout=_payload(name="mail-sync", status="online"))
    with pytest.raises(CliPM2ConflictError) as e:
        check_pm2_conflict(cli=None, runner=fake)
    assert e.value.exit_code == 9
    assert e.value.code == "E_PM2_RUNNING"
    assert "concurrent" in (e.value.hint or "").lower()


def test_mailsync_stopped_passes():
    fake = _FakeRun(stdout=_payload(name="mail-sync", status="stopped"))
    check_pm2_conflict(cli=None, runner=fake)  # no raise


def test_mailsync_errored_passes():
    fake = _FakeRun(stdout=_payload(name="mail-sync", status="errored"))
    check_pm2_conflict(cli=None, runner=fake)


def test_other_proc_only_passes():
    fake = _FakeRun(stdout=_payload(name="mailagent-webhook", status="online"))
    check_pm2_conflict(cli=None, runner=fake)


def test_pm2_not_installed_passes():
    fake = _FakeRun(exc=FileNotFoundError("pm2"))
    check_pm2_conflict(cli=None, runner=fake)


def test_pm2_timeout_passes():
    fake = _FakeRun(exc=subprocess.TimeoutExpired(cmd="pm2", timeout=5))
    check_pm2_conflict(cli=None, runner=fake)


def test_pm2_jlist_non_json_passes():
    fake = _FakeRun(stdout="not json at all")
    check_pm2_conflict(cli=None, runner=fake)


def test_pm2_jlist_empty_passes():
    fake = _FakeRun(stdout="[]")
    check_pm2_conflict(cli=None, runner=fake)


def test_allow_concurrent_bypass():
    fake = _FakeRun(stdout=_payload(name="mail-sync", status="online"))
    check_pm2_conflict(cli=None, allow_concurrent=True, runner=fake)
    # 应根本没调到 runner
    assert fake.calls == 0


def test_env_bypass(monkeypatch):
    monkeypatch.setenv(ENV_BYPASS, "true")
    fake = _FakeRun(stdout=_payload(name="mail-sync", status="online"))
    check_pm2_conflict(cli=None, runner=fake)
    assert fake.calls == 0


def test_env_bypass_case_insensitive(monkeypatch):
    monkeypatch.setenv(ENV_BYPASS, "True")
    fake = _FakeRun(stdout=_payload(name="mail-sync", status="online"))
    check_pm2_conflict(cli=None, runner=fake)


def test_pm2_returncode_nonzero_passes():
    fake = _FakeRun(stdout="", returncode=1)
    check_pm2_conflict(cli=None, runner=fake)
