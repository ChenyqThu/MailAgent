"""外部服务授权凭证的通用保管层（阶段 0a）—— Fernet 密文落 ``agent_config.db`` 的
``external_credential`` 表，**payload 形状不可知**。

**存什么**：不属于本机、由外部服务签发的授权材料 —— MCP connector（Notion / Jira）的 OAuth 2.1
token set 与 OAuth client_info（DCR 注册结果，不持久化就得每次连接重新注册），以及 IM 自建应用的
app 凭证。三者结构完全不同，故 payload 统一按 **JSON 对象**加密存储，本层不校验其形状。

**与 per-skill secret（``secrets.py`` / ``skill_secrets`` 表）的分工**：
  - skill secret 会**注入子进程 env**，故名字必须过 ``src/skills/secret_names.py`` 的 env-regex +
    reserved deny-list（``HTTP_PROXY`` / ``SSL_CERT_FILE`` / ``NODE_OPTIONS`` …）—— 那道闸防的是
    「secret 名覆盖执行环境实现劫持」。
  - 外部凭证**永不进任何 env**，是给 HTTP 客户端带的授权材料。故**刻意不复用**那套校验（两者威胁
    模型无关，混用只会让 deny-list 的意图漂移）；本模块自带一套面向「命名空间寻址」的键名约束。
  - 两张表物理隔离：本模块只读写 ``external_credential``，skill secret API 只读写 ``skill_secrets``，
    互相看不见对方的行。

**加密机制复用，不造第二套**：``encrypt_secret`` / ``decrypt_secret`` 直接来自 ``secrets.py``
（同一把 master key、同一个 Keychain 条目 ``MailAgent-SkillSecrets``、同一个 keyfile fallback）
—— 与 ``llm_providers.py`` 存 provider api_key 的做法一致。**不新增 Keychain service**：多一个
service 就多一个用户要授权/迁移/丢失的对象，而威胁模型（防静态落盘泄漏）完全相同。

🔴 **expires_at 是明文列，peek 路径永不解密**：设置页展示连接健康状态、以及阶段 1 的懒刷新判提前量，
都只需要「什么时候过期」。故 ``peek_credential`` / ``list_credentials`` 只读明文列 —— master key
不可用时这些查询照样成立（Settings 仍能如实显示「已连接、xx 过期」而非整页报错）。

**不做后台刷新 worker**（08-03 修正一）：续期是「用的时候才查、快过期就顺手刷」，归阶段 1 的
connector 客户端；本层只负责存取。
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from loguru import logger

from src.agent_config.secrets import decrypt_secret, encrypt_secret
from src.agent_config.store import ExternalCredentialMeta

# ── 键形状 ───────────────────────────────────────────────────────────────────────────
# namespace = ``<kind>:<provider>``（如 ``connector:notion`` / ``im:feishu``）—— 必须带冒号：
# kind 段让「MCP 连接器」与「IM 应用」这类不同来源在同一张表里天然分区，list 按 namespace 过滤即
# 一个服务的全部凭证。provider 段允许再带 ':' 作实例后缀（``connector:jira:acme``，多账号预留）。
_NAMESPACE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}:[a-z0-9][a-z0-9_.:-]{0,63}$")
# credential_key = 同一 provider 下的凭证槽位（``tokens`` / ``client_info`` / ``app_secret``）。
# 小写 snake —— 与 skill secret 的大写 env 名**刻意不同形**，肉眼即可区分两张表的键。
_CREDENTIAL_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _store():
    from src.agent_config.store import get_agent_config_store

    return get_agent_config_store()


def _validate_key(namespace: str, credential_key: str) -> None:
    """键形状校验（脏键落库 = 之后按 namespace 怎么也查不回来）。非法 → ValueError。"""
    if not isinstance(namespace, str) or not _NAMESPACE_RE.match(namespace):
        raise ValueError(
            f"credential namespace {namespace!r} must match {_NAMESPACE_RE.pattern} "
            "(e.g. 'connector:notion', 'im:feishu')"
        )
    if not isinstance(credential_key, str) or not _CREDENTIAL_KEY_RE.match(credential_key):
        raise ValueError(
            f"credential key {credential_key!r} must match {_CREDENTIAL_KEY_RE.pattern} "
            "(e.g. 'tokens', 'client_info', 'app_secret')"
        )


# ── 公共 API ─────────────────────────────────────────────────────────────────────────


def set_credential(
    namespace: str,
    credential_key: str,
    payload: dict[str, Any],
    *,
    expires_at: Optional[int] = None,
    metadata: Optional[dict[str, Any]] = None,
    store=None,
) -> None:
    """写/替换（upsert）一条外部凭证。``payload`` 任意 JSON 对象，加密后落库。

    - ``expires_at``：epoch 秒，None = 不过期/未知。落**明文列**供 peek。
    - ``metadata``：明文非敏感元数据（账号 label / scope 列表这类展示位）。
      🔴 **调用方责任**：任何凭证值都归 ``payload``，放进 metadata 即等于明文落盘。
    - **整行替换**：不传 ``expires_at`` / ``metadata`` 即清空对应列（刷新 token 时留旧到期时间
      会谎报健康状态）。``created_at`` 保留首次落库时间。

    payload / metadata 的值任何形态**不进日志**。
    """
    _validate_key(namespace, credential_key)
    if not isinstance(payload, dict):
        raise ValueError("credential payload must be a JSON object (dict)")
    # bool 是 int 子类 —— 显式拒，否则 expires_at=True 会静默变成 epoch 1。
    if expires_at is not None and (not isinstance(expires_at, int) or isinstance(expires_at, bool)):
        raise ValueError("credential expires_at must be an int (epoch seconds) or None")
    if metadata is not None and not isinstance(metadata, dict):
        raise ValueError("credential metadata must be a JSON object (dict) or None")
    ciphertext = encrypt_secret(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    (store or _store()).upsert_external_credential(
        namespace,
        credential_key,
        ciphertext,
        expires_at=expires_at,
        metadata_json=(
            json.dumps(metadata, ensure_ascii=False, sort_keys=True) if metadata is not None else None
        ),
    )


def get_credential(
    namespace: str, credential_key: str, *, store=None
) -> Optional[dict[str, Any]]:
    """取一条外部凭证的**明文 payload**（无 → None）。调用栈外**不缓存**明文。

    解密失败（master key 轮换 / 密文损坏）或 payload 不是 JSON 对象 → warning + None，语义
    收敛成「没有可用凭证 → 去重新授权」（镜像 ``get_secrets_for_skill`` 的跳过纪律）。此时
    ``peek_credential`` 仍能返回该行元数据，Settings 不会因此显示成「未连接」。
    """
    _validate_key(namespace, credential_key)
    ciphertext = (store or _store()).get_external_credential_ciphertext(namespace, credential_key)
    if ciphertext is None:
        return None
    try:
        payload = json.loads(decrypt_secret(ciphertext))
    except Exception:  # noqa: BLE001 — 值不进异常消息/日志
        logger.warning(
            "failed to decrypt external credential (namespace={}, key={}) — treating as absent",
            namespace,
            credential_key,
        )
        return None
    if not isinstance(payload, dict):
        logger.warning(
            "external credential payload is not a JSON object (namespace={}, key={}) — "
            "treating as absent",
            namespace,
            credential_key,
        )
        return None
    return payload


def peek_credential(
    namespace: str, credential_key: str, *, store=None
) -> Optional[ExternalCredentialMeta]:
    """取一条外部凭证的元数据（含 ``expires_at``）—— 🔴 **不读密文列、不解密**。

    设置页的连接健康状态走这条路径：master key 不可用时依然能如实回答「存了没、什么时候过期」。
    """
    _validate_key(namespace, credential_key)
    return (store or _store()).get_external_credential_meta(namespace, credential_key)


def list_credentials(
    namespace: Optional[str] = None, *, store=None
) -> list[ExternalCredentialMeta]:
    """列凭证元数据（``namespace`` 有值 = 只列该服务的；None = 全部）。同样**不解密**。"""
    if namespace is not None and not (
        isinstance(namespace, str) and _NAMESPACE_RE.match(namespace)
    ):
        raise ValueError(f"credential namespace {namespace!r} must match {_NAMESPACE_RE.pattern}")
    return (store or _store()).list_external_credential_meta(namespace)


def delete_credential(namespace: str, credential_key: str, *, store=None) -> bool:
    """删一条外部凭证（断开连接 / 撤销授权）。幂等（无行 False）。"""
    _validate_key(namespace, credential_key)
    return (store or _store()).delete_external_credential(namespace, credential_key)
