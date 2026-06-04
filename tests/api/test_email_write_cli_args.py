"""email WRITE endpoints — CLI argv construction (the happy path, minus the fork).

The write endpoints still backed by a fork (archive / draft / send / draft-plan)
fork the real `mailagent` CLI via cli_runner.run_cli. Forking a real CLI needs a
full `.env` (NOTION_TOKEN, …) + a davmail bridge, so the *happy* paths are e2e
territory. What we CAN and MUST pin here is the **argv the router builds** — the
ABSENCE of `--allow-concurrent` on archive (#6/#9), the `--body-html-file <tmp>`
temp-file dance (#8), snake_case body keys NOT getting camel-cased into CLI flags
(#8), and the temp file being cleaned up afterwards.

NOTE: flag + resync moved to in-process MailWriteService in A2 (no longer fork
CLI) — their endpoint tests live in tests/api/test_email_write_service.py.

Technique: monkeypatch `src.api.routers.email.run_cli` (the name the router
imported) with an async spy that records the argv and returns a canned
CliResult, OR raises CliRunnerError to simulate the davmail gate. No subprocess
is ever spawned; we assert on the captured argv.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

import src.api.routers.email as email_router
from src.api.cli_runner import CliResult, CliRunnerError

from tests.api.conftest import EMAIL_ID


class _Spy:
    """Records the last run_cli(args, api_key=...) call and returns a canned result."""

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


@pytest.fixture()
def spy(monkeypatch) -> _Spy:
    """Default success spy patched onto the router's run_cli reference."""
    s = _Spy()
    monkeypatch.setattr(email_router, "run_cli", s)
    return s


# ===========================================================================
# POST /api/email/{id}/archive  — NO --allow-concurrent (#9), davmail gate (#6)
# ===========================================================================


def test_archive_argv_has_no_allow_concurrent(client, spy):
    r = client.post(f"/api/email/{EMAIL_ID}/archive", json={})
    assert r.status_code == 200
    args = spy.last_args
    assert args[:3] == ["email", "archive", str(EMAIL_ID)]
    # archive does NOT do a pm2 check → must NOT carry --allow-concurrent (#9).
    assert "--allow-concurrent" not in args


def test_archive_dry_run(client, spy):
    r = client.post(f"/api/email/{EMAIL_ID}/archive", json={"dryRun": True})
    assert r.status_code == 200
    assert "--dry-run" in spy.last_args
    assert spy.calls[-1]["api_key"] is None


def test_archive_non_davmail_gate_400(client, monkeypatch):
    # gotcha #6: on a non-davmail backend the CLI self-reports E_INVALID_ARG;
    # the router surfaces it cleanly as 400 (no backend re-probe in the router).
    spy = _Spy(raises=CliRunnerError(
        code="E_INVALID_ARG", exit_code=2,
        message="email archive requires MAILAGENT_BACKEND=davmail",
        hint="set MAILAGENT_BACKEND=davmail",
    ))
    monkeypatch.setattr(email_router, "run_cli", spy)
    r = client.post(f"/api/email/{EMAIL_ID}/archive", json={})
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["code"] == "E_INVALID_ARG"
    assert "davmail" in body["error"]["message"]


# ===========================================================================
# POST /api/email/draft + /send  — body-html-file temp file (#8) + snake_case
# ===========================================================================


def test_draft_writes_body_html_file_and_cleans_up(client, monkeypatch):
    import os

    captured: dict = {}

    async def _fake(args, *, api_key=None, **kw):
        # Snapshot the temp file path + its contents AT CALL TIME (before the
        # router's finally-block unlinks it).
        a = list(args)
        captured["args"] = a
        i = a.index("--body-html-file")
        path = a[i + 1]
        captured["path"] = path
        with open(path, encoding="utf-8") as fh:
            captured["html"] = fh.read()
        captured["existed_during_call"] = os.path.exists(path)
        return CliResult(data={"appended_uid": 7}, meta={}, status="success")

    monkeypatch.setattr(email_router, "run_cli", _fake)

    r = client.post(
        "/api/email/draft",
        json={
            "internalId": EMAIL_ID,
            "mode": "reply",
            "to": ["x@example.com", "y@example.com"],
            "cc": ["c@example.com"],
            "subject": "Re: hello",
            "bodyHtml": "<p>hi <b>there</b></p>",
        },
    )
    assert r.status_code == 200

    args = captured["args"]
    # verb + positional id + mode.
    assert args[:5] == ["email", "draft", str(EMAIL_ID), "--mode", "reply"]
    # recipients joined with commas (snake_case body key `to` → CLI `--to`).
    assert args[args.index("--to") + 1] == "x@example.com,y@example.com"
    assert args[args.index("--cc") + 1] == "c@example.com"
    assert args[args.index("--subject") + 1] == "Re: hello"
    # body went through a temp .html file (NOT inline on argv).
    assert "<p>hi <b>there</b></p>" not in args
    assert captured["path"].endswith(".html")
    assert captured["html"] == "<p>hi <b>there</b></p>"
    assert captured["existed_during_call"] is True
    # gotcha #8 cleanup: the temp file is unlinked after the request returns.
    assert not os.path.exists(captured["path"])


def test_draft_no_body_html_omits_flag(client, spy):
    r = client.post("/api/email/draft", json={"internalId": EMAIL_ID, "mode": "reply"})
    assert r.status_code == 200
    assert "--body-html-file" not in spy.last_args


def test_draft_camel_body_keys_not_leaked_as_flags(client, spy):
    # The JSON body uses camelCase (internalId/bodyHtml); the CLI must receive
    # the canonical kebab flags, never `--internalId` / `--bodyHtml` (#8 history).
    r = client.post(
        "/api/email/draft",
        json={"internalId": EMAIL_ID, "mode": "forward", "bodyHtml": "<p>x</p>"},
    )
    assert r.status_code == 200
    args = spy.last_args
    assert "--internalId" not in args
    assert "--bodyHtml" not in args
    assert "--internal-id" not in args  # id is positional, not a flag.
    assert "--body-html-file" in args
    # internalId is the positional id.
    assert args[2] == str(EMAIL_ID)


def test_send_always_has_yes_flag(client, spy):
    r = client.post(
        "/api/email/send",
        json={"internalId": EMAIL_ID, "mode": "reply", "bodyHtml": "<p>send</p>"},
    )
    assert r.status_code == 200
    args = spy.last_args
    assert args[:3] == ["email", "send", str(EMAIL_ID)]
    # send is irreversible → always `--yes` (json mode CLI refuses otherwise).
    assert "--yes" in args
    assert "--body-html-file" in args


def test_send_temp_file_cleaned_up_even_on_cli_error(client, monkeypatch):
    import os

    seen: dict = {}

    async def _fake(args, *, api_key=None, **kw):
        a = list(args)
        seen["path"] = a[a.index("--body-html-file") + 1]
        raise CliRunnerError(code="E_UPSTREAM", exit_code=5, message="smtp down")

    monkeypatch.setattr(email_router, "run_cli", _fake)
    r = client.post(
        "/api/email/send",
        json={"internalId": EMAIL_ID, "mode": "reply", "bodyHtml": "<p>x</p>"},
    )
    # A2/A3: E_UPSTREAM (cli exit 5, upstream SMTP/davmail failure) now maps to
    # 502 Bad Gateway via ERROR_CODE_TO_HTTP (was an unmapped → 500 default).
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "E_UPSTREAM"
    # The point of this test: the finally-block must still have unlinked the temp
    # file despite the CLI error (gotcha #8 cleanup is in `finally`, not `try`).
    assert not os.path.exists(seen["path"])


def test_draft_missing_internal_id_no_fork(client, spy):
    # Pre-fork validation must reject before run_cli is ever called.
    r = client.post("/api/email/draft", json={"mode": "reply"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert spy.calls == []  # run_cli never reached.


def test_send_invalid_mode_no_fork(client, spy):
    r = client.post(
        "/api/email/send", json={"internalId": EMAIL_ID, "mode": "bogus"}
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert spy.calls == []


# ===========================================================================
# POST /api/email/{id}/draft-plan  — dry-run + snake_case passthrough (#8)
# ===========================================================================


def test_draft_plan_is_dry_run_no_api_key(client, spy):
    r = client.post(f"/api/email/{EMAIL_ID}/draft-plan", json={"mode": "reply"})
    assert r.status_code == 200
    args = spy.last_args
    assert args[:5] == ["email", "draft", str(EMAIL_ID), "--mode", "reply"]
    assert "--dry-run" in args
    assert "--yes" not in args
    # draft-plan never injects an api key (dry-run skips write auth).
    assert spy.calls[-1]["api_key"] is None


def test_draft_plan_returns_snake_case_data_verbatim(client, monkeypatch):
    # gotcha #8: DraftPlanResult snake_case (reply_html / forward_intro_html /
    # reply_source) must pass through to the wire UN-camel-cased.
    plan = {
        "mode": "reply",
        "to": ["a@example.com"],
        "subject": "Re: x",
        "reply_html": "<p>suggested</p>",
        "forward_intro_html": None,
        "reply_source": "llm_suggestion",
    }
    spy = _Spy(data=plan)
    monkeypatch.setattr(email_router, "run_cli", spy)
    r = client.post(f"/api/email/{EMAIL_ID}/draft-plan", json={"mode": "reply"})
    assert r.status_code == 200
    data = r.json()["data"]
    # exact snake_case keys preserved (no camelCase rewrite).
    assert data["reply_html"] == "<p>suggested</p>"
    assert data["reply_source"] == "llm_suggestion"
    assert "replyHtml" not in data
    assert "forwardIntroHtml" not in data
