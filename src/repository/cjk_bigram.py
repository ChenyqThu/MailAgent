"""2 字 CJK bigram 分词工具，用于消除 SQLite ``LIKE '%两字%'`` 的全表扫描瓶颈。

SQLite FTS5 内置的 ``trigram`` tokenizer 对长度 < 3 的 query 无法索引召回，导致 2 字中文查询
历来只能退回全表 ``LIKE '%词%'``（实测 ~9,300 封邮件 + ~2,000 份抽取附件耗时 280–1,680 ms）。
本模块将文本中的连续 CJK 字符流切分为去重的相邻 2-gram 词元（空格分隔），存入并行的
``unicode61`` FTS5 表，使 2 字纯 CJK 查询走倒排索引 ``MATCH``（< 10 ms 级），与原 ``LIKE``
子串语义完全等价。
"""

from __future__ import annotations

import unicodedata
from typing import Optional


def is_cjk_char(c: str) -> bool:
    """检测单字符是否 CJK / 日韩 (覆盖 BMP + 扩展 A/B-F + 假名 + 谚文)."""
    if not c:
        return False
    cp = ord(c)
    if 0x4E00 <= cp <= 0x9FFF:        # CJK Unified Ideographs
        return True
    if 0x3400 <= cp <= 0x4DBF:        # CJK Extension A
        return True
    if 0x20000 <= cp <= 0x2FA1F:      # CJK Extension B-F
        return True
    if 0x3040 <= cp <= 0x30FF:        # Hiragana / Katakana
        return True
    if 0xAC00 <= cp <= 0xD7AF:        # Hangul Syllables
        return True
    return False


def _is_bigram_letter(c: str) -> bool:
    """严格可用于 FTS5 unicode61 token 的 CJK 字母/表意文字（排除 `・` 等标点符号）。"""
    return is_cjk_char(c) and not unicodedata.category(c).startswith("P")


def is_pure_cjk_bigram(value: str) -> bool:
    """判别查询 term 是否恰好为两个可索引的 CJK 字符（如 ``合同``、``周报``）。"""
    return len(value) == 2 and _is_bigram_letter(value[0]) and _is_bigram_letter(value[1])


def extract_cjk_bigrams(text: Optional[str]) -> str:
    """抽取文本中全部相邻 CJK 2-gram（保序去重），以空格连接供 FTS5 unicode61 索引。"""
    if not text:
        return ""
    seen: dict[str, None] = {}
    prev: Optional[str] = None
    for ch in text:
        if _is_bigram_letter(ch):
            if prev is not None:
                seen.setdefault(prev + ch, None)
            prev = ch
        else:
            prev = None
    return " ".join(seen)
