"""飞书事件路由 + owner 消息接缝（08-01 阶段 2 PR-2）。

**3 秒纪律是本模块的第一约束。** lark 的 WS 客户端在收到事件时是
``result = self._event_handler._do_without_validation(pl)`` —— **同步调用** handler，
然后才把 ACK 帧写回去（``lark_oapi/ws/client.py::_handle_data_frame`` 源码实证）。
所以 handler 里做的任何事都直接顶在 ACK 前面，超过 3 秒飞书判失败并**重推**。

⇒ ``ImEventRouter.on_message`` 只做**纯内存**的三件事：解析 → 去重 → 私聊过滤，
然后把活儿甩进 executor 线程立刻返回（C6 实测 1.8ms / 3000ms）。
🔴 **绝不在 handler 里读写 sqlite / 发网络请求** —— 绑定查询、拒收回复、echo 投递
全在 executor 线程里做。

## 给 PR-3 的接缝

``handle_owner_message(text, ctx) -> None`` 是**唯一**的替换点：PR-3 把它换成
「起 gateway ``im_chat`` run → drain → 主动投递回复 / 弹审批卡」。签名与 ``ctx``
的字段在本 PR 就定死，PR-3 不该再动路由、去重、绑定、拒收这些东西。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Optional

from loguru import logger

from src.im.dedupe import EventDeduper
from src.im.delivery import FeishuDelivery
from src.im.lark_api import parse_text_message
from src.im.logfmt import clip, describe_error
from src.im.pairing import looks_like_pair_code, verify_pair_code
from src.im.state import ImFeishuState

# 飞书判超时的硬阈值（毫秒）——超过即重推。
ACK_BUDGET_MS = 3000
# 软阈值：handler 本该是亚毫秒级，超过它说明有阻塞操作偷偷混进了 handler。
ACK_SOFT_BUDGET_MS = 1000

# ── 固定回复文案（**不泄露任何内部信息**）────────────────────────────────────
UNBOUND_REPLY = (
    "这个机器人还没有绑定使用者。\n"
    "请在 MailAgent 所在的电脑上运行 `mailagent im pair` 拿到 6 位绑定码，"
    "再把这 6 位数字单独发给我。\n"
    "绑定完成前我不会处理任何内容。"
)
STRANGER_REPLY = "这个机器人已绑定其他使用者，不接受你的指令。"
BIND_OK_REPLY = "✅ 绑定成功，之后可以直接和我说话了。"
UNSUPPORTED_REPLY = "目前只支持文字消息（语音 / 图片 / 文件暂不支持）。"
INTERNAL_ERROR_REPLY = "处理你的消息时出错了。请到 MailAgent 日志里看 `[im-feishu]` 开头的记录。"

# PR-2 的占位实现前缀 —— 明说 AI 还没接上，免得 dogfood 时误判成「模型答非所问」。
ECHO_PREFIX = "[echo] IM 的 AI 桥接随 PR-3 上线，先把你说的原样回给你：\n"


@dataclass(frozen=True)
class ImMessageContext:
    """一条 owner 私聊消息的上下文（``handle_owner_message`` 的第二参数）。

    🔴 **PR-3 契约**：字段只增不改。``delivery`` 已经是可直接用的投递器 ——
    ``handle_owner_message`` 自己负责把回复发出去，路由层不代劳（因为 PR-3 的回复
    可能是多条、可能是卡片、可能中途停在审批门）。
    """

    open_id: str            # 发送者（= 已绑定的 owner）的 open_id，回复发给它
    chat_id: str            # 私聊会话 id（PR-3 做「一个话题一个 session」的映射键）
    message_id: str         # 这条消息的 message_id（回复引用 / 排障对账用）
    event_id: str           # 事件 id（幂等键，已在路由层去过重）
    received_at: float      # time.monotonic()，算「收到 → 回复」总耗时用
    received_wall: str      # 本地墙钟 ISO，日志/状态展示用
    delivery: FeishuDelivery


def handle_owner_message(text: str, ctx: ImMessageContext) -> None:
    """处理一条来自已绑定 owner 的私聊文本。**内部自行投递回复**，无返回值。

    🔴 **这是 PR-3 的单点替换处**（AI 桥接）。PR-2 = echo 占位。
    跑在 executor 线程上，可以随便做慢的事（3 秒预算只管 handler，主动发消息不受限，
    C6 实测 5s 的处理 + 主动发完全成立）。
    """
    ctx.delivery.send_text(ctx.open_id, ECHO_PREFIX + text)


class ImEventRouter:
    """把 lark 事件翻译成「谁说了什么」，并施加私聊 / 去重 / 绑定三道门。"""

    def __init__(
        self,
        *,
        state: ImFeishuState,
        delivery: FeishuDelivery,
        submit: Callable[..., Any],
        deduper: Optional[EventDeduper] = None,
        owner_handler: Callable[[str, ImMessageContext], None] = handle_owner_message,
    ) -> None:
        """
        Args:
            state: ``im.feishu.*`` 门面（**只在 executor 线程里碰**）。
            delivery: 出站投递器。
            submit: ``executor.submit`` 形状的 ``(fn, *args) -> Any``。
            deduper: 事件去重器（默认新建）。
            owner_handler: owner 消息处理器（PR-3 换成 gateway 桥）。
        """
        self._state = state
        self._delivery = delivery
        self._submit = submit
        self._deduper = deduper or EventDeduper()
        self._owner_handler = owner_handler
        # 🔴 内存计数/时间戳 —— handler 里绝不写 sqlite，落盘由 worker 的监控 tick 做。
        self.event_count = 0
        self.last_event_wall: Optional[str] = None

    # ── lark handler（必须 3 秒内返回且不抛）────────────────────────────────
    def on_message(self, data: Any) -> None:
        t0 = time.monotonic()
        try:
            parsed = parse_text_message(data)
            if parsed is None:
                return

            if self._deduper.seen(parsed["event_id"]):
                logger.warning(
                    "[im-feishu] 收到**重推**事件（飞书判超时后重发），已去重不重复执行："
                    f"event_id={parsed['event_id']}"
                )
                return

            self.event_count += 1
            self.last_event_wall = datetime.now().isoformat(timespec="seconds")

            # Q12=A：MVP 只做私聊，群聊完全不响应（一行日志，不回、不入会话）
            if parsed["chat_type"] != "p2p":
                logger.info(
                    f"[im-feishu] 群聊消息，忽略（chat_type={parsed['chat_type']} "
                    f"event_id={parsed['event_id']}）"
                )
                return

            logger.info(
                "[im-feishu] 收到私聊消息 "
                f"event_id={parsed['event_id']} message_id={parsed['message_id']} "
                f"open_id={parsed['open_id']} type={parsed['message_type']} "
                f"text={clip(parsed['text'])!r}"
            )
            self._submit(self._dispatch, parsed, t0)
        except Exception as e:  # noqa: BLE001 — handler 抛异常 = 飞书判失败并重推
            logger.error(f"[im-feishu] on_message 处理异常（已兜住，不外抛）: {describe_error(e)}")
        finally:
            elapsed_ms = (time.monotonic() - t0) * 1000
            if elapsed_ms >= ACK_SOFT_BUDGET_MS:
                logger.warning(
                    f"[im-feishu] 🔴 handler 返回耗时 {elapsed_ms:.1f} ms / "
                    f"{ACK_BUDGET_MS} ms 预算 —— handler 里混进了阻塞操作，"
                    "超时会让飞书重推事件"
                )
            else:
                logger.debug(f"[im-feishu] handler 返回，耗时 {elapsed_ms:.1f} ms")

    # ── executor 线程（可以慢，可以做 IO）───────────────────────────────────
    def _dispatch(self, parsed: dict, received_at: float) -> None:
        open_id = parsed["open_id"]
        try:
            bound = self._state.get_bound_open_id()

            if not bound:
                self._handle_unbound(open_id, parsed["text"])
                return

            if open_id != bound:
                logger.warning(
                    "[im-feishu] 拒收：非绑定用户的私聊 "
                    f"open_id={open_id} event_id={parsed['event_id']}"
                )
                self._delivery.send_text(open_id, STRANGER_REPLY)
                return

            if parsed["message_type"] != "text":
                logger.info(
                    f"[im-feishu] owner 发来非文本消息（message_type={parsed['message_type']}），"
                    "如实告知不支持"
                )
                self._delivery.send_text(open_id, UNSUPPORTED_REPLY)
                return

            ctx = ImMessageContext(
                open_id=open_id,
                chat_id=parsed.get("chat_id", ""),
                message_id=parsed["message_id"],
                event_id=parsed["event_id"],
                received_at=received_at,
                received_wall=datetime.now().isoformat(timespec="seconds"),
                delivery=self._delivery,
            )
            self._owner_handler(parsed["text"], ctx)
        except Exception as e:  # noqa: BLE001
            logger.error(
                f"[im-feishu] 处理消息失败 event_id={parsed.get('event_id')}: {describe_error(e)}"
            )
            self._try_reply(open_id, INTERNAL_ERROR_REPLY)

    def _handle_unbound(self, open_id: str, text: str) -> None:
        """未绑定任何人：只认绑定码，其余一律固定拒收文案（不处理内容）。"""
        if looks_like_pair_code(text) and verify_pair_code(self._state, text):
            self._state.set_bound_open_id(open_id)
            logger.info(f"[im-feishu] 绑定成功：owner open_id={open_id}")
            self._delivery.send_text(open_id, BIND_OK_REPLY)
            return
        logger.warning(f"[im-feishu] 拒收：尚未绑定 owner（来自 open_id={open_id}）")
        self._delivery.send_text(open_id, UNBOUND_REPLY)

    def _try_reply(self, open_id: str, text: str) -> None:
        try:
            self._delivery.send_text(open_id, text)
        except Exception as e:  # noqa: BLE001 — 兜底回复失败只记一行, 不再级联
            logger.error(f"[im-feishu] 兜底回复也失败了: {describe_error(e)}")
