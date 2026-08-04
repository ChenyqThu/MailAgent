"""CHAT_DB 行 → AI SDK UIMessage 历史重建（08-01 阶段 2 PR-3）。

## 为什么客户端要自己送历史（wire 语义实证，勿凭感觉改）

gateway 的 ``prepareChatRun``（``frontend/src/ai-gateway/chatRun.ts:220-425``）对
``body.messages`` **原样** ``convertToModelMessages`` —— 带 ``sessionId`` 只影响
**持久化归宿**（persistTurn 落到哪个 session），**不会**让 gateway 自动拼接历史。
renderer 的多轮 = assistant-ui runtime 自己持有全量消息、每轮全量重发。
⇒ 飞书桥要多轮连续，必须从 CHAT_DB 镜像（``src/chat/db.py::ChatDb.list_messages``）
重建该 session 的 UIMessage 数组，再 append 新 user 消息。**漏了这步 = 多轮假通**
（每轮都是失忆的新对话，只是记录恰好落在同一个 session 里）。

## 重建规则

- 行有 ``ui_message_json``（gateway onFinish 的 canonical 双写，CHAT_DB v9）→ 直接用
  （工具调用 part / approval-responded part 都原样保留 —— renderer 的 resume 重放
  同样带着它们，``convertToModelMessages`` 认识）；
- 没有（legacy 行 / 解析失败）→ 用 ``content`` 合成 ``{role, parts:[{type:'text'}]}``；
- 只认 ``user`` / ``assistant``，空 content 的合成行丢弃；
- 预算裁剪：gateway 有 8 MiB body 上限（``httpUtil.ts::MAX_JSON_BODY_BYTES``，超出
  413），这里按字符预算从**最旧**开始整条丢，并保证裁完后**首条是 user**
  （Anthropic API 要求首条 user；``convertToModelMessages`` 不会替你修）。
  新 user 消息永不被裁。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

# 历史 JSON 字符预算。1.5M 字符 ≈ 最多 ~4.5MiB UTF-8，远低于 gateway 8MiB/413 上限，
# 又远超正常会话量级（超长会话被裁掉最旧几轮，模型侧行为 = renderer 里手动开新会话）。
HISTORY_CHAR_BUDGET = 1_500_000
# 消息条数硬上限（与字符预算取交集）——防病态多轮把 convertToModelMessages 拖慢。
MAX_HISTORY_MESSAGES = 200


def rebuild_ui_message(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """一行 ``ai_chat_messages`` → UIMessage dict；不可用 → None。"""
    raw = row.get("ui_message_json")
    if raw:
        try:
            msg = json.loads(raw)
        except (TypeError, ValueError):
            msg = None
        if (
            isinstance(msg, dict)
            and msg.get("role") in ("user", "assistant")
            and isinstance(msg.get("parts"), list)
        ):
            if not msg.get("id"):
                msg["id"] = f"db-{row.get('id')}"
            return msg
    role = row.get("role")
    if role not in ("user", "assistant"):
        return None
    content = row.get("content") or ""
    if not content.strip():
        return None
    return {
        "id": f"db-{row.get('id')}",
        "role": role,
        "parts": [{"type": "text", "text": content}],
    }


def build_history(
    rows: List[Dict[str, Any]],
    new_text: str,
    new_message_id: str,
    *,
    char_budget: int = HISTORY_CHAR_BUDGET,
    max_messages: int = MAX_HISTORY_MESSAGES,
) -> List[Dict[str, Any]]:
    """历史行 + 新 user 消息 → 发给 ``/api/ai/im-chat`` 的 ``messages`` 数组。"""
    messages = [m for m in (rebuild_ui_message(r) for r in rows) if m is not None]
    messages.append(
        {
            "id": new_message_id or "im-msg",
            "role": "user",
            "parts": [{"type": "text", "text": new_text}],
        }
    )

    # 按预算从最旧整条丢（新 user 消息 = 最后一条，永不被裁）。
    sizes = [len(json.dumps(m, ensure_ascii=False)) for m in messages]
    total = sum(sizes)
    start = 0
    n = len(messages)
    while n - start > 1 and (n - start > max_messages or total > char_budget):
        total -= sizes[start]
        start += 1
    # 裁完首条必须是 user（历史以 assistant 开头会被上游 API 拒）。
    while n - start > 1 and messages[start].get("role") != "user":
        total -= sizes[start]
        start += 1
    return messages[start:]
