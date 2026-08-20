"""跨语言闸 —— Matter「跟进规则」写侧 `schedule_json` 的形状。

病根（0812 dogfood，「跟进规则保存必定失败」）：TS 写侧类型与 pydantic 写侧模型各写各的、
中间没有裁判。前端 builder 返回 ``JSON.stringify(envelope)``（字符串），而
``MatterPatchWithScheduleRequest.schedule_json`` 是 ``dict[str, Any] | None`` —— FastAPI 在请求
校验层 422，把整条 PATCH（含 agent_enabled / profile / instructions）一起打掉。

两侧读同一个 fixture ``tests/fixtures/matter_trigger_envelope.json``：

- vitest ``frontend/tests/components/matters/matterTriggerEnvelopeParity.test.ts``
  断言前端 builder 的产出逐键等于 fixture 里的 envelope；
- 本文件把**同一个 envelope 原样**喂进 pydantic 模型、``normalize_trigger_json``，
  以及真实的 PATCH 路由（owner 那条复现路径本身）。

🔴 fixture 读不到 / 形状不对 = 直接失败，不许静默跳过。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.agents.schedule_rule import parse_anchor, parse_rule
from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.routers.matters import MatterPatchWithScheduleRequest, get_matter_service
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService
from src.matters.triggers import normalize_trigger_json, parse_agent_overrides

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "matter_trigger_envelope.json"


@pytest.fixture(scope="module")
def fixture_doc() -> dict:
    assert FIXTURE_PATH.exists(), (
        f"跨语言 fixture 缺失: {FIXTURE_PATH} —— 它是前端 builder 与 pydantic 写侧模型之间唯一的裁判"
    )
    doc = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert isinstance(doc.get("envelope"), dict), "fixture 的 envelope 必须是对象"
    assert doc["envelope"].get("triggers"), "fixture 的 envelope 必须带至少一条 trigger"
    assert doc["envelope"].get("agent"), "fixture 的 envelope 必须带模型覆盖块（0813 轮 3 #10）"
    return doc


@pytest.fixture
def client(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    settings = SimpleNamespace(sync_store_db_path=str(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: MatterService(MatterRepository(path))
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _mutation(key: str, version: int | None = None) -> dict:
    payload = {"source": "desktop_ui", "idempotency_key": key}
    if version is not None:
        payload["expected_version"] = version
    return payload


def _patch_body(schedule_json) -> dict:
    return {"schedule_json": schedule_json, "mutation": _mutation("parity-fixture")}


def test_envelope_passes_request_validation(fixture_doc):
    """fixture 的 envelope 原样进 PATCH 请求模型 —— 这是前端真正发出去的那个值。"""
    body = MatterPatchWithScheduleRequest(**_patch_body(fixture_doc["envelope"]))
    assert isinstance(body.schedule_json, dict)
    assert body.schedule_json == fixture_doc["envelope"]


def test_stringified_envelope_is_rejected(fixture_doc):
    """把同一个 envelope 序列化成字符串 ⇒ 必须被拒。

    这条是本闸的**变异探针**：前端 builder 一旦改回返回 `JSON.stringify(...)`，发出去的就是
    这个值，而它在校验层就死了 —— 说明"字符串不是合法写侧形状"这件事是被断言过的，不是巧合。
    """
    with pytest.raises(ValueError):
        MatterPatchWithScheduleRequest(**_patch_body(json.dumps(fixture_doc["envelope"])))


def test_envelope_survives_normalization(fixture_doc):
    """service 侧归一化能吃下它，且 trigger 与 actions 一条不丢。"""
    envelope = fixture_doc["envelope"]
    normalized = normalize_trigger_json(envelope)
    assert normalized is not None
    assert len(normalized["triggers"]) == len(envelope["triggers"])
    assert normalized["triggers"][0]["id"] == envelope["triggers"][0]["id"]
    assert normalized["triggers"][0]["kind"] == envelope["triggers"][0]["kind"]
    # fixture 的 actions 刻意选成非出厂默认，所以它必须原样保留（默认值才不写这个键）。
    assert normalized["actions"] == envelope["actions"]
    # 0813 轮 3 #10 —— 模型覆盖三项同样必须原样活过归一化（丢了就是"保存了但不生效"）。
    assert normalized["agent"] == envelope["agent"]
    assert parse_agent_overrides(normalized) == envelope["agent"]


def test_schedule_entry_passes_the_evaluator(fixture_doc):
    """schedule 分支的深校验（service `_binding_changes` 逐字同款）。"""
    for entry in fixture_doc["envelope"]["triggers"]:
        if entry.get("kind") != "schedule":
            continue
        parse_rule(entry.get("rule"))
        parse_anchor(entry.get("anchor"))
        timezone_name = entry.get("timezone")
        assert isinstance(timezone_name, str) and timezone_name.strip()
        ZoneInfo(timezone_name)


def test_patch_route_accepts_the_envelope(client, fixture_doc):
    """owner 那条复现路径本身：详情页 → 跟进规则 → 推荐排程 → 保存。

    模态是一条 PATCH 同时写四个字段，所以断言的不只是「排程存下了」，还有
    「agent_enabled / instructions 没被 422 顺带打掉」—— 那正是原 bug 的杀伤面。
    """
    http = client
    created = http.post(
        "/api/matters",
        json={"title": "Trigger envelope", "mutation": _mutation("create")},
    )
    assert created.status_code == 201
    matter = created.json()["data"]["matter"]

    patched = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={
            "agent_enabled": True,
            "matter_instructions": "只盯 Acme 的回复",
            "schedule_json": fixture_doc["envelope"],
            "mutation": _mutation("patch-schedule", matter["version"]),
        },
    )
    assert patched.status_code == 200, patched.text

    detail = http.get(f"/api/matters/{matter['public_id']}")
    assert detail.status_code == 200
    row = detail.json()["data"]["matter"]
    assert row["agent_enabled"] in (1, True)
    assert row["matter_instructions"] == "只盯 Acme 的回复"
    # 🔴 读侧是**字符串**（DB 列），写侧是对象 —— 两者不是一个东西，这条断言把差别钉住。
    assert isinstance(row["schedule_json"], str)
    stored = json.loads(row["schedule_json"])
    assert stored["triggers"][0]["id"] == fixture_doc["envelope"]["triggers"][0]["id"]
    assert stored["actions"] == fixture_doc["envelope"]["actions"]


def test_patch_route_rejects_a_stringified_envelope(client, fixture_doc):
    """同一条路由收到字符串 ⇒ 422（owner 实际遇到的那个响应）。"""
    http = client
    created = http.post(
        "/api/matters",
        json={"title": "Trigger envelope reject", "mutation": _mutation("create-reject")},
    )
    matter = created.json()["data"]["matter"]
    rejected = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={
            "agent_enabled": True,
            "schedule_json": json.dumps(fixture_doc["envelope"]),
            "mutation": _mutation("patch-string", matter["version"]),
        },
    )
    assert rejected.status_code == 422
