"""Outlook ConversationIndex 解析 (纯算法, 零 COM 依赖).

从 MailAgentWin (同事 fork, 授权直搬) ``conversation_index.py`` 直搬改造。

结构 (MAPI PR_CONVERSATION_INDEX):
  - 头 22 字节 (44 hex chars) = 会话根的 FILETIME + GUID
  - 之后每 5 字节 (10 hex chars) 追加一层回复
  - 父邮件 index = 子邮件 index 去掉末尾 10 hex

在本仓的用途 (outlook_com backend):
  - ``root`` 前缀标识整条会话 —— 但本仓 ``thread_id`` 语义是「线程根邮件的
    Message-ID」(davmail 从 References/In-Reply-To 链推导, 见
    ``davmail_backend._thread_id_from_headers``), 所以 ConversationIndex **不直接
    当 thread_id 用**; 它是 header 链缺失时 (Exchange 内部投递常剥 References)
    的兜底信息, 由 backend 决定何时降级使用。
  - depth/parent_index 供将来线程深度/父子挂接增强。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

ROOT_LEN_HEX = 44  # 22 bytes
LEVEL_LEN_HEX = 10  # 5 bytes per reply level


@dataclass(frozen=True)
class ConvIndex:
    raw: str
    root: str  # 前 44 hex, 会话根标识
    depth: int  # 0 = 会话根
    parent_index: Optional[str]  # 去掉末 10 hex; 根邮件为 None


def parse(conversation_index: Optional[str]) -> Optional[ConvIndex]:
    """解析 ConversationIndex hex 串; 非法/过短返回 None (不 raise —— 纯信息字段)."""
    if not conversation_index or not isinstance(conversation_index, str):
        return None
    ci = conversation_index.strip().upper()
    if len(ci) < ROOT_LEN_HEX:
        return None
    # hex 校验: Outlook 偶发给出坏值, 非 hex 一律当缺失
    try:
        int(ci, 16)
    except ValueError:
        return None
    # 层级字节必须是 10 hex 的整倍数; 不是则截到最近合法层 (容错坏尾巴)
    extra = len(ci) - ROOT_LEN_HEX
    depth = extra // LEVEL_LEN_HEX
    valid_len = ROOT_LEN_HEX + depth * LEVEL_LEN_HEX
    ci = ci[:valid_len]
    parent = ci[:-LEVEL_LEN_HEX] if depth > 0 else None
    return ConvIndex(raw=ci, root=ci[:ROOT_LEN_HEX], depth=depth, parent_index=parent)
