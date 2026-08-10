"""anydoc 文档 → GFM markdown 提取（task 08-10 WP2）。

`firecrawl-anydoc` 是一个纯本地的 Rust 文档解析器（PyPI 包名 `firecrawl-anydoc`，
🔴 **import 名是 `anydoc`**），零 API key、零网络、零 ML 模型、零传递依赖。
本模块把它包成「永不抛异常」的薄层，失败一律返回 None，由调用方决定回落到哪个
原生 extractor —— 换代必须是「更好则用、不好则退」，不能是「换了就没退路」。

为什么换（`attachment_text.py` 的原生 extractor 有实测缺陷，非美观问题）：
  - docx: python-docx 的 `paragraph.text` **不含 `w:hyperlink` 内的 run**，实测一份
    真实附件丢了标题里的 "On-Premises" / "Approach"、正文 "1) **C**ontroller-based"
    的 C，以及全部超链接。这是**丢字**，不是排版差异。
  - docx / xlsx 的表格拼成 `a | b | c` 但**没有 `|---|` 分隔行** ⇒ 不是合法 GFM 表格，
    喂给模型时表结构等于不存在。
  - 老 .doc 走 soffice 桥，依赖未打包进 .app 的系统级 LibreOffice。

🔴 **PDF 有意不在默认 lane 里**（`MAILAGENT_ANYDOC_LANES` 默认 `office,legacy`）。
25 份真实 PDF 实测：20 份与 pypdf 持平、2 份略丰富、3 份回归，其中一份把 PDF 靠
重复绘制实现的伪粗体全抽了出来（`TThheerreeiissnnoo…`，连续重复字符占比 0.426 vs
pypdf 0.026），**它不抛异常也不返回空 ⇒ 没有任何判据能拦住它**。另一份把 pypdf 能
正常抽出 44K 字符的合同误判成 ImageBased 拒绝。收益≈0 而风险明确，故能力保留、
默认关；owner 加一个 `pdf` 到 LANES 即启用。

判据纪律：回落只认**异常类型**（`anydoc.ConvertError` 全家）与**空产出**，绝不解析
错误字符串。扫描件 PDF 抛 `UnsupportedError: PDF has no extractable text (Scanned, N pages)`，
类型本身已经够用。
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from loguru import logger


# ---------- lane 定义 ----------
#
# 值域取自 anydoc 实测的 `Format` literal（doc docx odt pdf ppt pptx rtf epub
# xlsx ods odp csv）+ `format_from_extension` 的扩展名映射表，不是 README 转述。
#
# 🔴 `.csv` 有意不在任何 lane 里：anydoc 支持它，但现状 plaintext 直读已经是最忠实的
# 产出，换过去只增风险不增收益。

LANE_OFFICE = 'office'
LANE_LEGACY = 'legacy'
LANE_PDF = 'pdf'

#: 现代 OOXML / ODF 家族。`.xlsm` / `.docm` 等宏格式在原生链路里是 unsupported，
#: 进 office lane 后变成可提取（净新增能力）。
ANYDOC_OFFICE_EXTENSIONS = frozenset({
    '.docx', '.docm', '.odt', '.rtf', '.epub',
    '.pptx', '.pptm', '.ppsx', '.ppsm', '.odp',
    '.xlsx', '.xlsm', '.xlsb', '.ods',
})

#: 老 OLE 二进制家族（原走 soffice 桥）。
#: 🔴 `.xls` 在 anydoc 的 `Format` 值域里**没有独立成员**（`doc`/`ppt` 有），
#: `format_from_extension('.xls')` 只是 fallback 到 `'xlsx'`，真 OLE 表格大概率解析不通。
#: 本机存量 `.xls` / `.ppt` 均为 0 条（45 条 soffice_bridge 全是 `.doc`），故列在这里
#: 是前瞻而非承诺：解析不通会照常回落 soffice 桥。
ANYDOC_LEGACY_EXTENSIONS = frozenset({
    '.doc', '.ppt', '.pps', '.pot', '.xls',
})

ANYDOC_PDF_EXTENSIONS = frozenset({'.pdf'})

ALL_LANES = frozenset({LANE_OFFICE, LANE_LEGACY, LANE_PDF})

_EXTENSION_LANES: dict[str, str] = {
    **{ext: LANE_OFFICE for ext in ANYDOC_OFFICE_EXTENSIONS},
    **{ext: LANE_LEGACY for ext in ANYDOC_LEGACY_EXTENSIONS},
    **{ext: LANE_PDF for ext in ANYDOC_PDF_EXTENSIONS},
}

#: 本模块统一的 extractor 标识（落 `email_attachment_text.extractor`）。
ANYDOC_EXTRACTOR = 'anydoc'


def lane_for_extension(ext: str) -> Optional[str]:
    """扩展名 → lane 名；不归任何 lane 返回 None。"""
    return _EXTENSION_LANES.get(ext.lower())


def _config():
    from src.config import config
    return config


def anydoc_enabled() -> bool:
    """总开关（`MAILAGENT_ANYDOC_ENABLED`，默认 false）。"""
    return bool(getattr(_config(), 'mailagent_anydoc_enabled', False))


def enabled_lanes() -> frozenset[str]:
    """`MAILAGENT_ANYDOC_LANES` 解析成 lane 集合。

    逗号分隔、去空白、忽略未知值（未知 lane 静默丢弃而不是炸配置 —— 这是应急阀，
    半夜改错一个字不该让整个提取链起不来）。
    """
    raw = getattr(_config(), 'mailagent_anydoc_lanes', '') or ''
    parsed = {item.strip().lower() for item in raw.split(',') if item.strip()}
    unknown = parsed - ALL_LANES
    if unknown:
        logger.warning(
            f'MAILAGENT_ANYDOC_LANES 含未知 lane {sorted(unknown)}，已忽略；'
            f'可选值 {sorted(ALL_LANES)}'
        )
    return frozenset(parsed & ALL_LANES)


def lane_active(ext: str) -> bool:
    """该扩展名此刻是否该走 anydoc（总开关 + lane 双条件）。"""
    if not anydoc_enabled():
        return False
    lane = lane_for_extension(ext)
    return lane is not None and lane in enabled_lanes()


def available() -> bool:
    """anydoc 包是否可 import（缺包时软着陆，不让提取链崩）。"""
    return _load() is not None


def _load():
    """懒 import。缺包返回 None —— 打包漏装依赖时该降级，不该整链失败。"""
    try:
        import anydoc  # type: ignore[import-not-found]
    except ImportError as e:
        logger.debug(f'anydoc not installed ({e}); falling back to native extractors')
        return None
    return anydoc


def convert_path(path: Path | str) -> Optional[str]:
    """文件 → markdown。失败/不支持/空产出一律 None（调用方回落）。"""
    mod = _load()
    if mod is None:
        return None
    try:
        md = mod.to_markdown(str(path))
    except Exception as e:  # noqa: BLE001 — 含 ConvertError 全家；任何异常都只是「回落」
        logger.debug(f'anydoc convert failed for {Path(path).name}: {type(e).__name__}: {e}')
        return None
    return md if md and md.strip() else None


def convert_bytes(data: bytes, fmt: Optional[str] = None) -> Optional[str]:
    """内存字节 → markdown（WP3 chat 附件用，全程不落盘）。

    `fmt` 是 anydoc 的 Format 名（`docx` / `pdf` / `csv` …）。无签名格式（CSV）
    必须显式点名，否则 anydoc 认不出来。实测 `to_markdown_bytes` 与 `to_markdown`
    的产出逐字节相同，故两条路不会给出不一致的结果。
    """
    mod = _load()
    if mod is None:
        return None
    try:
        md = mod.to_markdown_bytes(data, fmt) if fmt else mod.to_markdown_bytes(data)
    except Exception as e:  # noqa: BLE001 — 同上，异常即回落信号
        logger.debug(f'anydoc bytes convert failed (fmt={fmt}): {type(e).__name__}: {e}')
        return None
    return md if md and md.strip() else None


def format_for_extension(ext: str) -> Optional[str]:
    """扩展名 → anydoc Format 名；认不出返回 None（让内容签名自己去探测）。"""
    mod = _load()
    if mod is None:
        return None
    try:
        return mod.format_from_extension(ext)
    except Exception:  # noqa: BLE001 — 探测失败等同「不知道」，交给内容签名
        return None
