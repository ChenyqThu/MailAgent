"""闸 — 法官免卡锚 ``judgeScopeHash`` 的跨语言同口径（g2）。

同一个判据「当前 ``members_json`` 原文的 sha256 hexdigest 是否等于 owner 确认法官位时写入的
``judgeScopeHash``」在两侧各算一份：

  1. ``src/chat/db.py::get_group_config`` —— serve-api 读面（群设置页的 ``judgeScopeStale``）
  2. ``frontend/src/electron/main/ai_gateway_lifecycle.ts::computeJudgeScopeStale`` —— gateway
     读面（``GroupSessionFacts.judgeScopeStale``，法官工厂据此拒 ``E_JUDGE_SCOPE_STALE``）

两侧必须都钉 **原文字节**（``members_json`` 列的字符串，utf-8）：写侧 ``put_group_config`` 写的是
原文的 hash，等价重排（``["a","b"]`` vs ``["a", "b"]``）也算变。任何一侧改成「从解析后的成员数组
重新序列化再 hash」都会让免卡在一侧永远失配 / 另一侧永远匹配 —— 编译过、测试过，法官要么被
无声拒绝、要么在名单已改后仍免卡投递。

🔴 抽取失败必须红：每个抽取器抓不到目标结构就抛（不返回 None 装绿）。
"""

from __future__ import annotations

import re
from typing import Match

import pytest

from . import _parsers as p

LIFECYCLE_TS = (
    p.REPO_ROOT / "frontend" / "src" / "electron" / "main" / "ai_gateway_lifecycle.ts"
)
CHAT_DB_PY = p.REPO_ROOT / "src" / "chat" / "db.py"

#: TS：``createHash('sha256').update(<param> ?? '', 'utf8').digest('hex')`` —— 算法 / 编码 / 输出
#: 三件事一次钉住；``<param>`` 是纯函数的形参名，随后与调用点对账。
TS_HASH_RE = re.compile(
    r"createHash\('sha256'\)\s*\.update\(\s*(\w+)\s*\?\?\s*'',\s*'utf8'\s*\)\s*\.digest\('hex'\)"
)
#: TS：纯函数签名 ``export function computeJudgeScopeStale(<param>: string | null, …``。
TS_FN_RE = re.compile(
    r"export function computeJudgeScopeStale\(\s*(\w+)\s*:\s*string \| null\s*,"
)
#: TS：resolveGroupSession 里的调用点必须把 ``session.members_json`` **原文**喂进去。
TS_CALL_RE = re.compile(r"computeJudgeScopeStale\(\s*session\.members_json\s*\?\?\s*null\s*,")
#: Python：``hashlib.sha256((<var> or "").encode("utf-8")).hexdigest()``。
PY_HASH_RE = re.compile(
    r'hashlib\.sha256\(\(\s*(\w+)\s+or\s+""\s*\)\.encode\("utf-8"\)\)\.hexdigest\(\)'
)


def _read(path) -> str:
    return path.read_text(encoding="utf-8")


def _must(m: "Match[str] | None", what: str) -> "Match[str]":
    assert m is not None, f"{what} —— 解析器坏了（或算法被改写），闸不能装绿"
    return m


def _ts_function_body(src: str) -> str:
    """``computeJudgeScopeStale`` 的函数体（从签名到下一个顶层 ``}``）。"""
    m = _must(TS_FN_RE.search(src), f"{LIFECYCLE_TS.name}: 没找到 export function computeJudgeScopeStale")
    end = src.find("\n}\n", m.start())
    assert end != -1, f"{LIFECYCLE_TS.name}: computeJudgeScopeStale 函数体没有闭合 —— 解析器坏了"
    return src[m.start() : end]


def _py_function_body(src: str) -> str:
    """``get_group_config`` 的函数体（到下一个同缩进 ``def`` 为止）。"""
    start = src.find("    def get_group_config(")
    assert start != -1, f"{CHAT_DB_PY.name}: 没找到 def get_group_config —— 解析器坏了"
    nxt = src.find("\n    def ", start + 1)
    return src[start : nxt if nxt != -1 else len(src)]


def test_ts_hashes_members_json_raw_utf8() -> None:
    """gateway 侧：纯函数对形参 ``rawMembersJson`` 原文做 sha256/utf8/hex，且调用点喂的是
    ``session.members_json`` 列原文。"""
    src = _read(LIFECYCLE_TS)
    body = _ts_function_body(src)
    param = _must(TS_FN_RE.search(body), "computeJudgeScopeStale 签名").group(1)
    hashed = _must(TS_HASH_RE.search(body), "computeJudgeScopeStale 函数体里的 createHash('sha256')…digest('hex')").group(1)
    assert hashed == param, (
        f"computeJudgeScopeStale hash 的是 `{hashed}`，但形参是 `{param}` —— 必须直接 hash 传入的原文"
    )
    _must(TS_CALL_RE.search(src), f"{LIFECYCLE_TS.name}: resolveGroupSession 里的 computeJudgeScopeStale(session.members_json ?? null, …) 调用点")


def test_py_hashes_members_json_raw_utf8() -> None:
    """serve-api 侧：``get_group_config`` 对 ``members_json`` 列原文做 sha256/utf-8/hexdigest。"""
    body = _py_function_body(_read(CHAT_DB_PY))
    var = _must(PY_HASH_RE.search(body), "get_group_config 里的 hashlib.sha256((… or \"\").encode(\"utf-8\")).hexdigest()").group(1)
    assert re.search(rf"{var}\s*=\s*row\.get\(\"members_json\"\)", body), (
        f"get_group_config 里 hash 的变量 `{var}` 不是 row.get(\"members_json\") 的原文 —— 与 TS 侧口径漂了"
    )


def test_neither_side_reserializes_the_member_array() -> None:
    """两侧都不许从解析后的成员数组重新序列化再 hash（那样与写侧 put_group_config 的原文 hash 永不相等）。"""
    ts_src = _read(LIFECYCLE_TS)
    assert "JSON.stringify(members" not in ts_src, (
        f"{LIFECYCLE_TS.name} 出现 JSON.stringify(members… —— judgeScopeStale 必须 hash members_json 原文"
    )
    py_body = _py_function_body(_read(CHAT_DB_PY))
    assert "json.dumps(members" not in py_body, (
        f"{CHAT_DB_PY.name}::get_group_config 出现 json.dumps(members… —— 必须 hash members_json 原文"
    )


def test_extractors_fail_loudly_on_missing_structures() -> None:
    """反向用例：抽取器抓不到目标结构时必须抛（否则整道闸退化成平凡绿）。"""
    with pytest.raises(AssertionError):
        _ts_function_body("export function somethingElse(x: string | null) {\n}\n")
    with pytest.raises(AssertionError):
        _py_function_body("class Nope:\n    def other(self):\n        pass\n")
    with pytest.raises(AssertionError):
        _must(TS_HASH_RE.search("createHash('md5').update(x, 'utf8').digest('hex')"), "md5 不算")
    with pytest.raises(AssertionError):
        _must(PY_HASH_RE.search('hashlib.sha256(json.dumps(members).encode("utf-8")).hexdigest()'), "重序列化不算")
