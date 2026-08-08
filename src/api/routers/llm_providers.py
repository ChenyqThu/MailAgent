"""LLM provider 配置面路由 — /api/llm/providers*（task 07-12 P0，prd §4.3b/§4.4）。

端点与鉴权分层（P3 收紧：prd「远程 web 对 provider 配置只读」落到 API 层）：
  - **读**（provider 列表 / per-provider 模型列表）= ``Depends(verify_cf_access)``（owner-only
    双腿：本地 token / CF JWT——远程可看）。列表/详情对 key 只回掩码（``hasKey`` +
    ``keyLast4``），**永不回明文**；自定义 header 同为 secret（review 批2 HIGH-1）——
    CRUD 投影只回 ``headerNames``（名字列表），值 write-only、全值只经 snapshot。
    ``GET /{id}/models`` 是**纯 SQLite 读**（零上游外呼，review 批2 HIGH-2）。
  - **写**（provider POST/PATCH/DELETE + model 行 PUT/DELETE + ``POST /{id}/models/refresh``
    上游拉取 + ``POST /{id}/test`` 连通性测试）= ``Depends(verify_local_token)``（**仅**本地
    ephemeral token，不接受 CF JWT）：本地 renderer 经 chat_local_bridge webRequest 注入
    local token 不受影响；远程 CF 会话恒 403 → Settings 远程只读。refresh/test 归写面：
    它们拿解密 key 发真实上游请求（探测/出网面），不该被远程会话驱动。
  - **``GET /snapshot``** = ``Depends(verify_local_token)``（镜像 island announce / exec
    端点先例）：返回**解密后** key，仅供同机 loopback 的 embedded gateway 消费；远程 CF
    会话经代理路径不可达（403）。

Seed（prd §4.1）：读端点惰性触发 ``ensure_seeded_store()`` —— 表空时把现有 env 配置
（LLM_API_BASE/KEY/MODEL + 热读 .env 的 LLM_ENABLED_MODELS）落成 ``default`` provider 行；
行落地后行权威，env 键降级为首次默认。幂等：有任何 provider 行即跳过。
🔴 seed 本体（``ensure_seeded_store`` / ``_resolve_seed_inputs``）已搬去
``src/agent_config/enabled_models.py``（08-04）：飞书 IM 桥跑在同步进程里，需要同一份
seed + 同一份「在册模型全集」，而它 import 不起本模块（本模块拖 FastAPI）。这里只 import
复用，语义不变。

统一响应走 app.success_envelope / app.APIError（与 llm.py 等 router 一致）。
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, Depends, Query, Request

from src.agent_config.enabled_models import ensure_seeded_store
from src.agent_config.llm_providers import (
    DEFAULT_PROVIDER_ID,
    PROVIDER_PROTOCOLS,
    LlmModelRow,
    LlmProviderRow,
    LlmProviderStore,
)
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token

# URL 归一 + 脱敏单源 = provider_routing（review HIGH-2/HIGH-3：探测面与 runtime 面
# 必须推导出同一 wire URL，禁止 router 里复制实现）。
from src.llm_agent.provider_routing import (
    normalize_anthropic_base,
    normalize_openai_base,
    redact_secrets,
)

router = APIRouter(prefix="/api/llm/providers", tags=["llm-providers"])

_UPSTREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=10.0, write=10.0, pool=10.0)

# base_url 为空时的官方默认（prd §4.5 模板语义：空 = 官方端点）。openai-compatible 无默认
# （各家/自建中转地址不同，base_url 必填）。google 走其 OpenAI 兼容面（/models 可用）。
_DEFAULT_BASES: Dict[str, str] = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "deepseek": "https://api.deepseek.com",
    "openrouter": "https://openrouter.ai/api/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai",
}

# ---------------------------------------------------------------------------
# 投影 helper（掩码纪律：CRUD 面永不回明文 key，header 值 write-only）
# ---------------------------------------------------------------------------


def _masked_provider_dict(store: LlmProviderStore, row: LlmProviderRow) -> Dict[str, Any]:
    key = store.get_provider_api_key(row.id) if row.has_key else None
    return {
        "id": row.id,
        "protocol": row.protocol,
        "displayName": row.display_name,
        "baseUrl": row.base_url,
        # header 值同 key 是潜在 secret（Authorization/网关签名等，review 批2 HIGH-1）：
        # CRUD 面只回名字；全值只经 snapshot（verify_local_token）供 gateway/runtime。
        "headerNames": sorted(row.headers.keys()),
        "enabled": row.enabled,
        "sortOrder": row.sort_order,
        "hasKey": row.has_key,
        # last4 供 UI 识别是哪把 key（掩码显示业界标配）；解密失败 → None（hasKey 仍 True）。
        "keyLast4": key[-4:] if key else None,
        "isDefault": row.id == DEFAULT_PROVIDER_ID,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }


def _model_dict(m: LlmModelRow) -> Dict[str, Any]:
    return {
        "id": m.model_id,
        "displayName": m.display_name,
        "groupName": m.group_name,
        "enabled": m.enabled,
        "capabilities": m.capabilities,
        "maxOutput": m.max_output,
        "contextWindow": m.context_window,
        "source": m.source,
        "fetchedAt": m.fetched_at,
    }


def _require_provider(store: LlmProviderStore, provider_id: str) -> LlmProviderRow:
    prov = store.get_provider(provider_id)
    if prov is None:
        raise APIError(
            "E_NOT_FOUND", f"llm provider not found: {provider_id!r}", source="sqlite"
        )
    return prov


def _resolve_base(protocol: str, base_url: str) -> str:
    return (base_url or "").strip() or _DEFAULT_BASES.get(protocol, "")


def _outbound_base_problem(base: str) -> Optional[str]:
    """出网 base_url 最小策略（review 批2 HIGH-2）：仅 http/https、拒 userinfo
    （``user:pass@host`` 形态 URL）。返回可读错误；None = 通过。

    刻意**不封私网 IP**——本地 ollama / 自建 one-api 是合法场景，且两个外呼端点
    （/models/refresh + /test）已收紧 verify_local_token，远程面已消除。"""
    try:
        url = httpx.URL(base)
    except Exception:  # noqa: BLE001 — 任何解析失败都按坏 URL 拒
        return "base_url is not a valid URL"
    if url.scheme not in ("http", "https"):
        return f"base_url scheme must be http or https, got {url.scheme or '(none)'!r}"
    if url.username or url.password:
        return "base_url must not embed credentials (user:pass@host)"
    if not url.host:
        return "base_url is missing a host"
    return None


# ---------------------------------------------------------------------------
# 上游探测（模型发现 + 连通性测试）。transport 参数 = 测试注入缝（httpx.MockTransport）。
# ---------------------------------------------------------------------------


def _parse_models_payload(body: Any) -> List[str]:
    """GET /models 响应解析 data[].id（OpenAI / Anthropic / OpenRouter 三家同形）。"""
    if not isinstance(body, dict):
        return []
    data = body.get("data")
    if not isinstance(data, list):
        return []
    return [i["id"] for i in data if isinstance(i, dict) and isinstance(i.get("id"), str)]


def _merge_headers(
    provider_headers: Optional[Dict[str, str]], system: Dict[str, str]
) -> Dict[str, str]:
    """provider 自定义头 + 系统生成头合并（review MEDIUM-5）。同名（大小写不敏感）时
    系统鉴权头赢——防用户自定义 header 意外顶掉真实 key。"""
    system_lower = {k.lower() for k in system}
    merged = {
        k: v for k, v in (provider_headers or {}).items() if k.lower() not in system_lower
    }
    merged.update(system)
    return merged


def _models_request(
    protocol: str,
    base: str,
    api_key: str,
    headers: Optional[Dict[str, str]] = None,
) -> Tuple[str, Dict[str, str]]:
    """按 protocol 组装模型发现请求（url, headers）。URL 归一与 runtime 同源
    （provider_routing，review HIGH-2）：anthropic = canonical_root + ``/v1/models``；
    openai 家族 = canonical_api_base + ``/models``。google 的 OpenAI 兼容面挂在
    ``/v1beta/openai`` 下（无 /vN 尾段，Python runtime 无 google 腿）→ 原样拼接。
    provider 自定义 header 合入、系统鉴权头优先（MEDIUM-5）。"""
    if protocol == "anthropic":
        root = normalize_anthropic_base(base) or ""
        auth = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
        return f"{root}/v1/models", _merge_headers(headers, auth)
    auth = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    if protocol == "google":
        return f"{base.rstrip('/')}/models", _merge_headers(headers, auth)
    return f"{normalize_openai_base(base)}/models", _merge_headers(headers, auth)


async def _fetch_provider_models(
    protocol: str,
    base: str,
    api_key: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> List[str]:
    """按 protocol 拉上游模型列表。anthropic 腿 401 时再退 Bearer 一轮（CRS 类中转两种
    鉴权头都存在，镜像 llm.py 双协议探测风格）。失败抛 ValueError（消息可读、不含 key），
    由端点转成 payload 的 error 字段（不 5xx —— 中转不透传 /models 时手动添加是正路）。"""
    url, req_headers = _models_request(protocol, base, api_key, headers)
    async with httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT, transport=transport) as client:
        try:
            r = await client.get(url, headers=req_headers)
            if protocol == "anthropic" and r.status_code == 401 and api_key:
                retry = _merge_headers(headers, {"Authorization": f"Bearer {api_key}"})
                r = await client.get(url, headers=retry)
        except httpx.HTTPError as exc:
            raise ValueError(f"connection failed: {exc.__class__.__name__}") from exc
    if r.status_code in (401, 403):
        raise ValueError(f"authentication failed (HTTP {r.status_code}) — check the API key")
    if r.status_code == 404:
        raise ValueError(
            "models endpoint not available (HTTP 404) — this upstream may not expose "
            "/models; add models manually"
        )
    if not r.is_success:
        raise ValueError(f"models endpoint returned HTTP {r.status_code}")
    try:
        models = _parse_models_payload(r.json())
    except ValueError as exc:
        raise ValueError("models endpoint returned non-JSON payload") from exc
    return models


def _completion_request(
    protocol: str,
    base: str,
    api_key: str,
    model_id: str,
    headers: Optional[Dict[str, str]] = None,
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    """max_tokens=1 的最小补全请求（连通性测试兜底，/models 不透传时用）。URL 归一与
    runtime 同源（HIGH-2）、header 合并同 ``_models_request``（MEDIUM-5）。"""
    body = {"model": model_id, "max_tokens": 1, "messages": [{"role": "user", "content": "ping"}]}
    if protocol == "anthropic":
        root = normalize_anthropic_base(base) or ""
        auth = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
        return f"{root}/v1/messages", _merge_headers(headers, auth), body
    auth = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    if protocol == "google":
        return f"{base.rstrip('/')}/chat/completions", _merge_headers(headers, auth), body
    return f"{normalize_openai_base(base)}/chat/completions", _merge_headers(headers, auth), body


def _upstream_error_detail(
    resp: httpx.Response, *, api_key: str, headers: Optional[Dict[str, str]]
) -> str:
    """上游错误的 allowlist 摘要（review HIGH-3）：只提 JSON ``error`` 的 type/code/message
    三字段（或纯字符串 error），过 redact_secrets 再截断——**绝不**透传任意上游正文
    （自建中转/调试代理可能在正文回显 Authorization / key / 自定义签名头）。
    非 JSON / 无 error 字段 → ''（调用方只报状态码）。"""
    try:
        body = resp.json()
    except ValueError:
        return ""
    err = body.get("error") if isinstance(body, dict) else None
    parts: List[str] = []
    if isinstance(err, str):
        parts.append(err)
    elif isinstance(err, dict):
        for k in ("type", "code", "message"):
            v = err.get(k)
            if isinstance(v, (str, int)) and str(v).strip():
                parts.append(f"{k}={v}")
    detail = redact_secrets("; ".join(parts), api_key=api_key, headers=headers)
    return detail[:200]


async def _probe_provider(
    protocol: str,
    base: str,
    api_key: str,
    probe_model: Optional[str],
    *,
    headers: Optional[Dict[str, str]] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> Optional[str]:
    """连通性测试：先试 models 端点，404 再发 max_tokens=1 最小补全（业界三家标配的
    check 语义）。返回 None = ok；str = 可读错误 = 状态码 + 异常类名 + allowlist 字段
    （HIGH-3：**不含 key / 不透传任意上游正文**）。"""
    url, req_headers = _models_request(protocol, base, api_key, headers)
    async with httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT, transport=transport) as client:
        try:
            r = await client.get(url, headers=req_headers)
        except httpx.HTTPError as exc:
            return f"connection failed: {exc.__class__.__name__}"
        if r.is_success:
            return None
        if r.status_code in (401, 403):
            return f"authentication failed (HTTP {r.status_code}) — check the API key"
        if r.status_code != 404:
            return f"models endpoint returned HTTP {r.status_code}"
        # 404 → 中转不透传 /models：退最小补全探测。
        if not probe_model:
            return (
                "models endpoint not available (HTTP 404) and no model configured for a "
                "completion probe — add a model to this provider first"
            )
        curl, cheaders, cbody = _completion_request(protocol, base, api_key, probe_model, headers)
        try:
            cr = await client.post(curl, headers=cheaders, json=cbody)
        except httpx.HTTPError as exc:
            return f"connection failed: {exc.__class__.__name__}"
        if cr.is_success:
            return None
        if cr.status_code in (401, 403):
            return f"authentication failed (HTTP {cr.status_code}) — check the API key"
        detail = _upstream_error_detail(cr, api_key=api_key, headers=headers)
        suffix = f": {detail}" if detail else ""
        return f"completion probe failed (HTTP {cr.status_code}){suffix}"


# ---------------------------------------------------------------------------
# GET /api/llm/providers/snapshot（gateway 内部消费面 —— 仅本地 token，含解密 key）
# 注册在参数路由之前（虽无 GET /{id} 冲突，防御性保序）。
# ---------------------------------------------------------------------------


@router.get("/snapshot", dependencies=[Depends(verify_local_token)])
async def provider_snapshot(request: Request):
    """§4.3b 快照（version + enabled providers + 解密 key + 全部模型行带 enabled）。

    **仅** ``verify_local_token``（不接受 CF JWT）：唯一合法调用方是同机 loopback 的
    embedded gateway；远程 CF 会话（含经 serve-api 代理路径）恒 403 —— 解密 key 不出本机。
    """
    store = ensure_seeded_store()
    return success_envelope(store.snapshot(), request=request, source="sqlite")


# ---------------------------------------------------------------------------
# provider CRUD（owner 面，掩码）
# ---------------------------------------------------------------------------


@router.get("")
async def list_providers(request: Request, _: None = Depends(verify_cf_access)):
    """provider 列表（含 disabled 行；key 掩码 hasKey + keyLast4，永不回明文）。"""
    store = ensure_seeded_store()
    providers = [_masked_provider_dict(store, p) for p in store.list_providers()]
    return success_envelope(
        {"providers": providers, "version": store.get_snapshot_version()},
        request=request,
        source="sqlite",
    )


# provider create/PATCH 的严格入参约束（终审 MEDIUM-4：对齐 model upsert 的 MEDIUM-6 纪律，
# 拒未知字段与隐式类型转换——`enabled:"false"` 曾被 bool() 转成 True 写成相反状态、拼错的
# 字段名被静默忽略、对象值曾被 str() 字符串化入库或在 SQLite 绑定阶段炸成未捕获 500）。
_PROVIDER_CREATE_KEYS = frozenset(
    {"id", "protocol", "displayName", "baseUrl", "apiKey", "headers", "enabled", "sortOrder"}
)
_PROVIDER_PATCH_KEYS = frozenset(_PROVIDER_CREATE_KEYS - {"id"})
_SORT_ORDER_CEILING = 10_000


def _validate_provider_body(body: Dict[str, Any], *, allowed: frozenset) -> None:
    """create/PATCH 共用的严格 schema 闸（出现的键才校验——PATCH 省略=不改语义不受影响）。

    - 未知顶层字段 400；`protocol` 枚举；`displayName`/`baseUrl` 严格 string（清空传 ''，
      不收 null）；`apiKey` string 或 null（null = 无 key / PATCH 清除，前端契约）；
    - `headers` 平坦 string→string map 或 null（null/{} = 清空，全量替换语义不变）；
    - `enabled` 严格 bool；`sortOrder` 0..10000 有界整数（bool 是 int 子类，显式拒）。
    """
    unknown = set(body) - allowed
    if unknown:
        raise APIError(
            "E_INVALID_ARG",
            f"unknown fields: {sorted(unknown)}",
            hint=f"allowed: {sorted(allowed)}",
            source="sqlite",
        )
    if "protocol" in body and body["protocol"] not in PROVIDER_PROTOCOLS:
        raise APIError(
            "E_INVALID_ARG",
            f"'protocol' must be one of {PROVIDER_PROTOCOLS}",
            source="sqlite",
        )
    for key in ("displayName", "baseUrl"):
        if key in body and not isinstance(body[key], str):
            raise APIError(
                "E_INVALID_ARG", f"'{key}' must be a string (use '' to clear)", source="sqlite"
            )
    if "apiKey" in body and body["apiKey"] is not None and not isinstance(body["apiKey"], str):
        raise APIError(
            "E_INVALID_ARG", "'apiKey' must be a string (null clears the key)", source="sqlite"
        )
    if "headers" in body and body["headers"] is not None:
        headers = body["headers"]
        if not isinstance(headers, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in headers.items()
        ):
            raise APIError(
                "E_INVALID_ARG",
                "'headers' must be a flat string→string object (null/{} clears)",
                source="sqlite",
            )
    if "enabled" in body and not isinstance(body["enabled"], bool):
        raise APIError("E_INVALID_ARG", "'enabled' must be a boolean", source="sqlite")
    if "sortOrder" in body:
        sort_order = body["sortOrder"]
        if (
            isinstance(sort_order, bool)
            or not isinstance(sort_order, int)
            or not 0 <= sort_order <= _SORT_ORDER_CEILING
        ):
            raise APIError(
                "E_INVALID_ARG",
                f"'sortOrder' must be an integer in 0..{_SORT_ORDER_CEILING}",
                source="sqlite",
            )


@router.post("")
async def create_provider(
    request: Request,
    body: Optional[Dict[str, Any]] = None,
    _: None = Depends(verify_local_token),
):
    """新建 provider。body: {id, protocol, displayName?, baseUrl?, apiKey?, headers?,
    enabled?, sortOrder?}。apiKey 明文入参 → 落库即 Fernet 密文；响应恒掩码。
    严格 schema 见 ``_validate_provider_body``（终审 MEDIUM-4）。"""
    body = body or {}
    _validate_provider_body(body, allowed=_PROVIDER_CREATE_KEYS)
    provider_id = body.get("id")
    protocol = body.get("protocol")
    if not isinstance(provider_id, str) or not isinstance(protocol, str):
        raise APIError(
            "E_INVALID_ARG",
            "body must include string fields 'id' and 'protocol'",
            hint=f"protocol ∈ {PROVIDER_PROTOCOLS}",
            source="sqlite",
        )
    store = ensure_seeded_store()
    try:
        row = store.create_provider(
            provider_id,
            protocol=protocol,
            display_name=body.get("displayName") or "",
            base_url=body.get("baseUrl") or "",
            api_key=body.get("apiKey"),
            headers=body.get("headers"),
            enabled=body.get("enabled", True),
            sort_order=body.get("sortOrder", 0),
        )
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite") from exc
    return success_envelope(_masked_provider_dict(store, row), request=request, source="sqlite")


@router.patch("/{provider_id}")
async def update_provider(
    provider_id: str,
    request: Request,
    body: Optional[Dict[str, Any]] = None,
    _: None = Depends(verify_local_token),
):
    """部分更新（body 里出现的键才动）。``apiKey``：非空 str = 轮换；空串/null = 清除。
    ``headers``：write-only 明文 map（响应只回 headerNames，HIGH-1），**全量替换**语义
    ——省略 = 不改；``{}``/null = 清空。严格 schema 见 ``_validate_provider_body``
    （终审 MEDIUM-4）。"""
    body = body or {}
    _validate_provider_body(body, allowed=_PROVIDER_PATCH_KEYS)
    store = ensure_seeded_store()
    _require_provider(store, provider_id)
    kwargs: Dict[str, Any] = {}
    if "protocol" in body:
        kwargs["protocol"] = body["protocol"]
    if "displayName" in body:
        kwargs["display_name"] = body["displayName"]
    if "baseUrl" in body:
        kwargs["base_url"] = body["baseUrl"]
    if "apiKey" in body:
        kwargs["api_key"] = body["apiKey"]
    if "headers" in body:
        kwargs["headers"] = body["headers"]
    if "enabled" in body:
        kwargs["enabled"] = body["enabled"]
    if "sortOrder" in body:
        kwargs["sort_order"] = body["sortOrder"]
    try:
        row = store.update_provider(provider_id, **kwargs)
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite") from exc
    if row is None:
        raise APIError(
            "E_NOT_FOUND", f"llm provider not found: {provider_id!r}", source="sqlite"
        )
    return success_envelope(_masked_provider_dict(store, row), request=request, source="sqlite")


@router.delete("/{provider_id}")
async def delete_provider(
    provider_id: str,
    request: Request,
    _: None = Depends(verify_local_token),
):
    """删 provider（级联删其模型行）。``default`` 行禁删（legacy providerRef 落点）→ 400。"""
    store = ensure_seeded_store()
    try:
        removed = store.delete_provider(provider_id)
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite") from exc
    if not removed:
        raise APIError(
            "E_NOT_FOUND", f"llm provider not found: {provider_id!r}", source="sqlite"
        )
    return success_envelope({"deleted": provider_id}, request=request, source="sqlite")


# ---------------------------------------------------------------------------
# per-provider 模型发现（prd §4.4）
# ---------------------------------------------------------------------------


@router.get("/{provider_id}/models")
async def list_provider_models(
    provider_id: str,
    request: Request,
    _: None = Depends(verify_cf_access),
):
    """provider 的模型列表（``llm_model`` 表）——**纯 SQLite 读，零上游外呼**（review 批2
    HIGH-2：cf_access 读端点不得驱动服务端出网/写表）。上游拉取拆去
    ``POST /{id}/models/refresh``（verify_local_token）。旧 ``?refresh=true`` 入参直接
    忽略（未声明的 query 参数 FastAPI 自然丢弃）——旧 UI 短暂共存期不 400。
    响应形状保持 {provider, models, fetchedNew:0, error:null}（消费端零改）。"""
    store = ensure_seeded_store()
    _require_provider(store, provider_id)
    models = [_model_dict(m) for m in store.list_models(provider_id)]
    return success_envelope(
        {"provider": provider_id, "models": models, "fetchedNew": 0, "error": None},
        request=request,
        source="sqlite",
    )


@router.post("/{provider_id}/models/refresh")
async def refresh_provider_models(
    provider_id: str,
    request: Request,
    _: None = Depends(verify_local_token),
):
    """按 protocol 拉上游 ``/models`` merge 进表（新 id source='fetched' enabled=0；
    **不覆盖** manual 行与已有 enabled 状态），再返回全量模型行。归写面 =
    verify_local_token（review 批2 HIGH-2：出网 + merge 写表，远程 CF 会话恒 403）。
    拉取失败 → 恒 200 + ``error`` 可读消息 + 现存行照常返回（中转不透传 /models 时
    走手动添加兜底）。响应形状与旧 ``GET ?refresh=true`` 一致。"""
    store = ensure_seeded_store()
    prov = _require_provider(store, provider_id)
    error: Optional[str] = None
    fetched_new = 0
    base = _resolve_base(prov.protocol, prov.base_url)
    if not base:
        error = "base_url not configured for this provider"
    else:
        error = _outbound_base_problem(base)
    if error is None:
        api_key = store.get_provider_api_key(provider_id) or ""
        try:
            ids = await _fetch_provider_models(
                prov.protocol, base, api_key, headers=prov.headers
            )
            fetched_new = store.merge_fetched_models(provider_id, ids)
        except ValueError as exc:
            error = str(exc)
        except Exception:  # noqa: BLE001 — 防御兜底；不 5xx
            error = "unexpected error while fetching upstream models"
    models = [_model_dict(m) for m in store.list_models(provider_id)]
    return success_envelope(
        {"provider": provider_id, "models": models, "fetchedNew": fetched_new, "error": error},
        request=request,
        source="upstream",
    )


# ---------------------------------------------------------------------------
# model 行写面（P3：Settings 模型管理的启用勾选 / 手动添加 / maxOutput 编辑）。
# model_id 走 body/query 而非 path 段——OpenRouter 等家的 wire id 含 '/'（如
# 'openai/gpt-4o'），进 path 段会撞路由分段。
# ---------------------------------------------------------------------------

# model upsert 的入参约束（review 批2 MEDIUM-6：拒未知字段与隐式类型转换）。
_MODEL_UPSERT_KEYS = frozenset(
    {"id", "displayName", "enabled", "capabilities", "maxOutput", "contextWindow"}
)
_CAPABILITY_KEYS = frozenset({"tools", "vision", "reasoning"})
_MAX_OUTPUT_CEILING = 2_000_000


@router.put("/{provider_id}/models")
async def upsert_provider_model(
    provider_id: str,
    request: Request,
    body: Optional[Dict[str, Any]] = None,
    _: None = Depends(verify_local_token),
):
    """model 行 upsert。body: {id, displayName?, enabled?, capabilities?, maxOutput?, contextWindow?}。

    merge 语义：body 里出现的键才动，未出现的键保留现行值（store.upsert_model 是全字段
    覆盖 → 端点先读现行行回填，避免「勾启用」把 maxOutput/capabilities 清掉）。新行 =
    手动添加（source='manual'，enabled 缺省 True——owner 手动加模型就是为了用）。

    严格校验（MEDIUM-6）：未知顶层字段 400；``enabled`` 必须 bool（不收 "false"/1）；
    ``capabilities`` 只允许 tools/vision/reasoning 三键且值为 bool；``maxOutput`` 与
    ``contextWindow`` = null 或 1..2_000_000 正整数。
    """
    body = body or {}
    unknown = set(body) - _MODEL_UPSERT_KEYS
    if unknown:
        raise APIError(
            "E_INVALID_ARG",
            f"unknown fields: {sorted(unknown)}",
            hint=f"allowed: {sorted(_MODEL_UPSERT_KEYS)}",
            source="sqlite",
        )
    model_id = body.get("id")
    if not isinstance(model_id, str) or not model_id.strip():
        raise APIError("E_INVALID_ARG", "body must include string field 'id'", source="sqlite")
    model_id = model_id.strip()
    store = ensure_seeded_store()
    _require_provider(store, provider_id)
    existing = next(
        (m for m in store.list_models(provider_id) if m.model_id == model_id), None
    )

    def _pick(key: str, current: Any) -> Any:
        return body[key] if key in body else current

    display_name = _pick("displayName", existing.display_name if existing else None)
    if display_name is not None and not isinstance(display_name, str):
        raise APIError("E_INVALID_ARG", "'displayName' must be a string", source="sqlite")
    enabled = _pick("enabled", existing.enabled if existing else True)
    if not isinstance(enabled, bool):
        raise APIError("E_INVALID_ARG", "'enabled' must be a boolean", source="sqlite")
    capabilities = _pick("capabilities", existing.capabilities if existing else None)
    if capabilities is not None:
        if not isinstance(capabilities, dict):
            raise APIError("E_INVALID_ARG", "'capabilities' must be an object", source="sqlite")
        if set(capabilities) - _CAPABILITY_KEYS or not all(
            isinstance(v, bool) for v in capabilities.values()
        ):
            raise APIError(
                "E_INVALID_ARG",
                f"'capabilities' allows only boolean keys {sorted(_CAPABILITY_KEYS)}",
                source="sqlite",
            )
    max_output = _pick("maxOutput", existing.max_output if existing else None)
    if max_output is not None and (
        isinstance(max_output, bool)
        or not isinstance(max_output, int)
        or not 1 <= max_output <= _MAX_OUTPUT_CEILING
    ):
        raise APIError(
            "E_INVALID_ARG",
            f"'maxOutput' must be null or an integer in 1..{_MAX_OUTPUT_CEILING}",
            source="sqlite",
        )
    context_window = _pick("contextWindow", existing.context_window if existing else None)
    if context_window is not None and (
        isinstance(context_window, bool)
        or not isinstance(context_window, int)
        or not 1 <= context_window <= _MAX_OUTPUT_CEILING
    ):
        raise APIError(
            "E_INVALID_ARG",
            f"'contextWindow' must be null or an integer in 1..{_MAX_OUTPUT_CEILING}",
            source="sqlite",
        )
    try:
        row = store.upsert_model(
            provider_id,
            model_id,
            display_name=display_name,
            group_name=existing.group_name if existing else None,
            enabled=enabled,
            capabilities=capabilities,
            max_output=max_output,
            context_window=context_window,
            source=existing.source if existing else "manual",
        )
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite") from exc
    return success_envelope(_model_dict(row), request=request, source="sqlite")


@router.delete("/{provider_id}/models")
async def delete_provider_model(
    provider_id: str,
    request: Request,
    model_id: str = Query(..., alias="modelId"),
    _: None = Depends(verify_local_token),
):
    """删一个 model 行（query ``modelId``，理由同上——wire id 可含 '/'）。缺行 → 404。"""
    store = ensure_seeded_store()
    _require_provider(store, provider_id)
    if not store.delete_model(provider_id, model_id):
        raise APIError(
            "E_NOT_FOUND",
            f"model not found: {model_id!r} (provider {provider_id!r})",
            source="sqlite",
        )
    return success_envelope({"deleted": model_id}, request=request, source="sqlite")


# ---------------------------------------------------------------------------
# 连通性测试（prd §4.5：Settings 编辑面的 check 按钮）
# ---------------------------------------------------------------------------


@router.post("/{provider_id}/test")
async def test_provider(
    provider_id: str,
    request: Request,
    _: None = Depends(verify_local_token),
):
    """连通性测试：先试 models 端点，404 再发 max_tokens=1 最小补全。恒 200，
    data = {ok, latencyMs, error?}（error 可读、不泄 key）。"""
    store = ensure_seeded_store()
    prov = _require_provider(store, provider_id)
    base = _resolve_base(prov.protocol, prov.base_url)
    problem = (
        "base_url not configured for this provider" if not base else _outbound_base_problem(base)
    )
    if problem:
        return success_envelope(
            {"ok": False, "latencyMs": 0, "error": problem},
            request=request,
            source="upstream",
        )
    api_key = store.get_provider_api_key(provider_id) or ""
    models = store.list_models(provider_id)
    probe_model = next((m.model_id for m in models if m.enabled), None) or (
        models[0].model_id if models else None
    )
    t0 = time.monotonic()
    try:
        error = await _probe_provider(
            prov.protocol, base, api_key, probe_model, headers=prov.headers
        )
    except Exception:  # noqa: BLE001 — 防御兜底；不 5xx（error 恒可读）
        error = "unexpected error during connectivity test"
    latency_ms = int((time.monotonic() - t0) * 1000)
    return success_envelope(
        {"ok": error is None, "latencyMs": latency_ms, "error": error},
        request=request,
        source="upstream",
    )
