"""「当前启用的模型全集」的**单源**投影（08-04 飞书 ``/model`` 指令抽取）。

这份聚合原本内联在 ``src/api/routers/chat.py`` 的 ``/chat/config``（``enabledModels``）里。
飞书 IM 的 ``/model`` 指令要用**同一份清单**校验用户输入，照抄一份必然漂移（CLAUDE.md
「跨边界手抄常量必建一致性闸」的第一选择是**消灭镜像**），所以抽到这里；``/chat/config``
改为调用本模块，行为逐字节不变。

🔴 **为什么不是放在 ``src/api/routers/llm_providers.py``**：飞书 worker 跑在
``src/service.py`` 的同步进程里（不是 serve-api），而 ``src/api/app.py`` 在模块顶层
挂载**全部** router —— 从同步进程 ``import src.api.routers.llm_providers`` 会把整个
API 面拖进来。本模块因此**不许 import FastAPI**；``src.api.deps`` 本身是 FastAPI-free
的（顶层只有 functools/typing，其余全 lazy），故 seed 输入解析仍复用它，且在**函数体内**
import（保持本模块 import 期零副作用，裸 worktree 也能 import）。

聚合语义（``MAILAGENT_LLM_PROVIDER_REGISTRY``，task 07-12 P0）：
  - **on** → 遍历 enabled provider × enabled model；``default`` provider 输出**裸 model
    id**（legacy 兼容 —— chat 面板 localStorage 偏好 / report_agent 行零迁移），其余输出
    ``providerId:modelId``；default 恒排最前。聚合任何一步失败 → 整体回退 env 清单
    （never fail ``/chat/config``）。
  - **off**（显式 false 应急回退）→ env ``LLM_ENABLED_MODELS`` 逗号清单**原样**（含顺序）。
    这条路径下不做 provider 分组 —— 分组会重排（``["a:x", "y", "a:z"]`` 会变成
    ``["a:x", "a:z", "y"]``），而这个列表是 ``/chat/config`` 的对外契约。
    ⚠️ 与抽取前的**唯一**差别：解析不出 model_id 的畸形条目（``"foo:"`` / ``":"``）此前原样
    透出、现在丢掉 —— 它们在前端会渲染成一个必然调用失败的可选项，且 ``find`` 本来就永远
    判它们不在册。有测试钉住（``test_flag_off_drops_unparsable_entries``）。

``EnabledModelCatalog.find`` 是「这个 ref 在不在册」的判据单源：按 ``parse_provider_ref``
归一成 ``(provider_id, model_id)`` 再比 —— ``default:claude-x`` 与裸 ``claude-x`` 等价。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Sequence

from dotenv import dotenv_values
from loguru import logger

from src.agent_config.llm_providers import (
    DEFAULT_PROVIDER_ID,
    LlmProviderStore,
    get_llm_provider_store,
    parse_provider_ref,
)

#: ``cfg.llm_model`` 为空串时的兜底（与 ``src/config.py`` 的 pydantic default 同值）。
FALLBACK_DEFAULT_MODEL = "claude-sonnet-4-6"

#: ``EnabledModelCatalog.source`` 值域 —— 清单是从 provider 表聚合的还是 env 回退来的。
SOURCE_REGISTRY = "registry"
SOURCE_ENV = "env"


@dataclass(frozen=True)
class EnabledModel:
    """一个在册可选模型。``ref`` = 消费端要传的规范引用（default provider → 裸 model id）。"""

    ref: str
    provider_id: str
    model_id: str
    display_name: str = ""

    @property
    def label(self) -> str:
        """人读标签：有别名且与 ref 不同才带上，避免「x（x）」这种废话。"""
        if self.display_name and self.display_name != self.ref:
            return f"{self.display_name}（{self.ref}）"
        return self.ref


@dataclass(frozen=True)
class EnabledModelGroup:
    """按 provider 分组（**纯展示**用）。``provider_name`` 为空 = 不分组（env 回退路径）。"""

    provider_id: str
    provider_name: str
    models: tuple[EnabledModel, ...]


@dataclass(frozen=True)
class EnabledModelCatalog:
    groups: tuple[EnabledModelGroup, ...] = ()
    default_model: str = ""
    source: str = SOURCE_ENV

    @property
    def refs(self) -> list[str]:
        """扁平 ref 列表（``/chat/config.enabledModels`` 的对外形状）。"""
        return [m.ref for g in self.groups for m in g.models]

    def find(self, ref: str) -> Optional[EnabledModel]:
        """``ref`` 在不在册（归一比较，``default:x`` ≡ 裸 ``x``）；不在 → None。"""
        provider_id, model_id = parse_provider_ref((ref or "").strip())
        if not model_id:
            return None
        for group in self.groups:
            for model in group.models:
                if model.provider_id == provider_id and model.model_id == model_id:
                    return model
        return None


# ---------------------------------------------------------------------------
# seed（惰性，provider 表空时把现有 env 配置落成 default provider 行）
# ---------------------------------------------------------------------------


def read_env_enabled_models() -> list[str]:
    """热读 ``.env`` 的 ``LLM_ENABLED_MODELS``（逗号清单）。读不到 → ``[]``。

    该键无 pydantic 字段，读法与 ``/chat/config`` 一致（``dotenv_values`` 绕单例，改
    ``.env`` 即时生效）。
    """
    try:
        from src.api.deps import get_env_file_path

        env_path = get_env_file_path()
        if not env_path:
            return []
        raw = (dotenv_values(env_path) or {}).get("LLM_ENABLED_MODELS") or ""
    except Exception:  # noqa: BLE001 — enabled models 是 best-effort 热读
        return []
    return [m.strip() for m in raw.split(",") if m.strip()]


def _resolve_seed_inputs() -> dict[str, Any]:
    """seed 输入（prd §4.1）：pydantic 单例的 base/key/model + 热读 .env 的 enabled 清单。"""
    from src.api.deps import get_settings

    cfg: Any = get_settings()
    return {
        "api_base": (getattr(cfg, "llm_api_base", "") or "").strip(),
        "api_key": (getattr(cfg, "llm_api_key", "") or "").strip(),
        "model": (getattr(cfg, "llm_model", "") or "").strip(),
        "enabled_models": read_env_enabled_models(),
    }


def ensure_seeded_store() -> LlmProviderStore:
    """取 store 单例并保证 seed 已执行（幂等：有任何 provider 行即跳过）。

    ``/api/llm/providers*`` 的读端点与本模块的聚合共用这一个 seed 入口。seed 失败
    （裸 worktree 缺 .env 等）不阻断读 —— 空表照常返回。
    """
    store = get_llm_provider_store()
    if not store.has_providers():
        try:
            store.seed_default_from_env(**_resolve_seed_inputs())
        except Exception:  # noqa: BLE001 — seed 是 best-effort；空表可用
            logger.warning("llm provider seed skipped (settings unavailable)")
    return store


# ---------------------------------------------------------------------------
# 聚合
# ---------------------------------------------------------------------------


def _flat_catalog(
    refs: Sequence[str], *, default_model: str, source: str
) -> EnabledModelCatalog:
    """把一串 ref **原序**装成单组 catalog（env 回退路径：不分组、不重排）。"""
    models: list[EnabledModel] = []
    for raw in refs:
        ref = (raw or "").strip()
        if not ref:
            continue
        provider_id, model_id = parse_provider_ref(ref)
        if not model_id:
            continue
        models.append(
            EnabledModel(ref=ref, provider_id=provider_id, model_id=model_id)
        )
    groups = (
        (EnabledModelGroup(provider_id="", provider_name="", models=tuple(models)),)
        if models
        else ()
    )
    return EnabledModelCatalog(
        groups=groups, default_model=default_model, source=source
    )


def build_enabled_model_catalog(
    *,
    registry_enabled: bool,
    env_models: Sequence[str],
    default_model: str = "",
) -> EnabledModelCatalog:
    """聚合当前可选模型全集。``env_models`` = 已热读的 env 清单（flag off / 聚合失败的回退）。"""
    env_catalog = _flat_catalog(
        env_models, default_model=default_model, source=SOURCE_ENV
    )
    if not registry_enabled:
        return env_catalog
    try:
        store = ensure_seeded_store()
        default_group: Optional[EnabledModelGroup] = None
        other_groups: list[EnabledModelGroup] = []
        for provider in store.list_providers():
            if not provider.enabled:
                continue
            is_default = provider.id == DEFAULT_PROVIDER_ID
            models = [
                EnabledModel(
                    ref=m.model_id if is_default else f"{provider.id}:{m.model_id}",
                    provider_id=provider.id,
                    model_id=m.model_id,
                    display_name=(m.display_name or "").strip(),
                )
                for m in store.list_models(provider.id)
                if m.enabled
            ]
            if not models:
                continue
            group = EnabledModelGroup(
                provider_id=provider.id,
                provider_name=(provider.display_name or "").strip() or provider.id,
                models=tuple(models),
            )
            if is_default:
                default_group = group
            else:
                other_groups.append(group)
        groups = ([default_group] if default_group is not None else []) + other_groups
    except Exception:  # noqa: BLE001 — best-effort；聚合失败整体回退 env 清单
        return env_catalog
    return EnabledModelCatalog(
        groups=tuple(groups), default_model=default_model, source=SOURCE_REGISTRY
    )


def load_enabled_model_catalog() -> EnabledModelCatalog:
    """自解析 flag + env + 默认模型的便利入口（非 FastAPI 调用方用，如飞书 IM 桥）。

    ``/chat/config`` **不**走这里 —— 它已经手上有 cfg 与热读的 env 值，直接调
    ``build_enabled_model_catalog`` 免得重复读一遍 ``.env``。
    """
    registry_on = False
    default_model = ""
    try:
        from src.api.deps import get_settings

        cfg: Any = get_settings()
        registry_on = bool(getattr(cfg, "llm_provider_registry_enabled", False))
        default_model = (getattr(cfg, "llm_model", "") or "").strip()
    except Exception:  # noqa: BLE001 — 配置读不到不该让调用方炸；按 flag off 兜底
        logger.warning("[enabled-models] settings unavailable — falling back to env list")
    return build_enabled_model_catalog(
        registry_enabled=registry_on,
        env_models=read_env_enabled_models(),
        default_model=default_model or FALLBACK_DEFAULT_MODEL,
    )
