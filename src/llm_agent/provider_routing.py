"""providerRef → 上游 provider 路由解析（task 07-12 P2，prd §4.3 / §4.3b）。

flag ``MAILAGENT_LLM_PROVIDER_REGISTRY``（pydantic ``cfg.llm_provider_registry_enabled``，
默认 off）关闭时 ``resolve_route`` 恒返回 None —— 消费端（client.py / mem0_engine.py）走
legacy 前缀路由 + 全局 env 配置，字节级不变。

on 时：``parse_provider_ref`` 切 ``providerId:modelId``（无冒号 → default，legacy 兼容）→
查 ``agent_config.db`` 的 ``llm_provider``/``llm_model`` 表（**30s TTL 快照热读**，镜像
serve-api 热读先例 —— 不进 pydantic 冻结单例，CRUD 后 ≤30s 生效，勿每 call 开 DB）→ 产出
``ProviderRoute``（协议 + per-provider base/key/headers 解密值 + per-model max_output）。

fail-open（prd §4.3，保 chat 不死）：provider 行缺失 / 被禁用（snapshot 只含 enabled 行）/
快照读失败 → None，调用方回退全局 env 配置 + 前缀路由。

baseURL 归一（research/01 §7「三种拼接规则」的统一点，本模块是双腿共用单源）：
  - anthropic 腿：AsyncAnthropic 自动追加 ``/v1/messages`` —— 行值**原样**（只去尾 ``/``）。
    CRS ``https://crs.chenge.ink/api`` 与 DeepSeek/Kimi/GLM 的 anthropic-compat 端点
    ``https://api.deepseek.com/anthropic`` 同语义。空 → None（SDK 官方默认 api.anthropic.com）。
  - openai 腿：行值已以 ``/v<N>`` 结尾（dashscope ``.../compatible-mode/v1``）→ 原样；否则补
    ``/v1``（裸域名 ``https://api.deepseek.com`` / CRS ``.../api``）。返回值 +
    ``/chat/completions`` 即 wire URL。
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from loguru import logger

from src.agent_config.llm_providers import (
    DEFAULT_PROVIDER_ID,
    get_llm_provider_store,
    parse_provider_ref,
)
from src.config import config as cfg

# openai 协议族：全走 httpx OpenAI Chat Completions 腿（prd §4.3；google v1 不支持）。
OPENAI_FAMILY_PROTOCOLS = ("openai", "openai-compatible", "deepseek", "openrouter")

# base_url 空 = 官方默认（prd §4.1）。anthropic 空由 SDK 默认兜底不在此表；
# openai-compatible 无官方默认（base 必配，缺 = 配置错误，调用方报错走 fallback 链）。
_PROTOCOL_DEFAULT_BASE = {
    "openai": "https://api.openai.com",
    "deepseek": "https://api.deepseek.com",
    "openrouter": "https://openrouter.ai/api/v1",
}

_SNAPSHOT_TTL_SEC = 30.0

_V_SUFFIX_RE = re.compile(r"/v\d+$")


@dataclass(frozen=True)
class ProviderRoute:
    """一次 LLM 调用的路由决议：provider 行 + wire model id + per-model clamp 依据。"""

    provider_id: str
    protocol: str
    base_url: str  # 行原样存储值（空 = 官方默认）；归一化由消费 helper 做
    api_key: str  # 解密明文（空 = 行无 key）
    headers: Dict[str, str] = field(default_factory=dict)
    model_id: str = ""  # wire model id（providerRef 冒号后段；legacy 无冒号 = 整串）
    model_ref: str = ""  # 原始引用（日志/统计口径）
    max_output: Optional[int] = None  # llm_model.max_output（NULL = 不 clamp）

    @property
    def is_default(self) -> bool:
        return self.provider_id == DEFAULT_PROVIDER_ID


def registry_enabled() -> bool:
    """flag 读取单点（pydantic 冻结单例，翻转需重启 —— 镜像其它 pydantic flag 纪律）。"""
    return bool(getattr(cfg, "llm_provider_registry_enabled", False))


def normalize_anthropic_base(base_url: str) -> Optional[str]:
    """anthropic 腿 base：行值原样（只去尾 ``/``）；空 → None（AsyncAnthropic 官方默认）。"""
    base = (base_url or "").strip().rstrip("/")
    return base or None


def normalize_openai_base(base_url: str) -> str:
    """openai 腿 base 归一：已以 ``/v<N>`` 结尾 → 原样；否则补 ``/v1``；空 → ''。

    返回值即 httpx base_url，POST 路径恒 ``/chat/completions``。
    """
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return ""
    if _V_SUFFIX_RE.search(base):
        return base
    return base + "/v1"


def openai_base_for(route: ProviderRoute) -> str:
    """openai 腿的 httpx base（已归一含 /vN）。行 base 空 → 按 protocol 官方默认；
    openai-compatible 无官方默认 → ''（配置错误，调用方对该模型报错走 fallback 链）。"""
    raw = (route.base_url or "").strip() or _PROTOCOL_DEFAULT_BASE.get(route.protocol, "")
    return normalize_openai_base(raw)


def clamp_max_tokens(requested: int, route: Optional[ProviderRoute]) -> int:
    """per-model max_output clamp（prd §4.2/§4.3）：行值非 NULL → min(requested, max_output)。"""
    if route is not None and route.max_output:
        return min(int(requested), int(route.max_output))
    return int(requested)


# ---------------------------------------------------------------------------
# 快照 TTL 缓存（30s；读失败沿用旧值 fail-open，且刷新时间戳防 per-call 重试风暴）
# ---------------------------------------------------------------------------

_cache_lock = threading.Lock()
_cache: Dict[str, Any] = {"ts": 0.0, "snapshot": None}


def _snapshot() -> Optional[Dict[str, Any]]:
    now = time.monotonic()
    with _cache_lock:
        cached = _cache["snapshot"]
        if cached is not None and now - _cache["ts"] < _SNAPSHOT_TTL_SEC:
            return cached
    try:
        fresh: Optional[Dict[str, Any]] = get_llm_provider_store().snapshot()
    except Exception as e:  # noqa: BLE001 — 配置读失败不挡 LLM 调用（fail-open）
        logger.warning(
            "[llm-provider] snapshot read failed — keeping previous snapshot: {!r}", e
        )
        fresh = None
    with _cache_lock:
        if fresh is not None:
            _cache["snapshot"] = fresh
        # 失败也刷新 ts：沿用旧值（可能 None）并退避 30s，避免坏库时每 call 重试+刷屏。
        _cache["ts"] = now
        return _cache["snapshot"]


def reset_provider_route_cache() -> None:
    """test-only：清 TTL 快照缓存（切换 db 路径 / 写行后立即可见）。"""
    with _cache_lock:
        _cache["snapshot"] = None
        _cache["ts"] = 0.0


def resolve_route(model_ref: str) -> Optional[ProviderRoute]:
    """providerRef → ProviderRoute；None = 走 legacy 路径（flag off / fail-open）。

    模型行不存在也可路由（手填 ref 合法，max_output=None 不 clamp）；模型行 enabled 只驱动
    选择器可选集，不在此处拦截（直填配置串仍可用）。
    """
    if not registry_enabled():
        return None
    provider_id, model_id = parse_provider_ref(model_ref or "")
    snap = _snapshot()
    if not snap:
        return None
    provider = next(
        (p for p in snap.get("providers") or [] if p.get("id") == provider_id), None
    )
    if provider is None:
        return None  # fail-open：行缺失/禁用 → 全局配置 + 前缀路由
    max_output: Optional[int] = None
    for m in provider.get("models") or []:
        if m.get("id") == model_id:
            mo = m.get("maxOutput")
            max_output = int(mo) if mo else None
            break
    return ProviderRoute(
        provider_id=provider_id,
        protocol=provider.get("protocol") or "anthropic",
        base_url=provider.get("baseUrl") or "",
        api_key=provider.get("apiKey") or "",
        headers=dict(provider.get("headers") or {}),
        model_id=model_id,
        model_ref=model_ref,
        max_output=max_output,
    )
