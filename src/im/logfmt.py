"""IM 侧的日志摘要化工具（08-01 阶段 2 PR-2）。

🔴 **纪律：绝不把 SDK 错误对象或用户正文整体写进日志。**
理由（LobeHub `BotCallbackService.describePlatformError` 的实战教训，复核 §8 第 1 条）：
平台 SDK 的错误对象常挟带 ``requestBody`` —— 也就是**用户消息全文**。一句
``logger.error(err)`` 就把私聊内容写进了 ``logs/sync.log``。

所以本模块只提供三件事，IM 链路上任何日志都必须经它们：
  - ``clip()``      正文截断（默认 50 字符，与 C6 spike 同口径）
  - ``describe_error()``  异常 → ``name= message= status= code=`` 摘要
  - ``describe_resp()``   lark ``BaseResponse`` → ``code= msg= log_id=`` 摘要
    （拿得到 log_id 就够去飞书开放平台后台查原始请求，不需要本地留 body）

无任何第三方 import —— ``describe_resp`` 用 duck-typing 读属性，故本模块可被
测试直接 import，不拉 lark_oapi（见 src/im/connection.py 关于 lark 全局 loop 的红字）。
"""

from __future__ import annotations

from typing import Any, Optional

# 正文在日志里的默认截断长度（与 c6_spike.TEXT_CLIP 同值，便于对照真机日志）。
TEXT_CLIP = 50
# 错误 message 的截断长度 —— 比正文宽，但仍有界（SDK 异常 str() 可能很长）。
ERROR_MESSAGE_CLIP = 200


def clip(text: Optional[str], n: int = TEXT_CLIP) -> str:
    """正文截断 + 换行折叠。``None`` / 空 → 空串。

    超长时追加 ``…(+N)`` 说明被截掉多少，便于判断「是不是被截断误导了」。
    """
    if not text:
        return ""
    flat = str(text).replace("\n", "\\n")
    if len(flat) <= n:
        return flat
    return flat[:n] + f"…(+{len(flat) - n})"


def describe_error(e: BaseException) -> str:
    """异常摘要：只摘 name / message / status / code，绝不整体转储。"""
    parts = [f"name={type(e).__name__}", f"message={clip(str(e), ERROR_MESSAGE_CLIP)}"]
    for attr in ("status", "code", "status_code"):
        val = getattr(e, attr, None)
        if val is not None:
            parts.append(f"{attr}={val}")
    return " ".join(parts)


def describe_resp(resp: Any) -> str:
    """lark ``BaseResponse`` 摘要：code / msg / log_id，**不读 raw body**。

    duck-typing 而非 isinstance —— 本模块刻意不 import lark_oapi。
    """
    log_id = None
    getter = getattr(resp, "get_log_id", None)
    if callable(getter):
        try:
            log_id = getter()
        except Exception:  # noqa: BLE001 — 摘要工具自己绝不能抛
            log_id = None
    return (
        f"code={getattr(resp, 'code', None)} "
        f"msg={clip(getattr(resp, 'msg', None), ERROR_MESSAGE_CLIP)} "
        f"log_id={log_id}"
    )
