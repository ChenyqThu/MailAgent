"""``calendar_event.source`` 三元组的**全仓一致性闸**（issue #68）。

`('caldav', 'email_ics', 'legacy_calendar_app')` 曾在**九处**各写一份。issue #68 收敛掉
能收敛的（Python 三处改 import `SOURCES_TRY_ORDER`；前端两个组件的 `_VALID_SOURCES` +
`narrowSource` 合并进 `shared/lib/calendarSource.ts`，那里再用 `satisfies` + 穷尽性检查把
TS 联合类型钉成编译期真源），剩下这些**消灭不掉**，由本闸对撞：

| 镜像 | 为什么消灭不掉 |
|---|---|
| `src/mail/sync_store.py` 的 `CHECK (source IN (...))` | 建表 SQL 字符串，import 不进去（也是**最终执行者**：不在其中的值 INSERT 直接被拒） |
| `src/api/schemas/calendar.py::CalendarEventSource` | `Literal[...]` 的参数必须是字面量，无法由运行期 tuple 派生 |
| `src/skills/builtin/calendar.py::_VALID_SOURCES` | 对外 Skill 面的独立校验层 |
| `frontend/src/shared/api/types/calendar.ts::CalendarEventSource` | 跨语言 |
| `frontend/src/ai-gateway/tools/schemas.ts` 的 `z.enum([...])` | 跨语言，且是模型输入 allowlist（语义与"值域"不同：它还带 `.default`） |

🔴 **漏改的后果分两种**，都不报错在改动处：收窄的一侧（SQL CHECK / zod / skills 校验）漏加
新 source → 写入/调用被拒，但报的是"非法参数"，排查会往调用方去；放宽的一侧（Literal /
TS 联合）漏加 → 该值能存能读，却过不了 web 侧 ajv 校验、前端 `narrowCalendarSource` 把它
判成未知值 fallback 掉（**只在 console.warn**）。

**两侧都抽真源，本文件不持任何期望值副本**；抽取失败一律断言红（正则只认当前习语，改写法
的人必须回来更新抽取器，顺手核对镜像仍一致）。反向用例用合成源码证明闸真会红。

canonical = ``src/calendar_sync/_common.SOURCES_TRY_ORDER``（直接 import）。注意它的**顺序**
另有语义（未指定 source 时的 fallback 查找顺序），故各处只与它的**集合**比对，不比顺序。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Set, get_args

import pytest

from src.api.schemas.calendar import CalendarEventSource
from src.calendar_sync._common import SOURCES_TRY_ORDER

_REPO_ROOT = Path(__file__).resolve().parents[2]
CANONICAL: Set[str] = set(SOURCES_TRY_ORDER)

_SQL_CHECK = _REPO_ROOT / "src/mail/sync_store.py"
_SKILL = _REPO_ROOT / "src/skills/builtin/calendar.py"
_TS_TYPES = _REPO_ROOT / "frontend/src/shared/api/types/calendar.ts"
_TS_ZOD = _REPO_ROOT / "frontend/src/ai-gateway/tools/schemas.ts"
_TS_SHARED = _REPO_ROOT / "frontend/src/shared/lib/calendarSource.ts"


def _read(path: Path) -> str:
    assert path.exists(), f"镜像文件搬家了？{path}"
    return path.read_text(encoding="utf-8")


def _extract(pattern: str, src: str, *, origin: str, what: str) -> Set[str]:
    m = re.search(pattern, src)
    assert m, (
        f"{origin}: 没抽到 {what} —— 写法变了（改名 / 换结构 / 换引号）？"
        "更新本闸的抽取器，并核对该处仍与 SOURCES_TRY_ORDER 一致"
    )
    values = set(re.findall(r"['\"]([a-z_]+)['\"]", m.group(1)))
    assert values, f"{origin}: {what} 里一个值都没抽到 —— 习语变了，更新本闸的抽取器"
    return values


def _sql_check(src: str, *, origin: str) -> Set[str]:
    """🔴 必须先锚到 ``calendar_event`` 的建表块再抓 CHECK。

    ``sync_store.py`` 里有**不止一个** ``CHECK (source IN (...))``（``email_translation``
    表也有一个，值是 llm_agent/on_demand）—— 不锚定表名就会抓到隔壁那张表，闸红在一个
    根本不存在的漂移上。本闸开发时就先撞了这一脚。
    """
    block = re.search(
        r"CREATE TABLE IF NOT EXISTS calendar_event \((.*?)\n\s*\)", src, re.DOTALL
    )
    assert block, (
        f"{origin}: 没抽到 calendar_event 的建表块 —— 建表被挪走/改写了？更新本闸的抽取器"
    )
    return _extract(
        r"CHECK \(source IN \(([^)]*)\)\)",
        block.group(1),
        origin=origin,
        what="calendar_event 的 CHECK 约束",
    )


def _skill_sources(src: str, *, origin: str) -> Set[str]:
    return _extract(
        r"(?m)^_VALID_SOURCES\s*=\s*\(([^)]*)\)", src, origin=origin, what="_VALID_SOURCES 元组"
    )


def _ts_union(src: str, *, origin: str) -> Set[str]:
    return _extract(
        r"export type CalendarEventSource\s*=\s*([^\n]+)",
        src,
        origin=origin,
        what="CalendarEventSource 联合类型",
    )


def _ts_zod_enum(src: str, *, origin: str) -> Set[str]:
    return _extract(
        r"source: z\.enum\(\[([^\]]*)\]\)", src, origin=origin, what="日历 source 的 z.enum"
    )


def _ts_shared_list(src: str, *, origin: str) -> Set[str]:
    return _extract(
        r"export const VALID_CALENDAR_SOURCES\s*=\s*\[([^\]]*)\]",
        src,
        origin=origin,
        what="VALID_CALENDAR_SOURCES 数组",
    )


# ── Python 侧 ────────────────────────────────────────────────────────────────

def test_pydantic_literal_matches_canonical():
    assert set(get_args(CalendarEventSource)) == CANONICAL, (
        "wire 契约的 Literal 与 SOURCES_TRY_ORDER 漂移 —— 少一个 = 该 source 的行读出来"
        "过不了响应模型校验；多一个 = 声明了一个存不进 DB（CHECK 约束会拒）的值"
    )


def test_sql_check_constraint_matches_canonical():
    got = _sql_check(_read(_SQL_CHECK), origin=str(_SQL_CHECK))
    assert got == CANONICAL, (
        f"建表 CHECK 约束 {sorted(got)} 与 SOURCES_TRY_ORDER {sorted(CANONICAL)} 漂移 —— "
        "CHECK 是最终执行者：不在其中的 source 会在 INSERT 时被 SQLite 直接拒掉。"
        "🔴 改它还需要一次 schema 迁移（CHECK 约束改不了，得重建表），不是改行字面量就完"
    )


def test_skill_surface_matches_canonical():
    got = _skill_sources(_read(_SKILL), origin=str(_SKILL))
    assert got == CANONICAL, (
        f"对外 Skill 面的白名单 {sorted(got)} 与 SOURCES_TRY_ORDER 漂移 —— "
        "外部 agent 传新 source 会被这层拒掉，报的却是「非法参数」"
    )


# ── TS 侧（跨语言，源码抽取）─────────────────────────────────────────────────

def test_ts_union_matches_canonical():
    got = _ts_union(_read(_TS_TYPES), origin=str(_TS_TYPES))
    assert got == CANONICAL, (
        f"前端 CalendarEventSource 联合 {sorted(got)} 与 Python 真源 {sorted(CANONICAL)} 漂移 —— "
        "少一个 = 该 source 的事件被 narrowCalendarSource 判成未知值 fallback 掉（只 console.warn）"
    )


def test_ts_shared_runtime_list_matches_canonical():
    """`shared/lib/calendarSource.ts` 的运行期数组（两个日历组件共用的白名单）。

    它在 TS 侧已有 `satisfies` + 穷尽性检查兜住「与联合类型不一致」；本条兜的是
    **跨语言**那一步：联合类型自己漂了，TS 编译期照样绿。
    """
    got = _ts_shared_list(_read(_TS_SHARED), origin=str(_TS_SHARED))
    assert got == CANONICAL


def test_gateway_zod_enum_matches_canonical():
    got = _ts_zod_enum(_read(_TS_ZOD), origin=str(_TS_ZOD))
    assert got == CANONICAL, (
        f"gateway 工具入参的 z.enum {sorted(got)} 与 Python 真源漂移 —— "
        "模型提的合法 source 会被 zod 拒在工具边界外"
    )


# ── 反向用例：合成源码证明闸真会红 ───────────────────────────────────────────

_SYNTHETIC_CREATE = """
            CREATE TABLE IF NOT EXISTS calendar_event (
                id INTEGER PRIMARY KEY,
                source TEXT NOT NULL,
                CHECK (source IN ('caldav', 'email_ics'))
            )
"""


def test_gate_drift_would_go_red():
    two = _sql_check(_SYNTHETIC_CREATE, origin="<synthetic>")
    assert two != CANONICAL, "缺一个值的合成 CHECK 竟与真源相等 —— 本闸对漂移无感"

    four = _ts_union(
        "export type CalendarEventSource = 'caldav' | 'email_ics' | 'legacy_calendar_app' | 'graph'",
        origin="<synthetic>",
    )
    assert four != CANONICAL, "多一个值的合成联合竟与真源相等 —— 本闸对漂移无感"


@pytest.mark.parametrize(
    "extractor,broken",
    [
        (_sql_check, "CHECK (source IN (SELECT name FROM sources))"),
        (_skill_sources, "_VALID_SOURCES = frozenset(SOURCES_TRY_ORDER)"),
        (_ts_union, "export type CalendarEventSource = z.infer<typeof sourceSchema>"),
        (_ts_zod_enum, "source: sourceEnum.default('caldav'),"),
        (_ts_shared_list, "export const VALID_CALENDAR_SOURCES = new Set(SOURCES)"),
    ],
)
def test_gate_extractor_failure_would_go_red(extractor, broken: str):
    """任一处改写法（派生/引用/换结构）必须断言红，不是静默返回空集恒真。

    注意：这些"坏"样例里有几个其实是**好事**（比如 skill 改成
    `frozenset(SOURCES_TRY_ORDER)` = 真单源了）。闸红在这里是**期望行为** ——
    它逼改动者回来删掉对应的断言而不是让一个已失效的闸继续挂着。
    """
    with pytest.raises(AssertionError):
        extractor(broken, origin="<synthetic>")
