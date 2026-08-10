"""chat 附件字符上限的跨语言一致性闸（task 08-10 WP3）。

同一个「单个 chat 附件进 prompt 的字符上限」被手抄在两处：

  * Python — `src/api/routers/attachment.py::CHAT_ATTACHMENT_MAX_CHARS`
    （`/api/attachment/convert` 返回前截断，防止把一份 300 页文档整个吐回 renderer）
  * TypeScript — `frontend/src/shared/lib/chat-attachments.ts::ATTACHMENT_MAX_CONTENT_CHARS`
    （入 prompt 前的最后一道截断）

两侧必须相等。不等时的失败模式很隐蔽：服务端按 20000 截并回 `truncated=false`
（因为对它来说没截），客户端又按自己的值截一刀 —— `buildAttachmentBlock` 于是不会
告诉模型「你看到的是片段」，模型把半份文档当全文来回答。

🔴 抽取失败必须红：任一侧抽不到常量就 fail，绝不 skip —— 一个恒绿的闸比没有闸更糟
（它让人以为有保护）。改名/删除任一侧，本测试立刻红。
"""

from __future__ import annotations

import ast
import re

from . import _parsers as p

_PY_SRC = p.REPO_ROOT / "src" / "api" / "routers" / "attachment.py"
_TS_SRC = p.REPO_ROOT / "frontend" / "src" / "shared" / "lib" / "chat-attachments.ts"

_PY_NAME = "CHAT_ATTACHMENT_MAX_CHARS"
_TS_NAME = "ATTACHMENT_MAX_CONTENT_CHARS"


def _python_value() -> int:
    """AST 抽取模块级 `CHAT_ATTACHMENT_MAX_CHARS = <int>`。

    用 AST 而不是正则：正则会把注释里、字符串里的同名出现也算进去，而「部分抽取」
    比「抽不到」更毒 —— 它会给出一个看似成功的错值。
    """
    tree = ast.parse(_PY_SRC.read_text(encoding="utf-8"))
    found: list[int] = []
    for node in tree.body:  # 仅顶层，不下潜到函数内的同名局部变量
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == _PY_NAME:
                value = node.value
                assert isinstance(value, ast.Constant) and isinstance(value.value, int), (
                    f"{_PY_NAME} must be a plain int literal so this gate can read it; "
                    f"got {ast.dump(value)[:80]}"
                )
                found.append(value.value)
    assert len(found) == 1, (
        f"expected exactly one top-level `{_PY_NAME}` in {_PY_SRC.name}, found {len(found)}. "
        "Two same-named constants is exactly how a parity gate silently reads the wrong one."
    )
    return found[0]


def _ts_value() -> int:
    src = _TS_SRC.read_text(encoding="utf-8")
    matches = re.findall(
        rf"^export const {_TS_NAME}\s*=\s*(\d+)\s*$", src, flags=re.MULTILINE,
    )
    assert len(matches) == 1, (
        f"expected exactly one `export const {_TS_NAME} = <int>` in {_TS_SRC.name}, "
        f"found {len(matches)}"
    )
    return int(matches[0])


def test_chat_attachment_char_cap_matches_across_languages():
    py, ts = _python_value(), _ts_value()
    assert py == ts, (
        f"chat attachment char cap drifted: Python {_PY_NAME}={py} vs "
        f"TS {_TS_NAME}={ts}. Both sides truncate; a mismatch makes the `truncated` "
        f"flag lie and the model reads a fragment as if it were the whole document."
    )


def test_cap_is_large_enough_for_a_converted_document():
    """回归钉：这个值曾是 5000（为「粘贴一段日志」定的），会把一份 docx 腰斩。"""
    assert _python_value() >= 20000
