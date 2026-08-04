"""飞书出站投递 —— 分块 + 单次重试 + **显式成败日志**（08-01 阶段 2 PR-2）。

投递纪律（复核 §8 第 2 条，LobeHub 作者原话是「曾靠『日志里没报错』推断投递成功，
吃了几天亏」）：
  1. 长回复按字符上限**分块**投递；
  2. 发送失败**重试一次**，仍失败则停止后续分块（半截消息乱序比缺失更难判读）；
  3. 每一块的成功/失败都写**生产可见**日志（INFO 带 message_id / ERROR 带摘要）。

本模块**不 import lark** —— 它只认一个 ``MessageSender`` 协议（``create_message``）。
真实现 ``LarkMessageSender`` 在 ``src/im/lark_api.py``，测试塞假的。这样分块/重试/
日志这些真正容易写错的逻辑可以完全离线测。

卡片投递（审批卡 + ``PATCH`` 更新）是 **PR-3** 的活，本模块只做文本。
"""

from __future__ import annotations

import time
from typing import Any, List, Optional, Protocol

from loguru import logger

from src.im.logfmt import clip, describe_error

# 单块字符上限。
# 🔴 取值依据：飞书官方文档对 text 消息给的是**请求体字节**上限（150KB 量级），没有给出
# 一个「超过就一定被截断」的字符数；C6 的两份底稿（feishu-wechat-bot-research-0803.md /
# c6-spike/README.md）也没有记录实测阈值。故按任务书要求取**保守 2000 字符/块** ——
# 远低于任何可能的硬限，代价只是长回复多发几条，收益是永远不会撞上未知的截断。
# 真要放宽，先在真机上量出阈值再改，别拍脑袋。
CHUNK_CHARS = 2000
# 单条回复最多几块 —— 防「模型跑飞产出 10 万字」把飞书刷屏。超出部分截断并明说。
MAX_CHUNKS = 20
# 失败重试的间隔（秒）。只重一次：飞书 5xx/限流通常几百毫秒内自愈，重更多次只会
# 让「一条消息发了 30 秒」这种更糟的形态出现。
RETRY_DELAY_SEC = 1.0
# 空回复兜底 —— 飞书拒收空 text，而「什么都不回」在 IM 里等于失联。
EMPTY_TEXT_PLACEHOLDER = "(空回复)"


class MessageSender(Protocol):
    """出站消息发送面（真实现见 ``src/im/lark_api.py::LarkMessageSender``）。"""

    def create_message(
        self, receive_id: str, msg_type: str, content: dict
    ) -> Optional[str]:
        """发一条消息，返回 ``message_id``；失败返回 None（**不抛**）。"""
        ...


def split_for_delivery(
    text: str, *, limit: int = CHUNK_CHARS, max_chunks: int = MAX_CHUNKS
) -> List[str]:
    """把长文本切成 ≤ ``limit`` 字符的块，尽量在换行处切。

    - 换行位置在窗口前半段（< limit/2）时**不采用** —— 否则一段长代码块前面恰好有个
      换行会让每块只装几十个字符，把一条回复炸成几十条消息。
    - 超过 ``max_chunks`` 时截断，最后一块追加明确的截断说明（宁可明说，也不静默丢）。
    - 纯空白 / 空串 → 返回 ``[]``（由 ``send_text`` 决定兜底文案）。
    """
    if limit <= 0:
        raise ValueError("split_for_delivery limit must be positive")
    if not text or not text.strip():
        return []

    chunks: List[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break
        window = remaining[:limit]
        cut = window.rfind("\n")
        if cut < limit // 2:
            cut = limit  # 换行太靠前（或没有）→ 硬切
        else:
            cut += 1  # 含换行本身
        chunks.append(remaining[:cut])
        remaining = remaining[cut:]

    # 去掉块尾换行（飞书里渲染成空行），并丢掉切完只剩空白的块
    cleaned = [c.rstrip("\n") for c in chunks]
    cleaned = [c for c in cleaned if c.strip()]
    if not cleaned:
        return []

    if len(cleaned) > max_chunks:
        dropped = sum(len(c) for c in cleaned[max_chunks:])
        cleaned = cleaned[:max_chunks]
        cleaned[-1] = cleaned[-1] + f"\n\n…（回复过长，已截断约 {dropped} 字符）"
    return cleaned


class FeishuDelivery:
    """一个 open_id 维度的文本投递器。**只在 executor 线程里调**（会做网络 IO）。"""

    def __init__(
        self,
        sender: MessageSender,
        *,
        chunk_chars: int = CHUNK_CHARS,
        max_chunks: int = MAX_CHUNKS,
        retry_delay_sec: float = RETRY_DELAY_SEC,
        sleep: Any = time.sleep,
    ) -> None:
        self._sender = sender
        self._chunk_chars = chunk_chars
        self._max_chunks = max_chunks
        self._retry_delay_sec = retry_delay_sec
        self._sleep = sleep

    def send_text(self, open_id: str, text: str) -> List[str]:
        """分块投递一段文本，返回**已成功**的 message_id 列表（可能短于块数）。"""
        if not open_id:
            logger.error("[im-feishu] 投递失败：没有 open_id（调用方 bug）")
            return []

        chunks = split_for_delivery(
            text, limit=self._chunk_chars, max_chunks=self._max_chunks
        )
        if not chunks:
            chunks = [EMPTY_TEXT_PLACEHOLDER]

        sent: List[str] = []
        total = len(chunks)
        for idx, chunk in enumerate(chunks, start=1):
            message_id = self._send_one_with_retry(open_id, chunk, idx, total)
            if message_id is None:
                logger.error(
                    f"[im-feishu] 投递中止：第 {idx}/{total} 块两次尝试均失败，"
                    f"后续 {total - idx} 块不再发送（避免乱序半截消息）"
                )
                break
            sent.append(message_id)
        return sent

    # ── 内部 ──────────────────────────────────────────────────────────────
    def _send_one_with_retry(
        self, open_id: str, chunk: str, idx: int, total: int
    ) -> Optional[str]:
        for attempt in (1, 2):
            message_id = self._create(open_id, chunk)
            if message_id:
                logger.info(
                    f"[im-feishu] 投递成功 message_id={message_id} "
                    f"块={idx}/{total} 长度={len(chunk)} 尝试={attempt}"
                )
                return message_id
            if attempt == 1:
                logger.warning(
                    f"[im-feishu] 投递失败（第 {idx}/{total} 块），{self._retry_delay_sec}s 后重试一次"
                )
                self._sleep(self._retry_delay_sec)
        return None

    def _create(self, open_id: str, chunk: str) -> Optional[str]:
        try:
            return self._sender.create_message(open_id, "text", {"text": chunk})
        except Exception as e:  # noqa: BLE001 — sender 契约是不抛, 这是防御
            logger.error(
                f"[im-feishu] 投递异常（{describe_error(e)}）text={clip(chunk)!r}"
            )
            return None
