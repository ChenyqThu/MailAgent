"""owner 绑定 —— 一次性绑定码（08-01 阶段 2 PR-2，PRD「08-04 实施拍板补充」）。

流程（owner 拍板：PR-2 由 CLI 出码，PR-4 补 Settings UI）：
  1. ``mailagent im pair`` 生成 6 位数字码，TTL 10 分钟，落 sync_state；
  2. owner 在飞书私聊里把这串码发给 bot；
  3. bot 校验码 → 把发送者 ``open_id`` 写进 ``im.feishu.bound_open_id``（跨重启存活）；
  4. 之后**只有**这个 open_id 的私聊会进指令通道，其他一律拒。

设计取舍（都写在这里，免得下一个人重问）：
  - **码存明文**：6 位数字 + 10 分钟 TTL 的本地配对码，存哈希只是把「能读到本机
    SQLite 的人」挡在门外一秒（6 位数字的空间 10^6，读得到库就爆得出）。而明文换来
    CLI 崩掉后还能 ``sqlite3`` 查回来。能读你 sync_store.db 的人已经拿到全部邮件了。
  - **比对仍用 ``hmac.compare_digest``**：成本为零，顺手消灭时序侧信道这个话题。
  - **码是一次性的**：绑成功即清；过期或绑定后残留的码也会被清（``verify`` 内自愈）。
  - **已绑定后码不再有意义**：绑定判定的**唯一**入口是 ``handler.ImEventRouter._dispatch``，
    它在已绑定时**先拒后判** —— 非 owner 一律 ``STRANGER_REPLY``，根本走不到
    ``_handle_unbound`` 的验码分支，避免「陌生人拿到码就能顶掉 owner」
    （闸：``tests/im/test_handler.py::test_stranger_rejected_after_binding_even_with_valid_code``）。
    重新绑定要 ``mailagent im pair --rebind`` 显式解绑（否则换手机/换账号会永久锁死）。
"""

from __future__ import annotations

import hmac
import secrets
import time
from typing import Optional, Tuple

from src.im.state import (
    ImFeishuState,
    STATE_PAIR_CODE,
    STATE_PAIR_CODE_EXPIRES_AT,
)

# 绑定码形状 —— 6 位数字（飞书里手输，别用 base32 这类易混字符集）。
PAIR_CODE_DIGITS = 6
# 有效期（秒）。10 分钟：够 owner 从终端切到飞书，又短到过期即废。
PAIR_CODE_TTL_SEC = 600


def generate_pair_code() -> str:
    """密码学随机的 6 位数字码（含前导零）。"""
    return f"{secrets.randbelow(10 ** PAIR_CODE_DIGITS):0{PAIR_CODE_DIGITS}d}"


def issue_pair_code(
    state: ImFeishuState, *, now: Optional[float] = None
) -> Tuple[str, int]:
    """生成并落库一个新绑定码，返回 ``(code, expires_at_epoch)``。

    覆盖旧码（同时只有一个有效码 —— 多码并存只会让「我发的哪个」变成新的困惑源）。
    """
    now = time.time() if now is None else now
    code = generate_pair_code()
    expires_at = int(now + PAIR_CODE_TTL_SEC)
    state.set(STATE_PAIR_CODE, code)
    state.set(STATE_PAIR_CODE_EXPIRES_AT, str(expires_at))
    return code, expires_at


def clear_pair_code(state: ImFeishuState) -> None:
    state.set(STATE_PAIR_CODE, "")
    state.set(STATE_PAIR_CODE_EXPIRES_AT, "")


def peek_pair_code_expiry(
    state: ImFeishuState, *, now: Optional[float] = None
) -> Optional[int]:
    """当前有效码的到期 epoch；无码 / 已过期 → None（**不返回码本身**）。"""
    now = time.time() if now is None else now
    code = (state.get(STATE_PAIR_CODE) or "").strip()
    if not code:
        return None
    expires_at = _parse_expiry(state)
    if expires_at is None or now > expires_at:
        return None
    return expires_at


def verify_pair_code(
    state: ImFeishuState, candidate: str, *, now: Optional[float] = None
) -> bool:
    """校验候选码。命中即消费（清码）；过期码顺手清掉。

    非纯函数是有意的：绑定码一次性，「验过了但没清」是最容易漏的一步。
    """
    now = time.time() if now is None else now
    stored = (state.get(STATE_PAIR_CODE) or "").strip()
    if not stored:
        return False

    expires_at = _parse_expiry(state)
    if expires_at is None or now > expires_at:
        # 过期（或到期时间损坏）→ 自愈清掉，避免一个永不过期的僵尸码
        clear_pair_code(state)
        return False

    if not hmac.compare_digest(stored, (candidate or "").strip()):
        return False

    clear_pair_code(state)
    return True


def looks_like_pair_code(text: str) -> bool:
    """文本是不是「一串 6 位数字」——用来决定要不要走绑定分支。

    只认**整条消息就是**这串数字（strip 后），不在长句里找数字：
    「我的工号是 123456」不该被当成绑定码。
    """
    stripped = (text or "").strip()
    return len(stripped) == PAIR_CODE_DIGITS and stripped.isdigit()


def _parse_expiry(state: ImFeishuState) -> Optional[int]:
    raw = (state.get(STATE_PAIR_CODE_EXPIRES_AT) or "").strip()
    if not raw:
        return None
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return None
