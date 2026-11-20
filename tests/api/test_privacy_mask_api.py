"""Phase 5 WP-5A — 出站隐私占位符脱敏 API 与 Python direct-SDK vault 测试。

覆盖：
  1. GET/PUT /api/llm/providers/privacy-config（默认配置、规则落库、snapshot 投影门控）；
  2. verify_local_token 写面鉴权（PUT /privacy-config、POST/DELETE /privacy-hits：
     AUTH_DISABLED=False 下 CF JWT 与无 token 均 403，LOCAL_HEADERS 200）；
  3. 嵌套量词 ReDoS / 空匹配 / 非法 tag -> 400 E_INVALID_ARG；
  4. POST/DELETE /privacy-hits 仅存储类别计数、SQLite 零明文落盘；
  5. PythonMaskVault 双向脱敏/还原（SECRET、ISO 7064 身份证、Luhn 银行卡、手机、邮箱、
     自定义规则、去重、既有占位符幂等、PrivacyMaskError Fail-Closed）。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

import src.agent_config.enabled_models as enabled_models_mod
import src.api.auth as auth_mod
from src.agent_config import secrets
from src.agent_config.llm_providers import (
    DEFAULT_PROVIDER_ID,
    get_llm_provider_store,
    reset_llm_provider_store_cache,
)
from src.api.app import app
from src.llm_agent.privacy_mask import PrivacyMaskError, PythonMaskVault

SEED_KEY = "seed-key-abcd1234"
LOCAL_TOK = "ephemeral-secret-phase5-privacy"
CF_HEADERS = {"Cf-Access-Jwt-Assertion": "header.payload.sig"}
LOCAL_HEADERS = {auth_mod.LOCAL_TOKEN_HEADER: LOCAL_TOK}


def _force_keyfile(monkeypatch: pytest.MonkeyPatch) -> None:
    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)


@pytest.fixture(autouse=True)
def _fresh_provider_store(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    _force_keyfile(monkeypatch)
    secrets.reset_master_key_cache()
    reset_llm_provider_store_cache()
    monkeypatch.setattr(
        enabled_models_mod,
        "_resolve_seed_inputs",
        lambda: {
            "api_base": "https://crs.example.com/api",
            "api_key": SEED_KEY,
            "model": "claude-sonnet-4-6",
            "enabled_models": ["claude-sonnet-4-6"],
        },
    )
    yield tmp_path
    secrets.reset_master_key_cache()
    reset_llm_provider_store_cache()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _arm_cf_jwt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key())
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})


def test_privacy_config_defaults_and_persistence(client: TestClient) -> None:
    r = client.get("/api/llm/providers/privacy-config")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["config"] == {
        "builtIn": {
            "secret": True,
            "id_card": True,
            "phone": True,
            "email": True,
            "bank_card": True,
        },
        "customRules": [],
    }
    assert data["hits"] == {"total": 0, "byCategory": []}

    payload = {
        "builtIn": {
            "secret": True,
            "id_card": True,
            "phone": False,
            "email": True,
            "bank_card": True,
        },
        "customRules": [
            {
                "id": "emp-badge",
                "name": "Employee Badge",
                "pattern": r"EMP-\d{5}",
                "tag": "emp_id",
                "enabled": True,
            }
        ],
    }
    put_resp = client.put("/api/llm/providers/privacy-config", json=payload)
    assert put_resp.status_code == 200, put_resp.text
    saved = put_resp.json()["data"]["config"]
    assert saved["builtIn"]["phone"] is False
    assert saved["customRules"][0]["tag"] == "EMP_ID"

    # Snapshot omits privacyMask while no provider enables privacyMaskEnabled.
    snap_off = client.get("/api/llm/providers/snapshot").json()["data"]
    assert "privacyMask" not in snap_off

    # Enabling privacyMaskEnabled on a provider includes privacyMask in snapshot.
    patch_resp = client.patch(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}",
        json={"privacyMaskEnabled": True},
    )
    assert patch_resp.status_code == 200, patch_resp.text
    snap_on = client.get("/api/llm/providers/snapshot").json()["data"]
    assert snap_on["privacyMask"] == saved
    default_entry = next(p for p in snap_on["providers"] if p["id"] == DEFAULT_PROVIDER_ID)
    assert default_entry["privacyMaskEnabled"] is True


def test_privacy_config_rejects_redos_empty_and_invalid_tag(client: TestClient) -> None:
    bad_redos = {
        "builtIn": {"secret": True},
        "customRules": [
            {
                "id": "bad1",
                "name": "ReDoS",
                "pattern": r"(a+)+b",
                "tag": "BAD",
                "enabled": True,
            }
        ],
    }
    r1 = client.put("/api/llm/providers/privacy-config", json=bad_redos)
    assert r1.status_code == 400
    assert r1.json()["error"]["code"] == "E_INVALID_ARG"

    bad_empty = {
        "customRules": [
            {
                "id": "bad2",
                "name": "Empty",
                "pattern": r"a*",
                "tag": "EMPTY",
                "enabled": True,
            }
        ]
    }
    r2 = client.put("/api/llm/providers/privacy-config", json=bad_empty)
    assert r2.status_code == 400
    assert r2.json()["error"]["code"] == "E_INVALID_ARG"

    bad_tag = {
        "customRules": [
            {
                "id": "bad3",
                "name": "Tag",
                "pattern": r"TOK-\d+",
                "tag": "9INVALID",
                "enabled": True,
            }
        ]
    }
    r3 = client.put("/api/llm/providers/privacy-config", json=bad_tag)
    assert r3.status_code == 400
    assert r3.json()["error"]["code"] == "E_INVALID_ARG"


def test_privacy_hits_category_only_no_plaintext_and_clear(
    client: TestClient, _fresh_provider_store
) -> None:
    tmp_path = _fresh_provider_store
    r1 = client.post(
        "/api/llm/providers/privacy-hits",
        json={"counts": {"email": 2, "secret": 1, "zero_ignored": 0}},
    )
    assert r1.status_code == 200, r1.text
    r2 = client.post(
        "/api/llm/providers/privacy-hits",
        json={"counts": {"email": 3}},
    )
    assert r2.status_code == 200, r2.text
    hits = r2.json()["data"]["hits"]
    assert hits["total"] == 6
    by_cat = {row["category"]: row["count"] for row in hits["byCategory"]}
    assert by_cat == {"EMAIL": 5, "SECRET": 1}

    # Verify DB schema only holds category / hit_count / updated_at (zero plaintext).
    db_path = tmp_path / "agent_config.db"
    conn = sqlite3.connect(str(db_path))
    cols = [row[1] for row in conn.execute("PRAGMA table_info(privacy_mask_hits)").fetchall()]
    rows = conn.execute("SELECT category, hit_count FROM privacy_mask_hits").fetchall()
    conn.close()
    assert cols == ["category", "hit_count", "updated_at"]
    assert dict(rows) == {"EMAIL": 5, "SECRET": 1}

    cleared = client.delete("/api/llm/providers/privacy-hits")
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["data"]["cleared"] == 2
    assert client.get("/api/llm/providers/privacy-config").json()["data"]["hits"]["total"] == 0


def test_privacy_endpoints_enforce_local_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.get("/api/llm/providers")
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)

    # Read remains accessible to authenticated CF owner session.
    assert client.get("/api/llm/providers/privacy-config", headers=CF_HEADERS).status_code == 200

    # Write endpoints reject both CF JWT and unauthenticated calls with 403.
    for headers in (CF_HEADERS, {}):
        assert (
            client.put(
                "/api/llm/providers/privacy-config",
                json={"builtIn": {"secret": True}},
                headers=headers,
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/llm/providers/privacy-hits",
                json={"counts": {"email": 1}},
                headers=headers,
            ).status_code
            == 403
        )
        assert client.delete("/api/llm/providers/privacy-hits", headers=headers).status_code == 403

    # Local ephemeral token succeeds on all three write endpoints.
    assert (
        client.put(
            "/api/llm/providers/privacy-config",
            json={"builtIn": {"secret": True, "email": True}},
            headers=LOCAL_HEADERS,
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/llm/providers/privacy-hits",
            json={"counts": {"email": 1}},
            headers=LOCAL_HEADERS,
        ).status_code
        == 200
    )
    assert (
        client.delete("/api/llm/providers/privacy-hits", headers=LOCAL_HEADERS).status_code
        == 200
    )


def test_python_mask_vault_bidirectional_roundtrip_and_fail_closed() -> None:
    vault = PythonMaskVault(
        {
            "builtIn": {
                "secret": True,
                "id_card": True,
                "phone": True,
                "email": True,
                "bank_card": True,
            },
            "customRules": [
                {
                    "id": "emp",
                    "name": "Employee",
                    "pattern": r"EMP-\d{5}",
                    "tag": "EMP_ID",
                    "enabled": True,
                }
            ],
        }
    )

    secret_val = "sk-ant-1234567890abcdefghij"
    valid_id = "11010519491231002X"
    invalid_id = "110105194912310029"
    valid_card = "4532015112830366"
    invalid_card = "4532015112830367"
    phone_val = "+86 13812345678"
    email_val = "alice@example.com"
    emp_val = "EMP-00421"

    outbound = (
        f"key={secret_val} key2={secret_val} id={valid_id} badid={invalid_id} "
        f"card={valid_card} badcard={invalid_card} tel={phone_val} mail={email_val} "
        f"badge={emp_val} keep=[[PII_EMAIL_99]]"
    )
    masked = vault.mask_string(outbound)

    for raw in (secret_val, valid_id, valid_card, phone_val, email_val, emp_val):
        assert raw not in masked
    assert invalid_id in masked
    assert invalid_card in masked
    assert "[[PII_EMAIL_99]]" in masked
    # Same secret value reuses the same placeholder index.
    assert masked.count("[[PII_SECRET_1]]") == 2

    blocks = vault.mask_system_blocks([{"type": "text", "text": f"Notify {email_val}"}])
    assert email_val not in blocks[0]["text"]
    assert "[[PII_EMAIL_1]]" in blocks[0]["text"]

    # Model reply quoting placeholders unmasks back to original values across nested structures.
    unmasked_str = vault.unmask_string(f"Sent to [[PII_EMAIL_1]] with badge [[PII_EMP_ID_1]].")
    assert unmasked_str == f"Sent to {email_val} with badge {emp_val}."
    nested = vault.unmask_value({"id": "[[PII_ID_CARD_1]]", "items": ["[[PII_BANK_CARD_1]]", "[[PII_PHONE_1]]"]})
    assert nested == {"id": valid_id, "items": [valid_card, phone_val]}

    assert vault.hits["secret"] == 2
    assert vault.hits["email"] == 2
    assert vault.hits["id_card"] == 1
    assert vault.hits["bank_card"] == 1
    assert vault.hits["phone"] == 1
    assert vault.hits["custom:emp"] == 1

    # Fail-closed errors raise PrivacyMaskError with E_PRIVACY_MASK_FAILED.
    for bad_pattern in (r"(a+)+b", r"[unclosed", r"a*"):
        with pytest.raises(PrivacyMaskError) as exc_info:
            PythonMaskVault(
                {
                    "builtIn": {"secret": False},
                    "customRules": [
                        {"id": "bad", "name": "Bad", "pattern": bad_pattern, "tag": "BAD", "enabled": True}
                    ],
                }
            )
        assert exc_info.value.code == "E_PRIVACY_MASK_FAILED"

    # Non-plaintext check against store helper too.
    assert json.dumps(vault.hits)
