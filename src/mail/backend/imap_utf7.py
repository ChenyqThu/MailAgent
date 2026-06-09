"""Modified UTF-7 (RFC 3501 §5.1.3) 编解码 — IMAP 文件夹名 ASCII 安全表示.

Exchange / davmail 把非 ASCII 文件夹名（中文如「DMS固件发布」）以 modified UTF-7 编码出现在
IMAP LIST 响应里。多文件夹同步要：① LIST 后**解码**成可读 display name；② CREATE/RENAME
非 ASCII 文件夹时**编码**回 modified UTF-7（imaplib 默认按 ASCII 编码 args，中文会 raise）。

规则（RFC 3501 §5.1.3，与标准 UTF-7 的区别）：
- 可打印 ASCII (0x20-0x7e) 原样输出，但 ``&`` 必须转义为 ``&-``。
- 其它字符（含 0x20 以下控制符、非 ASCII）：``&`` 引导一段 modified-BASE64（UTF-16BE 字节），
  以 ``-`` 结束；BASE64 里的 ``/`` 用 ``,`` 代替，且**去掉**填充 ``=``。

实测样本：``DMS&VvpO9lPRXgM-`` ↔ ``DMS固件发布``（见 multi-folder-sync gate）。
"""
from __future__ import annotations

import base64

__all__ = ["encode_imap_utf7", "decode_imap_utf7"]


def encode_imap_utf7(text: str) -> str:
    """unicode → modified UTF-7（IMAP 文件夹名）。纯 ASCII 输入原样返回（仅转义 ``&``）。"""
    res: list[str] = []
    buf: list[str] = []

    def _flush() -> None:
        if buf:
            raw = "".join(buf).encode("utf-16-be")
            b64 = base64.b64encode(raw).decode("ascii").rstrip("=").replace("/", ",")
            res.append("&" + b64 + "-")
            buf.clear()

    for ch in text:
        if 0x20 <= ord(ch) <= 0x7E:
            _flush()
            res.append("&-" if ch == "&" else ch)
        else:
            buf.append(ch)
    _flush()
    return "".join(res)


def decode_imap_utf7(value: str) -> str:
    """modified UTF-7（IMAP 文件夹名）→ unicode。非法分段尽力还原，不抛异常。"""
    res: list[str] = []
    i, n = 0, len(value)
    while i < n:
        ch = value[i]
        if ch == "&":
            end = value.find("-", i)
            if end == -1:
                # 缺结束符：按字面处理剩余内容，避免异常
                res.append(value[i:])
                break
            chunk = value[i + 1 : end]
            if chunk == "":
                res.append("&")  # ``&-`` = 字面 &
            else:
                b64 = chunk.replace(",", "/")
                b64 += "=" * ((-len(b64)) % 4)  # 补回去掉的填充
                try:
                    res.append(base64.b64decode(b64).decode("utf-16-be"))
                except Exception:
                    # 解码失败：保留原始分段（含 & 与 -），不丢字符
                    res.append(value[i : end + 1])
            i = end + 1
        else:
            res.append(ch)
            i += 1
    return "".join(res)
