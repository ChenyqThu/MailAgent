"""
日历事件描述解析器 - 解析 Teams 会议和表格，转换为 Notion blocks

核心设计原则：
1. 基于特征识别，而非固定格式匹配
2. Teams 会议的核心要素：链接、会议ID、密码
3. 使用正则表达式灵活匹配多语言格式
"""

import re
from typing import List, Dict, Any, Optional, Tuple
from urllib.parse import unquote, parse_qs, urlparse
from dataclasses import dataclass


@dataclass
class TeamsMeetingInfo:
    """Teams 会议信息"""
    join_url: Optional[str] = None
    meeting_id: Optional[str] = None
    passcode: Optional[str] = None

    def is_valid(self) -> bool:
        """至少有链接才算有效"""
        return self.join_url is not None


class DescriptionParser:
    """解析日历事件描述，转换为 Notion blocks"""

    # Teams 链接的正则模式（核心特征：域名 + 路径格式）
    TEAMS_URL_PATTERNS = [
        # 新版格式: /meet/数字?p=密钥
        r'https://teams\.microsoft\.com/meet/\d+\?p=[A-Za-z0-9]+',
        # 旧版格式: /l/meetup-join/编码路径
        r'https://teams\.microsoft\.com/l/meetup-join/[^\s<>"\']+',
        # SafeLinks 包装的 Teams 链接
        r'https://[^/]*safelinks\.protection\.outlook\.com/ap/t-[^\s<>"\']+',
    ]

    # 会议 ID 的正则模式（核心特征：多组数字，通常用空格分隔）
    MEETING_ID_PATTERNS = [
        # 带标签: "Meeting ID: 123 456 789" 或 "会议 ID: 123 456 789"
        r'(?:Meeting\s*ID|会议\s*ID|会议ID)\s*[:：]\s*([\d\s]{10,25})',
    ]

    # 密码的正则模式（核心特征：标签后跟非空白字符串）
    PASSCODE_PATTERNS = [
        # 带标签: "Passcode: abc123" 或 "密码: abc123"
        r'(?:Passcode|Password|Pass code|密码)\s*[:：]\s*(\S{4,20})',
    ]

    def parse(self, description: str) -> List[Dict[str, Any]]:
        """
        解析描述内容，返回 Notion blocks
        """
        if not description:
            return []

        blocks = []

        # 清理换行符
        text = description.replace('\r\n', '\n').replace('\r', '\n')

        # 提取 Teams 会议信息
        teams_info = self._extract_teams_info(text)

        # 分离主要内容和 Teams 部分
        main_content = self._remove_teams_section(text)

        # 处理正文内容
        if main_content.strip():
            content_blocks = self._parse_main_content(main_content)
            blocks.extend(content_blocks)

        # 如果有 Teams 会议信息，添加格式化的会议卡片
        if teams_info.is_valid():
            # 添加分隔线
            blocks.append({"type": "divider", "divider": {}})
            teams_blocks = self._build_teams_blocks(teams_info)
            blocks.extend(teams_blocks)

        return blocks[:100]  # Notion API 限制最多 100 个 blocks

    def _extract_teams_info(self, text: str) -> TeamsMeetingInfo:
        """
        基于特征提取 Teams 会议信息

        核心逻辑：直接搜索链接、ID、密码的特征，不依赖固定格式
        """
        info = TeamsMeetingInfo()

        # 1. 提取 Teams 链接（优先级：新版 > 旧版 > SafeLinks）
        info.join_url = self._extract_teams_url(text)

        # 2. 提取会议 ID
        for pattern in self.MEETING_ID_PATTERNS:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                # 清理并格式化 ID（保留数字和空格）
                raw_id = match.group(1).strip()
                info.meeting_id = ' '.join(raw_id.split())
                break

        # 3. 提取密码
        for pattern in self.PASSCODE_PATTERNS:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                info.passcode = match.group(1).strip()
                break

        return info

    def _extract_teams_url(self, text: str) -> Optional[str]:
        """
        提取 Teams 会议链接

        策略：
        1. 先找新版简洁格式 (/meet/)
        2. 再找旧版格式 (/l/meetup-join/)
        3. 最后找 SafeLinks 包装的
        """
        # 新版格式: "加入: url" 或 "Join: url" 后面紧跟的链接
        # 这种格式后面可能跟着 SafeLinks 版本，需要只取干净的部分
        join_prefix_match = re.search(
            r'(?:加入|Join)\s*[:：]\s*(https://teams\.microsoft\.com/meet/\d+\?p=[A-Za-z0-9]+)',
            text, re.IGNORECASE
        )
        if join_prefix_match:
            return join_prefix_match.group(1)

        # 直接搜索 Teams URL
        for pattern in self.TEAMS_URL_PATTERNS:
            match = re.search(pattern, text)
            if match:
                url = match.group(0)
                # 如果是 SafeLinks，尝试解包
                if 'safelinks.protection.outlook.com' in url:
                    unwrapped = self._unwrap_safelinks(url)
                    if unwrapped and 'teams.microsoft.com' in unwrapped:
                        return unwrapped
                return url

        return None

    def _remove_teams_section(self, text: str) -> str:
        """
        从文本中移除 Teams 会议部分，保留主要内容

        策略：找到 Teams 相关标记的开始位置，截断后面的内容
        """
        # 常见的 Teams 部分开始标记（不区分大小写匹配）
        markers = [
            'Microsoft Teams 会议',
            'Microsoft Teams meeting',
            'Microsoft Teams Meeting',
            'Microsoft Teams Need help',
            'Microsoft Teams 是否需要帮助',
        ]

        earliest_pos = len(text)

        for marker in markers:
            # 不区分大小写查找
            pos = text.lower().find(marker.lower())
            if pos != -1:
                # 往前找分隔线
                sep_pos = text.rfind('_____', 0, pos)
                if sep_pos != -1 and pos - sep_pos < 50:
                    pos = sep_pos
                earliest_pos = min(earliest_pos, pos)

        if earliest_pos < len(text):
            return text[:earliest_pos].strip()

        return text

    def _build_teams_blocks(self, info: TeamsMeetingInfo) -> List[Dict[str, Any]]:
        """构建 Teams 会议的 Notion blocks"""
        blocks = []

        # 标题
        blocks.append({
            "type": "heading_2",
            "heading_2": {
                "rich_text": [{"type": "text", "text": {"content": "📅 Microsoft Teams 会议"}}]
            }
        })

        # 加入链接
        if info.join_url:
            blocks.append({
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [
                        {"type": "text", "text": {"content": "👉 "}},
                        {
                            "type": "text",
                            "text": {"content": "加入会议", "link": {"url": info.join_url}},
                            "annotations": {"bold": True, "color": "blue"}
                        }
                    ]
                }
            })

        # 会议 ID 和密码
        info_lines = []
        if info.meeting_id:
            info_lines.append(f"会议 ID: {info.meeting_id}")
        if info.passcode:
            info_lines.append(f"密码: {info.passcode}")

        if info_lines:
            blocks.append({
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": '\n'.join(info_lines)}}]
                }
            })

        return blocks

    def _parse_main_content(self, content: str) -> List[Dict[str, Any]]:
        """解析主要内容，识别表格、列表等"""
        blocks = []
        lines = content.split('\n')

        # 尝试检测表格
        table_data = self._detect_table(lines)
        if table_data:
            pre_table, table_lines, post_table = table_data

            if pre_table:
                blocks.extend(self._parse_text_blocks(pre_table))

            table_block = self._build_table_block(table_lines)
            if table_block:
                blocks.append(table_block)

            if post_table:
                blocks.extend(self._parse_text_blocks(post_table))
        else:
            blocks.extend(self._parse_text_blocks(lines))

        return blocks

    def _detect_table(self, lines: List[str]) -> Optional[Tuple[List[str], List[List[str]], List[str]]]:
        """检测并解析表格结构"""
        # 查找 ABR 风格表格
        time_pattern = re.compile(r'^\d{1,2}:\d{2}$')

        table_start = -1

        for i, line in enumerate(lines):
            stripped = line.strip()
            if 'Annual Business Review' in stripped or ('Meeting' in stripped and ('Jan' in stripped or '/' in stripped)):
                remaining = lines[i+1:i+10] if i+1 < len(lines) else []
                remaining_text = [l.strip() for l in remaining if l.strip()]

                if 'Time' in remaining_text and 'Topic' in remaining_text and 'Presenter' in remaining_text:
                    table_start = i
                    break

        if table_start == -1:
            return None

        pre_table = lines[:table_start]
        table_lines_raw = lines[table_start:]

        tables = []
        current_table = []
        current_header = None
        i = 0

        while i < len(table_lines_raw):
            line = table_lines_raw[i].strip()

            if 'Annual Business Review' in line or ('Meeting' in line and ('Jan' in line or '/' in line)):
                if current_table:
                    tables.append((current_header, current_table))
                current_header = line
                current_table = []
                i += 1
                continue

            if line in ['Time', 'Topic', 'Presenter', 'Duration']:
                i += 1
                continue

            if 'Break' in line:
                current_table.append([line, '', '', '', '', ''])
                i += 1
                continue

            if time_pattern.match(line):
                row = []
                for j in range(6):
                    if i + j < len(table_lines_raw):
                        row.append(table_lines_raw[i + j].strip())
                    else:
                        row.append('')

                if len(row) >= 6 and (row[1] == '-' or row[1] == ''):
                    current_table.append(row)
                    i += 6
                    continue

            if '___' in line or 'Microsoft Teams' in line:
                break

            i += 1

        if current_table:
            tables.append((current_header, current_table))

        if not tables:
            return None

        parsed_tables = []
        for header, rows in tables:
            table_data = []
            if header:
                table_data.append([header, '', '', ''])
            table_data.append(['Time', 'Duration', 'Topic', 'Presenter'])

            for row in rows:
                if 'Break' in row[0]:
                    table_data.append([row[0], '', '', ''])
                else:
                    time_range = f"{row[0]} - {row[2]}" if row[1] == '-' and row[2] else row[0]
                    duration = row[3] if len(row) > 3 else ''
                    topic = row[4] if len(row) > 4 else ''
                    presenter = row[5] if len(row) > 5 else ''
                    table_data.append([time_range, duration, topic, presenter])

            parsed_tables.extend(table_data)

        return pre_table, parsed_tables, []

    def _build_table_block(self, table_data: List[List[str]]) -> Optional[Dict[str, Any]]:
        """构建 Notion 表格 block"""
        if not table_data or len(table_data) < 2:
            return None

        num_cols = max(len(row) for row in table_data)
        if num_cols < 1:
            return None

        rows = []
        for row in table_data:
            cells = []
            for i in range(num_cols):
                cell_text = row[i] if i < len(row) else ''
                cells.append([{
                    "type": "text",
                    "text": {"content": str(cell_text)[:2000]}
                }])
            rows.append({
                "type": "table_row",
                "table_row": {"cells": cells}
            })

        return {
            "type": "table",
            "table": {
                "table_width": num_cols,
                "has_column_header": True,
                "has_row_header": False,
                "children": rows
            }
        }

    def _parse_text_blocks(self, lines: List[str]) -> List[Dict[str, Any]]:
        """将文本行解析为 Notion blocks"""
        blocks = []
        current_paragraph = []

        for line in lines:
            stripped = line.strip()

            if not stripped:
                if current_paragraph:
                    text = '\n'.join(current_paragraph)
                    blocks.append(self._create_paragraph_block(text))
                    current_paragraph = []
                continue

            if stripped.startswith('*   ') or stripped.startswith('  *   '):
                if current_paragraph:
                    text = '\n'.join(current_paragraph)
                    blocks.append(self._create_paragraph_block(text))
                    current_paragraph = []

                item_text = stripped.lstrip('* ').strip()
                item_text = self._clean_text_with_links(item_text)
                blocks.append({
                    "type": "bulleted_list_item",
                    "bulleted_list_item": {
                        "rich_text": [{"type": "text", "text": {"content": item_text[:2000]}}]
                    }
                })
            else:
                cleaned = self._clean_text_with_links(stripped)
                current_paragraph.append(cleaned)

        if current_paragraph:
            text = '\n'.join(current_paragraph)
            blocks.append(self._create_paragraph_block(text))

        return blocks

    def _create_paragraph_block(self, text: str) -> Dict[str, Any]:
        """创建段落 block"""
        return {
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": text[:2000]}}]
            }
        }

    def _unwrap_safelinks(self, url: str) -> Optional[str]:
        """解包 Microsoft SafeLinks URL"""
        if 'safelinks.protection.outlook.com' not in url:
            return url

        try:
            parsed = urlparse(url)
            query = parse_qs(parsed.query)
            if 'url' in query:
                return unquote(query['url'][0])
        except Exception:
            pass

        return url

    def _clean_text_with_links(self, text: str) -> str:
        """清理文本中的链接格式"""
        text = re.sub(r'([^<\s]+)<https?://[^>]+>', r'\1', text)
        text = re.sub(r'<(https?://[^>]+)>', r'\1', text)
        text = re.sub(r'<mailto:([^>]+)>', r'\1', text)
        return text
