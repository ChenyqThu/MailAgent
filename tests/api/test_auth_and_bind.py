"""Auth layer (CF Access JWT) + the loopback-bind startup assertion.

- Bypass ON (default fixture, MAILAGENT_API_AUTH_DISABLED=true): protected
  endpoints are reachable without a JWT, and request.state.user_email is the dev
  placeholder.
- Bypass OFF (monkeypatch src.api.auth.AUTH_DISABLED=False): a protected endpoint
  with NO `Cf-Access-Jwt-Assertion` header → 401 E_AUTH_FAILED; a bogus token →
  403 E_AUTH_FAILED. verify_cf_access is also unit-tested directly.
- Loopback: the lifespan startup assertion (_assert_bind_loopback) rejects a
  non-127.0.0.1 MAILAGENT_API_HOST; we assert it exists and fires.
"""

from __future__ import annotations

import asyncio
import os

import pytest
from fastapi import HTTPException

import src.api.auth as auth_mod
from src.api.auth import verify_cf_access


# ---------------------------------------------------------------------------
# Bypass ON (default) — env var set at conftest import time
# ---------------------------------------------------------------------------


def test_bypass_allows_protected_read(client):
    """With MAILAGENT_API_AUTH_DISABLED=true, no JWT needed."""
    assert auth_mod.AUTH_DISABLED is True
    r = client.get("/api/email/list")
    assert r.status_code == 200
    assert r.json()["status"] == "success"


@pytest.mark.asyncio
async def test_verify_cf_access_bypass_sets_dev_email():
    """Bypass path stamps the dev placeholder identity, returns None."""

    class _Req:
        def __init__(self):
            self.headers = {}

            class _S:
                pass

            self.state = _S()

    req = _Req()
    assert auth_mod.AUTH_DISABLED is True
    result = await verify_cf_access(req)  # type: ignore[arg-type]
    assert result is None
    assert req.state.user_email == "dev@localhost"


# ---------------------------------------------------------------------------
# Bypass OFF — re-lock the layer via monkeypatch
# ---------------------------------------------------------------------------


def test_missing_jwt_401(client, monkeypatch):
    """No Cf-Access-Jwt-Assertion header + bypass off → 401 E_AUTH_FAILED."""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = client.get("/api/email/list")
    assert r.status_code == 401
    body = r.json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "E_AUTH_FAILED"
    assert body["data"] is None


def test_invalid_jwt_403(client, monkeypatch):
    """A malformed token fails verification → 403 E_AUTH_FAILED.

    A non-JWT string makes PyJWKClient/jwt.decode raise a PyJWTError, which
    verify_cf_access maps to HTTPException(403).
    """
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = client.get(
        "/api/email/list",
        headers={"Cf-Access-Jwt-Assertion": "not.a.real.jwt"},
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_missing_jwt_on_email_get_401(client, monkeypatch):
    """The dependency guards every protected route, not just /list."""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = client.get("/api/email/1001")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_health_liveness_never_requires_auth(client, monkeypatch):
    """/api/health is the unauthenticated probe — reachable even bypass off."""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = client.get("/api/health")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_verify_cf_access_missing_token_raises_401(monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Req:
        headers: dict = {}

        class state:  # noqa: N801
            pass

    with pytest.raises(HTTPException) as ei:
        await verify_cf_access(_Req())  # type: ignore[arg-type]
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_verify_cf_access_bad_token_raises_403(monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Req:
        headers = {"Cf-Access-Jwt-Assertion": "garbage-token"}

        class state:  # noqa: N801
            pass

    with pytest.raises(HTTPException) as ei:
        await verify_cf_access(_Req())  # type: ignore[arg-type]
    assert ei.value.status_code == 403


# ---------------------------------------------------------------------------
# C1 — defense-in-depth L2: email claim required + single-allowlist match
# ---------------------------------------------------------------------------
#
# These exercise verify_cf_access PAST jwt.decode without a real CF signature:
# we stub _jwk_client.get_signing_key_from_jwt (so no JWKS fetch) and
# jwt.decode (so we control the returned claims). AUTH_DISABLED is forced off.


class _ReqWithToken:
    def __init__(self):
        self.headers = {"Cf-Access-Jwt-Assertion": "header.payload.sig"}

        class _S:
            pass

        self.state = _S()


def _stub_decode(monkeypatch, claims: dict):
    """Make signature verification a no-op and jwt.decode return `claims`."""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(
        auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key()
    )
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: claims)


@pytest.mark.asyncio
async def test_valid_jwt_matching_email_passes(monkeypatch):
    """Signed JWT whose email == allowed email → passes, stamps that email."""
    _stub_decode(monkeypatch, {"email": "Owner@Example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})
    req = _ReqWithToken()
    result = await verify_cf_access(req)  # type: ignore[arg-type]
    assert result is None
    # Verified original-cased email is stamped (compare was case-insensitive).
    assert req.state.user_email == "Owner@Example.com"


@pytest.mark.asyncio
async def test_valid_jwt_matching_second_email_in_allowlist_passes(monkeypatch):
    """JWT email matches the second entry in a multi-email allowlist → passes."""
    _stub_decode(monkeypatch, {"email": "lucien.chen@tp-link.com"})
    monkeypatch.setattr(
        auth_mod,
        "_resolve_allowed_emails",
        lambda: {"lucien.chen@omadanetworks.com", "lucien.chen@tp-link.com"},
    )
    req = _ReqWithToken()
    result = await verify_cf_access(req)  # type: ignore[arg-type]
    assert result is None
    assert req.state.user_email == "lucien.chen@tp-link.com"


@pytest.mark.asyncio
async def test_valid_jwt_missing_email_claim_403(monkeypatch):
    """A correctly-signed JWT with NO email claim → 403 (C1)."""
    _stub_decode(monkeypatch, {"sub": "service-token", "aud": "x"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})
    with pytest.raises(HTTPException) as ei:
        await verify_cf_access(_ReqWithToken())  # type: ignore[arg-type]
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_valid_jwt_wrong_email_403(monkeypatch):
    """Signed JWT whose email is NOT in the allowlist → 403 (C1 allowlist)."""
    _stub_decode(monkeypatch, {"email": "intruder@evil.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})
    with pytest.raises(HTTPException) as ei:
        await verify_cf_access(_ReqWithToken())  # type: ignore[arg-type]
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_valid_jwt_but_no_allowlist_configured_fails_closed_403(monkeypatch):
    """allowed emails unresolved (USER_EMAIL + override both empty) → fail-closed 403."""
    _stub_decode(monkeypatch, {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: set())
    with pytest.raises(HTTPException) as ei:
        await verify_cf_access(_ReqWithToken())  # type: ignore[arg-type]
    assert ei.value.status_code == 403


# ---------------------------------------------------------------------------
# _resolve_allowed_emails unit tests
# ---------------------------------------------------------------------------


def test_resolve_allowed_emails_union_of_config_and_override(monkeypatch):
    """USER_EMAIL + override 都配 → 两者并集，两个邮箱都在白名单。"""
    import src.config as config_mod

    class _FakeConfig:
        user_email = "lucien.chen@omadanetworks.com"

    monkeypatch.setattr(config_mod, "config", _FakeConfig())
    monkeypatch.setattr(auth_mod, "ALLOWED_EMAIL_OVERRIDE", "lucien.chen@tp-link.com")
    result = auth_mod._resolve_allowed_emails()
    assert result == {"lucien.chen@omadanetworks.com", "lucien.chen@tp-link.com"}


def test_resolve_allowed_emails_comma_separated_override(monkeypatch):
    """override 逗号分隔多邮箱（含空白、大小写）→ 全部解析进集合，统一小写。"""
    import src.config as config_mod

    monkeypatch.delattr(config_mod, "config", raising=False)
    monkeypatch.setattr(
        auth_mod, "ALLOWED_EMAIL_OVERRIDE", "  Alice@Example.com , bob@Example.com  , "
    )
    result = auth_mod._resolve_allowed_emails()
    assert result == {"alice@example.com", "bob@example.com"}


def test_resolve_allowed_emails_empty_set_when_both_unconfigured(monkeypatch):
    """USER_EMAIL 不可用 + override 空 → 空集合 → 调用方 fail-closed。"""
    import src.config as config_mod

    monkeypatch.delattr(config_mod, "config", raising=False)
    monkeypatch.setattr(auth_mod, "ALLOWED_EMAIL_OVERRIDE", "")
    result = auth_mod._resolve_allowed_emails()
    assert result == set()


def test_resolve_allowed_emails_config_absent_falls_back_to_override(monkeypatch):
    """config 不可用 (裸 worktree / 缺 .env) → resolver 使用 override env。

    hermetic: 删掉 ``src.config.config`` 符号, 强制 lazy import 抛 ImportError
    (= 裸 worktree config 单例构造失败的等效), 验证解析器只取 override。
    """
    import src.config as config_mod

    monkeypatch.setattr(auth_mod, "ALLOWED_EMAIL_OVERRIDE", "Fallback@Example.com")
    monkeypatch.delattr(config_mod, "config", raising=False)
    result = auth_mod._resolve_allowed_emails()
    assert result == {"fallback@example.com"}


def test_resolve_allowed_email_prefers_override_when_config_absent(monkeypatch):
    """_resolve_allowed_email() compat shim: config 不可用 → 回退 override env (hermetic)。"""
    import src.config as config_mod

    monkeypatch.setattr(auth_mod, "ALLOWED_EMAIL_OVERRIDE", "Fallback@Example.com")
    monkeypatch.delattr(config_mod, "config", raising=False)
    assert auth_mod._resolve_allowed_email() == "fallback@example.com"


def test_resolve_allowed_email_prefers_config_over_override(monkeypatch):
    """_resolve_allowed_email(): config.user_email 可用时优先于 ALLOWED_EMAIL_OVERRIDE。

    即使 override 也配了，返回值应是 config.user_email（主配置身份），而不是 override。
    """
    import src.config as config_mod

    class _FakeConfig:
        user_email = "primary@example.com"

    monkeypatch.setattr(config_mod, "config", _FakeConfig())
    monkeypatch.setattr(auth_mod, "ALLOWED_EMAIL_OVERRIDE", "override@example.com")
    result = auth_mod._resolve_allowed_email()
    assert result == "primary@example.com"


# ---------------------------------------------------------------------------
# C2 — auth bypass is dev-only: import-time RuntimeError without dev context
# ---------------------------------------------------------------------------


def test_auth_disabled_without_dev_context_refuses_to_start(monkeypatch):
    """MAILAGENT_API_AUTH_DISABLED=true + MAILAGENT_API_DEV unset → RuntimeError.

    Re-import the module under a doctored env to observe the import-time guard
    (the live module was imported with MAILAGENT_API_DEV=true by conftest).
    """
    import importlib

    monkeypatch.setenv("MAILAGENT_API_AUTH_DISABLED", "true")
    monkeypatch.delenv("MAILAGENT_API_DEV", raising=False)
    with pytest.raises(RuntimeError, match="dev"):
        importlib.reload(auth_mod)
    # Restore a clean, consistent module for the rest of the session.
    monkeypatch.setenv("MAILAGENT_API_DEV", "true")
    importlib.reload(auth_mod)


# ---------------------------------------------------------------------------
# C2 — dual-layer auth: local ephemeral token leg (same-machine Electron)
# ---------------------------------------------------------------------------
#
# verify_cf_access gains a SECOND leg before the (byte-unchanged) CF JWT path:
# a configured _LOCAL_API_TOKEN + matching X-MailAgent-Local-Token header →
# pass as the local identity. Unconfigured token / mismatch → fall through to
# the CF JWT path (fail-closed). monkeypatch the module global like AUTH_DISABLED.


def _req_with_local_token(tok: str | None):
    class _Req:
        def __init__(self):
            self.headers = {} if tok is None else {auth_mod.LOCAL_TOKEN_HEADER: tok}

            class _S:
                pass

            self.state = _S()

    return _Req()


@pytest.mark.asyncio
async def test_local_token_match_passes_stamps_email(monkeypatch):
    """配了 token + header 匹配 → 放行, 落 allowed email 身份 (不碰 CF JWT)。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "ephemeral-secret")
    monkeypatch.setattr(auth_mod, "_resolve_allowed_email", lambda: "owner@example.com")
    req = _req_with_local_token("ephemeral-secret")
    result = await verify_cf_access(req)  # type: ignore[arg-type]
    assert result is None
    assert req.state.user_email == "owner@example.com"


@pytest.mark.asyncio
async def test_local_token_match_fallback_sentinel_when_no_allowlist(monkeypatch):
    """token 匹配但 allowed email 解析不出 → 回落 same-machine sentinel (仍放行)。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "ephemeral-secret")
    monkeypatch.setattr(auth_mod, "_resolve_allowed_email", lambda: "")
    req = _req_with_local_token("ephemeral-secret")
    await verify_cf_access(req)  # type: ignore[arg-type]
    assert req.state.user_email == "local@127.0.0.1"


@pytest.mark.asyncio
async def test_local_token_mismatch_falls_through_to_401(monkeypatch):
    """token 配了但 header 不匹配 + 无 CF JWT → 回落 CF 腿 → 401 (fail-closed)。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "ephemeral-secret")
    with pytest.raises(HTTPException) as ei:
        await verify_cf_access(_req_with_local_token("wrong-token"))  # type: ignore[arg-type]
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_local_token_unconfigured_ignores_header_401(monkeypatch):
    """未配 token (_LOCAL_API_TOKEN 空) → 本地腿停用, 带 header 也回落 CF → 401。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "")
    with pytest.raises(HTTPException) as ei:
        await verify_cf_access(_req_with_local_token("anything"))  # type: ignore[arg-type]
    assert ei.value.status_code == 401


def test_local_token_via_testclient_passes(client, monkeypatch):
    """端到端: bypass off + 配 token, 带正确 header 打受保护读端点 → 200 (走 dependency 全栈)。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "ephemeral-secret")
    monkeypatch.setattr(auth_mod, "_resolve_allowed_email", lambda: "owner@example.com")
    r = client.get("/api/email/list", headers={auth_mod.LOCAL_TOKEN_HEADER: "ephemeral-secret"})
    assert r.status_code == 200
    assert r.json()["status"] == "success"


def test_local_token_wrong_via_testclient_401(client, monkeypatch):
    """端到端: bypass off + 配 token, 带错误 header → 401 (无 CF JWT 回落)。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "ephemeral-secret")
    r = client.get("/api/email/list", headers={auth_mod.LOCAL_TOKEN_HEADER: "nope"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


# ---------------------------------------------------------------------------
# C2 — relaxed import guard: ≥1 auth method required (CF_AUDIENCE OR local token)
# ---------------------------------------------------------------------------


def test_import_guard_allows_local_token_only(monkeypatch):
    """CF_AUDIENCE 空但配了 MAILAGENT_LOCAL_API_TOKEN → 不再 RuntimeError (本地-only 合法)。"""
    import importlib

    monkeypatch.delenv("MAILAGENT_API_AUTH_DISABLED", raising=False)
    monkeypatch.delenv("CF_AUDIENCE", raising=False)
    monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "ephemeral-secret")
    try:
        importlib.reload(auth_mod)  # must NOT raise
        assert auth_mod._LOCAL_API_TOKEN == "ephemeral-secret"
        assert auth_mod.AUTH_DISABLED is False
    finally:
        # 还原 conftest 一致的干净模块 (bypass on + dev), 不污染后续用例。
        monkeypatch.setenv("MAILAGENT_API_AUTH_DISABLED", "true")
        monkeypatch.setenv("MAILAGENT_API_DEV", "true")
        monkeypatch.delenv("MAILAGENT_LOCAL_API_TOKEN", raising=False)
        importlib.reload(auth_mod)


def test_import_guard_raises_without_any_auth_method(monkeypatch):
    """三种鉴权方式 (CF_AUDIENCE / 本地 token / bypass) 全无 → 启动即 RuntimeError (fail-closed)。"""
    import importlib

    monkeypatch.delenv("MAILAGENT_API_AUTH_DISABLED", raising=False)
    monkeypatch.delenv("CF_AUDIENCE", raising=False)
    monkeypatch.delenv("MAILAGENT_LOCAL_API_TOKEN", raising=False)
    try:
        with pytest.raises(RuntimeError, match="No auth method"):
            importlib.reload(auth_mod)
    finally:
        monkeypatch.setenv("MAILAGENT_API_AUTH_DISABLED", "true")
        monkeypatch.setenv("MAILAGENT_API_DEV", "true")
        importlib.reload(auth_mod)


# ---------------------------------------------------------------------------
# Loopback bind assertion (REMOTE-ACCESS §6.5)
# ---------------------------------------------------------------------------


def _get_startup_assert():
    """Locate the bind-loopback startup coroutine on the app."""
    import src.api.app as app_mod

    fn = getattr(app_mod, "_assert_bind_loopback", None)
    assert fn is not None, "bind-loopback startup assertion must exist"
    return fn


def test_loopback_assertion_exists():
    _get_startup_assert()


def test_loopback_assertion_rejects_public_bind(monkeypatch):
    """MAILAGENT_API_HOST=0.0.0.0 must trip the guard.

    C3: the guard now raises RuntimeError (not AssertionError) so it survives
    `python -O`, which strips `assert` statements entirely.
    """
    fn = _get_startup_assert()
    monkeypatch.setenv("MAILAGENT_API_HOST", "0.0.0.0")
    with pytest.raises(RuntimeError):
        asyncio.run(fn())


def test_loopback_guard_is_not_an_assert_in_source():
    """C3 static guard: the bind check must NOT be implemented with `assert`.

    The asyncio-level test above proves the *type* is RuntimeError, but a future
    refactor could re-introduce an `assert host in (...)` that still happens to
    raise AssertionError in CI yet vanishes under `python -O`. Pin the source
    contract directly: `_assert_bind_loopback` raises explicitly, never asserts.
    """
    import inspect

    import src.api.app as app_mod

    src = inspect.getsource(app_mod._assert_bind_loopback)
    assert "raise RuntimeError" in src, "guard must raise explicitly"
    # No bare `assert` statement in the guard body (would be stripped by -O).
    # Match the statement form (`assert ` / `assert(`), not the word in a comment.
    import ast

    tree = ast.parse(inspect.getsource(app_mod._assert_bind_loopback))
    assert not any(
        isinstance(node, ast.Assert) for node in ast.walk(tree)
    ), "guard body must contain no `assert` statement (python -O strips it)"


def test_loopback_guard_survives_python_O_subprocess():
    """C3 (decisive): run the guard under `python -O` and confirm it STILL fires.

    `-O` strips every `assert` statement at compile time, so if the guard ever
    regressed to `assert host in (...)`, an optimized production interpreter
    would silently skip the check and a 0.0.0.0 bind would sail through. We fork
    a real `python -O`, point it at MAILAGENT_API_HOST=0.0.0.0, call the guard,
    and require a non-zero exit from the RuntimeError. This is the only test that
    actually exercises the optimized-bytecode path the C3 fix exists for.
    """
    import subprocess
    import sys
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[2]
    snippet = (
        "import asyncio, sys\n"
        "from src.api.app import _assert_bind_loopback\n"
        "try:\n"
        "    asyncio.run(_assert_bind_loopback())\n"
        "except RuntimeError:\n"
        "    sys.exit(7)\n"      # guard fired → the contract we want
        "sys.exit(0)\n"          # guard did NOT fire → assert was stripped (BAD)
    )
    env = {
        **os.environ,
        "MAILAGENT_API_HOST": "0.0.0.0",
        # auth.py import-time guards: declare a dev context + bypass so the bare
        # subprocess imports cleanly without a real .env / CF_AUDIENCE.
        "MAILAGENT_API_AUTH_DISABLED": "true",
        "MAILAGENT_API_DEV": "true",
        "PYTHONPATH": str(repo_root),
    }
    proc = subprocess.run(
        [sys.executable, "-O", "-c", snippet],
        cwd=str(repo_root),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    # exit 7 == guard raised RuntimeError under -O; exit 0 == it was stripped.
    assert proc.returncode == 7, (
        "loopback guard did not fire under `python -O` — it was likely "
        f"reverted to an `assert` (stripped by -O).\nstdout={proc.stdout!r}\n"
        f"stderr={proc.stderr!r}"
    )


def test_loopback_assertion_unset_host_fail_closed(monkeypatch):
    """A4: unset MAILAGENT_API_HOST is fail-closed (raise), not defaulted to allow.

    The only legit launch (`mailagent serve-api`) always exports the var before
    uvicorn.run; an unset var means a bare/unguarded uvicorn start that nobody
    hard-bound to loopback, so the guard treats it as untrusted.
    """
    fn = _get_startup_assert()
    monkeypatch.delenv("MAILAGENT_API_HOST", raising=False)
    with pytest.raises(RuntimeError):
        asyncio.run(fn())


def test_loopback_assertion_accepts_127(monkeypatch):
    fn = _get_startup_assert()
    monkeypatch.setenv("MAILAGENT_API_HOST", "127.0.0.1")
    asyncio.run(fn())  # no raise


def test_loopback_assertion_accepts_localhost(monkeypatch):
    fn = _get_startup_assert()
    monkeypatch.setenv("MAILAGENT_API_HOST", "localhost")
    asyncio.run(fn())  # no raise


def test_serve_api_command_hardbinds_loopback():
    """The serve-api CLI command must hard-bind 127.0.0.1 (not take a host arg).

    Read the CLI source by path rather than importing src.cli.main: that module
    constructs the pydantic Config() at import time, which requires a real .env
    (NOTION_TOKEN etc.) the bare test worktree intentionally lacks. The bind
    guarantee is a static property of the source, so a text assertion is enough.
    """
    from pathlib import Path

    cli_main = (
        Path(__file__).resolve().parents[2] / "src" / "cli" / "main.py"
    )
    text = cli_main.read_text(encoding="utf-8")
    # The serve_api command body hard-codes the loopback host.
    assert 'host = "127.0.0.1"' in text
