#!/usr/bin/env python3
"""将 Markdown 文本转换为 HTML 并写入 macOS 剪贴板（富文本格式）"""

import re
import sys

def md_to_html(text: str, font_size: int = 14) -> str:
    """基础 Markdown → HTML（覆盖常用格式）"""
    # 与 src/converter/markdown_to_html.py 保持一致 (改其一须同步): 还原字面 "\n"/"\t"
    # (早期 prompt double-escape 残留) + 收敛 3+ 连续空行。
    text = text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\t", "\t")
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = text.split("\n")
    html_lines = []
    in_list = False
    in_table = False
    table_header_done = False
    in_code_block = False
    code_block_lines = []

    for line in lines:
        stripped = line.strip()

        # Fenced code block (```)
        if stripped.startswith("```"):
            if in_code_block:
                code_content = "\n".join(code_block_lines)
                code_content = code_content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                html_lines.append(
                    f"<pre style='background:#f0f0f0;padding:8px 12px;border-radius:6px;font-size:13px;overflow-x:auto'><code>{code_content}</code></pre>"
                )
                code_block_lines = []
                in_code_block = False
            else:
                in_code_block = True
                code_block_lines = []
            continue

        if in_code_block:
            code_block_lines.append(line)
            continue

        # 表格行
        if "|" in stripped and stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            # 分隔行（| --- | --- |）跳过
            if all(re.match(r'^[-:]+$', c) for c in cells):
                table_header_done = True
                continue
            if not in_table:
                html_lines.append("<table style='border-collapse:collapse;margin:8px 0'>")
                in_table = True
            tag = "th" if not table_header_done else "td"
            style = "border:1px solid #ddd;padding:6px 12px"
            if tag == "th":
                style += ";background:#f5f5f5;font-weight:bold"
            row = "".join(f"<{tag} style='{style}'>{c}</{tag}>" for c in cells)
            html_lines.append(f"<tr>{row}</tr>")
            continue
        elif in_table:
            html_lines.append("</table>")
            in_table = False
            table_header_done = False

        # 关闭列表
        if in_list and not stripped.startswith("- "):
            html_lines.append("</ul>")
            in_list = False

        # 空行
        if not stripped:
            html_lines.append("<br>")
            continue

        # 水平线
        if re.match(r'^-{3,}$', stripped):
            html_lines.append("<hr style='border:none;border-top:1px solid #ccc;margin:12px 0'>")
            continue

        # 引用
        if stripped.startswith("> "):
            content = _inline_format(stripped[2:])
            html_lines.append(
                f"<blockquote style='border-left:3px solid #ccc;padding-left:12px;color:#555;margin:8px 0'>{content}</blockquote>"
            )
            continue

        # 列表项
        if stripped.startswith("- "):
            if not in_list:
                html_lines.append("<ul style='margin:4px 0;padding-left:24px'>")
                in_list = True
            content = _inline_format(stripped[2:])
            html_lines.append(f"<li>{content}</li>")
            continue

        # 普通段落
        html_lines.append(f"{_inline_format(stripped)}<br>")

    if in_list:
        html_lines.append("</ul>")
    if in_table:
        html_lines.append("</table>")

    body = "\n".join(html_lines)
    body = re.sub(r'(<br>\s*){2,}(<pre\b)', r'<br>\n\2', body)
    body = re.sub(r'(</pre>)\s*(<br>\s*){2,}', r'\1\n<br>', body)
    return f"<div style='font-family:system-ui,-apple-system;font-size:{font_size}px;line-height:1.6'>{body}</div>"


def _inline_format(text: str) -> str:
    """处理行内格式：加粗、斜体、行内代码、链接、删除线"""
    text = re.sub(r'`(.+?)`', r"<code style='background:#f0f0f0;padding:1px 4px;border-radius:3px'>\1</code>", text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" style="color:#1a73e8">\1</a>', text)
    # 占位链接 [文字]（无 URL）去裸方括号; 首字符数字的脚注 [1]/[12] 保留。与 src/converter 同步。
    text = re.sub(r'\[([^\]\d][^\]]*)\]', r'\1', text)
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'<b><i>\1</i></b>', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\*(.+?)\*', r'<i>\1</i>', text)
    text = re.sub(r'~~(.+?)~~', r'<s>\1</s>', text)
    return text


def set_html_clipboard(html: str):
    """通过 NSPasteboard 设置 HTML 剪贴板"""
    from AppKit import NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeString
    pb = NSPasteboard.generalPasteboard()
    pb.clearContents()
    pb.setString_forType_(html, NSPasteboardTypeHTML)
    # 同时设置纯文本 fallback
    import re
    plain = re.sub(r'<[^>]+>', '', html)
    pb.setString_forType_(plain, NSPasteboardTypeString)


if __name__ == "__main__":
    if "--set-html" in sys.argv:
        # Pre-converted HTML: just set clipboard
        html = sys.stdin.read()
        set_html_clipboard(html)
    else:
        # Markdown → HTML → clipboard
        text = sys.stdin.read()
        font_size = int(sys.argv[1]) if len(sys.argv) > 1 else 14
        html = md_to_html(text, font_size)
        set_html_clipboard(html)
