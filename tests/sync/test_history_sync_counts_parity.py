"""闸 —— 「同步历史邮件」跨语言契约: Python 字段全集 ↔ TypeScript 接口。

两处手抄同一份字段表:

  1. ``src/sync/history_sync.py::_COUNT_FIELDS`` (runner 记账 + router 组装 ``counts``);
  2. ``frontend/src/shared/api/types/historySync.ts`` 的 ``HistorySyncCounts`` ——
     设置页「历史邮件」的摘要直接读这些字段。

``job`` 顶层字段集的同名闸在 ``tests/api/test_history_sync_api.py`` (那边的 conftest 已经
配好 API 鉴权; 本文件只 import ``src.sync``, 保持 ``pytest tests/sync`` 单独可跑)。

漏一个字段是**静默**的: TS 接口里声明了后端根本不发的字段, 前端 ``job.counts[field]``
拿到 undefined 照样渲染 (摘要里那一行直接空掉), typecheck 与后端测试两边都不会红。

🔴 抽取失败必须红: 抽不到接口就断言失败, 绝不拿空集合比空集合装绿
(部分抽取比抽不到更毒 —— 见 architecture-internals「跨语言手抄常量的一致性闸」)。
"""

from __future__ import annotations

import re
from pathlib import Path

from src.sync.history_sync import _COUNT_FIELDS

ROOT = Path(__file__).resolve().parents[2]
TS_TYPES = ROOT / "frontend/src/shared/api/types/historySync.ts"

#: 注释先剥掉, 否则注释里的 ``key: value`` 会被当成字段。
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"//[^\n]*")
FIELD = re.compile(r"^\s*(\w+)\??:", re.M)


def _interface_fields(name: str) -> list[str]:
    source = TS_TYPES.read_text(encoding="utf-8")
    match = re.search(rf"export interface {name}\s*\{{(.*?)\n\}}", source, re.S)
    assert match is not None, (
        f"{TS_TYPES.name}: 没找到 `export interface {name}` —— 接口被改名/改写了, "
        "更新这道闸的解析器 (不要让它抽空集合装绿)"
    )
    body = LINE_COMMENT.sub("", BLOCK_COMMENT.sub("", match.group(1)))
    fields = FIELD.findall(body)
    assert fields, f"{TS_TYPES.name}: {name} 字段抽取结果为空 —— 解析器坏了"
    return fields


def test_counts_fields_match_the_ts_interface() -> None:
    """摘要的八项分项计数两边逐字段对应。"""
    fields = _interface_fields("HistorySyncCounts")
    # canary: 抓到的若是别的接口, 立刻暴露
    assert "scanned" in fields, "抽取 canary 失败 (没抓到 'scanned')"

    assert set(fields) == set(_COUNT_FIELDS)
