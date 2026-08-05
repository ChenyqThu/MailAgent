"""Report artifact vocabulary parity across Python and TypeScript.

The extraction canaries are deliberate: a source-format change must fail this gate instead of
silently comparing an empty set and reporting a false green.
"""

from __future__ import annotations

import re
from pathlib import Path

from src.reports.models import (
    MANUAL_CHAT_REPORT_AGENT_ID,
    MAX_IMAGE_SRC_CHARS,
    REPORT_BLOCK_TYPES,
    REPORT_CADENCES,
)


ROOT = Path(__file__).resolve().parents[2]
TS_CONTRACT = ROOT / "frontend/src/shared/api/reportBlocks.ts"
TS_TYPES = ROOT / "frontend/src/shared/api/types/report.ts"
TS_AVATAR_IMAGE = ROOT / "frontend/src/shared/components/agents/avatarImage.ts"
TS_AVATAR_IDENTITY = ROOT / "frontend/src/shared/components/agents/agentAvatarIdentity.ts"
QUOTED = re.compile(r"'([^']+)'")


def _extract_const_array(source: str, name: str) -> tuple[str, ...]:
    match = re.search(rf"export\s+const\s+{name}\s*=\s*\[(.*?)\]\s*as\s+const", source, re.S)
    assert match is not None, f"failed to extract {name}; update the consistency gate parser"
    values = tuple(QUOTED.findall(match.group(1)))
    assert values, f"{name} extraction returned no values"
    return values


def test_report_block_types_match_frontend_runtime_contract() -> None:
    source = TS_CONTRACT.read_text(encoding="utf-8")
    frontend = _extract_const_array(source, "REPORT_BLOCK_TYPES")
    assert "header" in frontend and "image" in frontend, "block extraction canary failed"
    assert frontend == REPORT_BLOCK_TYPES


def test_report_cadences_match_runtime_and_typescript_union() -> None:
    runtime_source = TS_CONTRACT.read_text(encoding="utf-8")
    frontend_runtime = _extract_const_array(runtime_source, "REPORT_CADENCES")
    assert "custom" in frontend_runtime, "cadence extraction canary failed"

    type_source = TS_TYPES.read_text(encoding="utf-8")
    type_match = re.search(r"export\s+type\s+ReportCadence\s*=([^\n]+)", type_source)
    assert type_match is not None, "failed to extract ReportCadence union"
    frontend_type = tuple(QUOTED.findall(type_match.group(1)))
    assert frontend_type, "ReportCadence union extraction returned no values"

    assert frontend_runtime == REPORT_CADENCES
    assert frontend_type == REPORT_CADENCES


def test_image_src_cap_matches_frontend_runtime_schema() -> None:
    """image src 上限跨语言同源（08-02 review F8）。

    这是 report_write 里唯一没有长度约束过的模型自由字段（markdown 的 text 早有 50k 上限），
    两侧任一边放宽而另一边不动，就会出现「gateway 收下、Python 拒绝」或反之的静默不一致。
    """
    source = TS_CONTRACT.read_text(encoding="utf-8")
    match = re.search(r"export\s+const\s+MAX_IMAGE_SRC_CHARS\s*=\s*([\d_]+)", source)
    assert match is not None, "没找到 MAX_IMAGE_SRC_CHARS —— 更新这道闸的解析器"
    frontend_cap = int(match.group(1).replace("_", ""))
    assert frontend_cap >= 1000, "上限 canary 失败 —— 解析器可能抓到了别的数字"
    assert frontend_cap == MAX_IMAGE_SRC_CHARS


def test_avatar_image_cap_matches_frontend() -> None:
    """上传头像的字节硬顶跨语言同源（0804 WP7）。

    前端压到 ≤N 才落库、后端 >N 就拒 —— 两边不同值时的失败很难自证：前端放宽（或后端收紧）
    后，用户上传一张「前端说 OK」的图，保存却回一个通用错误，重试永远无效。Python 不可能
    import TS，故只能建闸。
    """
    from src.reports.wire import AVATAR_IMAGE_MAX_BYTES

    source = TS_AVATAR_IMAGE.read_text(encoding="utf-8")
    match = re.search(
        r"export\s+const\s+AVATAR_IMAGE_MAX_BYTES\s*=\s*([\d_]+)\s*\*\s*([\d_]+)", source
    )
    assert match is not None, "没找到 AVATAR_IMAGE_MAX_BYTES —— 更新这道闸的解析器"
    frontend_cap = int(match.group(1).replace("_", "")) * int(match.group(2).replace("_", ""))
    assert frontend_cap >= 1024, "上限 canary 失败 —— 解析器可能抓到了别的数字"
    assert frontend_cap == AVATAR_IMAGE_MAX_BYTES


def test_avatar_image_mime_whitelist_matches_frontend() -> None:
    """上传头像的 mime 白名单跨语言同源（0804 WP7）。

    后端认、前端渲染判别不认 → 存进去的头像在界面上「静默变回生成头像」（无报错，用户以为
    没保存成功）。两侧都是正则字面量，故比较正则里的 mime 分支集合。
    """
    from src.reports.wire import _AVATAR_IMAGE_DATA_URI_RE

    def _mimes(pattern: str, where: str) -> set[str]:
        # `\\?/` 吃掉 TS 正则字面量里 `image\/` 的转义斜杠（Python 侧没有）。
        match = re.search(r"data:image\\?/\(\?:([a-z|]+)\)", pattern)
        assert match is not None, f"{where}: mime 白名单抽取失败 —— 更新这道闸的解析器"
        values = set(match.group(1).split("|"))
        assert "webp" in values, f"{where}: mime canary 失败"
        return values

    backend = _mimes(_AVATAR_IMAGE_DATA_URI_RE.pattern, "wire.py")
    frontend = _mimes(TS_AVATAR_IDENTITY.read_text(encoding="utf-8"), "agentAvatarIdentity.ts")
    assert backend == frontend


def test_manual_chat_author_id_matches_frontend() -> None:
    """manual chat 报告的哨兵作者 id 跨语言同源（08-02 review F6）。

    两侧不一致的后果不对称：gateway 传的 id 若与 Python 认的哨兵不同，`/reports/custom` 会按
    「未知 agent」拒绝，manual chat 的 report_write 直接不可用（且报错指向 agentId 而非配置）。
    """
    source = TS_CONTRACT.read_text(encoding="utf-8")
    match = re.search(r"export\s+const\s+MANUAL_CHAT_REPORT_AGENT_ID\s*=\s*'([^']+)'", source)
    assert match is not None, "没找到 MANUAL_CHAT_REPORT_AGENT_ID —— 更新这道闸的解析器"
    assert match.group(1) == MANUAL_CHAT_REPORT_AGENT_ID
