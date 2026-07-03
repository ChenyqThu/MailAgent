"""Custom Agent 触发判别式（trigger_json）解析/校验 + budget 解析（S4 W1，ADR D5/D7）。

trigger_json 两态判别式（``kind`` 分流）：

    {"v":1, "kind":"cron",         "cron":"0 9 * * 1-5", "timezone":"Asia/Shanghai"}
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

# budget 三门默认 + clamp（ADR D7）。max_steps 上限硬 clamp ≤ 16。
DEFAULT_MAX_STEPS = 8
MAX_STEPS_CEILING = 16
DEFAULT_MAX_RUNS_PER_DAY = 24
DEFAULT_MAX_RUN_SECONDS = 300
MAX_RUN_SECONDS_CEILING = 1800  # 30min 单 run 硬顶（与岛 stash TTL 同量级）


class TriggerValidationError(ValueError):
    """trigger_json 校验失败（判别式非法 / ReDoS 超长 / cron 非法 / 谓词全空）。"""


@dataclass(frozen=True)
class CronTrigger:
    """cron 定时触发 → contextMode='cron_headless'。"""

    cron: str
    timezone: str = "UTC"
    kind: str = "cron"


@dataclass(frozen=True)
class EmailFilterTrigger:
    """邮件事件触发 → contextMode='untrusted_trigger'。谓词至少一个非空。"""

    subject_pattern: Optional[str] = None
    sender_pattern: Optional[str] = None
    folders: Tuple[str, ...] = ()
    kind: str = "email_filter"


Trigger = Union[CronTrigger, EmailFilterTrigger]


@dataclass(frozen=True)
class Budget:
    """per-agent 预算三门（ADR D7）。NULL/非法 → 全默认；各字段已 clamp。"""

    max_steps: int = DEFAULT_MAX_STEPS
    max_runs_per_day: int = DEFAULT_MAX_RUNS_PER_DAY
    max_run_seconds: int = DEFAULT_MAX_RUN_SECONDS


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
    """trigger_json（JSON 串 / dict）→ ``CronTrigger`` | ``EmailFilterTrigger``。

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
    raise TriggerValidationError(f"unknown trigger kind={kind!r} (expect cron|email_filter)")


def _clamp_int(value: Any, default: int, lo: int, hi: int) -> int:
    """int clamp（非 int/越界 → 收进 [lo, hi]，坏值回 default）。"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def parse_budget(raw: Union[str, dict, None]) -> Budget:
    """budget_json → ``Budget``（防御性：NULL/坏 JSON/缺字段 → 默认；各字段 clamp）。

    运行时读（enqueue 前 runs/day 门 + drain maxSteps/deadline），故**不抛**——任何异常
    退回默认预算，绝不因坏配置卡住触发。
    """
    data = _as_dict(raw) or {}
    _v = data.get("v", 1)
    if _v != 1:  # 版本不认 → 全默认（保守，不抛）
        return Budget()
    return Budget(
        max_steps=_clamp_int(
            data.get("max_steps", DEFAULT_MAX_STEPS), DEFAULT_MAX_STEPS, 1, MAX_STEPS_CEILING
        ),
        max_runs_per_day=_clamp_int(
            data.get("max_runs_per_day", DEFAULT_MAX_RUNS_PER_DAY),
            DEFAULT_MAX_RUNS_PER_DAY, 0, 100000,
        ),
        max_run_seconds=_clamp_int(
            data.get("max_run_seconds", DEFAULT_MAX_RUN_SECONDS),
            DEFAULT_MAX_RUN_SECONDS, 1, MAX_RUN_SECONDS_CEILING,
        ),
    )


def validate_agent_config_patch(patch: dict) -> None:
    """保存时（set_config REST + CLI config-set）深校验 custom agent friendly patch。

    只在 patch 显式含**非空** ``trigger`` 时深校验（``parse_trigger`` 拒坏 cron / 未知 kind /
    超长或不可编译 pattern / 空谓词）—— 坏 trigger 入库后 owner 侧零反馈、运行时 agent 静默
    不触发（cron worker / email dispatch 都先 parse_trigger 再匹配, 坏配置 skip + warning）,
    故保存时硬拒给反馈。

    ``budget`` / ``tool_policy`` 保存时**不**在此硬拒:
      - 结构校验（必须 dict|null）已在 ``wire.config_patch_to_db`` 做（非 dict → ValueError → 400）;
      - budget 值域是运行时 ``parse_budget`` 防御性 clamp（设计即优雅降级, 非 skip, 无需拒）;
      - tool_policy 的 allowed_tools 交集在 gateway 运行时施加（W3）, W1 无值域校验器。

    校验失败抛 ``TriggerValidationError``（``ValueError`` 子类）→ caller 转 400 E_INVALID_ARG /
    CLI 错误出口。``trigger`` 缺省 / None（清空）跳过, 不碰 report/preprocess/search 的 patch。
    """
    trig = patch.get("trigger")
    if trig is not None:
        parse_trigger(trig)  # 抛 TriggerValidationError（ValueError）on 坏配置
