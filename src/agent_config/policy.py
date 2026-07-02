"""exec / file / web 策略白名单评估器 —— **业务权威在 Python**（ADR-001 §6 D4）。

gateway（W1b）的 ``needsApproval`` 在决定「免卡直接执行」前，经 ``/api/agent/policy/evaluate``
调本模块的 :func:`evaluate`。返回 ``auto_allow`` 才免卡；任何解析/评估异常、无匹配、context_mode
不符一律 ``ask``（弹审批卡）—— **fail-closed**，绝不因一条坏规则或异常放行。

结构化匹配（红线⑤，非字符串前缀）：
  - **exec**：argv[0] realpath 解析后**等值**比对 + argv 逐位模板（``pin`` 字面等值 / ``any``
    单参通配，**长度必须相等、无跨位/前缀通配**）+ 可选 cwd 落在 ``cwd_scope`` realpath 前缀内。
  - **file_read / file_write**：目标 path realpath 后落在 ``realpath_prefix`` 规范化前缀内
    （含边界分隔符，``/foo`` 不匹配 ``/foobar``）。
  - **web**：scheme+host+port 三元组等值（端口按 scheme 默认补齐再比）。

context_mode 严格等值绑定（红线①）由 store.candidate_policy_rules 保证：manual_chat 规则永不进
untrusted_trigger 查询候选集。危险 argv0（解释器/shell/包管理器/runner）的宽 ``{any}`` 规则本模块
**不入库拒**（owner 手动放宽是 ADR 允许的），但 :func:`rule_is_dangerously_wide` 供 API 打
``dangerous`` 标志 → W1b UI 红色不可沙箱警告。
"""

from __future__ import annotations

import os
import re
import shutil
import urllib.parse
from typing import TYPE_CHECKING, Any, Optional

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from src.skills.secret_names import FIXED_EXEC_PATH

if TYPE_CHECKING:
    from src.agent_config.store import AgentConfigStore

# 支持的能力面 + 上下文三态（ADR-001 §3 D1）。
CAPABILITIES: tuple[str, ...] = ("exec", "file_read", "file_write", "web")
CONTEXT_MODES: tuple[str, ...] = ("manual_chat", "untrusted_trigger", "cron_headless")

# 危险 argv0 basename（realpath 解析后按 basename 判定）——解释器 / shell / 包管理器 / 可扩展
# runner：允许某位 {any} 或子命令 ≈ 任意代码执行（ADR-001 §6，codex P1-3；W1a-fix P2-1 补 macOS 项）。
DANGEROUS_ARGV0_BASENAMES: frozenset = frozenset(
    {
        # shell / 解释器
        "bash", "sh", "zsh", "dash", "ksh", "csh", "tcsh", "fish",
        "python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "osascript",
        "tclsh", "expect", "lua", "Rscript",
        # 包管理器 / 构建 / 通用 runner
        "npm", "npx", "pnpm", "yarn", "pip", "pip3", "uv",
        "git", "make", "cmake", "env", "xargs", "find", "awk", "sed", "sudo",
        # macOS / *nix 脚枪：任意 .app 启动（open）· 网络+可执行（ssh/scp/sftp/nc/ncat/socat）·
        # 编辑器 :!cmd 逃逸（vim/vi/view/nano/emacs）· 归档 --to-command（tar）· DB .shell/.load
        # （sqlite3）· 调试器 attach+执行（gdb/lldb/dtrace）。
        "open", "ssh", "scp", "sftp", "nc", "ncat", "socat",
        "vim", "vi", "view", "nano", "emacs",
        "tar", "sqlite3", "gdb", "lldb", "dtrace",
    }
)
# 版本化解释器（python3.11 / python3.12…）也算危险。
_PYTHON_VERSIONED = re.compile(r"^python3\.\d+$")


# ---------------------------------------------------------------------------
# matcher 数据模型（pydantic，带 "v":1 版本位；未知 v / extra 字段 → 拒）
# ---------------------------------------------------------------------------


class ExecArgvItem(BaseModel):
    """exec argv 模板的单个位：恰好一个 ``pin``（字面等值）或 ``any``（单参通配，须为 true）。"""

    model_config = ConfigDict(extra="forbid")

    pin: Optional[str] = None
    any: Optional[bool] = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "ExecArgvItem":
        has_pin = self.pin is not None
        has_any = self.any is not None
        if has_pin == has_any:
            raise ValueError("argv_template item must have exactly one of {pin, any}")
        if has_any and self.any is not True:
            raise ValueError("argv_template 'any' must be true (no negative wildcard)")
        return self


class ExecMatcher(BaseModel):
    model_config = ConfigDict(extra="forbid")

    v: int
    argv0_realpath: str
    argv_template: list[ExecArgvItem] = []
    cwd_scope: Optional[str] = None

    @field_validator("v")
    @classmethod
    def _v1(cls, v: int) -> int:
        if v != 1:
            raise ValueError(f"unknown matcher version: {v}")
        return v

    @field_validator("argv0_realpath")
    @classmethod
    def _abs_argv0(cls, v: str) -> str:
        if not v or not os.path.isabs(v):
            raise ValueError("argv0_realpath must be a non-empty absolute path")
        return v

    @field_validator("cwd_scope")
    @classmethod
    def _abs_cwd(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and (not v or not os.path.isabs(v)):
            raise ValueError("cwd_scope must be a non-empty absolute path")
        return v


class FileMatcher(BaseModel):
    model_config = ConfigDict(extra="forbid")

    v: int
    realpath_prefix: str

    @field_validator("v")
    @classmethod
    def _v1(cls, v: int) -> int:
        if v != 1:
            raise ValueError(f"unknown matcher version: {v}")
        return v

    @field_validator("realpath_prefix")
    @classmethod
    def _abs_prefix(cls, v: str) -> str:
        if not v or not os.path.isabs(v):
            raise ValueError("realpath_prefix must be a non-empty absolute path")
        return v


class WebMatcher(BaseModel):
    model_config = ConfigDict(extra="forbid")

    v: int
    origin: str

    @field_validator("v")
    @classmethod
    def _v1(cls, v: int) -> int:
        if v != 1:
            raise ValueError(f"unknown matcher version: {v}")
        return v

    @field_validator("origin")
    @classmethod
    def _valid_origin(cls, v: str) -> str:
        if _normalize_origin(v) is None:
            raise ValueError("origin must be http(s)://host[:port]")
        return v


def parse_matcher(capability: str, matcher_dict: dict[str, Any]) -> BaseModel:
    """按 capability 把 matcher dict 解析成 typed 模型（非法 → pydantic ValidationError / ValueError）。

    API create 端点用它做入库前校验（非法 422）；:func:`evaluate` 逐规则用它，解析失败即跳过该规则。
    """
    if capability == "exec":
        return ExecMatcher.model_validate(matcher_dict)
    if capability in ("file_read", "file_write"):
        return FileMatcher.model_validate(matcher_dict)
    if capability == "web":
        return WebMatcher.model_validate(matcher_dict)
    raise ValueError(f"unknown capability: {capability}")


# ---------------------------------------------------------------------------
# 匹配（纯函数）
# ---------------------------------------------------------------------------


def _within_prefix(path: str, prefix: str) -> bool:
    """path 落在 prefix 规范化前缀内（相等或以 ``prefix + sep`` 开头，防 /foo 匹配 /foobar）。"""
    path = os.path.normpath(path)
    prefix = os.path.normpath(prefix)
    return path == prefix or path.startswith(prefix + os.sep)


def _normalize_origin(origin: str) -> Optional[str]:
    """把 origin / 完整 URL 归一成 ``scheme://host:port``（端口按 scheme 默认补齐）。非 http(s)/
    缺 host → None。"""
    if not isinstance(origin, str) or not origin:
        return None
    parsed = urllib.parse.urlsplit(origin if "//" in origin else "//" + origin)
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    if scheme not in ("http", "https") or not host:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port is None:
        port = 443 if scheme == "https" else 80
    return f"{scheme}://{host}:{port}"


def _resolve_argv0(argv0: str, cwd: Optional[str]) -> str:
    """把 argv[0] 解析成 realpath（对齐白名单里存的 argv0_realpath）。

    含分隔符 → 按 cwd/绝对解析后 realpath；裸命令名 → 经**固定 exec PATH** which 查（与子进程实际
    spawn 的 PATH 一致），查不到回退直接 realpath（多半不匹配任何规则 = fail-closed 弹卡）。
    """
    if os.sep in argv0 or (os.altsep and os.altsep in argv0):
        base = argv0 if os.path.isabs(argv0) else os.path.join(cwd or os.getcwd(), argv0)
        return os.path.realpath(base)
    found = shutil.which(argv0, path=FIXED_EXEC_PATH)
    return os.path.realpath(found) if found else os.path.realpath(argv0)


def _match_exec(matcher: ExecMatcher, action: dict[str, Any]) -> bool:
    argv = action.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        return False
    cwd = action.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        return False
    if _resolve_argv0(argv[0], cwd) != matcher.argv0_realpath:
        return False
    rest = argv[1:]
    if len(rest) != len(matcher.argv_template):  # 长度必须相等，无跨位通配
        return False
    for item, arg in zip(matcher.argv_template, rest):
        if item.pin is not None and item.pin != arg:
            return False
        # item.any is True → 该位任意单参通过
    if matcher.cwd_scope is not None:
        if not isinstance(cwd, str) or not cwd:
            return False  # 规则要求 cwd 落域，但动作未给 cwd → 不匹配（fail-closed）
        if not _within_prefix(os.path.realpath(cwd), os.path.realpath(matcher.cwd_scope)):
            return False
    return True


def _match_file(matcher: FileMatcher, action: dict[str, Any]) -> bool:
    path = action.get("path")
    if not isinstance(path, str) or not path:
        return False
    return _within_prefix(os.path.realpath(path), os.path.realpath(matcher.realpath_prefix))


def _match_web(matcher: WebMatcher, action: dict[str, Any]) -> bool:
    given = action.get("origin") or action.get("url")
    if not isinstance(given, str) or not given:
        return False
    gnorm = _normalize_origin(given)
    return gnorm is not None and gnorm == _normalize_origin(matcher.origin)


def _match(capability: str, matcher: BaseModel, action: dict[str, Any]) -> bool:
    if capability == "exec" and isinstance(matcher, ExecMatcher):
        return _match_exec(matcher, action)
    if capability in ("file_read", "file_write") and isinstance(matcher, FileMatcher):
        return _match_file(matcher, action)
    if capability == "web" and isinstance(matcher, WebMatcher):
        return _match_web(matcher, action)
    return False


# ---------------------------------------------------------------------------
# 危险 argv0 判定
# ---------------------------------------------------------------------------


def is_dangerous_argv0(argv0_realpath: str) -> bool:
    """argv0 的 basename 是否属危险名（解释器/shell/包管理器/runner + 版本化 python）。"""
    bn = os.path.basename(argv0_realpath)
    return bn in DANGEROUS_ARGV0_BASENAMES or bool(_PYTHON_VERSIONED.match(bn))


def rule_is_dangerously_wide(matcher_dict: dict[str, Any]) -> bool:
    """exec matcher：argv0 危险 **且** argv_template 含 ``{any:true}`` → 危险宽规则。

    非 exec matcher / 解析失败 → False。入库不拒（owner 可手动放宽），API create/update 用它打
    ``dangerous`` 标志供 UI 红色警告（ADR-001 §6：exec 的最终防线是 HITL + 白名单窄度，非沙箱）。
    """
    try:
        m = ExecMatcher.model_validate(matcher_dict)
    except Exception:  # noqa: BLE001 — 非 exec / 非法 matcher → 非危险宽规则
        return False
    if not is_dangerous_argv0(m.argv0_realpath):
        return False
    return any(item.any is True for item in m.argv_template)


# ---------------------------------------------------------------------------
# 评估入口（fail-closed）
# ---------------------------------------------------------------------------


def _shell_wrapped_skill_ref_forces_ask(
    argv: list, cwd: Optional[str], skills_root: str
) -> bool:
    """belt-and-suspenders（壳包装盲区变体，W4a review P2-1 探针实证）：argv0 解析为**危险解释器**
    （shell / 解释器 / 包管理器 / runner —— 复用 :func:`is_dangerous_argv0` 同一单源危险名集）
    **且**某个后续 argv token 的**文本**包含 realpath 后的 ``skills_root`` 子串、但该 token 自身
    realpath **不落** skills 目录内（probe 未把它当 skills 路径落地）→ True（恒 ask）。

    语义：「危险解释器 + 文本引用 skill 目录 + 无法验证引用的执行对象」⇒ 不可校验 ⇒ 恒 ask。
    典型命中 ``bash -c "cd <skills>/x && python3 main.py"``（cwd=/tmp）—— 第三个 token 文本含
    skills_root 但作为整条 shell 命令 realpath 不落 skills 内，故直接盲区收口（names 非空）漏掉它。

    🔴 **不误伤直接形状**：``python3 <skills>/x/main.py`` 的 token realpath 落 skills 内 → probe
    已落地（``touched_files`` 有对象，:func:`_skill_gate_forces_ask` 走既有完整性/首跑逻辑，首跑
    后 auto_allow 仍成立），根本不进本 belt（belt 仅在 ``touched_files`` 空且 ``names`` 空时被调）。
    非危险 argv0（``cat <skills>/x/f``）第一关即 return False，由既有 touched 逻辑管。

    **诚实边界**：纯文本子串匹配的 best-effort —— 相对路径 / 变量展开（``$SK/main.py``）/ base64 等
    编码可逃逸；fail 方向恒 ask。**残余面** = run 端点 / owner API 直调对壳包装形状仍**零**完整性
    校验（详见 exec_gate 模块 docstring 的 S4 清单）。
    """
    if not argv:
        return False
    if not is_dangerous_argv0(_resolve_argv0(argv[0], cwd)):
        return False
    base = cwd if cwd else os.getcwd()
    for tok in argv[1:]:  # argv0 自身是解释器，不算「引用 skill 目录」
        if skills_root not in tok:
            continue
        cand = tok if os.path.isabs(tok) else os.path.join(base, tok)
        try:
            rp = os.path.realpath(cand)
        except (OSError, ValueError):
            return True  # 文本引用 skill 目录但无法解析 → 保守 ask
        if not (rp == skills_root or rp.startswith(skills_root + os.sep)):
            return True  # 文本含 skills_root 但 realpath 未落地 ⇒ 不可校验的执行引用
    return False


def _skill_gate_forces_ask(store: "AgentConfigStore", action_descriptor: dict[str, Any]) -> bool:
    """W4 前置 gate（ADR-002 §5 顺序不变式，codex P2-7）：exec 动作触及 skill 目录且（任一触达
    文件完整性不符 **或** 无有效首跑记录 **或** 无法识别将执行哪个文件）→ True（强制 ask，
    **不查 PolicyRule**）。

    堵「先装 skill 不跑 → 诱导 owner 批个宽 interpreter 白名单 → skill 脚本命中宽规则免卡」的
    组合链：宽规则再宽也放行不了未首跑/被篡改的 skill 脚本。

    🔴 探测盲区两层收口（team-lead 对抗推演 + W4a review P2-1 探针实证）：probe 的路径判定是启发式
    的，两种盲区形状 evaluate 侧恒 ask ——
    ① **直接形状**（team-lead）``cd <skills>/x && python3 main.py``（cwd 落 skill 目录 + 裸 token
       argv）：``main.py`` 不被 probe → ``touched_files`` 空、``names`` **非空**。gate 对
       「names 非空且零触达文件」恒 ask（动作进入 skill 目录但认不出要跑什么 ⇒ 不可校验）。
    ② **壳包装形状**（review P2-1）``bash -c "cd <skills>/x && python3 main.py"``（cwd=/tmp）：
       shell 命令是**单个 token**，realpath 不落 skills → ``names`` 也空。①的收口兜不住，故加
       :func:`_shell_wrapped_skill_ref_forces_ask` 文本 belt：危险解释器 + token 文本引用
       skills_root 但 probe 未落地 → 恒 ask。

    **陈述收窄（review P2-1 建议①）**：仅「① 直接盲区形状恒 ask」+「② dangerous-interpreter 文本
    引用 belt 恒 ask」成立；其它编码变体（相对路径 / 变量展开 / base64）evaluate 层**不可判**，
    依赖 manual 恒卡 + owner 审慎建规则；S4 headless 前须独立 deny 防线（壳包装形状比裸 token
    更优先，因裸 token 在 headless 下 names 非空仍 ask，壳包装 names 空会 auto_allow）。

    纯读判定（落 last_error / 首跑记录是 run 端点的事）；判定自身异常 → True（fail-closed 到 ask）。
    """
    try:
        from src.skills.exec_gate import check_skill_gates, probe_skill_exec

        argv = action_descriptor.get("argv")
        if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
            return False  # 非法 argv 匹配不了任何 exec 规则，正常评估已 fail-closed
        cwd = action_descriptor.get("cwd")
        cwd = cwd if isinstance(cwd, str) and cwd else None
        probe = probe_skill_exec(argv, cwd)
        if probe.touched_files:
            checks = check_skill_gates(store, probe)
            return any(c.tampered or c.needs_first_run for c in checks)
        if probe.names:
            # ① 直接盲区形状（cwd 落 skill 目录 + 裸 token）：不可识别执行对象 ⇒ 恒 ask。
            return True
        # ② 壳包装盲区变体：dangerous 解释器文本引用 skills_root 但 probe 未落地 ⇒ 恒 ask。
        try:
            from src.skills.pack_fetch import skills_data_root

            skills_root = os.path.realpath(skills_data_root())
        except Exception:  # noqa: BLE001 — skills 根不可得（裸 worktree）⇒ 无 skill 概念，正常评估
            return False
        return _shell_wrapped_skill_ref_forces_ask(argv, cwd, skills_root)
    except Exception:  # noqa: BLE001 — gate 判定异常 → 保守 ask
        return True


def evaluate(
    store: "AgentConfigStore",
    capability: str,
    action_descriptor: dict[str, Any],
    context_mode: str,
) -> dict[str, Any]:
    """评估一次动作 → ``{"decision": "auto_allow"|"ask", "rule_id": int|None}``。

    只查 ``enabled=1 AND capability AND context_mode AND agent_id IS NULL`` 的候选规则（context_mode
    严格等值绑定，红线①）。命中首条 → auto_allow + bump use_count；无匹配 / 任何异常 / 未知
    capability / 未知 context_mode → ask（**fail-closed**，绝不放行）。

    🔴 W4 顺序不变式（codex P2-7）：exec 动作先过 skill 完整性/首跑前置 gate —— 命中 skill 目录
    且有触达文件被篡改或未首跑 → **在查任何 PolicyRule 之前**直接 ask（种一条能匹配的宽规则也
    放行不了首跑）。
    """
    ask: dict[str, Any] = {"decision": "ask", "rule_id": None}
    try:
        if capability not in CAPABILITIES or context_mode not in CONTEXT_MODES:
            return ask
        if capability == "exec" and _skill_gate_forces_ask(store, action_descriptor):
            return ask
        candidates = store.candidate_policy_rules(capability, context_mode)
        for rule in candidates:
            try:
                matcher = parse_matcher(capability, rule.matcher)
            except Exception:  # noqa: BLE001 — 坏规则跳过，不放行也不崩
                continue
            try:
                matched = _match(capability, matcher, action_descriptor)
            except Exception:  # noqa: BLE001 — 匹配异常视为不匹配（fail-closed）
                continue
            if matched:
                try:
                    store.bump_policy_rule_use(rule.id)
                except Exception:  # noqa: BLE001 — 计数失败不影响放行判定
                    pass
                return {"decision": "auto_allow", "rule_id": rule.id}
        return ask
    except Exception:  # noqa: BLE001 — 顶层兜底：任何异常 → ask
        return {"decision": "ask", "rule_id": None}
