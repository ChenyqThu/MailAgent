"""Wave 6 Chrome Profile 发现、AES-128-CBC / Chrome 130+ Cookie 解密与导入单测。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.hashes import SHA1
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.padding import PKCS7

from src.connectors import chrome_import, local_installer


def _encrypt_chrome_v10(secret: bytes, plaintext: bytes) -> bytes:
    key = PBKDF2HMAC(
        algorithm=SHA1(),
        length=16,
        salt=chrome_import._PBKDF2_SALT,
        iterations=chrome_import._PBKDF2_ITERATIONS,
    ).derive(secret)
    padder = PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(chrome_import._AES_IV)).encryptor()
    return b"v10" + encryptor.update(padded) + encryptor.finalize()


def _create_fake_cookies_db(
    db_path: Path,
    *,
    db_version: int,
    secret: bytes,
    rows: list[tuple[str, str, bytes, str, int, int, int, int]],
) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute("INSERT INTO meta (key, value) VALUES ('version', ?)", (str(db_version),))
    conn.execute(
        """
        CREATE TABLE cookies (
            host_key TEXT NOT NULL,
            name TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT '',
            encrypted_value BLOB NOT NULL,
            path TEXT NOT NULL,
            expires_utc INTEGER NOT NULL,
            is_secure INTEGER NOT NULL,
            is_httponly INTEGER NOT NULL,
            samesite INTEGER NOT NULL,
            has_expires INTEGER NOT NULL DEFAULT 1
        )
        """
    )
    conn.executemany(
        "INSERT INTO cookies (host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    conn.close()


def test_list_chrome_profiles_reads_local_state_and_filters_dirs(tmp_path):
    chrome_root = tmp_path / "Chrome"
    (chrome_root / "Default" / "Network").mkdir(parents=True)
    (chrome_root / "Default" / "Network" / "Cookies").write_bytes(b"db")
    (chrome_root / "Profile 2").mkdir(parents=True)
    (chrome_root / "Profile 2" / "Cookies").write_bytes(b"db")
    (chrome_root / "System Profile").mkdir(parents=True)  # should be ignored
    (chrome_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "info_cache": {
                        "Default": {"name": "Personal", "user_name": "me@example.com"},
                        "Profile 2": {"name": "Work", "user_name": "work@corp.com"},
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    profiles = chrome_import.list_chrome_profiles(chrome_root)
    assert profiles == [
        {
            "profile_id": "Default",
            "name": "Personal",
            "user_name": "me@example.com",
            "has_cookies": True,
        },
        {
            "profile_id": "Profile 2",
            "name": "Work",
            "user_name": "work@corp.com",
            "has_cookies": True,
        },
    ]


def test_decrypt_chrome_cookies_handles_v20_v24_filters_and_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    secret = b"test-chrome-safe-storage-secret"
    future_chrome_ts = int((9999999999.0 + chrome_import._CHROMIUM_EPOCH_OFFSET_SEC) * 1_000_000)
    past_chrome_ts = int((1000000000.0 + chrome_import._CHROMIUM_EPOCH_OFFSET_SEC) * 1_000_000)

    # Chrome 130+ (db_version=24): SHA256(host_key) 32-byte prefix prepended inside ciphertext
    host_a = "dms.company.com"
    prefix_a = hashlib.sha256(host_a.encode("utf-8")).digest()
    enc_v24 = _encrypt_chrome_v10(secret, prefix_a + b"sid=abc123")

    # Non-secure cookie with samesite=0 (None in Chromium) -> downgraded to Lax
    host_sub = ".sub.dms.company.com"
    prefix_sub = hashlib.sha256(host_sub.encode("utf-8")).digest()
    enc_sub = _encrypt_chrome_v10(secret, prefix_sub + b"prefs=dark")

    # __Host- cookie -> url field instead of domain
    enc_host_prefix = _encrypt_chrome_v10(secret, prefix_a + b"strict_tok")

    # Expired cookie & unrelated domain
    host_other = "other.org"
    prefix_other = hashlib.sha256(host_other.encode("utf-8")).digest()
    enc_other = _encrypt_chrome_v10(secret, prefix_other + b"x=1")

    db_v24 = tmp_path / "Chrome" / "Default" / "Network" / "Cookies"
    _create_fake_cookies_db(
        db_v24,
        db_version=24,
        secret=secret,
        rows=[
            (host_a, "SID", enc_v24, "/", future_chrome_ts, 1, 1, 1),
            (host_sub, "PREF", enc_sub, "/app", future_chrome_ts, 0, 0, 0),
            (host_a, "__Host-token", enc_host_prefix, "/", future_chrome_ts, 1, 1, 1),
            (host_a, "EXPIRED", enc_v24, "/", past_chrome_ts, 1, 1, 1),
            (host_other, "OTHER", enc_other, "/", future_chrome_ts, 1, 1, 1),
        ],
    )

    out = chrome_import.decrypt_chrome_cookies_from_db(
        db_v24,
        secret,
        domain_filters=["dms.company.com"],
    )
    by_name = {c["name"]: c for c in out}
    assert set(by_name) == {"SID", "PREF", "__Host-token"}
    assert by_name["SID"]["value"] == "sid=abc123"
    assert by_name["SID"]["domain"] == "dms.company.com"
    assert by_name["SID"]["sameSite"] == "Lax"
    assert by_name["PREF"]["value"] == "prefs=dark"
    assert "sameSite" not in by_name["PREF"]  # non-secure cannot use SameSite=None
    assert by_name["__Host-token"] == {
        "name": "__Host-token",
        "value": "strict_tok",
        "url": "https://dms.company.com/",
        "httpOnly": True,
        "secure": True,
        "sameSite": "Lax",
        "expires": int(by_name["__Host-token"]["expires"]),
    }

    # Verify Chromium < 130 (db_version=20) without 32-byte digest prefix, and session cookie persistence
    db_v20 = tmp_path / "Chrome" / "Profile 1" / "Cookies"
    _create_fake_cookies_db(
        db_v20,
        db_version=20,
        secret=secret,
        rows=[
            ("oa.internal", "SESSION", _encrypt_chrome_v10(secret, b"legacy-val"), "/", 0, 0, 1, 2),
            ("oa.internal", "V11_TOK", b"v11" + _encrypt_chrome_v10(secret, b"v11-val")[3:], "/", 0, 1, 1, 1),
        ],
    )
    now_fixed = 1_700_000_000.0
    out_v20 = chrome_import.decrypt_chrome_cookies_from_db(db_v20, secret, now_epoch=now_fixed)
    assert len(out_v20) == 2
    by_v20 = {c["name"]: c for c in out_v20}
    assert by_v20["SESSION"]["value"] == "legacy-val"
    assert by_v20["SESSION"]["sameSite"] == "Strict"
    assert by_v20["SESSION"]["expires"] == now_fixed + chrome_import._SESSION_COOKIE_PERSIST_SECONDS
    assert by_v20["V11_TOK"]["value"] == "v11-val"

    # Temp Staging directory must be completely wiped in finally
    rt_base = tmp_path / "runtimes"
    if rt_base.exists():
        assert [p.name for p in rt_base.iterdir() if p.name.startswith(".tmp-")] == []


def test_inject_cookies_uses_cold_cdp_when_managed_browser_stopped(tmp_path, monkeypatch):
    from src.connectors import managed_browser as mb_mod

    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    rt_dir = tmp_path / "runtimes" / "browser_use"
    cli_path = rt_dir / "pkg" / "cli.js"
    cli_path.parent.mkdir(parents=True, exist_ok=True)
    cli_path.write_text("console.log('ok')\n", encoding="utf-8")
    (rt_dir / "manifest.json").write_text(
        json.dumps({"connector_id": "browser_use", "entrypoint": "pkg/cli.js"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(mb_mod.managed_browser, "is_running", lambda: False)

    calls: list[tuple[list[dict], Path]] = []

    def _fake_cold_sync(cookies, *, profile_dir=None):
        calls.append((cookies, profile_dir))
        return {"imported": len(cookies), "skipped": 0}

    monkeypatch.setattr(mb_mod.managed_browser, "inject_cookies_cold_sync", _fake_cold_sync)
    res = chrome_import.inject_cookies_into_managed_profile(
        [{"name": "sid", "value": "abc", "domain": "dms.company.com", "path": "/"}],
        runtime_dir=rt_dir,
    )
    assert res == {"imported": 1, "skipped": 0}
    assert len(calls) == 1
    assert calls[0][1] == rt_dir / "profile"


def test_import_chrome_cookies_end_to_end_mocked(tmp_path, monkeypatch):
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    rt_dir = tmp_path / "runtimes" / "browser_use"
    cli_path = rt_dir / "pkg" / "node_modules" / "@playwright" / "mcp" / "cli.js"
    cli_path.parent.mkdir(parents=True, exist_ok=True)
    cli_path.write_text("console.log('ok')\n", encoding="utf-8")
    (rt_dir / "manifest.json").write_text(
        json.dumps({"connector_id": "browser_use", "entrypoint": "pkg/node_modules/@playwright/mcp/cli.js"}),
        encoding="utf-8",
    )

    secret = b"keychain-secret"
    chrome_root = tmp_path / "Chrome"
    cookie_db = chrome_root / "Default" / "Network" / "Cookies"
    _create_fake_cookies_db(
        cookie_db,
        db_version=20,
        secret=secret,
        rows=[("dms.corp.com", "auth", _encrypt_chrome_v10(secret, b"tok123"), "/", 0, 1, 1, 1)],
    )

    injected_calls: list[tuple[list[dict], Path]] = []

    def _fake_injector(cookies, target_dir):
        injected_calls.append((cookies, target_dir))
        return {"imported": len(cookies), "skipped": 0}

    res = chrome_import.import_chrome_cookies(
        "Default",
        chrome_root=chrome_root,
        keychain_reader=lambda: secret,
        cookie_injector=_fake_injector,
    )
    assert res == {"ok": True, "profile_id": "Default", "matched": 1, "imported": 1, "skipped": 0}
    assert len(injected_calls) == 1
    assert injected_calls[0][1] == rt_dir.resolve()
    assert injected_calls[0][0][0]["value"] == "tok123"


def test_decrypt_chrome_cookies_permission_error_raises_actionable_403(tmp_path, monkeypatch):
    import errno
    import pytest

    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    db = tmp_path / "Chrome" / "Default" / "Cookies"
    _create_fake_cookies_db(db, db_version=20, secret=b"s", rows=[])

    def _raise_eperm(src, dst, *args, **kwargs):
        raise PermissionError(errno.EPERM, "Operation not permitted", str(src))

    monkeypatch.setattr(chrome_import.shutil, "copyfile", _raise_eperm)

    with pytest.raises(local_installer.LocalInstallerError) as exc_info:
        chrome_import.decrypt_chrome_cookies_from_db(db, b"s")

    assert exc_info.value.code == "E_CHROME_PERMISSION_DENIED"
    assert exc_info.value.status_code == 403
    rt_base = tmp_path / "runtimes"
    if rt_base.exists():
        assert [p.name for p in rt_base.iterdir() if p.name.startswith(".tmp-")] == []


def test_list_chrome_cookie_domains_excludes_expired_flags_sensitive_and_skips_keychain(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")

    def _boom_keychain():
        raise AssertionError("Keychain must not be accessed for domain preview")

    monkeypatch.setattr(chrome_import, "read_macos_chrome_safe_storage_key", _boom_keychain)

    future_chrome_ts = int((9999999999.0 + chrome_import._CHROMIUM_EPOCH_OFFSET_SEC) * 1_000_000)
    past_chrome_ts = int((1000000000.0 + chrome_import._CHROMIUM_EPOCH_OFFSET_SEC) * 1_000_000)

    db = tmp_path / "Chrome" / "Default" / "Network" / "Cookies"
    _create_fake_cookies_db(
        db,
        db_version=24,
        secret=b"unused",
        rows=[
            (".github.com", "a", b"enc", "/", future_chrome_ts, 1, 1, 1),
            ("github.com", "b", b"enc", "/", future_chrome_ts, 1, 1, 1),
            ("github.com", "expired", b"enc", "/", past_chrome_ts, 1, 1, 1),
            (".bankofamerica.com", "s", b"enc", "/", 0, 1, 1, 1),
            ("oa.internal", "sess", b"enc", "/", 0, 0, 1, 2),
        ],
    )

    res = chrome_import.list_chrome_cookie_domains("Default", chrome_root=tmp_path / "Chrome")
    assert res["profile_id"] == "Default"
    assert res["total_cookies"] == 4
    assert res["domains"] == [
        {"domain": "github.com", "count": 2, "sensitive": False},
        {"domain": "bankofamerica.com", "count": 1, "sensitive": True},
        {"domain": "oa.internal", "count": 1, "sensitive": False},
    ]
    # Zero secret/value fields anywhere in response
    for entry in res["domains"]:
        assert set(entry.keys()) == {"domain", "count", "sensitive"}

    rt_base = tmp_path / "runtimes"
    if rt_base.exists():
        assert [p.name for p in rt_base.iterdir() if p.name.startswith(".tmp-")] == []


def test_list_and_clear_managed_cookie_domains_offline(tmp_path, monkeypatch):
    from src.connectors import managed_browser as mb_mod

    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    monkeypatch.setattr(mb_mod.managed_browser, "is_running", lambda: False)

    profile_dir = tmp_path / "runtimes" / "browser_use" / "profile"
    db = profile_dir / "Default" / "Cookies"
    future_chrome_ts = int((9999999999.0 + chrome_import._CHROMIUM_EPOCH_OFFSET_SEC) * 1_000_000)
    _create_fake_cookies_db(
        db,
        db_version=24,
        secret=b"unused",
        rows=[
            (".oa.internal", "s1", b"enc", "/", future_chrome_ts, 1, 1, 1),
            ("sub.oa.internal", "s2", b"enc", "/", future_chrome_ts, 1, 1, 1),
            ("notion.so", "n1", b"enc", "/", future_chrome_ts, 1, 1, 1),
        ],
    )

    listed = chrome_import.list_managed_cookie_domains(profile_dir=profile_dir)
    assert listed == {
        "domains": [
            {"domain": "notion.so", "count": 1},
            {"domain": "oa.internal", "count": 1},
            {"domain": "sub.oa.internal", "count": 1},
        ],
        "total_cookies": 3,
    }

    cleared_oa = chrome_import.clear_managed_cookies("oa.internal", profile_dir=profile_dir)
    assert cleared_oa == {"cleared": 2, "domain": "oa.internal"}
    assert chrome_import.list_managed_cookie_domains(profile_dir=profile_dir) == {
        "domains": [{"domain": "notion.so", "count": 1}],
        "total_cookies": 1,
    }

    cleared_all = chrome_import.clear_managed_cookies(None, profile_dir=profile_dir)
    assert cleared_all == {"cleared": 1, "domain": None}
    assert chrome_import.list_managed_cookie_domains(profile_dir=profile_dir) == {
        "domains": [],
        "total_cookies": 0,
    }
