"""xlsx 解析 + ENBU 过滤 + 按 Project Name 聚合。

xlsx 结构（Evelyn 转发的《【DDL】RD Project Progress Report--市场产品-YYYYMMDD_N（发布版本）.xlsx》)
  - Sheet 名: 'Project  Ongoing'（双空格，注意）
  - 15 列（英文）: BU / R&D Department / R&D Division / Product Line / Product Name /
                  Project Name / Product Model / Project Priority /
                  Shipped to the United States / Project Manager / Contact Window /
                  Assist Project Manager / Reference Date for the Business /
                  Project Progress / Project Risk
  - ~2800 行，其中 BU == 'TPS-ENBU' 约 1015 行，聚合后 ~226 个 unique Project Name
"""

from __future__ import annotations

import hashlib
import io
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import pandas as pd

from .priority import normalize_priority
from .progress_parser import (
    ProgressBlock,
    assign_years_descending,
    format_all_history_markdown,
    format_block_markdown,
    iso_week_of,
    parse_progress,
    pick_this_week,
)
from .slug import slugify

SHEET_NAME = "Project  Ongoing"

# xlsx 英文列名 → 内部字段
COL_BU = "BU"
COL_RND_DEPT = "R&D Department"
COL_RND_DIV = "R&D Division"
COL_PRODUCT_LINE = "Product Line"
COL_PRODUCT_NAME = "Product Name"
COL_PROJECT_NAME = "Project Name"
COL_PRODUCT_MODEL = "Product Model"
COL_PRIORITY = "Project Priority"
COL_SHIP_US = "Shipped to the United States"
COL_PM = "Project Manager"
COL_CONTACT = "Contact Window"
COL_ASSIST_PM = "Assist Project Manager"
COL_REF_DATE = "Reference Date for the Business"
COL_PROGRESS = "Project Progress"
COL_RISK = "Project Risk"

REQUIRED_COLS = [
    COL_BU,
    COL_PROJECT_NAME,
    COL_PRODUCT_MODEL,
    COL_PRIORITY,
    COL_PROGRESS,
]

# 文件名日期解析：【DDL】...20260420_1 或 市场产品-20260420
_FN_DATE_RE = re.compile(r"(?P<y>20\d{2})(?P<m>\d{2})(?P<d>\d{2})")


@dataclass
class ProjectRow:
    """xlsx 里的一行（= 一个 (Project Name, Product Model) pair = 一个 Notion 页）。

    每行独立一个 Notion 页；同 Project Name 下的多行通过 parent_external_id 建立母子关系。
    """

    project_name: str  # xlsx Project Name（用于识别 parent 组，但不作为 Notion title）
    product_model: str  # xlsx Product Model（作为 Notion title）
    external_id: str  # = slugify(project_name + "__" + product_model)，upsert key
    bu: str
    rnd_department: str = ""
    rnd_division: str = ""
    # 产品线：xlsx Product Line 原值（单行只有一个，但写 Notion multi_select 形式方便扩展）
    product_lines: List[str] = field(default_factory=list)
    product_name: str = ""
    priority_raw: Optional[str] = None  # 原值直写到 Notion select
    shipped_us: bool = False
    pm: str = ""
    contact_window: str = ""
    assist_pm: str = ""
    ref_date: Optional[date] = None
    ref_date_note: str = ""  # 非日期值（Terminated/No MPS）
    risks: List[str] = field(default_factory=list)
    progress_blocks: List[ProgressBlock] = field(default_factory=list)
    # 本周（reference_date 所在 ISO 周）内的块
    this_week_blocks: List[ProgressBlock] = field(default_factory=list)

    # 母子关系（由 _resolve_parent_child 在 parse_xlsx 末尾填充）
    is_parent: bool = False  # 同 Project Name 下选出的 "最早" 行 = True
    parent_external_id: Optional[str] = None  # 非 None 表示子任务，指向母的 external_id

    @property
    def earliest_progress_date(self) -> Optional[date]:
        """progress_blocks 里最老块的日期（用于选母任务）。需先 assign_years_descending。"""
        for b in reversed(self.progress_blocks):
            if b.month == 0 or b.year is None:
                continue
            try:
                return date(b.year, b.month, b.day)
            except ValueError:
                continue
        return None


@dataclass
class ParseResult:
    """`parse_xlsx` 的完整结果。"""

    xlsx_filename: str
    xlsx_md5: str
    xlsx_size: int
    sheet_name: str
    total_rows: int
    filter_bu: str
    filtered_rows: int
    projects: List[ProjectRow]
    reference_date: date
    week_tag: str
    missing_cols: List[str] = field(default_factory=list)

    @property
    def projects_total(self) -> int:
        return len(self.projects)


def _pick_engine():
    """优先使用 calamine（快 4-18x），回退到 openpyxl。"""
    try:
        import python_calamine  # noqa: F401

        return "calamine"
    except ImportError:
        return "openpyxl"


def _first_non_empty(series: pd.Series) -> str:
    for v in series:
        if v is None:
            continue
        s = str(v).strip()
        if s and s not in {"/", "-", "nan", "NaT"}:
            return s
    return ""


def _parse_date_or_note(raw: Any) -> Tuple[Optional[date], str]:
    """尝试把 Reference Date 解析成 date；失败则保留原文当 note。"""
    if raw is None:
        return None, ""
    if isinstance(raw, (datetime, pd.Timestamp)):
        return raw.date(), ""
    if isinstance(raw, date):
        return raw, ""
    s = str(raw).strip()
    if not s or s in {"/", "-", "nan", "NaT"}:
        return None, ""
    # 常见日期格式
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date(), ""
        except ValueError:
            continue
    return None, s  # 非日期值（Terminated / No MPS / TBD）


def _bool_ship_us(raw: Any) -> bool:
    if raw is None:
        return False
    s = str(raw).strip().upper()
    return s == "Y"


def _infer_reference_date(
    xlsx_filename: str, fallback: Optional[date] = None
) -> date:
    """从文件名中抽 YYYYMMDD。"""
    m = _FN_DATE_RE.search(xlsx_filename)
    if m:
        try:
            return date(int(m["y"]), int(m["m"]), int(m["d"]))
        except ValueError:
            pass
    return fallback or date.today()


def parse_xlsx(
    data: Union[bytes, str, Path],
    xlsx_filename: str,
    filter_bu: str = "TPS-ENBU",
    reference_date_override: Optional[date] = None,
) -> ParseResult:
    """解析 xlsx → 过滤 BU → 按 Project Name 聚合。

    Args:
        data: xlsx bytes 或文件路径
        xlsx_filename: 原文件名（用于 md5 记录 + 文件名日期推断）
        filter_bu: 保留的 BU 值（默认 TPS-ENBU）
        reference_date_override: 显式指定 reference_date（测试用）

    Returns:
        ParseResult，其中 projects 为聚合后的项目列表。
    """
    if isinstance(data, (str, Path)):
        content = Path(data).read_bytes()
    else:
        content = data
    md5 = hashlib.md5(content).hexdigest()
    size = len(content)

    df = pd.read_excel(
        io.BytesIO(content), sheet_name=SHEET_NAME, engine=_pick_engine()
    )

    missing_cols = [c for c in REQUIRED_COLS if c not in df.columns]

    total_rows = len(df)
    if COL_BU not in df.columns:
        return ParseResult(
            xlsx_filename=xlsx_filename,
            xlsx_md5=md5,
            xlsx_size=size,
            sheet_name=SHEET_NAME,
            total_rows=total_rows,
            filter_bu=filter_bu,
            filtered_rows=0,
            projects=[],
            reference_date=_infer_reference_date(xlsx_filename),
            week_tag=iso_week_of(_infer_reference_date(xlsx_filename)),
            missing_cols=missing_cols,
        )

    enbu = df[df[COL_BU].astype(str).str.strip() == filter_bu].copy()
    filtered_rows = len(enbu)

    reference_date = reference_date_override or _infer_reference_date(xlsx_filename)
    week_tag = iso_week_of(reference_date)

    projects: List[ProjectRow] = []

    if COL_PROJECT_NAME not in df.columns:
        return ParseResult(
            xlsx_filename=xlsx_filename,
            xlsx_md5=md5,
            xlsx_size=size,
            sheet_name=SHEET_NAME,
            total_rows=total_rows,
            filter_bu=filter_bu,
            filtered_rows=filtered_rows,
            projects=projects,
            reference_date=reference_date,
            week_tag=week_tag,
            missing_cols=missing_cols,
        )

    # 每行独立一个 ProjectRow
    for _, row in enbu.iterrows():
        name = str(row.get(COL_PROJECT_NAME, "") or "").strip()
        product_model = str(row.get(COL_PRODUCT_MODEL, "") or "").strip()
        if not name or name in {"/", "-"}:
            continue
        if not product_model or product_model in {"/", "-"}:
            # 仍然允许：用空 Product Model 做 slug（极少）
            product_model = name  # 退化：title 用 project name

        # Priority
        priority_raw = normalize_priority(row.get(COL_PRIORITY))

        # Shipped US
        shipped = _bool_ship_us(row.get(COL_SHIP_US))

        # Ref date
        ref_date, ref_date_note = _parse_date_or_note(row.get(COL_REF_DATE))

        # Risk
        risks: List[str] = []
        rv = row.get(COL_RISK)
        if rv is not None:
            s = str(rv).strip()
            if s and s not in {"/", "-"}:
                risks.append(s)

        # Progress
        raw_prog = row.get(COL_PROGRESS)
        all_blocks = parse_progress(raw_prog) if raw_prog is not None else []

        # 同 (m,d,y,body) 去重（同行里几乎不会重复，但保险）
        dedup_seen = set()
        dedup_blocks: List[ProgressBlock] = []
        for b in all_blocks:
            key = (b.month, b.day, b.year, b.body)
            if key in dedup_seen:
                continue
            dedup_seen.add(key)
            dedup_blocks.append(b)
        assign_years_descending(dedup_blocks, reference_date)
        this_week = pick_this_week(dedup_blocks, reference_date)

        # Product Lines (本行单值，写成 list 方便 multi_select 复用)
        product_lines: List[str] = []
        pv = row.get(COL_PRODUCT_LINE)
        if pv is not None:
            s = str(pv).strip()
            if s and s not in {"/", "-"}:
                product_lines.append(s)

        projects.append(
            ProjectRow(
                project_name=name,
                product_model=product_model,
                external_id=slugify(f"{name}__{product_model}"),
                bu=filter_bu,
                rnd_department=str(row.get(COL_RND_DEPT, "") or "").strip(),
                rnd_division=str(row.get(COL_RND_DIV, "") or "").strip(),
                product_lines=product_lines,
                product_name=str(row.get(COL_PRODUCT_NAME, "") or "").strip(),
                priority_raw=priority_raw,
                shipped_us=shipped,
                pm=str(row.get(COL_PM, "") or "").strip(),
                contact_window=str(row.get(COL_CONTACT, "") or "").strip(),
                assist_pm=str(row.get(COL_ASSIST_PM, "") or "").strip(),
                ref_date=ref_date,
                ref_date_note=ref_date_note,
                risks=risks,
                progress_blocks=dedup_blocks,
                this_week_blocks=this_week,
            )
        )

    _resolve_slug_collisions(projects)
    _resolve_parent_child(projects)

    return ParseResult(
        xlsx_filename=xlsx_filename,
        xlsx_md5=md5,
        xlsx_size=size,
        sheet_name=SHEET_NAME,
        total_rows=total_rows,
        filter_bu=filter_bu,
        filtered_rows=filtered_rows,
        projects=projects,
        reference_date=reference_date,
        week_tag=week_tag,
        missing_cols=missing_cols,
    )


_EXISTING_HASH_SUFFIX = re.compile(r"-[a-f0-9]{6}$")


def _resolve_parent_child(projects: List[ProjectRow]) -> None:
    """同一 Project Name 下选"progress 最老块日期最早"的一行作母任务，其它为子。

    - 单行 project: is_parent=False, parent_external_id=None（独立任务）
    - 多行: 选 earliest_progress_date 最老的；无 progress 的行参与排序时日期视为 date.max
      平局按 product_model 字母序。其余行 parent_external_id = 母的 external_id
    """
    from collections import defaultdict

    groups: Dict[str, List[ProjectRow]] = defaultdict(list)
    for r in projects:
        groups[r.project_name].append(r)

    for name, rows in groups.items():
        if len(rows) == 1:
            continue

        def key(r: ProjectRow):
            d = r.earliest_progress_date
            return (d if d is not None else date.max, r.product_model)

        sorted_rows = sorted(rows, key=key)
        mom = sorted_rows[0]
        mom.is_parent = True
        mom.parent_external_id = None
        for child in sorted_rows[1:]:
            child.is_parent = False
            child.parent_external_id = mom.external_id


def _resolve_slug_collisions(projects: List[ProjectRow]) -> None:
    """对 external_id 碰撞的项目全员加 sha1 短后缀。

    hash 基于 (project_name, product_model) 的组合 bytes，保证 row 级唯一。
    已含 6-hex 后缀（中文 fallback 分支）的 slug 不再追加。
    """
    counts = Counter(p.external_id for p in projects)
    for p in projects:
        if counts[p.external_id] <= 1:
            continue
        if _EXISTING_HASH_SUFFIX.search(p.external_id):
            continue
        key = f"{p.project_name}\x00{p.product_model}".encode("utf-8")
        suffix = hashlib.sha1(key).hexdigest()[:6]
        head = p.external_id[: 80 - 1 - len(suffix)].rstrip("-")
        p.external_id = f"{head}-{suffix}"

    # 若仍有碰撞（罕见：完全一致的 project_name + product_model，xlsx 异常），做二轮
    counts2 = Counter(p.external_id for p in projects)
    for i, p in enumerate(projects):
        if counts2[p.external_id] > 1:
            suffix = hashlib.sha1(f"row-{i}".encode()).hexdigest()[:6]
            head = p.external_id[: 80 - 1 - len(suffix)].rstrip("-")
            p.external_id = f"{head}-{suffix}"


def render_project_full_markdown(
    row: ProjectRow, week_tag_override: Optional[str] = None
) -> str:
    """首次创建项目页时，把全部 progress_blocks 渲染为 markdown。

    Args:
        row: 已聚合的项目行
        week_tag_override: 若提供，this_week_blocks 里的块 heading 用此 week_tag
            （与后续 prepend 的 week_tag 保持一致，保证幂等 guard 能命中）。

    非 this_week 的历史块按自身日期推算 ISO 周。
    """
    if not row.progress_blocks:
        return ""
    if week_tag_override is None:
        return format_all_history_markdown(
            row.progress_blocks, row.ref_date or date.today()
        )
    this_week_keys = {
        (b.month, b.day, b.year, b.body) for b in row.this_week_blocks
    }
    parts: List[str] = []
    ref = row.ref_date or date.today()
    for b in row.progress_blocks:
        if (b.month, b.day, b.year, b.body) in this_week_keys:
            parts.append(format_block_markdown(b, week_tag_override))
            continue
        if b.month == 0:
            body = b.body.strip()
            if body:
                parts.append(body + "\n")
            continue
        y = b.year
        if y is None:
            from datetime import timedelta as _td

            y = ref.year
            try:
                cand = date(y, b.month, b.day)
            except ValueError:
                continue
            if cand > ref + _td(days=7):
                y -= 1
        try:
            bd = date(y, b.month, b.day)
        except ValueError:
            continue
        parts.append(format_block_markdown(b, iso_week_of(bd)))
    return "\n".join(parts).strip()
