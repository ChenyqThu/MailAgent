"""md_to_html 转换器单测 —— compose reply_suggestion 富文本回复正文用。

覆盖 compose 「签名 / 链接 / 换行」修复批的三个核心 transform:
literal "\\n" 还原、3+ 连续空行收敛、裸占位链接去括号 (保留数字脚注)。
src/converter 与 scripts/html_clipboard 同款实现, 这里测前者 (compose / handlers 走它)。
"""

from src.converter.markdown_to_html import md_to_html


def test_unescapes_literal_newlines_in_signature():
    # 早期 prompt double-escape: 存量 reply_suggestion_md 含字面 "\n" → 应还原成真换行,
    # 签名才不会渲染成可见的反斜杠-n ("\n\n----\nBest,\nLucien")。
    html = md_to_html("正文段落\\n\\n----\\nBest,\\nLucien")
    assert "\\n" not in html  # 字面反斜杠-n 不再出现
    assert "<hr" in html  # ---- → 水平线
    assert "Best," in html and "Lucien" in html


def test_collapses_3plus_blank_lines():
    collapsed = md_to_html("a\n\n\n\n\nb")
    expanded = md_to_html("a\n\nb")
    # 5 连换行收敛到 2 → <br> 数量与「单个空行」一致, 不堆一长串。
    assert collapsed.count("<br>") == expanded.count("<br>")


def test_real_markdown_link_converted():
    html = md_to_html("see [doc](https://x.com/y)")
    assert '<a href="https://x.com/y"' in html
    assert ">doc</a>" in html


def test_bare_placeholder_link_stripped():
    # 无 URL 的占位链接 [文字] → 去方括号按纯文本 (避免「坏掉的链接」观感)。
    html = md_to_html("文档链接在此：[多通道解耦方案讨论文档]")
    assert "[多通道" not in html
    assert "多通道解耦方案讨论文档" in html


def test_numeric_footnote_brackets_preserved():
    # 首字符为数字的方括号是脚注标记, 不应被裸括号清理误删。
    html = md_to_html("参考 [1] 与 [12] 两处")
    assert "[1]" in html and "[12]" in html


def test_inline_bold_and_code_still_work():
    html = md_to_html("**粗体** 和 `code`")
    assert "<b>粗体</b>" in html
    assert "<code" in html and ">code</code>" in html
