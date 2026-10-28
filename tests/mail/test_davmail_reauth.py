"""DavMail 认证失效自助重连核心（``src/mail/davmail_reauth.py``）。

守住四件事：
  1. 回调解析：用户可能贴 oob URL / nativeclient URL / 只贴 code / 带首尾空白，都要取对；
     其它输入给出能照着做的提示。
  2. token 文件格式与 DavMail 字节级一致。golden 样本在 ``davmail_golden/``，由真实 DavMail
     6.7.0 jar 生成（``bash tests/mail/davmail_golden/regen.sh``，只用假字符串）。脚本同时让
     DavMail 自己的 ``Settings.loadRefreshToken`` + ``StringEncryptor`` 读回 Python 写出的
     token 文件，2026-10-28 生成时打印 OK。由于 IV 固定为盐，加密是确定性的：Python 密文与
     Java 密文逐字节相等，就等于 Java 能解开 Python 的输出。
  3. 写入前备份；验证失败恢复备份，文件回到原字节。
  4. 授权码与 token 原文不进日志、不进结果文案。
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from loguru import logger

from src.mail import davmail_reauth as mod
from src.mail.davmail_reauth import (
    OAuthSettings,
    ReauthError,
    _split_line,
    build_authorize_url,
    decrypt_token,
    encrypt_token,
    load_oauth_settings,
    parse_callback,
    read_token_value,
    restore_token_file,
    write_token_file,
)
from src.mail.davmail_watchdog import AUTH_LAST_INTERACTIVE_AT_KEY

GOLDEN_DIR = Path(__file__).parent / "davmail_golden"
FAKE_CODE = "0.AXEAfakeAuthCodeForTests_abcdefghijklmnopqrstuvwxyz-0123456789"
FAKE_REFRESH = "0.AXEAfakeRefreshTokenForTests.zyxwvutsrqponmlkjihgfedcba~9876543210"
CIPHER = "unit-test-cipher-key"
USER = "Owner@Example.com"


def _golden() -> dict[str, str]:
    lines = (GOLDEN_DIR / "golden.properties").read_text("latin-1").splitlines()
    return dict(p for p in map(_split_line, lines) if p)


def _settings(tmp_path: Path, **overrides) -> OAuthSettings:
    base = dict(
        client_id="client-123",
        tenant_id="common",
        redirect_uri="urn:ietf:wg:oauth:2.0:oob",
        token_file=tmp_path / "token" / "token.dat",
        fingerprint="davmailgateway!&",
        username=USER,
        password=CIPHER,
    )
    base.update(overrides)
    return OAuthSettings(**base)


# ── 回调解析 ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    [
        f"urn:ietf:wg:oauth:2.0:oob?code={FAKE_CODE}",
        f"urn:ietf:wg:oauth:2.0:oob?code={FAKE_CODE}&session_state=abc-123",
        f"https://login.microsoftonline.com/common/oauth2/nativeclient?code={FAKE_CODE}&session_state=x",
        FAKE_CODE,
        f"  \n{FAKE_CODE}\t\n",
        f"\n https://login.microsoftonline.com/common/oauth2/nativeclient?code={FAKE_CODE} \n",
    ],
)
def test_parse_callback_accepts_supported_formats(text):
    assert parse_callback(text) == FAKE_CODE


def test_parse_callback_decodes_percent_encoding():
    assert parse_callback("urn:ietf:wg:oauth:2.0:oob?code=abc%2Bdef%3D&x=1") == "abc+def="


@pytest.mark.parametrize(
    "text,code",
    [
        ("", "E_EMPTY"),
        ("   \n ", "E_EMPTY"),
        ("https://login.microsoftonline.com/common/oauth2/nativeclient", "E_NO_CODE"),
        ("urn:ietf:wg:oauth:2.0:oob?session_state=abc", "E_NO_CODE"),
        ("hello world", "E_INVALID"),
        ("short", "E_INVALID"),
        (
            "https://login.microsoftonline.com/common/oauth2/nativeclient?error=invalid_grant"
            "&error_description=AADSTS70008%3a+expired",
            "AADSTS70008",
        ),
        ("urn:ietf:wg:oauth:2.0:oob?error=access_denied", "E_LOGIN_ERROR"),
    ],
)
def test_parse_callback_rejects_invalid_input(text, code):
    with pytest.raises(ReauthError) as exc:
        parse_callback(text)
    assert exc.value.stage == "parse"
    assert exc.value.code == code
    assert exc.value.message


# ── golden：与 DavMail 字节级一致 ──────────────────────────────────────────────


def test_golden_python_decrypts_java_ciphertext():
    g = _golden()
    assert decrypt_token(g["default.short"], g["password"]) == g["plain.short"]
    assert decrypt_token(g["default.long"], g["password"]) == g["plain.long"]
    assert decrypt_token(g["custom.long"], g["password"], g["custom_fingerprint"]) == g["plain.long"]


def test_golden_python_ciphertext_equals_java():
    g = _golden()
    assert encrypt_token(g["plain.short"], g["password"]) == g["default.short"]
    assert encrypt_token(g["plain.long"], g["password"]) == g["default.long"]
    assert encrypt_token(g["plain.long"], g["password"], g["custom_fingerprint"]) == g["custom.long"]


def test_golden_reads_token_file_written_by_davmail():
    g = _golden()
    stored = read_token_value(GOLDEN_DIR / "token.dat", g["username"])
    assert stored is not None
    assert decrypt_token(stored, g["password"]) == g["plain.long"]


def test_golden_written_file_matches_davmail_line(tmp_path):
    """Python 写出的账号行与 DavMail 写出的那一行逐字节相同（含小写 key 与 `\\=` 转义）。"""
    g = _golden()
    target = tmp_path / "token.dat"
    write_token_file(target, g["username"], encrypt_token(g["plain.long"], g["password"]))
    java_line = [
        ln for ln in (GOLDEN_DIR / "token.dat").read_text("latin-1").splitlines() if not ln.startswith("#")
    ]
    py_line = [ln for ln in target.read_text("latin-1").splitlines() if not ln.startswith("#")]
    assert py_line == java_line
    assert "\\=" in py_line[0]


def test_decrypt_with_wrong_password_or_salt_fails():
    g = _golden()
    with pytest.raises(ValueError):
        decrypt_token(g["default.long"], "wrong-password")
    with pytest.raises(ValueError):
        decrypt_token(g["default.long"], g["password"], "wrong-salt-12345")


# ── Properties 读写 + 备份 ─────────────────────────────────────────────────────


def test_split_line_unescapes_key_and_value():
    assert _split_line(r"a\:b\=c=x\=y\:z\\w") == ("a:b=c", "x=y:z\\w")
    assert _split_line("  key : value") == ("key", "value")
    assert _split_line("# comment") is None
    assert _split_line("! comment") is None
    assert _split_line("") is None


def test_write_token_file_replaces_account_and_keeps_others(tmp_path):
    target = tmp_path / "token.dat"
    original = (
        "#Oauth tokens\n#Wed Oct 28 14:54:56 CST 2026\n"
        "other@example.com={AES}OTHER\\=\n"
        "owner@example.com={AES}OLD\\=\n"
    ).encode("latin-1")
    target.write_bytes(original)
    encrypted = encrypt_token(FAKE_REFRESH, CIPHER)

    backup = write_token_file(target, USER, encrypted)

    assert backup is not None and backup.name.startswith("token.dat.pre-reauth-")
    assert backup.read_bytes() == original
    text = target.read_text("latin-1")
    assert text.startswith("#Oauth tokens\n#Wed Oct 28")
    assert "other@example.com={AES}OTHER\\=\n" in text
    assert "OLD" not in text
    assert text.count("owner@example.com=") == 1
    assert decrypt_token(read_token_value(target, USER), CIPHER) == FAKE_REFRESH


def test_write_token_file_creates_new_file_without_backup(tmp_path):
    target = tmp_path / "nested" / "token.dat"
    backup = write_token_file(target, USER, encrypt_token(FAKE_REFRESH, CIPHER))
    assert backup is None
    assert target.read_text("latin-1").startswith("#Oauth tokens\n")
    assert decrypt_token(read_token_value(target, USER), CIPHER) == FAKE_REFRESH
    assert oct(target.stat().st_mode & 0o777) == "0o600"


def test_restore_token_file(tmp_path):
    target = tmp_path / "token.dat"
    target.write_bytes(b"#Oauth tokens\nowner@example.com={AES}OLD\n")
    original = target.read_bytes()
    backup = write_token_file(target, USER, encrypt_token(FAKE_REFRESH, CIPHER))
    restore_token_file(target, backup)
    assert target.read_bytes() == original

    fresh = tmp_path / "fresh.dat"
    write_token_file(fresh, USER, encrypt_token(FAKE_REFRESH, CIPHER))
    restore_token_file(fresh, None)
    assert not fresh.exists()


# ── 配置 + 授权链接 ───────────────────────────────────────────────────────────


def _davmail_root(tmp_path: Path, props: str) -> Path:
    root = tmp_path / "davmail-poc"
    (root / "config").mkdir(parents=True)
    (root / "config" / "davmail.properties").write_text(props, encoding="latin-1")
    return root


def _cfg(root: Path, **overrides):
    base = dict(
        davmail_root=str(root),
        user_email=USER,
        davmail_cipher_key=CIPHER,
        davmail_poc_mode=False,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_load_oauth_settings_reads_properties_and_defaults(tmp_path):
    root = _davmail_root(
        tmp_path,
        "davmail.mode=O365Manual\n"
        "davmail.oauth.clientId=client-abc\n"
        "davmail.oauth.tokenFilePath=/tmp/x\\:y/token.dat\n",
    )
    s = load_oauth_settings(_cfg(root))
    assert s.client_id == "client-abc"
    assert s.tenant_id == "common"
    assert s.redirect_uri == "urn:ietf:wg:oauth:2.0:oob"
    assert s.token_file == Path("/tmp/x:y/token.dat")
    assert s.fingerprint == "davmailgateway!&"
    assert (s.username, s.password) == (USER, CIPHER)
    assert CIPHER not in repr(s)


def test_load_oauth_settings_falls_back_to_poc_key(tmp_path):
    root = _davmail_root(tmp_path, "davmail.mode=O365Manual\ndavmail.oauth.tokenFilePath=/t\n")
    s = load_oauth_settings(_cfg(root, davmail_cipher_key="", davmail_poc_mode=True))
    assert s.password == "mailagent-poc-shared-key"


@pytest.mark.parametrize(
    "props,code",
    [
        ("davmail.mode=O365Graph\ndavmail.authentication=O365Manual\ndavmail.oauth.tokenFilePath=/t\n",
         "E_GRAPH_UNSUPPORTED"),
        ("davmail.mode=O365Manual\ndavmail.enableGraph=true\ndavmail.oauth.tokenFilePath=/t\n",
         "E_GRAPH_UNSUPPORTED"),
        ("davmail.mode=O365Manual\ndavmail.enableOidc=true\ndavmail.oauth.tokenFilePath=/t\n",
         "E_GRAPH_UNSUPPORTED"),
        ("davmail.mode=EWS\ndavmail.oauth.tokenFilePath=/t\n", "E_MODE_UNSUPPORTED"),
        ("davmail.mode=O365Manual\n", "E_TOKEN_PATH_MISSING"),
    ],
)
def test_load_oauth_settings_rejects_unsupported_config(tmp_path, props, code):
    root = _davmail_root(tmp_path, props)
    with pytest.raises(ReauthError) as exc:
        load_oauth_settings(_cfg(root))
    assert exc.value.code == code


def test_load_oauth_settings_missing_properties_or_cipher(tmp_path):
    with pytest.raises(ReauthError) as exc:
        load_oauth_settings(_cfg(tmp_path / "nope"))
    assert exc.value.code == "E_PROPERTIES_MISSING"

    root = _davmail_root(tmp_path, "davmail.mode=O365Manual\ndavmail.oauth.tokenFilePath=/t\n")
    with pytest.raises(ReauthError) as exc:
        load_oauth_settings(_cfg(root, davmail_cipher_key=""))
    assert exc.value.code == "E_CIPHER_KEY_MISSING"


def test_build_authorize_url(tmp_path):
    url = build_authorize_url(_settings(tmp_path, tenant_id="tenant-x"))
    parsed = urlparse(url)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == (
        "https://login.microsoftonline.com/tenant-x/oauth2/authorize"
    )
    assert {k: v[0] for k, v in parse_qs(parsed.query).items()} == {
        "client_id": "client-123",
        "response_type": "code",
        "redirect_uri": "urn:ietf:wg:oauth:2.0:oob",
        "response_mode": "query",
        "login_hint": USER,
        "resource": "https://outlook.office365.com",
    }


# ── 换 token ────────────────────────────────────────────────────────────────


def _id_token(account: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"upn": account}).encode()).rstrip(b"=").decode()
    return f"eyJhbGciOiJub25lIn0.{payload}.sig"


def _transport(status: int, body, seen: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler)


async def test_exchange_code_success_posts_expected_form(tmp_path):
    seen: list[httpx.Request] = []
    body = {"access_token": "AT", "refresh_token": FAKE_REFRESH, "id_token": _id_token(USER.lower())}
    token = await mod.exchange_code(_settings(tmp_path), FAKE_CODE, transport=_transport(200, body, seen))
    assert token == FAKE_REFRESH
    req = seen[0]
    assert str(req.url) == "https://login.microsoftonline.com/common/oauth2/token"
    form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
    assert form == {
        "grant_type": "authorization_code",
        "code": FAKE_CODE,
        "redirect_uri": "urn:ietf:wg:oauth:2.0:oob",
        "client_id": "client-123",
    }


@pytest.mark.parametrize(
    "body,code,fragment",
    [
        ({"error": "invalid_grant", "error_codes": [70008],
          "error_description": "AADSTS70008: The provided authorization code or refresh token has expired"},
         "AADSTS70008", "过期"),
        ({"error": "invalid_grant", "error_description": "AADSTS54005: OAuth2 Authorization code was already redeemed"},
         "AADSTS54005", "用过"),
        ({"error": "invalid_grant", "error_codes": [123456]}, "AADSTS123456", "AADSTS123456"),
        ({}, "HTTP_400", "重新获取链接"),
    ],
)
async def test_exchange_code_maps_aadsts_errors(tmp_path, body, code, fragment):
    with pytest.raises(ReauthError) as exc:
        await mod.exchange_code(_settings(tmp_path), FAKE_CODE, transport=_transport(400, body))
    assert exc.value.stage == "exchange"
    assert exc.value.code == code
    assert fragment in exc.value.message


async def test_exchange_code_network_error(tmp_path):
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(ReauthError) as exc:
        await mod.exchange_code(_settings(tmp_path), FAKE_CODE, transport=httpx.MockTransport(handler))
    assert (exc.value.stage, exc.value.code) == ("exchange", "E_NETWORK")


async def test_exchange_code_rejects_wrong_account_and_missing_refresh(tmp_path):
    body = {"refresh_token": FAKE_REFRESH, "id_token": _id_token("someone.else@example.com")}
    with pytest.raises(ReauthError) as exc:
        await mod.exchange_code(_settings(tmp_path), FAKE_CODE, transport=_transport(200, body))
    assert exc.value.code == "E_ACCOUNT_MISMATCH"
    assert "someone.else@example.com" in exc.value.message

    with pytest.raises(ReauthError) as exc:
        await mod.exchange_code(_settings(tmp_path), FAKE_CODE, transport=_transport(200, {"access_token": "AT"}))
    assert exc.value.code == "E_NO_REFRESH_TOKEN"


# ── 编排 ────────────────────────────────────────────────────────────────────


class _Store:
    def __init__(self):
        self.state: dict[str, str] = {}

    def set_state(self, key, value):
        self.state[key] = value


@pytest.fixture()
def log_lines():
    lines: list[str] = []
    sink_id = logger.add(lambda m: lines.append(str(m)), level="DEBUG")
    yield lines
    logger.remove(sink_id)


async def _no_sleep(_secs):
    return None


def _orig_token_file(settings: OAuthSettings) -> bytes:
    settings.token_file.parent.mkdir(parents=True, exist_ok=True)
    data = b"#Oauth tokens\nowner@example.com={AES}OLD\\=\n"
    settings.token_file.write_bytes(data)
    return data


async def test_complete_success_writes_token_and_records_time(tmp_path, log_lines):
    settings = _settings(tmp_path)
    _orig_token_file(settings)
    store = _Store()
    restarts: list[int] = []

    async def exchange(s, code):
        assert code == FAKE_CODE
        return FAKE_REFRESH

    async def restart():
        restarts.append(1)
        return True, "exit 0"

    result = await mod.complete_reauth(
        SimpleNamespace(), settings, f" urn:ietf:wg:oauth:2.0:oob?code={FAKE_CODE}\n",
        sync_store=store, exchange=exchange, verify=lambda cfg: True, restart=restart, sleep=_no_sleep,
    )

    assert (result.ok, result.stage) == (True, "done")
    assert restarts == []
    assert decrypt_token(read_token_value(settings.token_file, USER), CIPHER) == FAKE_REFRESH
    assert int(store.state["davmail.auth.last_interactive_at"]) > 1_700_000_000
    assert len(list(settings.token_file.parent.glob("token.dat.pre-reauth-*"))) == 1
    joined = "\n".join(log_lines)
    assert FAKE_CODE not in joined and FAKE_REFRESH not in joined
    assert FAKE_CODE not in result.message and FAKE_REFRESH not in result.message


async def test_complete_verify_fails_restarts_then_restores_backup(tmp_path, log_lines):
    settings = _settings(tmp_path)
    original = _orig_token_file(settings)
    store = _Store()
    restarts: list[int] = []
    verify_calls: list[int] = []

    async def exchange(s, code):
        return FAKE_REFRESH

    async def restart():
        restarts.append(1)
        return True, "exit 0"

    def verify(cfg):
        verify_calls.append(1)
        return False

    result = await mod.complete_reauth(
        SimpleNamespace(), settings, FAKE_CODE,
        sync_store=store, exchange=exchange, verify=verify, restart=restart, sleep=_no_sleep,
    )

    assert (result.ok, result.stage, result.code) == (False, "verify", "E_VERIFY_FAILED")
    assert "恢复" in result.message
    assert restarts == [1]
    assert len(verify_calls) == 1 + mod._POST_RESTART_ATTEMPTS
    assert settings.token_file.read_bytes() == original
    assert AUTH_LAST_INTERACTIVE_AT_KEY not in store.state
    joined = "\n".join(log_lines)
    assert FAKE_CODE not in joined and FAKE_REFRESH not in joined


_OLD_STAMPS = [
    "20250101-000000",
    "20250102-000000",
    "20250103-000000",
    "20250104-0930",  # 命令行流程手工备份用的是 %H%M，也算本流程的备份
    "20250105-000000",
    "20250106-000000",
    "20250107-000000",
]


def _seed_backups(settings: OAuthSettings) -> list[Path]:
    """7 份 pre-reauth 备份 + 3 份不该碰的文件。"""
    d = settings.token_file.parent
    for stamp in _OLD_STAMPS:
        (d / f"token.dat.pre-reauth-{stamp}").write_bytes(b"old")
    untouched = [
        d / "token.dat.bak-20250101-000000",
        d / "token.dat.new-auth-20250101-0000",
        d / "other.dat.pre-reauth-20240101-000000",
    ]
    for p in untouched:
        p.write_bytes(b"keep")
    return untouched


def _pre_reauth_names(settings: OAuthSettings) -> list[str]:
    return sorted(p.name for p in settings.token_file.parent.glob("token.dat.pre-reauth-*"))


async def test_complete_success_keeps_latest_five_backups(tmp_path):
    settings = _settings(tmp_path)
    _orig_token_file(settings)
    untouched = _seed_backups(settings)

    async def exchange(s, code):
        return FAKE_REFRESH

    result = await mod.complete_reauth(
        SimpleNamespace(), settings, FAKE_CODE,
        sync_store=_Store(), exchange=exchange, verify=lambda cfg: True, sleep=_no_sleep,
    )

    assert result.ok
    names = _pre_reauth_names(settings)
    assert len(names) == 5
    # 本次新备份（当前时间戳）+ 旧的里最新的 4 份
    assert names[:4] == [f"token.dat.pre-reauth-{s}" for s in _OLD_STAMPS[3:]]
    assert names[4] > f"token.dat.pre-reauth-{_OLD_STAMPS[-1]}"
    assert all(p.read_bytes() == b"keep" for p in untouched)


async def test_complete_failure_does_not_prune_backups(tmp_path):
    settings = _settings(tmp_path)
    _orig_token_file(settings)
    untouched = _seed_backups(settings)

    async def exchange(s, code):
        return FAKE_REFRESH

    async def restart():
        return False, "pm2 not found"

    result = await mod.complete_reauth(
        SimpleNamespace(), settings, FAKE_CODE,
        sync_store=_Store(), exchange=exchange, verify=lambda cfg: False, restart=restart,
        sleep=_no_sleep,
    )

    assert not result.ok
    assert len(_pre_reauth_names(settings)) == len(_OLD_STAMPS) + 1
    assert all(p.exists() for p in untouched)


def test_prune_backups_failure_only_warns(tmp_path, monkeypatch, log_lines):
    settings = _settings(tmp_path)
    _orig_token_file(settings)
    _seed_backups(settings)

    def boom(self, *a, **kw):
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "unlink", boom)
    mod.prune_backups(settings.token_file)
    assert len(_pre_reauth_names(settings)) == len(_OLD_STAMPS)
    assert sum("prune backup failed" in ln for ln in log_lines) == 2


async def test_complete_recovers_after_restart(tmp_path):
    settings = _settings(tmp_path)
    _orig_token_file(settings)
    store = _Store()
    answers = iter([False, False, True])

    async def exchange(s, code):
        return FAKE_REFRESH

    async def restart():
        return True, "exit 0"

    result = await mod.complete_reauth(
        SimpleNamespace(), settings, FAKE_CODE,
        sync_store=store, exchange=exchange, verify=lambda cfg: next(answers), restart=restart,
        sleep=_no_sleep,
    )
    assert result.ok
    assert decrypt_token(read_token_value(settings.token_file, USER), CIPHER) == FAKE_REFRESH
    assert AUTH_LAST_INTERACTIVE_AT_KEY in store.state


async def test_complete_restart_unavailable_restores(tmp_path):
    settings = _settings(tmp_path)
    original = _orig_token_file(settings)

    async def exchange(s, code):
        return FAKE_REFRESH

    async def restart():
        return False, "pm2 not found"

    result = await mod.complete_reauth(
        SimpleNamespace(), settings, FAKE_CODE,
        sync_store=_Store(), exchange=exchange, verify=lambda cfg: False, restart=restart,
        sleep=_no_sleep,
    )
    assert (result.ok, result.stage) == (False, "verify")
    assert settings.token_file.read_bytes() == original


async def test_complete_exchange_failure_leaves_token_file_untouched(tmp_path, log_lines):
    settings = _settings(tmp_path)
    original = _orig_token_file(settings)

    async def exchange(s, code):
        raise ReauthError("exchange", "AADSTS70008", mod.describe_aadsts("70008"))

    result = await mod.complete_reauth(
        SimpleNamespace(), settings, FAKE_CODE,
        sync_store=_Store(), exchange=exchange, verify=lambda cfg: True, sleep=_no_sleep,
    )
    assert (result.ok, result.stage, result.code) == (False, "exchange", "AADSTS70008")
    assert settings.token_file.read_bytes() == original
    assert list(settings.token_file.parent.glob("token.dat.pre-reauth-*")) == []
    assert any("code=AADSTS70008" in ln for ln in log_lines)


async def test_complete_parse_failure(tmp_path):
    settings = _settings(tmp_path)

    async def exchange(s, code):  # pragma: no cover - 不该被调到
        raise AssertionError("exchange must not run")

    result = await mod.complete_reauth(
        SimpleNamespace(), settings, "https://login.microsoftonline.com/common/oauth2/nativeclient",
        sync_store=_Store(), exchange=exchange, sleep=_no_sleep,
    )
    assert (result.ok, result.stage, result.code) == (False, "parse", "E_NO_CODE")
