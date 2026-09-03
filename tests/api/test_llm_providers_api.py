"""serve-api LLM provider 配置面测试（task 07-12 P0）— /api/llm/providers*。

覆盖：
  1. 惰性 seed（首个读端点触发）+ 列表 key 掩码（hasKey/keyLast4，明文不出 wire）
  2. provider CRUD（坏 protocol 400 / default 禁删 400 / 缺行 404 / key 轮换掩码）
  3. /snapshot 鉴权 = verify_local_token（CF JWT 恒 403，本地 token 200）
  4. /snapshot §4.3b 形状 + 解密 key + CRUD 后 version 递增 + 纯读不 bump
  5. POST /{id}/models/refresh 上游 merge（fetched 不覆盖 manual/enabled）+ 失败可读
     error + 鉴权 = verify_local_token；GET /{id}/models 纯 SQLite 读零外呼、旧
     ?refresh=true 入参被忽略（批2 HIGH-2 拆分）；元数据解析按 protocol 分流
     （anthropic display_name / openrouter context+capabilities / 其余空）且只填 NULL 列
  6. /{id}/test 连通性探测（_probe_provider MockTransport 单元 + 端点转发）
  7. /chat/config enabledModels：flag off 字节级现状（表有行也不读）/ flag on 聚合投影
  8. P3 写面鉴权收紧：provider POST/PATCH/DELETE + model PUT/DELETE + /models/refresh +
     /test 全 = verify_local_token（合法 CF JWT 恒 403 → 远程 Settings 只读）；GET 保持
     cf_access
  9. P3 model 行写端点：PUT merge 语义（未传键保留现行值）/ 手动添加默认 enabled /
     DELETE 缺行 404；批2 MEDIUM-6 严格校验（enabled 严格 bool / capabilities 三键 bool /
     maxOutput 1..2M / 未知顶层字段 400）
 10. /chat/config providerRegistryEnabled 投影（UI 门控字段，off=false / on=true）
 11. 批2 HIGH-1：CRUD 投影只回 headerNames（header 值 write-only 不出 wire）；PATCH
     省略/全量替换/{} 清空三语义；snapshot 仍含全值
 12. 批2 HIGH-2：两个外呼点（/models/refresh + /test）的 base_url 最小策略——仅
     http/https、拒 userinfo；坏 base 零外呼；有意不封私网（本地 ollama 合法）
 13. 终审 MEDIUM-4：provider create/PATCH 严格 schema（对齐 model upsert）——未知顶层
     字段 400 / enabled 严格 bool / displayName·baseUrl·apiKey 严格 string / protocol
     枚举 / sortOrder 0..10000 / headers 平坦 string→string；PATCH 省略=不改语义保持

隔离：每用例独立 agent_config.db（env 覆盖 + 单例 reset）+ keyfile master key（绝不弹真
钥匙串，镜像 tests/agent_config/test_secrets.py）+ stub ``_resolve_seed_inputs``（seed 不
读真 .env）。
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterator, List, Optional, Tuple

import httpx
import pytest
from fastapi.testclient import TestClient

import src.agent_config.enabled_models as enabled_models_mod
import src.api.auth as auth_mod
import src.api.routers.llm_providers as lp_router
from src.agent_config import secrets
from src.agent_config.llm_providers import (
    DEFAULT_PROVIDER_ID,
    get_llm_provider_store,
    reset_llm_provider_store_cache,
)
from src.api.app import app

SEED_KEY = "seed-key-abcd1234"
LOCAL_TOK = "ephemeral-secret-p0-llmprov"
CF_HEADERS = {"Cf-Access-Jwt-Assertion": "header.payload.sig"}
LOCAL_HEADERS = {auth_mod.LOCAL_TOKEN_HEADER: LOCAL_TOK}

# `_fetch_provider_models` 的返回形状：(model_id, meta)，meta 键 = llm_model 列名子集。
_Fetched = List[Tuple[str, Dict[str, Any]]]


def _force_keyfile(monkeypatch):
    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)


@pytest.fixture(autouse=True)
def _fresh_provider_store(monkeypatch, tmp_path):
    """每用例：干净 agent_config.db + tmp keyfile master key + 受控 seed 输入。"""
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    _force_keyfile(monkeypatch)
    secrets.reset_master_key_cache()
    reset_llm_provider_store_cache()
    # seed 本体 08-04 起住在 src/agent_config/enabled_models.py（飞书 IM 桥要用同一份
    # seed，而它 import 不起 router 模块）——stub 目标随之搬家。
    monkeypatch.setattr(
        enabled_models_mod,
        "_resolve_seed_inputs",
        lambda: {
            "api_base": "https://crs.example.com/api",
            "api_key": SEED_KEY,
            "model": "claude-sonnet-4-6",
            "enabled_models": ["claude-sonnet-4-6", "gpt-5.5"],
        },
    )
    yield
    secrets.reset_master_key_cache()
    reset_llm_provider_store_cache()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _arm_cf_jwt(monkeypatch):
    """装配「合法 CF Access JWT」环境（镜像 test_exec_auth）——用来证明 /snapshot 即便面对
    有效 CF 会话也拒绝（挂的是 verify_local_token，根本不看 CF JWT）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key())
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})


# ── 1. 惰性 seed + 掩码 ───────────────────────────────────────────────────────────────


def test_list_lazily_seeds_default_and_masks_key(client: TestClient):
    r = client.get("/api/llm/providers")
    assert r.status_code == 200
    data = r.json()["data"]
    (prov,) = data["providers"]
    assert prov["id"] == DEFAULT_PROVIDER_ID
    assert prov["protocol"] == "anthropic"
    assert prov["baseUrl"] == "https://crs.example.com/api"
    assert prov["hasKey"] is True
    assert prov["keyLast4"] == "1234"
    assert prov["isDefault"] is True
    # 明文 key 不出 CRUD wire（掩码纪律）；header 投影 = 名字列表（HIGH-1，seed 无头 → []）
    assert SEED_KEY not in r.text
    assert prov["headerNames"] == []
    assert "headers" not in prov
    # seed 幂等：再读不重复
    r2 = client.get("/api/llm/providers")
    assert len(r2.json()["data"]["providers"]) == 1


# ── 2. provider CRUD ─────────────────────────────────────────────────────────────────


def test_provider_crud_roundtrip(client: TestClient):
    r = client.post(
        "/api/llm/providers",
        json={
            "id": "dashscope",
            "protocol": "openai-compatible",
            "displayName": "Qwen",
            "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "apiKey": "sk-dash-secret-5678",
        },
    )
    assert r.status_code == 200
    created = r.json()["data"]
    assert created["hasKey"] is True and created["keyLast4"] == "5678"
    assert "sk-dash-secret-5678" not in r.text

    r = client.patch(
        "/api/llm/providers/dashscope",
        json={"displayName": "Qwen (corp)", "apiKey": "sk-rotated-0042", "enabled": False},
    )
    assert r.status_code == 200
    patched = r.json()["data"]
    assert patched["displayName"] == "Qwen (corp)"
    assert patched["keyLast4"] == "0042"
    assert patched["enabled"] is False
    assert "sk-rotated-0042" not in r.text

    r = client.delete("/api/llm/providers/dashscope")
    assert r.status_code == 200
    ids = [p["id"] for p in client.get("/api/llm/providers").json()["data"]["providers"]]
    assert "dashscope" not in ids


def test_provider_crud_error_paths(client: TestClient):
    # 坏 protocol → 400
    r = client.post("/api/llm/providers", json={"id": "x", "protocol": "grpc"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    # 缺必填 → 400
    r = client.post("/api/llm/providers", json={"protocol": "openai"})
    assert r.status_code == 400
    # default 禁删 → 400
    client.get("/api/llm/providers")  # 触发 seed
    r = client.delete(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}")
    assert r.status_code == 400
    # 缺行 → 404
    assert client.delete("/api/llm/providers/nope").status_code == 404
    assert client.patch("/api/llm/providers/nope", json={"enabled": True}).status_code == 404


# ── MEDIUM-4（终审）. provider create/PATCH 严格 schema ─────────────────────────────────


def test_provider_create_strict_validation(client: TestClient):
    """终审 MEDIUM-4：create 对齐 model upsert 的严格 schema——未知顶层字段 400（拼错
    字段名不再被静默忽略）；enabled 严格 bool（``"false"`` 曾被 bool() 转成 True 写成
    相反状态）；字符串字段拒对象/数字（曾被 str() 字符串化入库）；protocol 枚举；
    sortOrder 0..10000（bool 显式拒）；headers 平坦 string→string。"""

    def _post(payload):
        return client.post(
            "/api/llm/providers", json={"id": "strict1", "protocol": "openai", **payload}
        )

    # 未知顶层字段（如 camelCase 拼错成 baseURL）
    r = _post({"baseURL": "https://x.example"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "E_INVALID_ARG"
    # enabled 隐式转换
    assert _post({"enabled": "false"}).status_code == 400
    assert _post({"enabled": 1}).status_code == 400
    # 字符串字段严格（含 null——清空传 ''）
    assert _post({"displayName": {"nested": True}}).status_code == 400
    assert _post({"displayName": None}).status_code == 400
    assert _post({"baseUrl": 42}).status_code == 400
    assert _post({"apiKey": 123}).status_code == 400
    # protocol 枚举（endpoint 层，非法值不触达 store）
    assert (
        client.post("/api/llm/providers", json={"id": "strict1", "protocol": "grpc"}).status_code
        == 400
    )
    # sortOrder：字符串 / 负数 / 超界 / bool
    assert _post({"sortOrder": "5"}).status_code == 400
    assert _post({"sortOrder": -1}).status_code == 400
    assert _post({"sortOrder": 10_001}).status_code == 400
    assert _post({"sortOrder": True}).status_code == 400
    # headers：非 dict / 嵌套 / 非 string 值
    assert _post({"headers": ["X-A"]}).status_code == 400
    assert _post({"headers": {"X-A": {"nested": "v"}}}).status_code == 400
    assert _post({"headers": {"X-A": 1}}).status_code == 400
    # 以上全被拒 → 行未落库
    ids = [p["id"] for p in client.get("/api/llm/providers").json()["data"]["providers"]]
    assert "strict1" not in ids
    # 合法边界值通过：sortOrder 0/10000、apiKey null = 无 key、enabled 严格 bool
    r = _post({"sortOrder": 0, "apiKey": None, "enabled": False})
    assert r.status_code == 200
    created = r.json()["data"]
    assert created["enabled"] is False and created["sortOrder"] == 0
    assert created["hasKey"] is False
    r = client.post(
        "/api/llm/providers", json={"id": "strict2", "protocol": "openai", "sortOrder": 10_000}
    )
    assert r.status_code == 200 and r.json()["data"]["sortOrder"] == 10_000


def test_provider_patch_strict_validation(client: TestClient):
    """终审 MEDIUM-4：PATCH 同套严格 schema（对象值曾在 SQLite 绑定阶段炸成未捕获 500）；
    语义保持——省略 = 不改、apiKey null = 清除、protocol 合法枚举仍可改（onboarding
    PATCH upsert 路径带 protocol）。"""
    client.get("/api/llm/providers")  # seed
    r = client.post(
        "/api/llm/providers",
        json={
            "id": "p1",
            "protocol": "openai-compatible",
            "displayName": "P1",
            "baseUrl": "https://p1.example/v1",
            "apiKey": "sk-p1-secret-7777",
            "sortOrder": 3,
        },
    )
    assert r.status_code == 200

    url = "/api/llm/providers/p1"
    # 未知字段（snake_case 拼法）/ 隐式转换 / 对象值 / null 字符串字段 → 全 400
    assert client.patch(url, json={"display_name": "snake"}).status_code == 400
    assert client.patch(url, json={"enabled": 1}).status_code == 400
    assert client.patch(url, json={"displayName": {"x": 1}}).status_code == 400
    assert client.patch(url, json={"baseUrl": None}).status_code == 400
    assert client.patch(url, json={"sortOrder": "5"}).status_code == 400
    assert client.patch(url, json={"sortOrder": 10_001}).status_code == 400
    assert client.patch(url, json={"headers": {"X-A": 1}}).status_code == 400
    assert client.patch(url, json={"protocol": "grpc"}).status_code == 400
    # 以上全被拒 → 行原样
    row = next(
        p for p in client.get("/api/llm/providers").json()["data"]["providers"] if p["id"] == "p1"
    )
    assert row["displayName"] == "P1" and row["sortOrder"] == 3 and row["enabled"] is True
    assert row["keyLast4"] == "7777"
    # 省略 = 不改：只动 enabled，其余字段保持
    patched = client.patch(url, json={"enabled": False}).json()["data"]
    assert patched["enabled"] is False
    assert patched["displayName"] == "P1" and patched["sortOrder"] == 3
    assert patched["keyLast4"] == "7777"
    # apiKey null = 清除（前端契约 string|null）
    r = client.patch(url, json={"apiKey": None})
    assert r.status_code == 200 and r.json()["data"]["hasKey"] is False
    # protocol 合法枚举可改
    assert client.patch(url, json={"protocol": "openai"}).json()["data"]["protocol"] == "openai"


# ── HIGH-1. header 值 write-only（CRUD 投影只回 headerNames）─────────────────────────


def test_header_values_never_in_crud_projection(client: TestClient):
    """HIGH-1：自定义 header 值同 key 是 secret——列表/create/patch 响应只回名字列表，
    全文（含嵌套序列化）grep 不到任何 header 值；PATCH 三语义：省略=不改 / 传 map=
    全量替换 / {}=清空；snapshot（verify_local_token 面）仍含全值。"""
    sign_val = "gw-sign-secret-b2h1"
    tenant_val = "tenant-value-b2h1"
    r = client.post(
        "/api/llm/providers",
        json={
            "id": "corp",
            "protocol": "openai-compatible",
            "baseUrl": "https://gw.example/v1",
            "headers": {"X-Gw-Sign": sign_val, "X-Tenant": tenant_val},
        },
    )
    assert r.status_code == 200
    created = r.json()["data"]
    assert created["headerNames"] == ["X-Gw-Sign", "X-Tenant"]
    assert "headers" not in created
    assert sign_val not in r.text and tenant_val not in r.text

    # 列表响应全文无值
    r = client.get("/api/llm/providers")
    assert sign_val not in r.text and tenant_val not in r.text
    corp = next(p for p in r.json()["data"]["providers"] if p["id"] == "corp")
    assert corp["headerNames"] == ["X-Gw-Sign", "X-Tenant"]

    # snapshot（local-token 消费面）仍含全值——gateway/runtime 靠它发请求
    snap = client.get("/api/llm/providers/snapshot").json()["data"]
    corp_snap = next(p for p in snap["providers"] if p["id"] == "corp")
    assert corp_snap["headers"] == {"X-Gw-Sign": sign_val, "X-Tenant": tenant_val}

    # PATCH 省略 headers = 不改
    r = client.patch("/api/llm/providers/corp", json={"displayName": "Corp"})
    assert r.json()["data"]["headerNames"] == ["X-Gw-Sign", "X-Tenant"]
    # PATCH 传 map = 全量替换（不是逐键 merge）
    replaced_val = "replaced-value-b2h1"
    r = client.patch("/api/llm/providers/corp", json={"headers": {"X-Only": replaced_val}})
    assert r.json()["data"]["headerNames"] == ["X-Only"]
    assert replaced_val not in r.text
    # PATCH {} = 清空
    r = client.patch("/api/llm/providers/corp", json={"headers": {}})
    assert r.json()["data"]["headerNames"] == []


# ── 3. /snapshot 鉴权 = 仅本地 token ─────────────────────────────────────────────────


def test_snapshot_rejects_cf_jwt_and_accepts_local_token(client: TestClient, monkeypatch):
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    # 无凭证 → 403
    assert client.get("/api/llm/providers/snapshot").status_code == 403
    # 有效 CF JWT（远程 owner 会话）→ 仍 403（解密 key 不出本机）
    assert client.get("/api/llm/providers/snapshot", headers=CF_HEADERS).status_code == 403
    # 本地 token → 200
    r = client.get("/api/llm/providers/snapshot", headers=LOCAL_HEADERS)
    assert r.status_code == 200
    assert r.json()["data"]["providers"][0]["apiKey"] == SEED_KEY


# ── 4. /snapshot 形状 + version 语义 ─────────────────────────────────────────────────


def test_snapshot_shape_and_version_increments_on_crud(client: TestClient):
    r = client.get("/api/llm/providers/snapshot")
    assert r.status_code == 200
    snap = r.json()["data"]
    assert set(snap.keys()) == {"version", "providers"}
    v0 = snap["version"]
    (default,) = snap["providers"]
    assert set(default.keys()) == {
        "id", "protocol", "displayName", "baseUrl", "apiKey", "headers", "enabled", "models",
    }
    assert default["apiKey"] == SEED_KEY  # snapshot 是唯一解密面
    model_ids = {m["id"] for m in default["models"]}
    assert model_ids == {"claude-sonnet-4-6", "gpt-5.5"}
    assert all(
        set(m.keys())
        == {
            "id",
            "displayName",
            "enabled",
            "capabilities",
            "maxOutput",
            "contextWindow",
            "source",
        }
        for m in default["models"]
    )

    # 纯读不 bump
    assert client.get("/api/llm/providers/snapshot").json()["data"]["version"] == v0
    # CRUD 写后 +1
    client.patch(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}", json={"displayName": "CRS"})
    assert client.get("/api/llm/providers/snapshot").json()["data"]["version"] == v0 + 1


# ── P3-8. 写面鉴权收紧（prd「远程 web 对 provider 配置只读」落 API 层）──────────────────


def test_write_endpoints_reject_cf_jwt_and_accept_local_token(client: TestClient, monkeypatch):
    """写端点挂 verify_local_token：合法 CF JWT（远程 owner 会话）恒 403、本地 token 放行；
    GET 列表/模型保持 cf_access（远程可看）。"""
    client.get("/api/llm/providers")  # AUTH_DISABLED 下先触发 seed
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)

    create_body = {"id": "dash", "protocol": "openai-compatible", "baseUrl": "https://d/v1"}
    # 有效 CF JWT → 全部写端点 403（远程只读）
    assert client.post("/api/llm/providers", json=create_body, headers=CF_HEADERS).status_code == 403
    assert (
        client.patch(
            f"/api/llm/providers/{DEFAULT_PROVIDER_ID}", json={"enabled": True}, headers=CF_HEADERS
        ).status_code
        == 403
    )
    assert client.delete("/api/llm/providers/dash", headers=CF_HEADERS).status_code == 403
    assert (
        client.post(
            f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/test", headers=CF_HEADERS
        ).status_code
        == 403
    )
    assert (
        client.put(
            f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
            json={"id": "m1"},
            headers=CF_HEADERS,
        ).status_code
        == 403
    )
    assert (
        client.delete(
            f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models?modelId=m1", headers=CF_HEADERS
        ).status_code
        == 403
    )
    # HIGH-2：模型拉取（出网 + 写表）同为写面——远程 CF 会话不得驱动服务端外呼
    assert (
        client.post(
            f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models/refresh", headers=CF_HEADERS
        ).status_code
        == 403
    )
    # GET 读面对同一 CF JWT 照常放行（远程可看）
    assert client.get("/api/llm/providers", headers=CF_HEADERS).status_code == 200
    assert (
        client.get(
            f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models", headers=CF_HEADERS
        ).status_code
        == 200
    )
    # 本地 token → 写端点放行（本地 renderer 经 webRequest 注入同 header）
    r = client.post("/api/llm/providers", json=create_body, headers=LOCAL_HEADERS)
    assert r.status_code == 200
    assert (
        client.patch(
            "/api/llm/providers/dash", json={"displayName": "D"}, headers=LOCAL_HEADERS
        ).status_code
        == 200
    )
    assert client.delete("/api/llm/providers/dash", headers=LOCAL_HEADERS).status_code == 200


# ── P3-9. model 行写端点（Settings 模型管理）────────────────────────────────────────────


def test_model_upsert_manual_add_and_merge_semantics(client: TestClient):
    # 手动添加：新行默认 enabled=True + source='manual'
    r = client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
        json={"id": "claude-manual-1", "maxOutput": 32000, "contextWindow": 200_000},
    )
    assert r.status_code == 200
    m = r.json()["data"]
    assert m["id"] == "claude-manual-1"
    assert m["enabled"] is True
    assert m["source"] == "manual"
    assert m["maxOutput"] == 32000
    assert m["contextWindow"] == 200_000
    assert m["capabilities"] is None  # 不臆造能力位

    # merge 语义：只传 enabled=False，maxOutput/其余键保留现行值
    r = client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
        json={"id": "claude-manual-1", "enabled": False},
    )
    assert r.status_code == 200
    m = r.json()["data"]
    assert m["enabled"] is False
    assert m["maxOutput"] == 32000
    assert m["contextWindow"] == 200_000
    assert m["source"] == "manual"

    # capabilities 可标注；再次只动 maxOutput 时保留
    r = client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
        json={"id": "claude-manual-1", "capabilities": {"tools": True, "vision": False}},
    )
    assert r.json()["data"]["capabilities"] == {"tools": True, "vision": False}
    r = client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
        json={"id": "claude-manual-1", "maxOutput": None},
    )
    m = r.json()["data"]
    assert m["maxOutput"] is None
    assert m["contextWindow"] == 200_000
    assert m["capabilities"] == {"tools": True, "vision": False}

    r = client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
        json={"id": "claude-manual-1", "contextWindow": None},
    )
    assert r.status_code == 200
    assert r.json()["data"]["contextWindow"] is None


def test_model_upsert_and_delete_error_paths(client: TestClient):
    # 缺 id / 坏类型 → 400
    r = client.put(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models", json={})
    assert r.status_code == 400
    r = client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
        json={"id": "m1", "maxOutput": "64k"},
    )
    assert r.status_code == 400
    r = client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
        json={"id": "m1", "capabilities": ["tools"]},
    )
    assert r.status_code == 400
    # 缺 provider → 404
    assert client.put("/api/llm/providers/nope/models", json={"id": "m1"}).status_code == 404
    # DELETE：缺行 404 / 命中 200（seed 行 claude-sonnet-4-6 可删）
    assert (
        client.delete(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models?modelId=nope").status_code
        == 404
    )
    r = client.delete(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models?modelId=claude-sonnet-4-6"
    )
    assert r.status_code == 200
    ids = {
        m["id"]
        for m in client.get(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models").json()["data"][
            "models"
        ]
    }
    assert "claude-sonnet-4-6" not in ids


def test_model_upsert_strict_validation(client: TestClient):
    """MEDIUM-6：enabled 严格 bool（拒 "false"/1 隐式转换）/ capabilities 只允许
    tools·vision·reasoning 三键且值 bool / maxOutput、contextWindow = null 或
    1..2_000_000 / 未知
    顶层字段 400。"""
    url = f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models"
    client.get("/api/llm/providers")  # seed

    def _put(payload):
        return client.put(url, json={"id": "m-strict", **payload})

    # enabled 严格 bool
    assert _put({"enabled": "false"}).status_code == 400
    assert _put({"enabled": 1}).status_code == 400
    # capabilities：未知键 / 非 bool 值 → 400
    assert _put({"capabilities": {"tools": True, "bogus": True}}).status_code == 400
    assert _put({"capabilities": {"tools": "yes"}}).status_code == 400
    # maxOutput：0 / 负数 / 超上限 / bool → 400
    assert _put({"maxOutput": 0}).status_code == 400
    assert _put({"maxOutput": -3}).status_code == 400
    assert _put({"maxOutput": 2_000_001}).status_code == 400
    assert _put({"maxOutput": True}).status_code == 400
    # contextWindow 同一严格整数边界（未知保持 null，不做必填）。
    assert _put({"contextWindow": 0}).status_code == 400
    assert _put({"contextWindow": -3}).status_code == 400
    assert _put({"contextWindow": 2_000_001}).status_code == 400
    assert _put({"contextWindow": True}).status_code == 400
    # 未知顶层字段 → 400（source 是服务端派生列，不收）
    assert _put({"source": "fetched"}).status_code == 400
    # 以上全被拒 → 行未落库
    ids = {
        m["id"]
        for m in client.get(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models").json()["data"][
            "models"
        ]
    }
    assert "m-strict" not in ids
    # 合法边界值通过
    r = _put(
        {
            "enabled": False,
            "maxOutput": 1,
            "contextWindow": 2_000_000,
            "capabilities": {"tools": True, "vision": False, "reasoning": True},
        }
    )
    assert r.status_code == 200
    m = r.json()["data"]
    assert m["enabled"] is False and m["maxOutput"] == 1
    assert m["contextWindow"] == 2_000_000
    assert m["capabilities"] == {"tools": True, "vision": False, "reasoning": True}
    assert _put({"maxOutput": 2_000_000}).json()["data"]["maxOutput"] == 2_000_000


def test_model_id_with_slash_roundtrip(client: TestClient):
    """OpenRouter 式 wire id 含 '/'——走 body/query（非 path 段），必须整链可用。"""
    client.get("/api/llm/providers")  # seed
    slash_id = "openai/gpt-4o"
    r = client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models", json={"id": slash_id}
    )
    assert r.status_code == 200 and r.json()["data"]["id"] == slash_id
    r = client.delete(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models", params={"modelId": slash_id}
    )
    assert r.status_code == 200


# ── 5. /{id}/models 发现（HIGH-2 拆分：GET 纯读 / POST refresh 出网）──────────────────


def test_models_refresh_merges_fetched_without_touching_manual(client: TestClient, monkeypatch):
    async def _fake_fetch(protocol: str, base: str, api_key: str, **_kw) -> _Fetched:
        return [("claude-sonnet-4-6", {}), ("claude-new-model", {})]

    monkeypatch.setattr(lp_router, "_fetch_provider_models", _fake_fetch)
    r = client.post(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models/refresh")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["error"] is None and data["fetchedNew"] == 1
    by_id = {m["id"]: m for m in data["models"]}
    # seed 的 manual 行不被覆盖（enabled/source 原样）
    assert by_id["claude-sonnet-4-6"]["source"] == "manual"
    assert by_id["claude-sonnet-4-6"]["enabled"] is True
    # 新 fetched 行默认不启用
    assert by_id["claude-new-model"]["source"] == "fetched"
    assert by_id["claude-new-model"]["enabled"] is False

    # GET 读到 merge 后的表（纯读，形状不变）
    r = client.get(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data["models"]) == 3
    assert data["fetchedNew"] == 0 and data["error"] is None


def test_parse_models_payload_anthropic_takes_display_name():
    body = {
        "data": [
            {"id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6", "type": "model"},
            {"id": "claude-haiku-4-5"},
            {"no_id": True},
        ]
    }
    parsed = lp_router._parse_models_payload(body, "anthropic")
    assert [mid for mid, _ in parsed] == ["claude-sonnet-4-6", "claude-haiku-4-5"]
    assert parsed[0][1]["display_name"] == "Claude Sonnet 4.6"
    # 上游没给 display_name → 键值 None（存储层落 NULL，不臆造）
    assert parsed[1][1]["display_name"] is None


def test_parse_models_payload_openrouter_takes_context_and_capabilities():
    body = {
        "data": [
            {
                "id": "anthropic/claude-sonnet-4.5",
                "name": "Anthropic: Claude Sonnet 4.5",
                "context_length": 1000000,
                "architecture": {"input_modalities": ["text", "image", "file"]},
                "supported_parameters": ["tools", "reasoning", "temperature"],
                "top_provider": {"max_completion_tokens": 64000},
                "pricing": {"prompt": "0.000003", "completion": "0.000015"},
            },
            {
                "id": "text-only/model",
                "context_length": 8192,
                "architecture": {"input_modalities": ["text"]},
                "supported_parameters": ["temperature"],
            },
        ]
    }
    by_id = dict(lp_router._parse_models_payload(body, "openrouter"))
    rich = by_id["anthropic/claude-sonnet-4.5"]
    assert rich["display_name"] == "Anthropic: Claude Sonnet 4.5"
    assert rich["context_window"] == 1000000 and rich["max_output"] == 64000
    assert rich["capabilities"] == {"tools": True, "reasoning": True, "vision": True}
    # supported_parameters 是完整枚举 → 缺席的能力位是显式 false，不是「未标注」
    lean = by_id["text-only/model"]
    assert lean["capabilities"] == {"tools": False, "reasoning": False, "vision": False}
    assert lean["context_window"] == 8192 and lean["max_output"] is None
    # 有意不解析 pricing（llm_model 无价格列，成本估算走前端目录快照）
    assert "pricing" not in rich and "cost" not in rich


def test_parse_models_payload_other_protocols_carry_no_meta():
    body = {"data": [{"id": "gpt-5.5", "display_name": "GPT 5.5", "context_length": 400000}]}
    for protocol in ("openai", "openai-compatible", "deepseek", "google"):
        assert lp_router._parse_models_payload(body, protocol) == [("gpt-5.5", {})]


def test_models_refresh_fills_metadata_without_overwriting_manual_values(
    client: TestClient, monkeypatch
):
    """refresh 把上游元数据落进空列，但用户在 Settings 手填过的值恒赢。"""
    client.get("/api/llm/providers")  # seed（claude-sonnet-4-6 是 manual 行）
    client.put(
        f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models",
        json={"id": "claude-sonnet-4-6", "displayName": "我的 Sonnet", "maxOutput": 8192},
    )

    async def _fake_fetch(protocol: str, base: str, api_key: str, **_kw) -> _Fetched:
        meta = {
            "display_name": "Claude Sonnet 4.6",
            "context_window": 200000,
            "max_output": 64000,
        }
        return [("claude-sonnet-4-6", meta), ("claude-new-model", meta)]

    monkeypatch.setattr(lp_router, "_fetch_provider_models", _fake_fetch)
    data = client.post(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models/refresh").json()["data"]
    by_id = {m["id"]: m for m in data["models"]}

    edited = by_id["claude-sonnet-4-6"]
    assert edited["displayName"] == "我的 Sonnet" and edited["maxOutput"] == 8192
    assert edited["contextWindow"] == 200000  # 留白的那列才由上游补
    fresh = by_id["claude-new-model"]
    assert fresh["displayName"] == "Claude Sonnet 4.6" and fresh["contextWindow"] == 200000
    assert fresh["maxOutput"] == 64000


def test_models_get_is_pure_read_and_ignores_legacy_refresh_param(
    client: TestClient, monkeypatch
):
    """HIGH-2：GET /models 纯 SQLite 读零外呼；旧 ``?refresh=true`` 入参直接忽略
    （不 400 不外呼——旧 UI 短暂共存期兼容）。transport 级断言：整个请求期间
    模块内不得构造任何 httpx 客户端。"""
    client.get("/api/llm/providers")  # seed

    class _NoNetwork:
        def __init__(self, *_a, **_k):
            raise AssertionError("GET /models must not construct an httpx client")

    monkeypatch.setattr(lp_router.httpx, "AsyncClient", _NoNetwork)
    r = client.get(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models?refresh=true")
    assert r.status_code == 200
    data = r.json()["data"]
    assert {m["id"] for m in data["models"]} == {"claude-sonnet-4-6", "gpt-5.5"}
    assert data["fetchedNew"] == 0 and data["error"] is None


def test_models_refresh_requires_local_token(client: TestClient, monkeypatch):
    """HIGH-2：refresh = verify_local_token——合法 CF JWT（远程 owner 会话）恒 403，
    本地 token 放行。"""
    client.get("/api/llm/providers")  # AUTH_DISABLED 下先触发 seed
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    url = f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models/refresh"
    assert client.post(url).status_code == 403
    assert client.post(url, headers=CF_HEADERS).status_code == 403

    async def _fake(*_a, **_k) -> _Fetched:
        return []

    monkeypatch.setattr(lp_router, "_fetch_provider_models", _fake)
    assert client.post(url, headers=LOCAL_HEADERS).status_code == 200


def test_models_refresh_failure_is_readable_not_5xx(client: TestClient, monkeypatch):
    async def _fail(*_a, **_k) -> _Fetched:
        raise ValueError(
            "models endpoint not available (HTTP 404) — this upstream may not expose "
            "/models; add models manually"
        )

    monkeypatch.setattr(lp_router, "_fetch_provider_models", _fail)
    r = client.post(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/models/refresh")
    assert r.status_code == 200
    data = r.json()["data"]
    assert "404" in data["error"]
    # 现存（seed）行照常返回
    assert {m["id"] for m in data["models"]} == {"claude-sonnet-4-6", "gpt-5.5"}
    assert client.get("/api/llm/providers/nope/models").status_code == 404
    assert client.post("/api/llm/providers/nope/models/refresh").status_code == 404


# ── HIGH-2：出网 base_url 最小策略（仅 http/https、拒 userinfo；不封私网）──────────────


def test_outbound_base_problem_unit():
    p = lp_router._outbound_base_problem
    assert p("https://x.example/v1") is None
    assert p("http://127.0.0.1:11434/v1") is None  # 本地 ollama 合法——有意不封私网
    assert p("ftp://x.example") is not None
    assert p("x.example/v1") is not None  # 无 scheme
    assert p("https://user:pass@x.example/v1") is not None
    assert p("https://user@x.example/v1") is not None


def test_outbound_policy_blocks_refresh_and_test_without_network(
    client: TestClient, monkeypatch
):
    """坏 scheme / userinfo 的 base_url：/models/refresh 与 /test 都恒 200 + 可读 error，
    且零外呼（transport 级断言不构造 httpx 客户端）。"""
    client.get("/api/llm/providers")  # seed
    client.post(
        "/api/llm/providers",
        json={"id": "ftpish", "protocol": "openai-compatible", "baseUrl": "ftp://gw.example/v1"},
    )
    client.post(
        "/api/llm/providers",
        json={
            "id": "userinfo",
            "protocol": "openai-compatible",
            "baseUrl": "https://u:p@gw.example/v1",
        },
    )

    class _NoNetwork:
        def __init__(self, *_a, **_k):
            raise AssertionError("policy-rejected base_url must never reach the network")

    monkeypatch.setattr(lp_router.httpx, "AsyncClient", _NoNetwork)

    r = client.post("/api/llm/providers/ftpish/models/refresh")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["fetchedNew"] == 0 and "http or https" in data["error"]
    r = client.post("/api/llm/providers/userinfo/models/refresh")
    assert "credentials" in r.json()["data"]["error"]

    data = client.post("/api/llm/providers/ftpish/test").json()["data"]
    assert data["ok"] is False and "http or https" in data["error"]
    data = client.post("/api/llm/providers/userinfo/test").json()["data"]
    assert data["ok"] is False and "credentials" in data["error"]


# ── 6. 连通性测试 ────────────────────────────────────────────────────────────────────


def _mock_transport(handler) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_probe_ok_via_models_endpoint():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/models")
        return httpx.Response(200, json={"data": [{"id": "m1"}]})

    err = await lp_router._probe_provider(
        "openai-compatible", "https://x.example/v1", "sk-secret", None,
        transport=_mock_transport(handler),
    )
    assert err is None


@pytest.mark.anyio
async def test_probe_auth_failure_readable_and_no_key_leak():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    err = await lp_router._probe_provider(
        "openai", "https://api.openai.com/v1", "sk-super-secret", None,
        transport=_mock_transport(handler),
    )
    assert err is not None and "401" in err and "check the API key" in err
    assert "sk-super-secret" not in err


@pytest.mark.anyio
async def test_probe_falls_back_to_minimal_completion_on_404():
    calls: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path.endswith("/models"):
            return httpx.Response(404)
        # anthropic 腿：/v1/messages + max_tokens=1
        assert request.url.path.endswith("/v1/messages")
        body = json.loads(request.content)
        assert body["max_tokens"] == 1 and body["model"] == "claude-sonnet-4-6"
        assert request.headers.get("x-api-key") == "sk-k"
        return httpx.Response(200, json={"id": "msg_1"})

    err = await lp_router._probe_provider(
        "anthropic", "https://crs.example.com/api", "sk-k", "claude-sonnet-4-6",
        transport=_mock_transport(handler),
    )
    assert err is None
    assert calls == [
        "GET /api/v1/models",
        "POST /api/v1/messages",
    ]


@pytest.mark.anyio
async def test_probe_404_without_model_is_readable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    err = await lp_router._probe_provider(
        "openai-compatible", "https://x.example/v1", "sk", None,
        transport=_mock_transport(handler),
    )
    assert err is not None and "add a model" in err


@pytest.mark.anyio
async def test_probe_completion_failure_allowlists_and_redacts():
    """HIGH-3：补全探测失败不透传任意上游正文——只回状态码 + allowlist 字段
    （error.type/code/message），且先过 redactor（key 明文绝不出响应）。"""
    key = "sk-leak-me-1234"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(404)
        return httpx.Response(
            400,
            json={"error": {
                "type": "invalid_request_error",
                "message": f"auth was Bearer {key}",
                "debug_echo": f"x-api-key: {key}",
                "request_dump": "POST /chat/completions ...",
            }},
        )

    err = await lp_router._probe_provider(
        "openai-compatible", "https://x.example/v1", key, "m1",
        transport=_mock_transport(handler),
    )
    assert err is not None and "400" in err
    assert key not in err  # redactor：message 里的 key 被 ***
    assert "invalid_request_error" in err  # allowlist：type 透出
    assert "debug_echo" not in err and "request_dump" not in err  # 非 allowlist 字段不透传


@pytest.mark.anyio
async def test_probe_completion_failure_non_json_body_never_leaked():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(404)
        return httpx.Response(502, text="<html>proxy dump: Authorization: Bearer sk-leak-x</html>")

    err = await lp_router._probe_provider(
        "openai-compatible", "https://x.example/v1", "sk-leak-x", "m1",
        transport=_mock_transport(handler),
    )
    assert err is not None and "502" in err
    assert "sk-leak-x" not in err and "html" not in err  # 非 JSON 正文整体不透传


# ── MEDIUM-5：provider 自定义 headers 进探测面（系统鉴权头优先）─────────────────────────


def test_models_and_completion_requests_merge_provider_headers():
    url, headers = lp_router._models_request(
        "openai-compatible", "https://x.example", "sk-k",
        {"X-Tenant": "t1", "authorization": "user-key-override"},
    )
    assert url == "https://x.example/v1/models"  # canonical_api_base 补 /v1（HIGH-2 单源）
    assert headers["X-Tenant"] == "t1"
    assert headers["Authorization"] == "Bearer sk-k"
    assert "authorization" not in headers  # 系统鉴权头大小写不敏感地赢

    curl, cheaders, body = lp_router._completion_request(
        "anthropic", "https://crs.example.com/api/v1", "sk-k", "m",
        {"X-Tenant": "t1", "X-API-Key": "evil-override"},
    )
    assert curl == "https://crs.example.com/api/v1/messages"  # canonical_root 剥 /v1 再拼探测路径
    assert cheaders["x-api-key"] == "sk-k"
    assert "X-API-Key" not in cheaders  # 同名（大小写不敏感）用户头被系统鉴权头顶掉
    assert cheaders["X-Tenant"] == "t1"
    assert body["max_tokens"] == 1


@pytest.mark.anyio
async def test_probe_sends_provider_custom_headers():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-tenant") == "t1"
        assert request.headers.get("authorization") == "Bearer sk-k"
        return httpx.Response(200, json={"data": []})

    err = await lp_router._probe_provider(
        "openai-compatible", "https://x.example/v1", "sk-k", None,
        headers={"X-Tenant": "t1", "Authorization": "should-be-overridden"},
        transport=_mock_transport(handler),
    )
    assert err is None


def test_models_refresh_passes_provider_headers(client: TestClient, monkeypatch):
    client.post(
        "/api/llm/providers",
        json={"id": "corp", "protocol": "openai-compatible",
              "baseUrl": "https://gw.example/v1", "headers": {"X-Tenant": "t1"}},
    )
    seen: Dict[str, Any] = {}

    async def _fake(protocol: str, base: str, api_key: str, **kw) -> _Fetched:
        seen.update(kw)
        return []

    monkeypatch.setattr(lp_router, "_fetch_provider_models", _fake)
    r = client.post("/api/llm/providers/corp/models/refresh")
    assert r.status_code == 200
    assert seen.get("headers") == {"X-Tenant": "t1"}


def test_test_endpoint_shapes(client: TestClient, monkeypatch):
    async def _ok(*_a, **_k) -> Optional[str]:
        return None

    monkeypatch.setattr(lp_router, "_probe_provider", _ok)
    r = client.post(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/test")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["ok"] is True and isinstance(data["latencyMs"], int) and data["error"] is None

    async def _bad(*_a, **_k) -> Optional[str]:
        return "authentication failed (HTTP 401) — check the API key"

    monkeypatch.setattr(lp_router, "_probe_provider", _bad)
    data = client.post(f"/api/llm/providers/{DEFAULT_PROVIDER_ID}/test").json()["data"]
    assert data["ok"] is False and "401" in data["error"]

    assert client.post("/api/llm/providers/nope/test").status_code == 404


# ── 7. /chat/config enabledModels 投影（flag off 现状不变 / flag on 聚合）──────────────


class _ChatCfg:
    """/chat/config 所需最小 stub（镜像 test_llm_models_api）+ 本 flag。"""

    agent_max_iter = 8
    agent_max_cost_usd = 0.5
    kos_consumer_enabled = False
    kos_l1_hot_block_enabled = False
    kos_time_decay_enabled = True
    llm_model = "claude-sonnet-4-6"
    user_md_compile_enabled = False
    standing_docs_editor_enabled = True
    custom_agents_enabled = False
    llm_provider_registry_enabled = False
    notion_oauth_enabled = True


def _stub_chat_config(monkeypatch, cfg) -> None:
    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: cfg)
    # task 07-21 —— /chat/config 不再注入 Notion context page（Standing Context 单源），
    # 无需再 stub ContextLoader。

    def _fake_dotenv(path: str) -> Dict[str, Any]:
        return {"LLM_ENABLED_MODELS": "env-model-a, env-model-b"}

    monkeypatch.setattr("src.api.routers.chat.dotenv_values", _fake_dotenv)
    monkeypatch.setattr("src.api.routers.chat.get_env_file_path", lambda: "/fake/.env")


def test_chat_config_flag_off_keeps_env_projection(monkeypatch):
    """flag 显式 off（cutover 2026-07-13 后默认 on）：即便 provider 表已有行，
    enabledModels 仍 = .env 热读值（应急回退字节级现状）。"""
    # 先让表里有行（且与 env 值不同），证明 off 路径不读表
    store = get_llm_provider_store()
    store.seed_default_from_env(
        api_base="b", api_key="", model="table-model", enabled_models=["table-only"]
    )
    _stub_chat_config(monkeypatch, _ChatCfg())
    with TestClient(app, raise_server_exceptions=False) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["enabledModels"] == ["env-model-a", "env-model-b"]


def test_chat_config_flag_on_aggregates_across_providers(monkeypatch):
    """flag on：default provider 裸 model id 在前，其余 provider 输出 providerId:modelId；
    disabled provider / disabled model 不出现。"""

    class _FlagOnCfg(_ChatCfg):
        llm_provider_registry_enabled = True

    _stub_chat_config(monkeypatch, _FlagOnCfg())
    with TestClient(app, raise_server_exceptions=False) as c:
        # 首次 /chat/config 会经 ensure_seeded_store 触发 seed（stub 输入）；
        # 再补一个第二 provider + 启用/禁用模型各一 + 一个整体 disabled 的 provider。
        store = lp_router.ensure_seeded_store()
        store.create_provider("dash", protocol="openai-compatible", base_url="https://d/v1")
        store.upsert_model("dash", "qwen-max", enabled=True)
        store.upsert_model("dash", "qwen-turbo", enabled=False)
        store.create_provider("off", protocol="openai", enabled=False)
        store.upsert_model("off", "gpt-hidden", enabled=True)

        data = c.get("/api/chat/config").json()["data"]
    assert data["enabledModels"] == ["claude-sonnet-4-6", "gpt-5.5", "dash:qwen-max"]


def test_chat_config_flag_on_store_failure_falls_back_to_env(monkeypatch):
    """flag on 但聚合失败 → 回退 env 热读值（never fail /config）。"""

    class _FlagOnCfg(_ChatCfg):
        llm_provider_registry_enabled = True

    _stub_chat_config(monkeypatch, _FlagOnCfg())

    def _boom():
        raise RuntimeError("store down")

    monkeypatch.setattr(enabled_models_mod, "ensure_seeded_store", _boom)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/chat/config")
    assert r.status_code == 200
    assert r.json()["data"]["enabledModels"] == ["env-model-a", "env-model-b"]


# ── P3-10. /chat/config providerRegistryEnabled（Settings 模型服务区门控字段）───────────


def test_chat_config_provider_registry_enabled_projection(monkeypatch):
    """UI 门控字段与 enabledModels 聚合投影同源（pydantic 冻结单例）：off=false / on=true。"""
    _stub_chat_config(monkeypatch, _ChatCfg())
    with TestClient(app, raise_server_exceptions=False) as c:
        assert c.get("/api/chat/config").json()["data"]["providerRegistryEnabled"] is False

    class _FlagOnCfg(_ChatCfg):
        llm_provider_registry_enabled = True

    _stub_chat_config(monkeypatch, _FlagOnCfg())
    with TestClient(app, raise_server_exceptions=False) as c:
        assert c.get("/api/chat/config").json()["data"]["providerRegistryEnabled"] is True
