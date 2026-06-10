"""MIME charset 归一化 — 防御「声明 charset 与实际字节不符」的超集解码.

典型场景: 简中版 Outlook/Exchange 声明 ``charset=gb2312``, 实际字节是 GBK/GB18030
(繁体字、智能标点 – 等落在 GBK 扩展区). Python 的 ``gb2312`` codec 是严格子集,
``errors="replace"`` 下扩展区字符变 U+FFFD, GBK trail byte 落 ASCII 区的还残留
字母 (``�f``=協 / ``�x``=謝 / ``�C``=–). 解法: 按声明 charset 的**超集** codec
解码 — 超集对合法子集字节的解码结果逐字节一致, 仅对子集外字节有差异, 零回归.
"""

from typing import Optional

# 声明 charset (lower + 去引号) → Python codec 超集
_SUPERSET_CODEC = {
    # GB 系: gb18030 ⊃ gbk ⊃ gb2312
    "gb2312": "gb18030",
    "csgb2312": "gb18030",
    "gb_2312-80": "gb18030",
    "gb-2312": "gb18030",
    "euc-cn": "gb18030",
    "euccn": "gb18030",
    "gbk": "gb18030",
    "x-gbk": "gb18030",
    "cp936": "gb18030",
    "ms936": "gb18030",
    "chinese": "gb18030",
    # Big5 系: big5hkscs ⊃ big5-eten ⊃ big5
    "big5": "big5hkscs",
    "csbig5": "big5hkscs",
    "big5-tw": "big5hkscs",
    "x-big5": "big5hkscs",
    # 韩: cp949 ⊃ euc-kr ⊃ ks_c_5601-1987
    "ks_c_5601-1987": "cp949",
    "ks_c_5601_1987": "cp949",
    "ksc5601": "cp949",
    "euc-kr": "cp949",
    "euckr": "cp949",
    "korean": "cp949",
    # 日: cp932 ⊃ shift_jis (Windows 机种依存文字 ①㈱ 等)
    "shift_jis": "cp932",
    "shift-jis": "cp932",
    "sjis": "cp932",
    "x-sjis": "cp932",
    "ms_kanji": "cp932",
    # ascii 声明但混入高位字节: utf-8 ⊃ ascii
    "ascii": "utf-8",
    "us-ascii": "utf-8",
    "ansi_x3.4-1968": "utf-8",
}


def normalize_charset(charset: Optional[str]) -> str:
    """声明 charset → 实际解码用 codec. 缺失/空 → utf-8, 已知子集 → 超集."""
    if not charset:
        return "utf-8"
    cs = charset.strip().strip("'\"").lower()
    if not cs:
        return "utf-8"
    return _SUPERSET_CODEC.get(cs, cs)


def decode_mime_bytes(payload: bytes, charset: Optional[str]) -> str:
    """按归一化 charset 解码 MIME payload. 未知 codec → utf-8, replace 兜底."""
    codec = normalize_charset(charset)
    try:
        return payload.decode(codec, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def decode_text_part(part) -> str:
    """text/* MIME part → str, 取代 ``EmailMessage.get_content()`` 的解码步.

    ``get_content()`` 内部 ``content.decode(声明charset, errors='replace')``,
    gb2312 声明 + GBK 字节会产出 U+FFFD. payload 为 None (罕见结构) 时
    fallback 原 ``get_content()`` 行为 (调用方均为 policy.default 的
    EmailMessage).
    """
    payload = part.get_payload(decode=True)
    if payload is None:
        return part.get_content()
    return decode_mime_bytes(payload, part.get_content_charset())
