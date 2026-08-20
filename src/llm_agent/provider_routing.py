"""providerRef → 上游 provider 路由解析（task 07-12 P2，prd §4.3 / §4.3b）。

flag ``MAILAGENT_LLM_PROVIDER_REGISTRY``（pydantic ``cfg.llm_provider_registry_enabled``，
默认 on —— 2026-07-13 cutover，env 显式 false 应急回退）关闭时 ``resolve_route`` 恒返回
None —— 消费端（client.py / mem0_engine.py）走 legacy 前缀路由 + 全局 env 配置，字节级不变。

on 时：``parse_provider_ref`` 切 ``providerId:modelId``（无冒号 → default，legacy 兼容）→
查 ``agent_config.db`` 的 ``llm_provider``/``llm_model`` 表（**30s TTL 快照热读**，镜像
serve-api 热读先例 —— 不进 pydantic 冻结单例，CRUD 后 ≤30s 生效，勿每 call 开 DB）→ 产出
``ProviderRoute``（协议 + per-provider base/key/headers 解密值 + per-model max_output）。

fail-open（prd §4.3，保 chat 不死）仅两种情形（review MEDIUM-4）：①快照整体不可读
②无冒号 legacy id 查不到 default 行。显式带冒号的 ref 在 provider 缺失/禁用时抛
``ProviderRouteError``（调用方按该模型失败处理走 fallback 链），绝不静默降级到全局网关。

baseURL 归一（review HIGH-2 统一契约，本模块是 runtime/probe/TS 三消费面共用单源；
DB 行存用户原始输入，只在写入时 trim + 去尾 ``/``）：
  - **canonical_root**（anthropic 协议）= 行值去尾部 ``/v<N>``（若有）。Python
    AsyncAnthropic / mem0 传 canonical_root（SDK 自补 ``/v1/messages``）；probe 打
    ``canonical_root + '/v1/models'``。用户从厂商文档抄来的含 ``/v1`` 地址不再叠成
    ``/v1/v1``。空 → None（SDK 官方默认 api.anthropic.com）。
  - **canonical_api_base**（openai 家族）= 行值已以 ``/v<N>`` 结尾（dashscope
    ``.../compatible-mode/v1``）→ 原样；否则补 ``/v1``（裸域名 ``https://api.deepseek.com``
    / CRS ``.../api``）。runtime 拼 ``+ '/chat/completions'``；probe 打 ``+ '/models'``。
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


class ProviderRouteError(RuntimeError):
    """显式 providerRef 无法按 provider 行路由（provider 缺失/禁用，review MEDIUM-4）。

    调用方须把它当**该模型失败**处理（fallback 链跳下一个 / mem0 回退 legacy 并 warning），
    不得静默降级成全局 env 配置——那会把请求送去非预期网关（数据边界/费用/模型偏差）。
    """


def registry_enabled() -> bool:
    """flag 读取单点（pydantic 冻结单例，翻转需重启 —— 镜像其它 pydantic flag 纪律）。"""
    return bool(getattr(cfg, "llm_provider_registry_enabled", False))


def normalize_anthropic_base(base_url: str) -> Optional[str]:
    """anthropic 腿 canonical_root（review HIGH-2）：去尾 ``/`` 再剥尾部 ``/v<N>``（若有）；
    空 → None（AsyncAnthropic 官方默认）。

    runtime（AsyncAnthropic / mem0 ``anthropic_base_url``）直接吃 canonical_root（SDK 自补
    ``/v1/messages``）；probe 面用 ``canonical_root + '/v1/...'``——三面共享本函数，用户抄来
    含 ``/v1`` 的地址不会被 SDK 叠成 ``/v1/v1/messages``。
    """
    base = (base_url or "").strip().rstrip("/")
    base = _V_SUFFIX_RE.sub("", base)
    return base or None


def normalize_openai_base(base_url: str) -> str:
    """openai 家族 canonical_api_base（review HIGH-2）：已以 ``/v<N>`` 结尾 → 原样；
    否则补 ``/v1``；空 → ''。

    runtime 拼 ``+ '/chat/completions'``；probe 拼 ``+ '/models'``——两面共享本函数。
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


_REDACTED = "***"
# 短于此长度的值不替换：信息量趋零，且会误伤状态码/布尔标志等正常文本。
_MIN_SECRET_LEN = 4


def redact_secrets(
    text: str, *, api_key: str = "", headers: Optional[Dict[str, str]] = None
) -> str:
    """把当前 provider 的秘密值（api_key + 全部自定义 header 值）从文本里替换为 ``***``。

    上游错误正文可能回显请求头（自建中转 / 调试代理 / 恶意 provider——review HIGH-3），
    任何要进 LLMCallError / API 响应 / 日志的上游正文摘要必须先过这里、再截断（顺序反了
    会让被截断的 key 前缀漏网）。按值长度降序替换，防长值先被其前缀短值打断（镜像 S2
    skill secret 脱敏纪律）。
    """
    if not text:
        return text
    values = {api_key or ""}
    values.update((headers or {}).values())
    out = text
    for v in sorted(values, key=len, reverse=True):
        if len(v) >= _MIN_SECRET_LEN:
            out = out.replace(v, _REDACTED)
    return out


def clamp_max_tokens(requested: int, route: Optional[ProviderRoute]) -> int:
    """per-model max_output clamp（prd §4.2/§4.3）：行值非 NULL → min(requested, max_output)。"""
    if route is not None and route.max_output:
        return min(int(requested), int(route.max_output))
    return int(requested)


# per-protocol quirk：强制 tool_choice 轮须额外注入的请求体字段（P5 dogfood 实测）。
_FORCED_TOOL_CHOICE_EXTRA_BODY: Dict[str, Dict[str, Any]] = {
    "deepseek": {"thinking": {"type": "disabled"}},
}


def forced_tool_choice_extra_body(
    protocol: Optional[str], model_id: Optional[str]
) -> Dict[str, Any]:
    """强制 tool_choice 时须 merge 进请求体的 provider/model extra body（quirk 单源）。

    DeepSeek 官方端点实测（2026-07-13，api.deepseek.com，deepseek-v4-flash/-pro）：
    当前模型全系默认 thinking 模式，thinking 下强制指名 tool_choice
    （``{"type":"function","function":{...}}`` 与 ``"required"`` 同拒）→ 400
    "Thinking mode does not support this tool_choice"；``enable_thinking:false``
    不被识别；唯一可行解 = 请求体加 ``{"thinking": {"type": "disabled"}}``。

    2026-08-19 又实测 opencode openai-compatible 中转的 deepseek-v4-flash 在
    thinking 模式下强制 tool_choice 会返回空心参数，因此除 ``protocol='deepseek'``
    外，也按 ``model_id`` 的 ``deepseek`` 前缀识别中转行。代价是会向
    openai-compatible 请求体写入 DeepSeek 私有字段；透传型网关（如 opencode）无碍，
    严格拒绝未知字段的网关可能报错。auto 轮仍不注入（保留 thinking 推理能力），
    由调用方（client.py）保证。
    """
    is_deepseek_model = (model_id or "").lower().startswith("deepseek")
    quirk_protocol = "deepseek" if is_deepseek_model else (protocol or "")
    return dict(_FORCED_TOOL_CHOICE_EXTRA_BODY.get(quirk_protocol, {}))


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

    fail-open（回退全局 env + 前缀路由）仅两种情形（review MEDIUM-4）：①flag off / 快照
    整体不可读（配置面挂了不挡 LLM）②无冒号 legacy id 查不到 default 行（老配置引用天然
    归全局网关）。显式带冒号的 ref 在 provider 缺失/禁用时抛 ``ProviderRouteError``——
    拼错 id / 禁用 provider / 解密失败致行不可用都必须可见，不得静默改道全局网关。

    模型行不存在也可路由（手填 ref 合法，max_output=None 不 clamp）；模型行 enabled 只驱动
    选择器可选集，不在此处拦截（直填配置串仍可用）。
    """
    if not registry_enabled():
        return None
    ref = model_ref or ""
    provider_id, model_id = parse_provider_ref(ref)
    snap = _snapshot()
    if not snap:
        return None  # ① 快照整体不可读 → fail-open（含显式 ref）
    provider = next(
        (p for p in snap.get("providers") or [] if p.get("id") == provider_id), None
    )
    if provider is None:
        if ":" in ref:
            raise ProviderRouteError(
                f"provider '{provider_id}' referenced by model '{ref}' is not available "
                "(missing or disabled in the provider registry)"
            )
        return None  # ② 无冒号 legacy id → fail-open（default 行未 seed 等）
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
