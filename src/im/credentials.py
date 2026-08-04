"""飞书对话 bot 的应用凭证 —— env 首次 seed → ``external_credential`` 行权威。

存储走阶段 0a 就为此预留的通用保管层（``src/agent_config/credentials.py``，
namespace 形状 ``<kind>:<provider>``，docstring 里点名的示例正是 ``im:feishu``）：
Fernet 密文落 ``agent_config.db``，master key 在 Keychain。

**seed 语义（镜像 LLM provider registry 先例）**：
  - 表里**没有**这一行且 env 两键都在 → 写进去（一次性）；
  - 表里**有**行 → **行权威**，env 之后怎么改都不影响运行时；
  - 表里没有、env 也没有 → 没有可用凭证，worker 不起（不是错误，是「没配」）。

``metadata_json`` 是**明文**展示位（``set_credential`` 的红字：任何凭证值都归
payload）。这里只放 bot 身份：``app_name`` + bot ``open_id`` —— 用来破 C6 实证的
**同名陷阱**（owner 环境里对话 app 与通知 app 都叫「MailAgent」，光看名字分不出在跟
哪个 bot 说话）。PR-4 的设置页直接展示这两个字段。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from loguru import logger

# namespace / key 形状受 src/agent_config/credentials.py 的正则约束
# （namespace 必须带冒号；credential_key 小写 snake）。
NAMESPACE = "im:feishu"
KEY_APP_ID = "app_id"
KEY_APP_SECRET = "app_secret"

# seed 结果（供日志/测试判读，别用裸 bool —— 「没 seed」有两种完全不同的原因）
SEED_ROW_EXISTS = "row_exists"      # 已有行 → 行权威，什么都不做
SEED_WROTE = "seeded"               # 从 env 写了新行
SEED_NO_ENV = "no_env"              # 无行且 env 没配 → 未配置


@dataclass(frozen=True)
class FeishuAppCredentials:
    """一对可用的自建应用凭证。``app_secret`` 绝不进日志 / 绝不进 repr 之外的任何地方。"""

    app_id: str
    app_secret: str

    def __repr__(self) -> str:  # pragma: no cover - 防手滑打印
        return f"FeishuAppCredentials(app_id={self.app_id[:8]}…, app_secret=***)"


def load_credentials(*, store: Any = None) -> Optional[FeishuAppCredentials]:
    """读回一对完整凭证；任一缺失 / 解密失败 → None（语义 = 「没有可用凭证」）。"""
    from src.agent_config.credentials import get_credential

    app_id = _extract(get_credential(NAMESPACE, KEY_APP_ID, store=store), KEY_APP_ID)
    app_secret = _extract(
        get_credential(NAMESPACE, KEY_APP_SECRET, store=store), KEY_APP_SECRET
    )
    if not app_id or not app_secret:
        return None
    return FeishuAppCredentials(app_id=app_id, app_secret=app_secret)


def seed_from_env(cfg: Any, *, store: Any = None) -> str:
    """无行时用 env（``FEISHU_IM_APP_ID`` / ``_SECRET``）种一次；有行则原样不动。

    返回 ``SEED_*`` 之一。**不抛** —— 凭证层挂了只该让 worker 不起，不该让 serve 起不来。
    """
    from src.agent_config.credentials import set_credential

    existing = load_credentials(store=store)
    if existing is not None:
        return SEED_ROW_EXISTS

    env_app_id = (getattr(cfg, "feishu_im_app_id", "") or "").strip()
    env_secret = (getattr(cfg, "feishu_im_app_secret", "") or "").strip()
    if not env_app_id or not env_secret:
        return SEED_NO_ENV

    set_credential(NAMESPACE, KEY_APP_ID, {KEY_APP_ID: env_app_id}, store=store)
    set_credential(NAMESPACE, KEY_APP_SECRET, {KEY_APP_SECRET: env_secret}, store=store)
    logger.info(
        "[im-feishu] 凭证已从 env 首次 seed 进 external_credential "
        f"(namespace={NAMESPACE}, app_id={env_app_id[:8]}…) —— 此后**行权威**，"
        "改 FEISHU_IM_APP_ID/SECRET 不再影响运行时"
    )
    return SEED_WROTE


def ensure_credentials(cfg: Any, *, store: Any = None) -> Optional[FeishuAppCredentials]:
    """seed（若需要）后读回。凭证层任何异常 → warning + None，绝不上抛。"""
    try:
        seed_from_env(cfg, store=store)
        return load_credentials(store=store)
    except Exception as e:  # noqa: BLE001 — 值不进日志
        from src.im.logfmt import describe_error

        logger.warning(f"[im-feishu] 凭证读取失败（按未配置处理）: {describe_error(e)}")
        return None


def record_bot_identity(
    *, app_id: str, app_name: str, bot_open_id: str, store: Any = None
) -> bool:
    """把首次连上后拿到的 bot 身份回填 ``app_id`` 行的**明文** ``metadata_json``。

    🔴 ``set_credential`` 是**整行替换**（不传 metadata 即清空该列），所以必须连
    payload 一起重写 —— 这里先读回 payload 再写，读不到就放弃（宁可没有展示位，
    也不能把凭证行写坏）。失败只 warning：这是展示位，不是功能。
    """
    from src.agent_config.credentials import get_credential, set_credential

    try:
        payload = get_credential(NAMESPACE, KEY_APP_ID, store=store)
        if not payload:
            return False
        set_credential(
            NAMESPACE,
            KEY_APP_ID,
            payload,
            metadata={
                "app_id": app_id,
                "app_name": app_name,
                "bot_open_id": bot_open_id,
            },
            store=store,
        )
        return True
    except Exception as e:  # noqa: BLE001
        from src.im.logfmt import describe_error

        logger.warning(f"[im-feishu] bot 身份回填 metadata 失败（不影响连接）: {describe_error(e)}")
        return False


def _extract(payload: Optional[dict], key: str) -> str:
    if not isinstance(payload, dict):
        return ""
    value = payload.get(key)
    return value.strip() if isinstance(value, str) else ""
