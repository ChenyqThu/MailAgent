"""通用审批卡 JSON（08-01 阶段 2 PR-3，Q13=B）。

**一张统一卡片**：「AI 请求执行 <toolName>」+ inputPreview 摘要 + [批准][拒绝]
两个 callback 按钮；点击后 PATCH 成终态卡（已批准 / 已拒绝 / 已失效 / 出错）。
卡片 JSON 形状照 C6 spike 已验证样板（``research/c6-spike/c6_spike.py``）：
schema 2.0 + ``config.update_multi: true``（后续 PATCH 才对所有接收者生效）+
裸 callback 按钮 ``behaviors: [{type:"callback", value:{...}}]``。

纯 JSON 构造，零 lark / 零网络 —— 完全离线可测。

## value 契约（``card.action.trigger`` 回来时原样带回）

``{"kind": "im_approval", "approval_id", "decision", "session_id", "chat_id",
"tool_name", "input_preview"}``
—— ``kind`` 是路由判据（区分未来其他卡）；``decision`` 直接就是 gateway
``/decide`` 认的白名单值（``'approve'`` / ``'reject'``，``server.ts:964-971``
fail-closed，别的字符串会被 400）；``tool_name`` / ``input_preview`` 随 value
回带是为了 PATCH 终态卡时**不依赖 stash 还活着**（点「已失效」的卡时 stash
已经没了，还得把卡渲染成有内容的终态）。preview 来自 gateway ``/pending``，
已被 ``approvalInputPreview`` 截断到 ≤180 字符，塞 value 无压力。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# 卡片回调 value 的路由判据。
CARD_VALUE_KIND = "im_approval"

# 终态卡的语气/配色（飞书 header template 色板）。
_TEMPLATE_PENDING = "blue"
_TEMPLATE_APPROVED = "green"
_TEMPLATE_REJECTED = "red"
_TEMPLATE_INVALID = "grey"
_TEMPLATE_ERROR = "orange"

_HEADER_TITLE = "AI 请求执行操作"

# PR-4：destructive 红警告。措辞对齐桌面 ``McpApprovalCard`` 的
# ``chat.mcpApprovalCard.destructiveWarning``（zh-CN：「破坏性操作：服务方标记此工具
# 可能覆盖既有数据。」）—— 同一件事在两个界面必须是同一句话，否则用户会以为是两回事。
# 判据来自 MCP 服务方 manifest 的 ``destructive_hint``，经 gateway stash → ``/pending``
# 透出；**绝不从模型参数推断**（模型不能把自己的警告说没）。
DESTRUCTIVE_WARNING = "破坏性操作：服务方标记此工具可能覆盖既有数据。"


def _base_card(
    *,
    title: str,
    subtitle: str,
    template: str,
    elements: List[Dict[str, Any]],
) -> Dict[str, Any]:
    return {
        "schema": "2.0",
        # update_multi=true → 后续 PATCH 更新对所有接收者生效（C6 实证必须带）
        "config": {"width_mode": "fill", "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "subtitle": {"tag": "plain_text", "content": subtitle},
            "template": template,
        },
        "body": {
            "direction": "vertical",
            "vertical_spacing": "8px",
            "elements": elements,
        },
    }


def _summary_markdown(tool_name: str, input_preview: str) -> Dict[str, Any]:
    preview = (input_preview or "").strip() or "（无参数摘要）"
    return {
        "tag": "markdown",
        "content": f"**工具**：`{tool_name or '(unknown)'}`\n**参数摘要**：{preview}",
    }


def _button(
    label: str, btn_type: str, value: Dict[str, Any]
) -> Dict[str, Any]:
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": label},
        "type": btn_type,
        "behaviors": [{"type": "callback", "value": value}],
    }


def build_action_value(
    *,
    approval_id: str,
    decision: str,
    session_id: Optional[int],
    chat_id: str,
    tool_name: str = "",
    input_preview: str = "",
) -> Dict[str, Any]:
    return {
        "kind": CARD_VALUE_KIND,
        "approval_id": approval_id,
        "decision": decision,
        "session_id": session_id,
        "chat_id": chat_id,
        "tool_name": tool_name,
        "input_preview": input_preview,
    }


def build_approval_card(
    *,
    tool_name: str,
    input_preview: str,
    approval_id: str,
    session_id: Optional[int],
    chat_id: str,
    destructive: bool = False,
) -> Dict[str, Any]:
    """待决审批卡：摘要（+ destructive 红警告）+ [批准][拒绝]。

    ``destructive`` 只影响多一个红色警告块 —— 它是**提示**不是**闸**：写类工具在
    ``im_chat`` 下本来就恒 HITL，安全地板不因这一行文案变宽或变窄（header 仍是
    pending 的蓝，红色留给「已拒绝」终态，两者不抢同一个颜色语义）。
    """

    def _value(decision: str) -> Dict[str, Any]:
        return build_action_value(
            approval_id=approval_id,
            decision=decision,
            session_id=session_id,
            chat_id=chat_id,
            tool_name=tool_name,
            input_preview=input_preview,
        )

    elements: List[Dict[str, Any]] = [_summary_markdown(tool_name, input_preview)]
    if destructive:
        elements.append(
            {"tag": "markdown", "content": f"<font color='red'>⚠️ {DESTRUCTIVE_WARNING}</font>"}
        )

    return _base_card(
        title=_HEADER_TITLE,
        subtitle=f"{tool_name} · 批准后立即执行，拒绝则不执行",
        template=_TEMPLATE_PENDING,
        elements=[
            *elements,
            {
                "tag": "column_set",
                "flex_mode": "none",
                "columns": [
                    {
                        "tag": "column",
                        "width": "auto",
                        "elements": [_button("✅ 批准", "primary", _value("approve"))],
                    },
                    {
                        "tag": "column",
                        "width": "auto",
                        "elements": [_button("❌ 拒绝", "danger", _value("reject"))],
                    },
                ],
            },
        ],
    )


def build_decided_card(
    *,
    outcome: str,
    tool_name: str,
    input_preview: str,
    detail: str = "",
) -> Dict[str, Any]:
    """终态卡（PATCH 用）。``outcome`` ∈ approved / approved_repaused / rejected /
    invalid / error。未知值按 error 处理（fail-visible，不静默造新形态）。"""
    mapping = {
        "approved": ("✅ 已批准 · 已执行", _TEMPLATE_APPROVED),
        "approved_repaused": ("✅ 已批准 · 还有后续操作待确认", _TEMPLATE_APPROVED),
        "rejected": ("❌ 已拒绝 · 未执行", _TEMPLATE_REJECTED),
        "invalid": ("⚪ 已失效", _TEMPLATE_INVALID),
        "error": ("⚠️ 执行失败", _TEMPLATE_ERROR),
    }
    title, template = mapping.get(outcome, mapping["error"])
    elements: List[Dict[str, Any]] = [_summary_markdown(tool_name, input_preview)]
    if detail.strip():
        elements.append({"tag": "markdown", "content": detail.strip()})
    return _base_card(
        title=title,
        subtitle=_HEADER_TITLE,
        template=template,
        elements=elements,
    )
