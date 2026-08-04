"""Custom Agent 触发判别式（trigger_json）解析/校验 + budget 解析（S4 W1，ADR D5/D7）。

trigger_json 三态判别式（``kind`` 分流；``schedule`` 为 schedule-builder 任务新增，
契约见 ``src/agents/schedule_rule.py`` 模块 docstring 指向的 schedule-contract.md）：

    {"v":1, "kind":"cron",         "cron":"0 9 * * 1-5", "timezone":"Asia/Shanghai"}
    {"v":1, "kind":"schedule",     "rule":{...ScheduleRule 10 键全量...},
                                    "anchor":"2026-07-24", "timezone":"America/Los_Angeles"}
    {"v":1, "kind":"email_filter", "subject_pattern":"DMS.*审批",
                                    "sender_pattern":"dms@corp\\.com", "folders":["收件箱"]}

校验（ADR D5 ReDoS 三条 + cron 合法性）：
  1. 正则谓词（subject/sender_pattern）: ``re.compile`` 可编译 + 长度 ≤ ``MAX_PATTERN_LEN``；
  2. email_filter 谓词至少一个非空（sender/subject/folders 全空 = 永不匹配的死配置 → 拒）；
  3. cron 用 ``croniter.is_valid`` 试算 + 强制 5-field + IANA timezone（``zoneinfo.ZoneInfo``）。

``parse_trigger`` 是**保存时**校验的权威（create/update custom agent 调它，非法 → 拒）；也被
``AgentTriggerWorker`` 读 cron 配置。校验失败抛 ``TriggerValidationError``（ValueError 子类）。

设计纪律：纯函数、零 transport 依赖（只标准库 + croniter）、croniter 在函数内 import
（flag-off 不加载；缺库时只有 custom agent cron 路径报错，不拖垮主程序）。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Optional, Tuple, Union

# ReDoS 收面（ADR D5）：owner 配置正则作用于攻击者可控的邮件 subject/sender。
# 防线 = 「pattern 由 owner 而非攻击者配置 + 长度≤256 + 匹配输入截断 512（在 matcher）」。
# 注意：把匹配放进 new_watcher 的 fire-and-forget task 只是移出当封邮件的内联路径——task 仍在
# 同一 asyncio 事件循环、re 匹配持 GIL，owner 若配 catastrophic pattern 仍会卡整个事件循环
# （to_thread 亦无用，实测证实）。这层 task 隔离**不是** ReDoS 防线，别据此放宽 pattern 校验。
MAX_PATTERN_LEN = 256
MATCH_INPUT_CAP = 512  # matcher 匹配前 subject/sender 各取前 N 字符

# budget 两门默认 + clamp（07-28 W1）。tool loop 只保留 gateway 内部 10000 步终止哨兵，
# 不再把步数作为用户预算；旧行里的 max_steps 由 parse_budget 宽容忽略。
DEFAULT_MAX_RUNS_PER_DAY = 24
DEFAULT_MAX_RUN_SECONDS = 1800
MAX_RUN_SECONDS_CEILING = 1800  # 30min 单 run 硬顶（与岛 stash TTL 同量级）


class TriggerValidationError(ValueError):
    """trigger_json 校验失败（判别式非法 / ReDoS 超长 / cron 非法 / 谓词全空）。"""


class ToolPolicyValidationError(ValueError):
    """tool_policy_json 校验失败（非 object / 未知键 / 版本不符 / grant_exec 非 bool /
    grant_web 非 off|gated|open 字面量 / grant_connectors 非 {connector: read|write|update}
    对象，ADR-004 P1-4 严格化）。"""


@dataclass(frozen=True)
class CronTrigger:
    """cron 定时触发 → contextMode='cron_headless'。"""

    cron: str
    timezone: str = "UTC"
    kind: str = "cron"


@dataclass(frozen=True)
class ScheduleTrigger:
    """schedule-builder 结构化定时触发（契约 kind:'schedule'）。与 cron 同族 = 定时
    headless（trigger_worker 调度、fire_key/marker 机制同 cron）；timezone **必填**
    （契约 §1，不同于 cron 的空→UTC 默认），anchor = 本地日历日期（interval 相位原点）。

    ``rule`` 类型是 ``schedule_rule.ScheduleRule``（惰性 import，标注用 Any 免得
    flag-off 场景加载 dateutil —— 镜像 croniter 的函数内 import 纪律）。"""

    rule: Any
    anchor: str
    timezone: str
    kind: str = "schedule"


@dataclass(frozen=True)
class EmailFilterTrigger:
    """邮件事件触发 → contextMode='untrusted_trigger'。谓词至少一个非空。"""

    subject_pattern: Optional[str] = None
    sender_pattern: Optional[str] = None
    folders: Tuple[str, ...] = ()
    kind: str = "email_filter"


Trigger = Union[CronTrigger, ScheduleTrigger, EmailFilterTrigger]


@dataclass(frozen=True)
class Budget:
    """per-agent 预算两门。NULL/非法 → 全默认；各字段已 clamp。"""

    max_runs_per_day: int = DEFAULT_MAX_RUNS_PER_DAY
    max_run_seconds: int = DEFAULT_MAX_RUN_SECONDS


# tool_policy_json v1 允许键（additive：S4 = allowed_tools；S5 ADR-004 §4.1 += grant_exec；
# S6 W3 ADR-004 rev3.1 D6 += grant_web + skills；MCP connector PR3 += grant_connectors）。
_TOOL_POLICY_KEYS = frozenset(
    {"v", "allowed_tools", "grant_exec", "grant_web", "skills", "grant_connectors"}
)

# grant_web 三态枚举（ADR-004 rev3.1 §3.1：off=headless 不注册 / gated=域名白名单免卡 /
# open=全开放免卡）。非法态「web 关着却全开放」结构上不可表示。
_WEB_GRANT_VALUES = ("off", "gated", "open")

# grant_connectors 的 crud 天花板**有效**值域（MCP connector PRD 决策 5 + grill Q3=B）：
# read < write < update 单调递增；🔴 **delete 不在值域内 —— 写入即拒**（不是读侧宽容），
# 于是「AI 结构上拿不到删除工具」不依赖 owner 记得别配。
# 表结构 / 远端 manifest 的 crudType 枚举**保留 delete 位**（删除类工具照常同步入库、界面恒灰），
# 未来放开 = 把 "delete" 加进本元组 + 解灰界面开关，不改 schema、不做数据迁移。
_CONNECTOR_GRANT_VALUES = ("read", "write", "update")


@dataclass(frozen=True)
class ToolPolicy:
    """tool_policy_json 严格解析结果（ADR-004 P1-4）。

    ``allowed_tools=None`` = 未配置 —— spec 投影层落 ``DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS``
    默认安全集（ADR-004 §5.1，对 ADR-003 D6「NULL=不收窄」的显式修订）；``()`` = owner 显式
    空集（verbatim 透传）。``grant_exec`` 仅字面 ``True`` 有效（投影仅当 True 才输出）；
    ``grant_web`` 仅字面 ``'gated'``/``'open'`` 有效（缺省 ``'off'``，投影仅非 off 才输出）。
    ``skills``（S6 W3 rev3.1 §3.2/§5.1 —— per-agent skill 挂载列表，**收窄面**非 grants 键）：
    ``None`` = 未配置 → 投影层落 ``DEFAULT_CUSTOM_AGENT_MOUNTED_SKILLS`` 默认挂载集；
    ``()`` = owner 显式零挂载（verbatim，门控工具全缺席）。挂载词汇 strict-effect：未知/未装
    skill 名存储宽容（parse 只验类型），效果为零。
    ``grant_connectors``（MCP connector PR3 —— per-connector crud 天花板）：规范化成按
    connector_id 排序的 ``((connector_id, ceiling), ...)``（确定性有序、不可变、可直接 dict()）；
    ``()`` = 一个 connector 都没授权（缺省，headless 侧整族不注册）。connector_id 同样
    strict-effect：未连接的 id 存储宽容，效果为零。
    """

    allowed_tools: Optional[Tuple[str, ...]] = None
    grant_exec: bool = False
    grant_web: str = "off"
    skills: Optional[Tuple[str, ...]] = None
    grant_connectors: Tuple[Tuple[str, str], ...] = ()


def _as_dict(raw: Union[str, dict, None]) -> Optional[dict]:
    """JSON 串 / dict / None → dict 或 None（非 dict/坏 JSON → None）。"""
    if raw is None or raw == "":
        return None
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            v = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        return v if isinstance(v, dict) else None
    return None


def _check_version(data: dict) -> None:
    """版本位：缺省视作 1（宽容）；显式非 1 → 拒（防未来 schema 误读旧代码）。"""
    v = data.get("v", 1)
    if v != 1:
        raise TriggerValidationError(f"unsupported trigger version v={v!r} (expect 1)")


def _validate_pattern(name: str, value: Any) -> Optional[str]:
    """正则谓词校验（ADR D5 ReDoS 条件 ①）：None/'' → None；非字符串/超长/不可编译 → 拒。"""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise TriggerValidationError(f"{name} must be a string")
    if len(value) > MAX_PATTERN_LEN:
        raise TriggerValidationError(
            f"{name} too long ({len(value)}>{MAX_PATTERN_LEN}) — ReDoS 收面"
        )
    try:
        re.compile(value)
    except re.error as e:
        raise TriggerValidationError(f"{name} is not a valid regex: {e}") from e
    return value


def _validate_folders(value: Any) -> Tuple[str, ...]:
    """folders 白名单：None/缺省 → ()（matcher 缺省 = 收件箱）；须为字符串列表。"""
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise TriggerValidationError("folders must be a list of strings")
    return tuple(v for v in value if v)


def _validate_cron_expr(expr: Any) -> str:
    """cron 校验（ADR D5 条件 ③）：强制标准 5-field + croniter.is_valid。"""
    from croniter import croniter  # flag-off / 无 custom cron agent 时不加载

    if not isinstance(expr, str) or not expr.strip():
        raise TriggerValidationError("cron must be a non-empty string")
    expr = expr.strip()
    # 强制 5-field（分 时 日 月 周）。croniter 也吃 6-field(秒)/@daily 等，语义不同 → 拒，
    # 与 ADR「5-field」契约对齐（去重 marker 的 cron_hash 也据此表达式算）。
    if len(expr.split()) != 5:
        raise TriggerValidationError(
            f"cron must be standard 5-field (min hour dom mon dow), got {expr!r}"
        )
    if not croniter.is_valid(expr):
        raise TriggerValidationError(f"invalid cron expression: {expr!r}")
    return expr


def _validate_timezone(tz: Any) -> str:
    """IANA 时区校验；None/'' → 'UTC'（marker 存 UTC）。"""
    if tz is None or tz == "":
        return "UTC"
    if not isinstance(tz, str):
        raise TriggerValidationError("timezone must be a string")
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as e:
        raise TriggerValidationError(f"invalid IANA timezone: {tz!r}") from e
    return tz


def parse_trigger(raw: Union[str, dict, None]) -> Trigger:
    """trigger_json（JSON 串 / dict）→ ``CronTrigger`` | ``ScheduleTrigger`` | ``EmailFilterTrigger``。

    Raises:
        TriggerValidationError: NULL/非 dict/未知 kind/校验失败（保存时拒，运行时 skip）。
    """
    data = _as_dict(raw)
    if data is None:
        raise TriggerValidationError("trigger_json is empty or not an object")
    _check_version(data)
    kind = data.get("kind")
    if kind == "cron":
        return CronTrigger(
            cron=_validate_cron_expr(data.get("cron")),
            timezone=_validate_timezone(data.get("timezone")),
        )
    if kind == "schedule":
        # schedule-builder 结构化规则（契约 §1）：rule 10 键全量深校验 + anchor 可解析 +
        # timezone 必填（**无** cron 的空→UTC 兜底 —— 空时区正是两套排程历史分叉的病根）。
        from src.agents import schedule_rule  # 镜像 croniter：flag-off 不加载 dateutil

        tz = data.get("timezone")
        if not isinstance(tz, str) or not tz.strip():
            raise TriggerValidationError("schedule timezone is required (non-empty IANA name)")
        anchor = data.get("anchor")
        try:
            rule = schedule_rule.parse_rule(data.get("rule"))
            schedule_rule.parse_anchor(anchor)
        except schedule_rule.ScheduleRuleError as e:
            raise TriggerValidationError(f"invalid schedule trigger: {e}") from e
        return ScheduleTrigger(rule=rule, anchor=anchor, timezone=_validate_timezone(tz))
    if kind == "email_filter":
        subject = _validate_pattern("subject_pattern", data.get("subject_pattern"))
        sender = _validate_pattern("sender_pattern", data.get("sender_pattern"))
        folders = _validate_folders(data.get("folders"))
        # 条件 ②：谓词全空 = 永不匹配的死配置 → 拒（对齐 ProjectProgressDetector 全空语义，
        # 但这里是保存时硬拒，防 owner 建一个静默不触发的 agent）。
        if subject is None and sender is None and not folders:
            raise TriggerValidationError(
                "email_filter needs at least one of subject_pattern/sender_pattern/folders"
            )
        return EmailFilterTrigger(
            subject_pattern=subject, sender_pattern=sender, folders=folders
        )
    raise TriggerValidationError(
        f"unknown trigger kind={kind!r} (expect cron|schedule|email_filter)"
    )


def _clamp_int(value: Any, default: int, lo: int, hi: int) -> int:
    """int clamp（非 int/越界 → 收进 [lo, hi]，坏值回 default）。"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def parse_budget(raw: Union[str, dict, None]) -> Budget:
    """budget_json → ``Budget``（防御性：NULL/坏 JSON/缺字段 → 默认；各字段 clamp）。

    运行时读（enqueue 前 runs/day 门 + drain deadline），故**不抛**——任何异常退回默认预算，
    绝不因坏配置卡住触发。旧配置中的 ``max_steps`` 有意忽略，便于无迁移升级。
    """
    data = _as_dict(raw) or {}
    _v = data.get("v", 1)
    if _v != 1:  # 版本不认 → 全默认（保守，不抛）
        return Budget()
    return Budget(
        max_runs_per_day=_clamp_int(
            data.get("max_runs_per_day", DEFAULT_MAX_RUNS_PER_DAY),
            DEFAULT_MAX_RUNS_PER_DAY, 0, 100000,
        ),
        max_run_seconds=_clamp_int(
            data.get("max_run_seconds", DEFAULT_MAX_RUN_SECONDS),
            DEFAULT_MAX_RUN_SECONDS, 1, MAX_RUN_SECONDS_CEILING,
        ),
    )


def parse_tool_policy(raw: Union[str, dict, None]) -> ToolPolicy:
    """tool_policy_json（JSON 串 / dict / None）→ ``ToolPolicy``（**严格** typed 解析，ADR-004
    P1-4 —— TS interface 运行时擦除，两端都必须判别式校验）。

    - ``None`` / ``''`` → ``ToolPolicy()``（未配置：投影层落默认安全集）
    - 非 object / 坏 JSON → 拒
    - ``v`` 缺省视作 1（镜像 ``_check_version`` 宽容），显式非 1 → 拒
    - 未知键 → 拒（extra forbid —— 防未来加字段时 junk 键静默流进矩阵判定）
    - ``allowed_tools``：缺省/null → None；list[str]（滤空串）→ tuple（显式 ``[]`` → ``()``）；
      其它类型 → 拒
    - ``grant_exec``：缺省 → False；必须 JSON boolean（``"yes"`` / ``1`` → 拒）
    - ``grant_web``：缺省 → ``'off'``；必须 ∈ ``('off','gated','open')`` 字面量
      （``True`` / ``1`` / ``"yes"`` → 拒，镜像 grant_exec 严格化）
    - ``skills``：缺省/null → None（未配置 → 投影默认挂载集）；list[str]（滤空串）→ tuple
      （显式 ``[]`` → ``()`` 零挂载）；其它类型 → 拒（``"email"`` 裸串 → 拒，镜像 allowed_tools）
    - ``grant_connectors``：缺省/null → ``()``；必须是 ``{connector_id: 天花板}`` object
      （显式 ``{}`` → ``()`` 合法 = 无授权）；key 非空字符串、value ∈
      ``('read','write','update')`` 字面量 —— 🔴 ``"delete"`` **在值域外，入库即拒**
      （grill Q3=B：删除类工具照常入清单但 AI 永不可调，不靠读侧宽容兜）

    保存时权威（``validate_agent_config_patch`` 调用，坏形状 400）；读侧投影（spec 端点）自行
    try/except 落安全默认。Raises ``ToolPolicyValidationError``（``ValueError`` 子类）。
    """
    if raw is None or raw == "":
        return ToolPolicy()
    data = _as_dict(raw)
    if data is None:
        raise ToolPolicyValidationError("tool_policy must be a JSON object")
    unknown = set(data) - _TOOL_POLICY_KEYS
    if unknown:
        raise ToolPolicyValidationError(f"unknown tool_policy keys: {sorted(unknown)}")
    v = data.get("v", 1)
    if v != 1:
        raise ToolPolicyValidationError(f"unsupported tool_policy version v={v!r} (expect 1)")
    allowed_raw = data.get("allowed_tools")
    if allowed_raw is None:
        allowed: Optional[Tuple[str, ...]] = None
    elif isinstance(allowed_raw, list) and all(isinstance(t, str) for t in allowed_raw):
        allowed = tuple(t for t in allowed_raw if t)
    else:
        raise ToolPolicyValidationError("allowed_tools must be a list of strings")
    grant = data.get("grant_exec", False)
    if not isinstance(grant, bool):
        raise ToolPolicyValidationError("grant_exec must be a JSON boolean")
    grant_web = data.get("grant_web", "off")
    # 注意 True == 1 的 Python 等值陷阱不存在于此：字符串字面量成员判定，True/1/"yes" 均拒。
    if not isinstance(grant_web, str) or grant_web not in _WEB_GRANT_VALUES:
        raise ToolPolicyValidationError(
            f"grant_web must be one of {list(_WEB_GRANT_VALUES)}"
        )
    skills_raw = data.get("skills")
    if skills_raw is None:
        skills: Optional[Tuple[str, ...]] = None
    elif isinstance(skills_raw, list) and all(isinstance(s, str) for s in skills_raw):
        skills = tuple(s for s in skills_raw if s)
    else:
        raise ToolPolicyValidationError("skills must be a list of strings")
    connectors_raw = data.get("grant_connectors")
    if connectors_raw is None:
        connectors: Tuple[Tuple[str, str], ...] = ()
    elif isinstance(connectors_raw, dict):
        pairs = []
        for cid, ceiling in connectors_raw.items():
            if not isinstance(cid, str) or not cid.strip():
                raise ToolPolicyValidationError(
                    "grant_connectors keys must be non-empty connector ids"
                )
            # 成员判定挡住 True/1/"DELETE"（大小写敏感，fail-closed）；"delete" 同样在此拒 ——
            # 值域是唯一的开关，未来放开只放宽 _CONNECTOR_GRANT_VALUES。
            if not isinstance(ceiling, str) or ceiling not in _CONNECTOR_GRANT_VALUES:
                raise ToolPolicyValidationError(
                    f"grant_connectors[{cid!r}] must be one of "
                    f"{list(_CONNECTOR_GRANT_VALUES)}"
                )
            pairs.append((cid, ceiling))
        connectors = tuple(sorted(pairs))  # connector_id 排序 → 投影确定性
    else:
        raise ToolPolicyValidationError(
            "grant_connectors must be a JSON object of {connector: read|write|update}"
        )
    return ToolPolicy(
        allowed_tools=allowed,
        grant_exec=grant is True,
        grant_web=grant_web,
        skills=skills,
        grant_connectors=connectors,
    )


def validate_agent_config_patch(patch: dict) -> None:
    """保存时（set_config REST + CLI config-set）深校验 custom agent friendly patch。

    只在 patch 显式含**非空** ``trigger`` 时深校验（``parse_trigger`` 拒坏 cron / 未知 kind /
    超长或不可编译 pattern / 空谓词）—— 坏 trigger 入库后 owner 侧零反馈、运行时 agent 静默
    不触发（cron worker / email dispatch 都先 parse_trigger 再匹配, 坏配置 skip + warning）,
    故保存时硬拒给反馈。

    ``tool_policy`` 非空时同样硬拒坏形状（S5 ADR-004 P1-4：``parse_tool_policy`` 严格化 ——
    grant_exec 是 headless exec 矩阵例外的授权位, 坏形状入库再靠读侧宽容会静默丢 owner 意图）。

    ``budget`` 保存时**不**在此硬拒:
      - 结构校验（必须 dict|null）已在 ``wire.config_patch_to_db`` 做（非 dict → ValueError → 400）;
      - budget 值域是运行时 ``parse_budget`` 防御性 clamp（设计即优雅降级, 非 skip, 无需拒）。

    校验失败抛 ``TriggerValidationError`` / ``ToolPolicyValidationError``（均 ``ValueError``
    子类）→ caller 转 400 E_INVALID_ARG / CLI 错误出口。``trigger`` / ``tool_policy`` 缺省 /
    None（清空）跳过, 不碰 report/preprocess/search 的 patch。
    """
    trig = patch.get("trigger")
    if trig is not None:
        parse_trigger(trig)  # 抛 TriggerValidationError（ValueError）on 坏配置
    tp = patch.get("tool_policy")
    if tp is not None:
        parse_tool_policy(tp)  # 抛 ToolPolicyValidationError（ValueError）on 坏形状
