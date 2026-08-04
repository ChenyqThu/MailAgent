"""``lark-oapi`` HTTP 面的**唯一**封装（08-01 阶段 2 PR-2）。

只有这里和 ``src/im/connection.py`` 认识 lark SDK；其余模块经协议 / 回调解耦，
这样它们能离线测。

🔴 **所有 lark import 都在函数体内**，模块顶层一个都没有。原因见
``connection.py`` 的红字：``lark_oapi.ws.client`` 在 **import 期**就抓一个
``asyncio.get_event_loop()`` 存成模块全局，在跑着事件循环的线程里 import 会把服务
主 loop 抓进去，之后 ``ws.Client.start()``（``loop.run_until_complete``）当场
``RuntimeError``。把 import 关在函数里 → 谁调谁触发 → 我们保证第一次调用发生在
自己的连接线程上。

HTTP 段（换 token / 发消息 / PATCH）走 ``requests``，**会**读代理环境变量；
WS 段强制直连不读代理（``lark_oapi/ws/client.py::_ws_connect_kwargs`` 源码实证）。
两段行为不一致 —— 换网络环境出问题时先查这里（C6 RESULTS「环境 / 网络实测」）。
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from loguru import logger

from src.im.logfmt import clip, describe_error, describe_resp


def build_api_client(app_id: str, app_secret: str, *, debug: bool = False) -> Any:
    """构造 lark 的 HTTP API client（``lark.Client.builder()``）。"""
    import lark_oapi as lark

    return (
        lark.Client.builder()
        .app_id(app_id)
        .app_secret(app_secret)
        .log_level(lark.LogLevel.DEBUG if debug else lark.LogLevel.INFO)
        .build()
    )


class LarkMessageSender:
    """``src/im/delivery.py::MessageSender`` 的真实现。**契约：绝不抛**。"""

    def __init__(self, api_client: Any) -> None:
        self._api = api_client

    def create_message(
        self, receive_id: str, msg_type: str, content: Dict[str, Any]
    ) -> Optional[str]:
        """``POST /open-apis/im/v1/messages``（``receive_id_type=open_id``）。"""
        from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

        req = (
            CreateMessageRequest.builder()
            .receive_id_type("open_id")
            .request_body(
                CreateMessageRequestBody.builder()
                .receive_id(receive_id)
                .msg_type(msg_type)
                .content(json.dumps(content, ensure_ascii=False))
                .build()
            )
            .build()
        )
        try:
            resp = self._api.im.v1.message.create(req)
        except Exception as e:  # noqa: BLE001 — 错误对象挟带 requestBody(=用户正文), 只摘要
            logger.error(f"[im-feishu] 发消息异常 (msg_type={msg_type}): {describe_error(e)}")
            return None
        if not resp.success():
            logger.error(f"[im-feishu] 发消息失败 (msg_type={msg_type}): {describe_resp(resp)}")
            return None
        return getattr(resp.data, "message_id", None)

    def patch_message(self, message_id: str, content: Dict[str, Any]) -> bool:
        """``PATCH /open-apis/im/v1/messages/{message_id}``（更新审批卡）。**契约：绝不抛**。

        与 ``src/notify/feishu.py`` 回写 open_message_id 用的是同一个 API；卡片必须带
        ``config.update_multi: true`` 才能被 PATCH 对所有接收者生效（C6 spike 实证）。
        ⚠️ 卡片回调 token 有效期 30 分钟 —— 但我们走的是 tenant_access_token 的
        message PATCH，不受该 token 限制（同 C6 spike 路径）。
        """
        from lark_oapi.api.im.v1 import PatchMessageRequest, PatchMessageRequestBody

        req = (
            PatchMessageRequest.builder()
            .message_id(message_id)
            .request_body(
                PatchMessageRequestBody.builder()
                .content(json.dumps(content, ensure_ascii=False))
                .build()
            )
            .build()
        )
        try:
            resp = self._api.im.v1.message.patch(req)
        except Exception as e:  # noqa: BLE001 — 同 create_message：错误对象只摘要
            logger.error(
                f"[im-feishu] PATCH 更新卡片异常 message_id={message_id}: {describe_error(e)}"
            )
            return False
        if not resp.success():
            logger.error(
                f"[im-feishu] PATCH 更新卡片失败 message_id={message_id}: {describe_resp(resp)}"
            )
            return False
        return True


def fetch_bot_identity(api_client: Any) -> Optional[Dict[str, Any]]:
    """``GET /open-apis/bot/v3/info`` —— 拿本连接背后 bot 的 ``app_name`` / ``open_id``。

    官方文档明确「调用该接口无需权限」。破**同名陷阱**：owner 环境里对话 app 与通知
    app 都叫「MailAgent」，不显示 app_id/open_id 就分不清在跟哪个 bot 说话
    （C6 RESULTS 第 3 条）。

    🔴 响应里 ``bot`` 是 ``code``/``msg`` 的**同级顶层字段**，不在 ``data`` 下 ——
    SDK 的 typed model 取不到，必须手动解析 raw（C6 spike 实证）。

    失败一律 None + warning：拿不到身份只影响展示，绝不影响连接。
    """
    from lark_oapi.core import AccessTokenType, HttpMethod
    from lark_oapi.core.model import BaseRequest

    req = (
        BaseRequest.builder()
        .http_method(HttpMethod.GET)
        .uri("/open-apis/bot/v3/info")
        .token_types({AccessTokenType.TENANT})
        .build()
    )
    try:
        resp = api_client.request(req)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[im-feishu] 取 bot 身份失败（不影响连接）: {describe_error(e)}")
        return None
    if not resp.success():
        logger.warning(f"[im-feishu] 取 bot 身份失败（不影响连接）: {describe_resp(resp)}")
        return None
    try:
        payload = json.loads(bytes(resp.raw.content).decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[im-feishu] 解析 bot 身份失败（不影响连接）: {describe_error(e)}")
        return None
    bot = payload.get("bot")
    if not isinstance(bot, dict):
        logger.warning("[im-feishu] bot 身份响应里没有 bot 字段（不影响连接）")
        return None
    return bot


def parse_text_message(event_data: Any) -> Optional[Dict[str, Any]]:
    """从 ``P2ImMessageReceiveV1`` 事件对象里抽出我们关心的字段。

    全程 ``getattr`` 防御 —— SDK model 的字段随版本变过，一次 ``AttributeError``
    逃出 handler 就是飞书判超时 + 重推。抽不出结构 → None。

    返回 ``{event_id, message_id, chat_id, chat_type, message_type, open_id, text}``；
    ``text`` 只在 ``message_type == 'text'`` 时有意义（其余留空串）。
    """
    try:
        header = getattr(event_data, "header", None)
        event = getattr(event_data, "event", None)
        message = getattr(event, "message", None)
        sender = getattr(event, "sender", None)

        message_type = getattr(message, "message_type", None)
        text = ""
        if message_type == "text":
            raw = getattr(message, "content", "") or "{}"
            try:
                text = json.loads(raw).get("text", "") or ""
            except (ValueError, TypeError):
                text = ""

        return {
            "event_id": getattr(header, "event_id", None) or "",
            "message_id": getattr(message, "message_id", None) or "",
            "chat_id": getattr(message, "chat_id", None) or "",
            "chat_type": getattr(message, "chat_type", None) or "",
            "message_type": message_type or "",
            "open_id": getattr(getattr(sender, "sender_id", None), "open_id", None) or "",
            "text": text,
        }
    except Exception as e:  # noqa: BLE001
        logger.error(f"[im-feishu] 解析消息事件失败: {describe_error(e)} raw={clip(str(event_data))!r}")
        return None


def parse_card_action(event_data: Any) -> Optional[Dict[str, Any]]:
    """从 ``card.action.trigger`` 事件（``P2CardActionTrigger``）里抽字段（PR-3）。

    与 ``parse_text_message`` 同纪律：全程 ``getattr`` 防御、不 import lark、抽不出
    结构 → None。字段路径以 C6 spike 实收事件为准（``event.action.value`` /
    ``event.operator.open_id`` / ``event.context.open_message_id``）。

    返回 ``{event_id, value(dict), operator_open_id, open_message_id}``。
    """
    try:
        header = getattr(event_data, "header", None)
        event = getattr(event_data, "event", None)
        action = getattr(event, "action", None)
        context = getattr(event, "context", None)
        operator = getattr(event, "operator", None)

        value = getattr(action, "value", None)
        if not isinstance(value, dict):
            value = {}

        return {
            "event_id": getattr(header, "event_id", None) or "",
            "value": value,
            "operator_open_id": getattr(operator, "open_id", None) or "",
            "open_message_id": getattr(context, "open_message_id", None) or "",
        }
    except Exception as e:  # noqa: BLE001
        logger.error(
            f"[im-feishu] 解析卡片回调失败: {describe_error(e)} raw={clip(str(event_data))!r}"
        )
        return None


def wrap_card_action_handler(fn: Any) -> Any:
    """把「返回 toast dict」的纯 Python 处理器包成 lark 期望的 handler（PR-3）。

    ``fn(data) -> dict``（形如 ``{"toast": {"type": "info", "content": "…"}}``，
    **绝不抛** —— 桥接侧 ``ImAgentBridge.on_card_action`` 的契约）→ 包装成返回
    ``P2CardActionTriggerResponse`` 的 handler。lark import 在**返回的闭包里**
    （只会在连接线程上被调 —— 那里 lark 已按 connection.py 纪律 import 过），
    所以本函数可以在任何线程安全调用、测试可以直接测 ``fn`` 本体不碰 lark。
    """

    def _handler(data: Any) -> Any:
        payload = None
        try:
            payload = fn(data)
        except Exception as e:  # noqa: BLE001 — handler 抛异常 = 飞书判失败并重推
            logger.error(f"[im-feishu] 卡片回调处理器异常（已兜住）: {describe_error(e)}")
        if not isinstance(payload, dict):
            payload = {"toast": {"type": "info", "content": "已收到"}}
        from lark_oapi.event.callback.model.p2_card_action_trigger import (
            P2CardActionTriggerResponse,
        )

        return P2CardActionTriggerResponse(payload)

    return _handler
