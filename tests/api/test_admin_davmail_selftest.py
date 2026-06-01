"""admin davmail-health / system-alerts (sync_state davmail.* direct read) +
llm selftest (subprocess) + F1 serve_api↔loopback wiring.

- davmail-health / system-alerts have NO CLI (gotcha #12): they read the
  `davmail.*` keys DavMailWatchdog persists into sync_state and recompute the
  `level` with the watchdog's thresholds. meta.source must stay 'sqlite'. We seed
  sync_state on an ISOLATED DB so the davmail.* keys don't leak into other tests.
- llm selftest forks `mailagent llm selftest`. The CLI emits a *success* wrapper
  even when unhealthy and then exits 1; the router must recover that wrapper from
  exc.stdout and return 200 (healthy:false is a valid diagnosis, not an error).
  We monkeypatch run_cli to drive all three branches (healthy / unhealthy-recover
  / hard-crash) without a real fork.
- F1: serve_api wires MAILAGENT_API_HOST before uvicorn.run, and the lifespan
  assertion truly rejects a public bind when that var is poisoned.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Iterator

import pytest

import src.api.routers.llm as llm_router
from src.api.app import app
from src.api.cli_runner import CliResult, CliRunnerError
from src.api.deps import get_repository
from src.repository import AttachmentStore, EmailRepository


# ---------------------------------------------------------------------------
# Isolated client whose repo points at a DB we seed with davmail.* sync_state.
# ---------------------------------------------------------------------------


def _make_db_with_sync_state(db_path: Path, rows: dict[str, str]) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at REAL)"
        )
        now = time.time()
        for k, v in rows.items():
            conn.execute(
                "INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?)",
                (k, v, now),
            )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture()
def davmail_client_factory(tmp_path: Path) -> Iterator:
    """Returns a builder: davmail_state(dict) → TestClient reading those keys."""
    made: list = []

    def _build(state: dict[str, str]) -> "TestClient":  # noqa: F821
        from fastapi.testclient import TestClient

        db = tmp_path / f"dav_{len(made)}.db"
        _make_db_with_sync_state(db, state)
        repo = EmailRepository(
            db_path=str(db),
            attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
        )
        app.dependency_overrides[get_repository] = lambda: repo
        c = TestClient(app, raise_server_exceptions=False)
        made.append(c)
        return c

    yield _build
    app.dependency_overrides.pop(get_repository, None)


def _ok_sqlite(body: dict) -> None:
    assert body["status"] == "success"
    assert body["error"] is None
    assert body["meta"]["source"] == "sqlite"


# ===========================================================================
# GET /api/admin/davmail-health
# ===========================================================================


def test_davmail_health_disabled_when_no_probe(davmail_client_factory):
    # No davmail.last_probe_at → watchdog never ticked → enabled:false,
    # level:'unknown' (non-davmail mode). Must NOT 500.
    c = davmail_client_factory({})
    r = c.get("/api/admin/davmail-health")
    assert r.status_code == 200
    body = r.json()
    _ok_sqlite(body)
    data = body["data"]
    assert data["enabled"] is False
    assert data["level"] == "unknown"
    assert data["last_probe_at"] is None


def test_davmail_health_ok(davmail_client_factory):
    c = davmail_client_factory({
        "davmail.last_probe_at": "2026-05-31T10:00:00+00:00",
        "davmail.imap_reachable": "1",
        "davmail.smtp_reachable": "1",
        "davmail.token_age_days": "10",
        "davmail.throttle_events_5min": "0",
    })
    r = c.get("/api/admin/davmail-health")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["enabled"] is True
    assert data["level"] == "ok"
    assert data["imap_reachable"] is True
    assert data["smtp_reachable"] is True
    assert data["token_age_days"] == 10.0


def test_davmail_health_critical_on_imap_down(davmail_client_factory):
    c = davmail_client_factory({
        "davmail.last_probe_at": "2026-05-31T10:00:00+00:00",
        "davmail.imap_reachable": "0",
        "davmail.smtp_reachable": "1",
        "davmail.consecutive_imap_failures": "4",
        "davmail.token_age_days": "5",
    })
    r = c.get("/api/admin/davmail-health")
    data = r.json()["data"]
    assert data["level"] == "critical"
    assert data["imap_reachable"] is False
    assert data["consecutive_imap_failures"] == 4


def test_davmail_health_warning_on_token_aging(davmail_client_factory):
    # token_age_days >= 80 (warn) but < 87 (critical) → warning.
    c = davmail_client_factory({
        "davmail.last_probe_at": "2026-05-31T10:00:00+00:00",
        "davmail.imap_reachable": "1",
        "davmail.smtp_reachable": "1",
        "davmail.token_age_days": "82.5",
    })
    data = c.get("/api/admin/davmail-health").json()["data"]
    assert data["level"] == "warning"
    assert data["token_age_days"] == 82.5


def test_davmail_health_token_age_sentinel_minus1_is_null(davmail_client_factory):
    # "-1" sentinel (token file unreadable) → token_age_days None, not -1.
    c = davmail_client_factory({
        "davmail.last_probe_at": "2026-05-31T10:00:00+00:00",
        "davmail.imap_reachable": "1",
        "davmail.smtp_reachable": "1",
        "davmail.token_age_days": "-1",
    })
    data = c.get("/api/admin/davmail-health").json()["data"]
    assert data["token_age_days"] is None
    assert data["level"] == "ok"


# ===========================================================================
# GET /api/admin/system-alerts
# ===========================================================================


def test_system_alerts_empty_when_disabled(davmail_client_factory):
    # watchdog never ran → no trustworthy signal → empty alert list (no fabricated
    # alerts).
    c = davmail_client_factory({})
    r = c.get("/api/admin/system-alerts")
    assert r.status_code == 200
    body = r.json()
    _ok_sqlite(body)
    data = body["data"]
    assert data["alerts"] == []
    assert data["critical_count"] == 0
    assert data["warning_count"] == 0
    assert "generated_at" in data


def test_system_alerts_critical_imap_and_smtp(davmail_client_factory):
    c = davmail_client_factory({
        "davmail.last_probe_at": "2026-05-31T10:00:00+00:00",
        "davmail.imap_reachable": "0",
        "davmail.smtp_reachable": "0",
        "davmail.consecutive_imap_failures": "3",
        "davmail.consecutive_smtp_failures": "2",
        "davmail.token_age_days": "5",
    })
    data = c.get("/api/admin/system-alerts").json()["data"]
    titles = {a["title"] for a in data["alerts"]}
    assert "DavMail IMAP unreachable" in titles
    assert "DavMail SMTP unreachable" in titles
    assert data["critical_count"] == 2
    assert all(a["source"] == "davmail" for a in data["alerts"])


def test_system_alerts_warning_token_and_throttle(davmail_client_factory):
    c = davmail_client_factory({
        "davmail.last_probe_at": "2026-05-31T10:00:00+00:00",
        "davmail.imap_reachable": "1",
        "davmail.smtp_reachable": "1",
        "davmail.token_age_days": "83",
        "davmail.throttle_events_5min": "4",
    })
    data = c.get("/api/admin/system-alerts").json()["data"]
    levels = [a["level"] for a in data["alerts"]]
    assert "warning" in levels
    assert data["warning_count"] >= 2  # token aging + throttling.
    assert data["critical_count"] == 0


# ===========================================================================
# GET /api/llm/selftest  (subprocess; healthy / recover / crash branches)
# ===========================================================================


class _LlmSpy:
    def __init__(self, *, result=None, raises=None):
        self.calls: list = []
        self._result = result
        self._raises = raises

    async def __call__(self, args, *, api_key=None, **kw):
        self.calls.append({"args": list(args), "api_key": api_key})
        if self._raises is not None:
            raise self._raises
        return self._result


def test_llm_selftest_healthy(client, monkeypatch):
    data = {
        "healthy": True, "api_base": "https://llm.example", "primary_model": "x",
        "fallback_chain": [], "llm_agent_enabled": False, "reasons": [],
    }
    spy = _LlmSpy(result=CliResult(data=data, meta={}, status="success"))
    monkeypatch.setattr(llm_router, "run_cli", spy)
    r = client.get("/api/llm/selftest")
    assert r.status_code == 200
    body = r.json()
    assert body["data"]["healthy"] is True
    assert body["meta"]["source"] == "cli"
    # read endpoint → no api key injected.
    assert spy.calls[-1]["api_key"] is None
    assert spy.calls[-1]["args"] == ["llm", "selftest"]


def test_llm_selftest_unhealthy_recovered_from_stdout(client, monkeypatch):
    # CLI emits a success wrapper (healthy:false) to stdout, THEN exits 1.
    # run_cli raises CliRunnerError carrying that wrapper in .stdout; the router
    # must recover it and still return 200 (healthy:false is a valid diagnosis).
    wrapper_stdout = (
        '{"status":"success","schema_version":1,'
        '"data":{"healthy":false,"reasons":["LLM_API_KEY missing"]},'
        '"error":null,"meta":{"duration_ms":3}}'
    )
    exc = CliRunnerError(
        code="E_GENERIC", exit_code=1, message="selftest unhealthy",
        stdout=wrapper_stdout,
    )
    spy = _LlmSpy(raises=exc)
    monkeypatch.setattr(llm_router, "run_cli", spy)
    r = client.get("/api/llm/selftest")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["healthy"] is False
    assert "LLM_API_KEY missing" in data["reasons"]


def test_llm_selftest_hard_crash_surfaces_error(client, monkeypatch):
    # A real crash (no recoverable wrapper) → error path. E_NO_BIN unmapped → 500.
    exc = CliRunnerError(
        code="E_NO_BIN", exit_code=-1, message="mailagent CLI not found",
        stdout="", stderr="Traceback...",
    )
    spy = _LlmSpy(raises=exc)
    monkeypatch.setattr(llm_router, "run_cli", spy)
    r = client.get("/api/llm/selftest")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "E_NO_BIN"
    # stderr/traceback must NOT leak into the wire error.
    assert "Traceback" not in r.json()["error"]["message"]


def test_llm_selftest_exit1_nonrecoverable_wrapper_is_error(client, monkeypatch):
    # exit 1 but stdout is a *non*-success / non-`healthy` wrapper → not
    # recoverable → error path (guards the recover heuristic against false hits).
    exc = CliRunnerError(
        code="E_GENERIC", exit_code=1, message="boom",
        stdout='{"status":"error","error":{"code":"E_GENERIC","message":"boom"}}',
    )
    spy = _LlmSpy(raises=exc)
    monkeypatch.setattr(llm_router, "run_cli", spy)
    r = client.get("/api/llm/selftest")
    assert r.status_code == 500  # E_GENERIC unmapped → 500.
    assert r.json()["status"] == "error"


# ===========================================================================
# F1 — serve_api wires MAILAGENT_API_HOST before uvicorn.run + assertion bites
# ===========================================================================


def test_f1_serve_api_sets_host_env_before_uvicorn_run():
    """serve_api must set os.environ['MAILAGENT_API_HOST']=host BEFORE uvicorn.run.

    F1's fix is only real if the env var the lifespan assertion reads is written
    on the same hard-bound host *before* the server starts. Reading the source by
    path (importing src.cli.main builds Config() which needs a real .env the bare
    worktree lacks) we assert the ordering statically.
    """
    cli_main = Path(__file__).resolve().parents[2] / "src" / "cli" / "main.py"
    text = cli_main.read_text(encoding="utf-8")

    set_marker = 'os.environ["MAILAGENT_API_HOST"] = host'
    assert set_marker in text, "serve_api must export MAILAGENT_API_HOST (F1)"
    # host is hard-bound to loopback right above the export.
    assert 'host = "127.0.0.1"' in text
    # ordering: the env export precedes uvicorn.run.
    assert text.index(set_marker) < text.index("uvicorn.run("), (
        "MAILAGENT_API_HOST must be set BEFORE uvicorn.run so the lifespan "
        "loopback assertion sees the real bind host (F1)"
    )
    # F1 regression guard: the lifespan assertion must READ the self-owned
    # MAILAGENT_API_HOST var (the dead UVICORN_HOST read was the bug). Assert on
    # the live `os.environ.get(...)` call — NOT the mere absence of the string,
    # which still appears in the F1 explainer comment. The behavioural proof that
    # this read actually bites lives in test_f1_assertion_intercepts_public_bind.
    app_py = (Path(__file__).resolve().parents[2] / "src" / "api" / "app.py").read_text(
        encoding="utf-8"
    )
    assert 'os.environ.get("MAILAGENT_API_HOST"' in app_py


def test_f1_assertion_intercepts_public_bind_via_env(monkeypatch):
    """With MAILAGENT_API_HOST poisoned to 0.0.0.0 the lifespan guard raises.

    This is the behavioural half of F1: prove the guard actually reads the
    var serve_api sets and rejects a public bind (the old UVICORN_HOST read made
    this a no-op). C3: the guard now raises RuntimeError (not AssertionError) so
    it survives `python -O`, which strips `assert` statements.
    """
    import asyncio

    from src.api.app import _assert_bind_loopback

    monkeypatch.setenv("MAILAGENT_API_HOST", "0.0.0.0")
    with pytest.raises(RuntimeError):
        asyncio.run(_assert_bind_loopback())

    # And the loopback host serve_api sets is accepted.
    monkeypatch.setenv("MAILAGENT_API_HOST", "127.0.0.1")
    asyncio.run(_assert_bind_loopback())  # no raise
