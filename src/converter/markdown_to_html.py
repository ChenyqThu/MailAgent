"""Markdown → HTML（reply_suggestion 等富文本回复正文用）。

从 scripts/html_clipboard.py 的 md_to_html 抽到 src/ —— 原 _reply_md_to_html /
handlers 用 ``dirname×4(__file__)/scripts`` 推 scripts 目录再 ``import html_clipboard``,
在打包态推算错位: .app 里 src 在 ``.../site-packages/src``、scripts 在
``Resources/scripts``, ×4 算成不存在的 ``site-packages/scripts`` →
ModuleNotFoundError → CLI exit 1 → compose 回复「预填加载失败 (E_GENERIC)」。
(dev 下 ``__file__`` 是 ``src/cli/.../email.py``, ×4 恰好仓库根 → ``repo/scripts`` ✓,
所以只在打包态炸。) 放进 src/ 后随 site-packages 必然进包, import 路径稳定,
dev / 打包零差异。

纯 python (re), 无 PyObjC 依赖。scripts/html_clipboard.py 保留一份同款实现供
AppleScript fallback (create_reply_draft.sh) 独立运行 —— 改其一需同步另一处。
"""

import re


def md_to_html(text: str, font_size: int = 14) -> str:
    """基础 Markdown → HTML（覆盖常用格式）"""
    # 存量 reply_suggestion_md 里残留字面 "\n"/"\t"（早期 prompt double-escape, 模型把
    # 反斜杠-n 当字面量输出 → 签名显示成可见的 "\n\n----\nBest,\nLucien"）。先还原成真
    # 换行/制表再解析; 新数据已在 processor.py 修正 prompt。顺带把 3+ 连续空行收敛成 1
    # 个空行, 缓解「正文换行过多」。
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
    # line-height 与前端 composer 的撰写行距默认对齐 (COMPOSE_LINE_HEIGHT_DEFAULT,
    # frontend/src/shared/state/appearance.ts) —— AI 建议直接落草稿/发送时行距与用户
    # 手写的一致, 不会一封松一封紧。
    return f"<div style='font-family:system-ui,-apple-system;font-size:{font_size}px;line-height:1.5'>{body}</div>"


def _inline_format(text: str) -> str:
    """处理行内格式：加粗、斜体、行内代码、链接、删除线"""
    text = re.sub(r'`(.+?)`', r"<code style='background:#f0f0f0;padding:1px 4px;border-radius:3px'>\1</code>", text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" style="color:#1a73e8">\1</a>', text)
    # 占位链接 [文字]（模型拿不到真实 URL 时常这么写）—— 真实 [t](u) 已在上一步转成 <a>,
    # 这里把残留的裸方括号去掉按纯文本显示, 避免「看起来坏掉的链接」。首字符为数字的方括号
    # (脚注标记 [1]/[12]) 保留, 不误伤; 对回复建议而言这是有意的有损转换。
    text = re.sub(r'\[([^\]\d][^\]]*)\]', r'\1', text)
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'<b><i>\1</i></b>', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\*(.+?)\*', r'<i>\1</i>', text)
    text = re.sub(r'~~(.+?)~~', r'<s>\1</s>', text)
    return text
