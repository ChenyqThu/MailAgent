"""xlsx 解析 + ENBU 过滤 + (Ongoing 内) 母子任务建立.

支持两种 xlsx 结构 (自动检测):

1. **v2 (直接发件人 / 4 sheet)**, 默认形态:
   - Sheet 1 'Project  Ongoing' (双空格): 34 列, **双行表头**
     行 1 英文 (BU / R&D Department / ...) → 用作 columns
     行 2 中文标签 (事业部/产品 / 事业部/研发 / ...) → 跳过
     行 3+ 真实数据
   - Sheet 2 '<YYYY>-Project Shipped': 65 列, 双行表头, 已出货项目 → Status=Done
   - Sheet 3 'Project Suspended': 65 列, 双行表头, 已暂停项目 → Status=Suspended
   - Sheet 4 'Filling-in & Reading Guide': 字段说明文档, 解析时跳过

2. **v1 (转发 / 单 sheet)** (向后兼容已有 fixtures):
   - Sheet 1 'Project  Ongoing': 15 列, **单行表头** (行 1 英文, 行 2+ 数据)
   - 没有其他 sheet

检测逻辑: row 0 是否含 'Project Name' 等核心列 → 单行表头; 否则当双行 (row 1
继续找 'Project Name' 才确认双行).

每个 sheet 的每行 → 一个 ProjectRow (1:1, 不再按 Project Name 聚合) 带
`current_sheet` 标签 (ONGOING / SHIPPED / SUSPENDED). 同 Project Name 下的
**仅 Ongoing 内** 多行建立母子任务关系; Shipped / Suspended 全是独立任务.
"""

from __future__ import annotations

import enum
import hashlib
import io
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union

# pandas 延迟到实际解析 xlsx 时 import (见 _parse_date_or_note /
# _read_sheet_with_dual_header / parse_xlsx_v2)。本模块被 CLI project-progress 命令组
# import (为拿 SheetKind 等), 但绝大多数 CLI 调用不解析 xlsx — pandas 冷 import ~0.3s
# 不该计入 CLI 启动。type 注解里的 pd.DataFrame 因 `from __future__ import annotations`
# 已是惰性字符串, 不在 import 期 eval。

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


# ============================================================================
# Sheet 路由
# ============================================================================

class SheetKind(str, enum.Enum):
    ONGOING = "ongoing"      # 'Project  Ongoing' (双空格) — 在研项目
    SHIPPED = "shipped"      # '<YYYY>-Project Shipped' — 已出货 → Status=Done
    SUSPENDED = "suspended"  # 'Project Suspended' — 已暂停 → Status=Suspended


def classify_sheet(sheet_name: str) -> Optional[SheetKind]:
    """Sheet 名 → SheetKind. 不识别的 sheet (如 'Filling-in & Reading Guide') 返回 None."""
    n = (sheet_name or "").strip()
    # Ongoing: 双空格 / 单空格都接受 (防御性)
    if n.replace("  ", " ").lower() == "project ongoing":
        return SheetKind.ONGOING
    # Shipped: '2026-Project Shipped', '2027-Project Shipped' 等 — 容年份漂移
    if re.match(r"^20\d{2}-Project\s+Shipped\s*$", n, flags=re.IGNORECASE):
        return SheetKind.SHIPPED
    if n.lower() == "project shipped":
        return SheetKind.SHIPPED
    # Suspended
    if n.lower() == "project suspended":
        return SheetKind.SUSPENDED
    return None


# 默认枚举的三个 sheet 的"标准名"(用作 fallback / display)
SHEET_ONGOING = "Project  Ongoing"
SHEET_SUSPENDED = "Project Suspended"

# 兼容旧 API 的常量 (旧测试 import 这个名字)
SHEET_NAME = SHEET_ONGOING


# ============================================================================
# xlsx 列名常量 (英文 — 行 1 表头)
# ============================================================================

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

# v2 新增列 (Sheet 1 多 19 列, Sheet 2/3 多 30+ 列, 我们只取关心的)
COL_ESTABLISHMENT_DATE = "Product Establishment Date"            # 立项时间
COL_DESIRED_SHIP_DATE = "Desired shipping Date"                  # 期望交期
COL_ESTIMATED_SHIP_DATE = "Estimated Shipping Date"              # 预计出货
COL_ACTUAL_SHIPPED_DATE = "Actual Shipped Date"                  # 实际出货 (Sheet 2)
COL_SUSPENSION_DATE = "Suspension Date"                          # 暂停时间 (Sheet 3)
COL_REASONS_FOR_DELAY = "Reasons for the Delay"                  # 进度异常
COL_CURRENT_STATUS = "Current Status"                            # 当前状态 (Sheet 2/3)

# 必需列 (缺一就 fail-soft 返回 missing_cols)
REQUIRED_COLS = [
    COL_BU,
    COL_PROJECT_NAME,
    COL_PRODUCT_MODEL,
    COL_PRIORITY,
    COL_PROGRESS,
]

# 文件名日期: 【DDL】...20260420 / -20260420- / _20260420_
_FN_DATE_RE = re.compile(r"(?P<y>20\d{2})(?P<m>\d{2})(?P<d>\d{2})")


# ============================================================================
# 数据类
# ============================================================================

@dataclass
class ProjectRow:
    """xlsx 里的一行 = 一个 (Project Name, Product Model) pair = 一个 Notion 页.

    每行独立 1 个 Notion 页; 同 Project Name 下多行通过 parent_external_id 建立
    **仅 Ongoing 内**的母子关系.
    """

    project_name: str
    product_model: str
    external_id: str
    bu: str
    current_sheet: SheetKind = SheetKind.ONGOING  # 行所属 sheet, 决定 Status 写入策略
    rnd_department: str = ""
    rnd_division: str = ""
    product_lines: List[str] = field(default_factory=list)
    product_name: str = ""
    priority_raw: Optional[str] = None
    shipped_us: bool = False
    pm: str = ""
    contact_window: str = ""
    assist_pm: str = ""
    ref_date: Optional[date] = None
    ref_date_note: str = ""
    risks: List[str] = field(default_factory=list)
    progress_blocks: List[ProgressBlock] = field(default_factory=list)
    this_week_blocks: List[ProgressBlock] = field(default_factory=list)

    # v2 新增字段 (v1 单 sheet 模式下都为 None / "")
    establishment_date: Optional[date] = None    # 立项时间
    desired_ship_date: Optional[date] = None     # 期望交期
    estimated_ship_date: Optional[date] = None   # 预计出货
    actual_ship_date: Optional[date] = None      # 实际出货 (Sheet 2)
    suspension_date: Optional[date] = None       # 暂停时间 (Sheet 3)
    reasons_for_delay: str = ""                  # 进度异常 (rich_text)
    current_status: str = ""                     # 当前状态 (Sheet 2/3 select)

    # 母子关系 (由 _resolve_parent_child 在 parse_xlsx 末尾填充, 仅 Ongoing 内)
    is_parent: bool = False
    parent_external_id: Optional[str] = None

    @property
    def earliest_progress_date(self) -> Optional[date]:
        """progress_blocks 里最老块日期. 需先 assign_years_descending."""
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
    """`parse_xlsx` / `parse_xlsx_v2` 完整结果."""

    xlsx_filename: str
    xlsx_md5: str
    xlsx_size: int
    sheet_name: str  # 历史兼容: 单 sheet 模式下=ONGOING; 多 sheet 模式下=', '-join
    total_rows: int
    filter_bu: str
    filtered_rows: int
    projects: List[ProjectRow]
    reference_date: date
    week_tag: str
    missing_cols: List[str] = field(default_factory=list)
    sheet_stats: Dict[SheetKind, int] = field(default_factory=dict)  # 每 sheet 的 ENBU 行数
    sheets_parsed: List[str] = field(default_factory=list)  # 实际解析的 sheet 名列表

    @property
    def projects_total(self) -> int:
        return len(self.projects)


# ============================================================================
# 引擎选择 + helpers
# ============================================================================

def _pick_engine():
    """优先 calamine (快 4-18x), 回退 openpyxl."""
    try:
        import python_calamine  # noqa: F401
        return "calamine"
    except ImportError:
        return "openpyxl"


def _str_clean(v: Any) -> str:
    """str 化 + strip; None / NaN / "/" / "-" / "nan" / "NaT" → 空字符串."""
    if v is None:
        return ""
    s = str(v).strip()
    if s in {"/", "-", "nan", "NaT", ""}:
        return ""
    return s


def _parse_date_or_note(raw: Any) -> Tuple[Optional[date], str]:
    """尝试把 cell 解析为 date; 失败保留原文当 note.

    支持 datetime / Timestamp / 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD' / 'MM/DD/YYYY' 等.
    'TBD' / 'Finished' / '待定' / '/' / '' 等非日期文本 → (None, '原文 or "")
    """
    import pandas as pd

    if raw is None:
        return None, ""
    if isinstance(raw, (datetime, pd.Timestamp)):
        try:
            return raw.date(), ""
        except (ValueError, OverflowError):
            return None, str(raw)
    if isinstance(raw, date):
        return raw, ""
    s = str(raw).strip()
    if not s or s in {"/", "-", "nan", "NaT"}:
        return None, ""
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%m/%d/%Y",
        "%d/%m/%Y",
    ):
        try:
            return datetime.strptime(s, fmt).date(), ""
        except ValueError:
            continue
    return None, s  # 'TBD' / 'Finished' / '待定' / '/' 等非日期


def _parse_date_only(raw: Any) -> Optional[date]:
    """仅当能解析为 date 才返回; 否则 None. (用于不需要保留 note 的字段)"""
    d, _ = _parse_date_or_note(raw)
    return d


def _bool_ship_us(raw: Any) -> bool:
    if raw is None:
        return False
    s = str(raw).strip().upper()
    return s == "Y"


def _infer_reference_date(
    xlsx_filename: str, fallback: Optional[date] = None
) -> date:
    """从文件名抽 YYYYMMDD."""
    m = _FN_DATE_RE.search(xlsx_filename)
    if m:
        try:
            return date(int(m["y"]), int(m["m"]), int(m["d"]))
        except ValueError:
            pass
    return fallback or date.today()


# ============================================================================
# 双行表头检测 + 单 sheet 解析
# ============================================================================

_HEADER_SCAN_DEPTH = 5  # 表头允许出现在前 N 行


def _read_sheet_with_dual_header(
    content: bytes, sheet_name: str, engine: str
) -> Optional[pd.DataFrame]:
    """读 sheet, 自动适配单/双行表头 + 可能的 banner 行. 返回标准 DataFrame.

    实际见过三种结构:
      A. **v1**: row 0 = 英文表头, row 1+ = 数据 (单行表头).
      B. **v2 Sheet 1 (Ongoing)**: row 0 = banner ('项目基本信息\\n...'),
         row 1 = 英文表头, row 2 = 中文标签, row 3+ = 数据.
      C. **v2 Sheet 2/3**: 同 B, banner + 英文 + 中文 + 数据.

    检测逻辑:
      - 扫描前 _HEADER_SCAN_DEPTH 行, 找到首个**同时**含 'BU' 和 'Project Name'
        的英文表头行
      - 表头下一行如果**也含**核心英文列名重叠 → 当作单行模式 (无中文标签),
        否则当作双行 (跳过下一行中文标签).
      - 没找到 → 返回 None
    """
    import pandas as pd

    try:
        df_raw = pd.read_excel(
            io.BytesIO(content), sheet_name=sheet_name, header=None, engine=engine
        )
    except Exception:
        return None
    if df_raw.empty or len(df_raw) < 2:
        return None

    def row_cells(idx: int) -> List[str]:
        if idx >= len(df_raw):
            return []
        return [str(v).strip() if v is not None else "" for v in df_raw.iloc[idx].tolist()]

    def is_english_header(cells: List[str]) -> bool:
        cs = set(cells)
        return COL_BU in cs and COL_PROJECT_NAME in cs

    header_idx: Optional[int] = None
    for i in range(min(_HEADER_SCAN_DEPTH, len(df_raw))):
        if is_english_header(row_cells(i)):
            header_idx = i
            break
    if header_idx is None:
        return None

    headers = row_cells(header_idx)
    next_idx = header_idx + 1
    next_cells = row_cells(next_idx) if next_idx < len(df_raw) else []
    # 双行模式判定: 如果"下一行"也包含 BU/Project Name 等英文列名 → 单行表头 (无中文标签)
    # 否则当中文标签行, 数据从 header_idx + 2 开始
    next_is_english = bool(next_cells) and (
        COL_BU in set(next_cells) or COL_PROJECT_NAME in set(next_cells)
    )
    data_start = header_idx + 1 if next_is_english else header_idx + 2

    # 但若 next 行的第一个非空格 cell 看起来是真实数据 (例如 'TPS-HNBU') 而非中文标签,
    # 退化为单行表头
    if not next_is_english and next_cells:
        first_non_empty = next((c for c in next_cells if c), "")
        # 中文标签行常见值: '事业部/产品', '事业部/研发', '产品线' 等; 数据行 BU 列首值
        # 一般是 'TPS-XXX' / 'Enterprise XXX' 等. 简单启发: 含 '事业部' / '产品' / '研发'
        # / '/产品' 通常是中文标签
        zh_label_markers = ("事业部", "课组", "研发", "项目管理", "产品负责人")
        is_zh_label = any(m in first_non_empty for m in zh_label_markers)
        if not is_zh_label:
            data_start = header_idx + 1  # 当作单行表头, 紧跟数据

    df = df_raw.iloc[data_start:].copy()
    df.columns = headers
    return df.reset_index(drop=True)


def _parse_sheet(
    df: pd.DataFrame,
    *,
    sheet_kind: SheetKind,
    filter_bu: str,
    reference_date: date,
) -> Tuple[List[ProjectRow], int, int, List[str]]:
    """解析单个 sheet 的 DataFrame → (projects, total_rows_in_sheet, enbu_rows, missing_cols).

    df 必须已经是 columns=英文表头 + 真实数据行的标准形态.
    """
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    total = len(df)

    if COL_BU not in df.columns or COL_PROJECT_NAME not in df.columns:
        return [], total, 0, missing

    enbu = df[df[COL_BU].astype(str).str.strip() == filter_bu].copy()
    enbu_rows = len(enbu)
    projects: List[ProjectRow] = []

    for _, row in enbu.iterrows():
        name = _str_clean(row.get(COL_PROJECT_NAME))
        product_model = _str_clean(row.get(COL_PRODUCT_MODEL))
        if not name:
            continue
        if not product_model:
            product_model = name  # 退化: title 用 project name

        priority_raw = normalize_priority(row.get(COL_PRIORITY))
        shipped = _bool_ship_us(row.get(COL_SHIP_US))
        ref_date, ref_date_note = _parse_date_or_note(row.get(COL_REF_DATE))

        # Risk
        risks: List[str] = []
        rv = _str_clean(row.get(COL_RISK))
        if rv:
            risks.append(rv)

        # Progress
        raw_prog = row.get(COL_PROGRESS)
        all_blocks = parse_progress(raw_prog) if raw_prog is not None else []
        dedup_seen: Set[Tuple[Any, ...]] = set()
        dedup_blocks: List[ProgressBlock] = []
        for b in all_blocks:
            key = (b.month, b.day, b.year, b.body)
            if key in dedup_seen:
                continue
            dedup_seen.add(key)
            dedup_blocks.append(b)
        assign_years_descending(dedup_blocks, reference_date)
        this_week = pick_this_week(dedup_blocks, reference_date)

        # Product Lines
        product_lines: List[str] = []
        pl = _str_clean(row.get(COL_PRODUCT_LINE))
        if pl:
            product_lines.append(pl)

        # v2 新字段 (v1 单 sheet 没有这些列, _str_clean / _parse_date_only 返回空 / None)
        establishment_date = _parse_date_only(row.get(COL_ESTABLISHMENT_DATE))
        desired_ship_date = _parse_date_only(row.get(COL_DESIRED_SHIP_DATE))
        estimated_ship_date = _parse_date_only(row.get(COL_ESTIMATED_SHIP_DATE))
        actual_ship_date = _parse_date_only(row.get(COL_ACTUAL_SHIPPED_DATE))
        suspension_date = _parse_date_only(row.get(COL_SUSPENSION_DATE))
        reasons_for_delay = _str_clean(row.get(COL_REASONS_FOR_DELAY))
        current_status = _str_clean(row.get(COL_CURRENT_STATUS))

        projects.append(
            ProjectRow(
                project_name=name,
                product_model=product_model,
                external_id=slugify(f"{name}__{product_model}"),
                bu=filter_bu,
                current_sheet=sheet_kind,
                rnd_department=_str_clean(row.get(COL_RND_DEPT)),
                rnd_division=_str_clean(row.get(COL_RND_DIV)),
                product_lines=product_lines,
                product_name=_str_clean(row.get(COL_PRODUCT_NAME)),
                priority_raw=priority_raw,
                shipped_us=shipped,
                pm=_str_clean(row.get(COL_PM)),
                contact_window=_str_clean(row.get(COL_CONTACT)),
                assist_pm=_str_clean(row.get(COL_ASSIST_PM)),
                ref_date=ref_date,
                ref_date_note=ref_date_note,
                risks=risks,
                progress_blocks=dedup_blocks,
                this_week_blocks=this_week,
                establishment_date=establishment_date,
                desired_ship_date=desired_ship_date,
                estimated_ship_date=estimated_ship_date,
                actual_ship_date=actual_ship_date,
                suspension_date=suspension_date,
                reasons_for_delay=reasons_for_delay,
                current_status=current_status,
            )
        )

    return projects, total, enbu_rows, missing


# ============================================================================
# 主入口
# ============================================================================

def parse_xlsx_v2(
    data: Union[bytes, str, Path],
    xlsx_filename: str,
    *,
    filter_bu: str = "TPS-ENBU",
    reference_date_override: Optional[date] = None,
    sheets: Optional[Set[SheetKind]] = None,
) -> ParseResult:
    """解析 xlsx (默认 4-sheet v2, 自动兼容 v1 单 sheet).

    Args:
        sheets: 限制解析哪些 sheet (默认全 3 个 ONGOING/SHIPPED/SUSPENDED).
                Filling-in Guide 永远跳过.
    """
    import pandas as pd

    if isinstance(data, (str, Path)):
        content = Path(data).read_bytes()
    else:
        content = data
    md5 = hashlib.md5(content).hexdigest()
    size = len(content)

    if sheets is None:
        sheets = {SheetKind.ONGOING, SheetKind.SHIPPED, SheetKind.SUSPENDED}

    reference_date = reference_date_override or _infer_reference_date(xlsx_filename)
    week_tag = iso_week_of(reference_date)

    engine = _pick_engine()

    # 列出 xlsx 所有 sheet
    try:
        xls = pd.ExcelFile(io.BytesIO(content), engine=engine)
        all_sheet_names = xls.sheet_names
    except Exception:
        # fallback: 只试 ONGOING (兼容老调用)
        all_sheet_names = [SHEET_ONGOING]

    all_projects: List[ProjectRow] = []
    sheet_stats: Dict[SheetKind, int] = {}
    sheets_parsed: List[str] = []
    total_rows_all = 0
    enbu_rows_all = 0
    missing_cols_all: List[str] = []

    for sheet_name in all_sheet_names:
        kind = classify_sheet(sheet_name)
        if kind is None:
            continue  # Filling-in Guide 等
        if kind not in sheets:
            continue
        df = _read_sheet_with_dual_header(content, sheet_name, engine)
        if df is None:
            continue
        projects, total, enbu, missing = _parse_sheet(
            df,
            sheet_kind=kind,
            filter_bu=filter_bu,
            reference_date=reference_date,
        )
        all_projects.extend(projects)
        sheet_stats[kind] = sheet_stats.get(kind, 0) + enbu
        sheets_parsed.append(sheet_name)
        total_rows_all += total
        enbu_rows_all += enbu
        for c in missing:
            if c not in missing_cols_all:
                missing_cols_all.append(c)

    _resolve_slug_collisions(all_projects)
    _resolve_parent_child(all_projects)

    return ParseResult(
        xlsx_filename=xlsx_filename,
        xlsx_md5=md5,
        xlsx_size=size,
        sheet_name=", ".join(sheets_parsed) if sheets_parsed else SHEET_ONGOING,
        total_rows=total_rows_all,
        filter_bu=filter_bu,
        filtered_rows=enbu_rows_all,
        projects=all_projects,
        reference_date=reference_date,
        week_tag=week_tag,
        missing_cols=missing_cols_all,
        sheet_stats=sheet_stats,
        sheets_parsed=sheets_parsed,
    )


def parse_xlsx(
    data: Union[bytes, str, Path],
    xlsx_filename: str,
    filter_bu: str = "TPS-ENBU",
    reference_date_override: Optional[date] = None,
) -> ParseResult:
    """旧 API. 默认仅解析 Ongoing sheet (兼容旧 fixtures + 旧测试).

    新代码请用 parse_xlsx_v2 (默认枚举 3 sheet).
    """
    return parse_xlsx_v2(
        data,
        xlsx_filename,
        filter_bu=filter_bu,
        reference_date_override=reference_date_override,
        sheets={SheetKind.ONGOING},
    )


# ============================================================================
# 母子关系 + slug 碰撞
# ============================================================================

_EXISTING_HASH_SUFFIX = re.compile(r"-[a-f0-9]{6}$")


def _resolve_parent_child(projects: List[ProjectRow]) -> None:
    """同一 Project Name 下选最早立项的一行作母任务, 其它为子.

    排序键 (跨周稳定):
      1. **优先** xlsx 立项时间 (Product Establishment Date, v2 才有)
      2. 兜底 earliest_progress_date (progress 推断, v1 唯一信号)
      3. 平局按 product_model 字母序

    用立项时间排序保证跨周角色稳定 (立项时间是项目固有属性, 不会变化), 避免
    "上周 A 是母, 本周 A 变子" 触发 Notion dual_property 冲突.

    **仅在 Ongoing sheet 内分组**; Shipped / Suspended 全是独立任务.
    """
    from collections import defaultdict

    ongoing_rows = [r for r in projects if r.current_sheet == SheetKind.ONGOING]
    groups: Dict[str, List[ProjectRow]] = defaultdict(list)
    for r in ongoing_rows:
        groups[r.project_name].append(r)

    for name, rows in groups.items():
        if len(rows) == 1:
            continue

        def key(r: ProjectRow):
            # 立项时间优先 (跨周稳定); 兜底 progress 最老块 (v1 时代唯一信号)
            d = r.establishment_date or r.earliest_progress_date
            return (d if d is not None else date.max, r.product_model)

        sorted_rows = sorted(rows, key=key)
        mom = sorted_rows[0]
        mom.is_parent = True
        mom.parent_external_id = None
        for child in sorted_rows[1:]:
            child.is_parent = False
            child.parent_external_id = mom.external_id


def _resolve_slug_collisions(projects: List[ProjectRow]) -> None:
    """对 external_id 碰撞的项目全员加 sha1 短后缀.

    包括跨 sheet 碰撞 (理论上同 (project_name, product_model) 出现在不同 sheet
    几乎不可能 — 一个项目要么 Ongoing 要么 Shipped 要么 Suspended).
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

    counts2 = Counter(p.external_id for p in projects)
    for i, p in enumerate(projects):
        if counts2[p.external_id] > 1:
            suffix = hashlib.sha1(f"row-{i}".encode()).hexdigest()[:6]
            head = p.external_id[: 80 - 1 - len(suffix)].rstrip("-")
            p.external_id = f"{head}-{suffix}"


# ============================================================================
# Markdown 渲染 (沿用旧实现)
# ============================================================================

def render_project_full_markdown(
    row: ProjectRow, week_tag_override: Optional[str] = None
) -> str:
    """首次创建项目页时, 把全部 progress_blocks 渲染为 markdown."""
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
