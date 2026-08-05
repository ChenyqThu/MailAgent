"""飞书 IM 连接状态的 ``sync_state`` 键 —— **canonical 单源**（08-01 阶段 2 PR-2）。

🔴 **跨 lane 契约：键名以本模块的 ``STATE_*`` 常量为准，读侧必须 import，勿手抄**
（CLAUDE.md「跨边界手抄常量必建一致性闸」；镜像 ``src/kos/ingest_log.py`` 的
``STATE_*`` 先例）。PR-4 的 Settings「信任可见」面板、CLI、以及任何未来的
``/api/admin/*`` 投影都从这里 import。

键前缀 ``im.feishu.``，与 ``davmail.*`` / ``kos.*`` 同形态 —— 是 sync_state 的普通
KV 行，**不是 schema 变更，不 bump ``DB_VERSION``**。

本模块**只**依赖 ``get_state`` / ``set_state`` 两个方法（``SyncStore`` 的子集），
不 import SyncStore 本身 —— 让 CLI / worker / 测试都能拿一个最小替身进来。

值域约定（``connection_status``）见 ``STATUS_*``；所有读写都 fail-soft：
sync_state 挂掉只是**可观测性**降级，绝不能把长连接本身带崩。
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional, Protocol

from loguru import logger

# ── sync_state 键（canonical，勿手抄）─────────────────────────────────────────
STATE_PREFIX = "im.feishu."

STATE_CONNECTION_STATUS = "im.feishu.connection_status"
STATE_CONNECTED_AT = "im.feishu.connected_at"
STATE_LAST_EVENT_AT = "im.feishu.last_event_at"
STATE_BOUND_OPEN_ID = "im.feishu.bound_open_id"
STATE_BOUND_AT = "im.feishu.bound_at"
STATE_BOT_APP_NAME = "im.feishu.bot_app_name"
STATE_BOT_OPEN_ID = "im.feishu.bot_open_id"
STATE_CONFLICT = "im.feishu.conflict"
STATE_CONFLICT_REASON = "im.feishu.conflict_reason"
STATE_LAST_ERROR = "im.feishu.last_error"
STATE_PAIR_CODE = "im.feishu.pair_code"
STATE_PAIR_CODE_EXPIRES_AT = "im.feishu.pair_code_expires_at"
# PR-3：每个飞书私聊（chat_id）的「当前活跃 chat session id」（CHAT_DB 的
# ai_chat_sessions.id）。动态键 = 前缀 + chat_id（经 ``active_session_key``），
# 跨重启存活 → 多轮对话连续；``/new`` 清掉它 = 下一条消息开新会话。
STATE_ACTIVE_SESSION_PREFIX = "im.feishu.active_session."
# 08-04 ``/model``：每个飞书私聊（chat_id）选定的模型 ref（``providerId:modelId`` 或
# default provider 的裸 model id）。同为动态键 = 前缀 + chat_id（经 ``model_key``）。
# 🔴 与 active_session **有意分开**：``/new`` 只清会话、**不动**模型偏好（换话题不等于
# 换模型），所以两者不能共用一个键、也不能在 ``clear_active_session`` 里连坐。
STATE_MODEL_PREFIX = "im.feishu.model."


def active_session_key(chat_id: str) -> str:
    """``chat_id`` → sync_state 键。空 chat_id（解析兜底）归并到 ``_default``。"""
    return STATE_ACTIVE_SESSION_PREFIX + ((chat_id or "").strip() or "_default")


def model_key(chat_id: str) -> str:
    """``chat_id`` → 模型偏好键（空 chat_id 归并规则同 ``active_session_key``）。"""
    return STATE_MODEL_PREFIX + ((chat_id or "").strip() or "_default")

# ── connection_status 值域 ────────────────────────────────────────────────────
STATUS_DISABLED = "disabled"          # flag off / 凭证缺失 —— worker 根本没起
STATUS_CONNECTING = "connecting"      # 线程已起, 还没握上手
STATUS_CONNECTED = "connected"        # WS 在线
STATUS_DISCONNECTED = "disconnected"  # 曾连上, 现在断了（SDK 正在自动重连）
STATUS_CONFLICT = "conflict"          # 检出另一个实例（pm2 mail-sync）→ 有意不建连
STATUS_ERROR = "error"                # 连接线程 fatal 退出（凭证错 / 非自建应用 …）
STATUS_STOPPED = "stopped"            # 服务正常停机

# ── 告警 episode 键（src/notify/episode.py 的 key 段）───────────────────────────
# 🔴 **一个** episode + **一个 severity marker**（davmail token 的建模，
# davmail_watchdog.py:662-705）：两个平级 episode 会打架 —— 值从 critical 区间回落到
# warning 区间时, critical episode 判 RECOVER 会误报「已恢复」。
# 观测值 = 连续不可用秒数（含 conflict 态：conflict 期间同样是「飞书里指挥不动」，
# 用同一个 episode 才不会一件事告两遍）。
EPISODE_UNAVAILABLE = "im_feishu_disconnected"
EPISODE_UNAVAILABLE_CRITICAL = "im_feishu_disconnected_critical"


class StateKV(Protocol):
    """只用到 sync_state 的 KV 面（``SyncStore`` 的子集）。"""

    def get_state(self, key: str) -> Optional[str]: ...

    def set_state(self, key: str, value: str) -> bool: ...


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class ImFeishuState:
    """``im.feishu.*`` 的读写门面（fail-soft）。

    🔴 **不要在飞书事件 handler 里调它** —— ``set_state`` 是同步 sqlite 写，别的
    writer 持锁时能挂到 busy timeout，而 handler 有 **3 秒**硬预算（超时飞书判失败
    并重推）。handler 只更新内存，落盘交给 worker 的监控 tick 或 executor 线程。
    """

    def __init__(self, store: StateKV) -> None:
        self.store = store

    # ── 原始读写 ──────────────────────────────────────────────────────────
    def get(self, key: str) -> Optional[str]:
        try:
            return self.store.get_state(key)
        except Exception as e:  # noqa: BLE001 — 可观测性绝不拖垮长连接
            logger.debug(f"[im-feishu] state read failed ({key}): {e}")
            return None

    def set(self, key: str, value: str) -> None:
        try:
            self.store.set_state(key, value)
        except Exception as e:  # noqa: BLE001
            logger.debug(f"[im-feishu] state write failed ({key}): {e}")

    # ── 连接状态 ──────────────────────────────────────────────────────────
    def set_status(self, status: str) -> None:
        self.set(STATE_CONNECTION_STATUS, status)

    def get_status(self) -> Optional[str]:
        return self.get(STATE_CONNECTION_STATUS)

    def mark_connected(self) -> None:
        self.set(STATE_CONNECTION_STATUS, STATUS_CONNECTED)
        self.set(STATE_CONNECTED_AT, _now_iso())
        self.set(STATE_LAST_ERROR, "")

    def mark_last_event(self, wall_iso: Optional[str] = None) -> None:
        self.set(STATE_LAST_EVENT_AT, wall_iso or _now_iso())

    def set_last_error(self, detail: str) -> None:
        self.set(STATE_LAST_ERROR, detail)

    # ── 多实例冲突 ────────────────────────────────────────────────────────
    def mark_conflict(self, reason: str) -> None:
        self.set(STATE_CONFLICT, "1")
        self.set(STATE_CONFLICT_REASON, reason)
        self.set(STATE_CONNECTION_STATUS, STATUS_CONFLICT)

    def clear_conflict(self) -> None:
        self.set(STATE_CONFLICT, "0")
        self.set(STATE_CONFLICT_REASON, "")

    def in_conflict(self) -> bool:
        return self.get(STATE_CONFLICT) == "1"

    # ── bot 身份（破「新旧应用同名」陷阱，C6 RESULTS 第 3 条）────────────────
    def set_bot_identity(self, *, app_name: str, open_id: str) -> None:
        self.set(STATE_BOT_APP_NAME, app_name or "")
        self.set(STATE_BOT_OPEN_ID, open_id or "")

    # ── 会话映射（PR-3：飞书私聊 ↔ CHAT_DB session）───────────────────────
    def get_active_session(self, chat_id: str) -> Optional[int]:
        """当前活跃 session id；无 / 非法 / 非正数 → None（= 下一轮让 gateway 建新会话）。"""
        raw = (self.get(active_session_key(chat_id)) or "").strip()
        if not raw:
            return None
        try:
            n = int(raw)
        except (TypeError, ValueError):
            return None
        return n if n > 0 else None

    def set_active_session(self, chat_id: str, session_id: int) -> None:
        self.set(active_session_key(chat_id), str(int(session_id)))

    def clear_active_session(self, chat_id: str) -> None:
        self.set(active_session_key(chat_id), "")

    # ── 模型偏好（08-04 ``/model``：跨重启存活、``/new`` 不重置）──────────────
    def get_model_pref(self, chat_id: str) -> str:
        """该私聊选定的模型 ref；未选 → ``""``（= 用默认模型）。"""
        return (self.get(model_key(chat_id)) or "").strip()

    def set_model_pref(self, chat_id: str, model_ref: str) -> None:
        """🔴 只写**已对在册清单校验过**的 canonical ref —— 没在册的 ref 传到 gateway
        会让 ``createProviderRegistry`` 抛裸 Error、响应永不写出（调用侧读超时 30min）。"""
        self.set(model_key(chat_id), (model_ref or "").strip())

    def clear_model_pref(self, chat_id: str) -> None:
        self.set(model_key(chat_id), "")

    # ── owner 绑定 ────────────────────────────────────────────────────────
    def get_bound_open_id(self) -> str:
        return (self.get(STATE_BOUND_OPEN_ID) or "").strip()

    def set_bound_open_id(self, open_id: str) -> None:
        self.set(STATE_BOUND_OPEN_ID, open_id)
        self.set(STATE_BOUND_AT, _now_iso() if open_id else "")

    def snapshot(self) -> dict:
        """当前 ``im.feishu.*`` 全量（CLI / PR-4 设置页读这个）。**不含绑定码**。"""
        return {
            "connection_status": self.get(STATE_CONNECTION_STATUS) or STATUS_DISABLED,
            "connected_at": self.get(STATE_CONNECTED_AT) or "",
            "last_event_at": self.get(STATE_LAST_EVENT_AT) or "",
            "bound_open_id": self.get_bound_open_id(),
            "bound_at": self.get(STATE_BOUND_AT) or "",
            "bot_app_name": self.get(STATE_BOT_APP_NAME) or "",
            "bot_open_id": self.get(STATE_BOT_OPEN_ID) or "",
            "conflict": self.in_conflict(),
            "conflict_reason": self.get(STATE_CONFLICT_REASON) or "",
            "last_error": self.get(STATE_LAST_ERROR) or "",
        }
