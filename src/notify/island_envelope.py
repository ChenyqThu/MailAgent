"""Ping-island BridgeEnvelope 构造层（Island-Sprint 2）.

Wire 协议来源：``frontend/ISLAND-PLUGIN.md`` §3.2 + §3.3 + REVIEW-LOG H-11/H-16/H-18/M-15。

设计要点：
- ``provider`` 固定 ``"mail"`` —— fork 已加 ``BridgeProvider.mail`` 解码（Phase 1 完成）
- ``sentAt`` 是 Swift Date 编码（自 2001-01-01 UTC 秒数）：``time.time() - 978307200``
- envelope JSON 序列化后必须 ≤ 64 KiB，超出时优先截 ``metadata``（subject/preview 保留）
- ``id`` 用 UUID v4，``intervention.id`` 也用 UUID v4
- ``notionPageId`` 用 dash 格式 UUID（``§3.4`` 用 ``.replace('-', '')`` 拼 deep-link）
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Swift 用 2001-01-01 00:00:00 UTC 为 epoch (`NSDate`/`Date.timeIntervalSinceReferenceDate`).
# Unix epoch 1970-01-01 → Swift epoch 偏移 = 978307200 秒。
# REVIEW-LOG M-15: IEEE 754 double 在 ±50 年范围内毫秒级误差 < 0.1ms。
SWIFT_DATE_EPOCH_OFFSET = 978307200.0

# REVIEW-LOG H-18: envelope JSON 上限 64 KiB
ENVELOPE_MAX_BYTES = 64 * 1024


def swift_now() -> float:
    """生成 Swift Date 兼容时间戳（自 2001-01-01 UTC 秒数）."""
    return time.time() - SWIFT_DATE_EPOCH_OFFSET


@dataclass
class InterventionOption:
    """灵动岛展开后用户可点的单个选项."""

    id: str
    title: str
    detail: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "title": self.title}
        if self.detail:
            out["detail"] = self.detail
        return out


@dataclass
class Intervention:
    """``intervention`` 字段：question + options 让用户在灵动岛 Phase 3 expand 时点选."""

    title: str
    message: str
    options: List[InterventionOption]
    kind: str = "question"
    session_id: Optional[str] = None
    raw_context: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(uuid.uuid4()),
            "sessionID": self.session_id or "",
            "kind": self.kind,
            "title": self.title,
            "message": self.message,
            "options": [opt.to_dict() for opt in self.options],
            "rawContext": self.raw_context,
        }


@dataclass
class BridgeEnvelope:
    """ping-island 协议 envelope (Python → Swift)."""

    event_type: str
    session_key: str
    title: str
    preview: str = ""
    status_kind: str = "notification"  # notification | waitingForInput | completed | error
    status_detail: Optional[str] = None
    metadata: Dict[str, str] = field(default_factory=dict)
    intervention: Optional[Intervention] = None
    expects_response: bool = False
    cwd: Optional[str] = None
    terminal_context: Dict[str, Any] = field(default_factory=dict)
    envelope_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_wire_dict(self) -> Dict[str, Any]:
        """生成可 ``json.dumps`` 的 dict（不做大小裁剪）."""
        status: Dict[str, Any] = {"kind": self.status_kind, "detail": self.status_detail}
        body: Dict[str, Any] = {
            "id": self.envelope_id,
            "provider": "mail",
            "eventType": self.event_type,
            "sessionKey": self.session_key,
            "title": self.title,
            "preview": self.preview,
            "cwd": self.cwd,
            "status": status,
            "terminalContext": self.terminal_context,
            "intervention": (
                self.intervention.to_dict() if self.intervention is not None else None
            ),
            "expectsResponse": self.expects_response,
            "metadata": {k: str(v) for k, v in self.metadata.items()},
            "sentAt": swift_now(),
        }
        # 顶上注入 sessionID 供 intervention.sessionID fallback
        if self.intervention is not None and not body["intervention"].get("sessionID"):
            body["intervention"]["sessionID"] = self.session_key
        return body

    def encode(self, max_bytes: int = ENVELOPE_MAX_BYTES) -> bytes:
        """序列化为 UTF-8 JSON bytes；超 ``max_bytes`` 时优先裁剪 metadata.

        裁剪策略（保留 subject/preview/intervention，按值长度降序丢 metadata）：
          1. 先尝试完整序列化
          2. 超限 → 删除最长的 metadata 值，留 key 占位 ``"<truncated>"``
          3. 还超 → 截短 preview 到 200 字符
          4. 仍超 → log warning 但返回最后一次序列化结果（外层 fail-open）
        """
        body = self.to_wire_dict()
        data = _dumps(body)
        if len(data) <= max_bytes:
            return data

        # round 2: 删长 metadata 值
        meta: Dict[str, str] = body.get("metadata", {})
        if meta:
            ordered = sorted(meta.items(), key=lambda kv: len(kv[1] or ""), reverse=True)
            for k, _v in ordered:
                meta[k] = "<truncated>"
                data = _dumps(body)
                if len(data) <= max_bytes:
                    return data

        # round 3: 截 preview
        preview = body.get("preview") or ""
        if len(preview) > 200:
            body["preview"] = preview[:200] + "…"
            data = _dumps(body)
            if len(data) <= max_bytes:
                return data

        return data  # 由调用方决定是否丢弃；ping_island.send_sync 会再做尺寸 guard


def _dumps(body: Dict[str, Any]) -> bytes:
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def build_ping_envelope(session_key: str = "mailagent:system:ping") -> BridgeEnvelope:
    """轻量探测 envelope，给 reconnect_loop 用."""
    return BridgeEnvelope(
        event_type="Notification",
        session_key=session_key,
        title="ping",
        preview="",
        status_kind="notification",
        expects_response=False,
        metadata={"mailagent.kind": "ping"},
    )
