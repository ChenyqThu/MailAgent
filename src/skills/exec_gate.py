"""skill 目录执行探测 + 完整性/首跑闸判定（S2 W4，ADR-002 §5 D3）——**单源共享**。

三个消费者共用同一份「argv/cwd → 命中 skill 目录」路径判定（W4 kickoff 禁止复制两份）：

  1. ``exec.py::_skill_secret_overlay``（W3 secret 注入）—— 用 :func:`probe_skill_exec` 的
     ``names``（命中 skill 名；多命中 → 调用方保守零注入）。
  2. ``exec.py`` run 端点（W4 完整性 + 首跑落记录）—— 用 :func:`check_skill_gates`：
     tampered → 409 拒执行 + ``last_error``；触达文件无有效首跑记录 → 执行后落记录
     （能到达 run 端点 = owner 批准面：chat 路径因 evaluate 前置 gate 恒 ask 必过卡）。
  3. ``policy.py::evaluate`` 前置 gate（W4 顺序不变式，codex P2-7）—— 用
     :func:`check_skill_gates`：任一 tampered / 需首跑 → **在查 PolicyRule 之前**直接 ask
     （宽白名单规则永远放行不了未首跑/被篡改的 skill 脚本）。

判定语义（与 W3 的 ``_skill_secret_overlay`` 探测启发式逐字一致）：
  - probe 对象 = cwd 本身 + argv 里「含路径分隔符或以 ``.`` 开头」的 token（相对路径按 cwd
    join）；realpath 后落在 ``<skills>/<name>/`` 内 → 命中 name（``.quarantine`` 永不命中——
    deny 地板另有硬拒）。裸文件名 token（如 ``main.py``）不 probe —— 已知盲区，与 secret
    overlay 一致，诚实记录而非静默扩大。
  - 🔴 盲区两层收口（team-lead 对抗推演 + W4a review P2-1 探针实证）：probe 路径判定是启发式的，
    两种形状触达文件识别不出，evaluate 侧（``policy._skill_gate_forces_ask``）分别恒 ask ——
    ① **直接形状** ``cd <skills>/x && python3 main.py`` cwd 命中 skill 目录（``names`` 非空）但
       ``touched_files`` 空 → 对 names-without-touched-files 恒 ask。
    ② **壳包装形状** ``bash -c "cd <skills>/x && python3 main.py"``（cwd=/tmp）shell 命令是单个
       token，realpath 不落 skills → ``names`` 也空，①兜不住 → dangerous-interpreter 文本 belt
       :func:`shell_wrapped_skill_ref`（危险解释器 + token 文本引用 skills_root 但 probe 未落地）。
    **陈述收窄（review P2-1）**：仅这两种形状 evaluate 恒 ask；其它编码变体（相对路径 / 变量展开
    ``$SK/main.py`` / base64）evaluate 层**不可判**，依赖 manual 恒卡 + owner 审慎建规则。
    **残余面**：run 端点 / owner API 直调对**裸 token 形状**仍无完整性/首跑校验（``check_skill_gates``
    无触达文件对象可判；``_skill_unresolved_problem`` 对清单外裸 token 硬拒，清单内裸 token 放行但
    不 hash），manual 靠 gateway 恒弹审批卡兜底（owner 卡上见完整 argv + cwd）。
    🔴 **issue #62**：壳包装形状不再只是 evaluate 侧恒 ask —— run 端点用同一个
    :func:`shell_wrapped_skill_ref` **409 硬拒**（``exec.py::_shell_wrapped_skill_problem``），
    与审批链解耦。理由既是安全（headless 无人在环，恒卡兜底不成立；壳包装 ``names`` 空会
    auto_allow = 直接 RCE + 零完整性）也是功能：该形状下 secret 注入同样 fail-open 静默为空，
    skill 作者会误以为密钥功能坏了，**零攻击者即触发**。绝对路径 argv 形状三者自动恢复。
  - 触达文件 = probe 命中且 ``os.path.isfile`` 的常规文件（目录 / 不存在路径只贡献 name，
    无完整性可言）。
  - 完整性：触达文件的 relpath 必须出现在 ``agent_skills.files_json``（confirm 落库的逐文件
    sha256）且盘上 sha256 与之一致；**无行 / 无 files_json / 不在表内 / hash 不符一律
    tampered**（fail-closed：skills 目录下只应存在供应链管控内容）。
  - 首跑记录 = ``agent_skills.first_run_approved`` JSON dict
    ``{<entrypoint_realpath>: {version, entrypoint_hash, approved_at}}``（绑 version +
    entrypoint hash，非裸时间戳 —— skill 升级 / 换脚本自动重新触发首跑闸）。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from src.agent_config.store import AgentConfigStore

_READ_CHUNK = 64 * 1024


# ---------------------------------------------------------------------------
# 路径探测（单源 —— 自 exec.py::_skill_secret_overlay 抽出，逻辑逐字保持）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillExecProbe:
    """argv/cwd 对 skill 目录的命中结果。``names`` 含「仅 cwd 命中」的 skill；
    ``touched_files`` 只含实际存在的常规文件（skill 名 → 目录内 realpath 列表）。"""

    names: frozenset
    touched_files: dict = field(default_factory=dict)  # {skill_name: [realpath, ...]}


def _default_cwd() -> str:
    """run 端点 cwd 缺省值（``exec_floor._data_root``）—— evaluate 侧与执行侧必须用同一
    基底解析相对 token，否则「评估时不命中 / 执行时命中」出语义分歧。lazy import 防裸
    worktree 拉起 api 层（pack_fetch lazy import ssrf 同款纪律）。"""
    from src.api.exec_floor import _data_root

    return _data_root()


def probe_skill_exec(argv: list, cwd: Optional[str]) -> SkillExecProbe:
    """探测一次 exec 动作触达的 skill 目录。任何环境异常（skills 根不可得）→ 空命中。"""
    try:
        from src.skills.pack_fetch import skills_data_root

        skills_root = os.path.realpath(skills_data_root())
    except Exception:  # noqa: BLE001 — 裸 worktree / skills 目录缺失 → 无命中
        return SkillExecProbe(names=frozenset())

    base_cwd = cwd if cwd else _default_cwd()
    names: set = set()
    touched: dict = {}

    def _probe(token: str) -> None:
        cand = token if os.path.isabs(token) else os.path.join(base_cwd, token)
        try:
            rp = os.path.realpath(cand)
        except (OSError, ValueError):
            return
        if rp == skills_root or not rp.startswith(skills_root + os.sep):
            return
        first = rp[len(skills_root) + 1:].split(os.sep, 1)[0]
        # .quarantine 永不执行/注入（deny 地板另有硬约束）；空段跳过。
        if not first or first == ".quarantine":
            return
        names.add(first)
        if os.path.isfile(rp):
            touched.setdefault(first, [])
            if rp not in touched[first]:
                touched[first].append(rp)

    _probe(base_cwd)  # cwd 落在 skill 目录内 = 常见「cd 进 skill 目录跑脚本」模式
    for tok in argv:
        if isinstance(tok, str) and (os.sep in tok or tok.startswith(".")):
            _probe(tok)

    return SkillExecProbe(names=frozenset(names), touched_files=touched)


def shell_wrapped_skill_ref(
    argv: list, cwd: Optional[str], skills_root: str
) -> Optional[str]:
    """壳包装盲区变体的**单源**判定（issue #62 起 evaluate 侧与 run 端点共用；原为
    ``policy._shell_wrapped_skill_ref_forces_ask``）。返回触发的 token（调用方据此组织
    ask / 409 文案），``None`` = 未命中。

    判定：argv0 解析为**危险解释器**（shell / 解释器 / 包管理器 / runner —— 复用
    ``policy.is_dangerous_argv0`` 同一单源危险名集）**且**某个后续 argv token 的**文本**包含
    realpath 后的 ``skills_root`` 子串、但该 token 自身 realpath **不落** skills 目录内
    （probe 未把它当 skills 路径落地）。

    语义：「危险解释器 + 文本引用 skill 目录 + 无法验证引用的执行对象」⇒ 不可校验。典型命中
    ``sh -lc "cd <skills>/x && python3 main.py"``（cwd=/tmp）—— 整条 shell 命令是**单个** token，
    文本含 skills_root 但 realpath 不落 skills 内，故直接盲区收口（``names`` 非空）漏掉它，而
    ``cd`` 发生在 shell 内部、``cwd`` 仍是默认 data root ⇒ probe 的 ``names``/``touched_files``
    双空 ⇒ 完整性校验 / 首跑记录 / **secret 注入**三个消费者一起 fail-open。

    🔴 **不误伤直接形状**：``python3 <skills>/x/main.py`` 的 token realpath 落 skills 内 → probe
    已落地（``touched_files`` 有对象，走既有完整性/首跑逻辑，首跑后 auto_allow 仍成立），本判定
    对它 ``continue``。非危险 argv0（``cat <skills>/x/f``）第一关即 ``None``，由既有 touched 逻辑管。

    **诚实边界**：纯文本子串匹配的 best-effort —— 相对路径 / 变量展开（``$SK/main.py``）/ base64 等
    编码可逃逸；fail 方向恒命中（解析不动的 token 直接返回它）。
    """
    if not argv:
        return None
    from src.agent_config.policy import _resolve_argv0, is_dangerous_argv0

    if not is_dangerous_argv0(_resolve_argv0(argv[0], cwd)):
        return None
    base = cwd if cwd else os.getcwd()
    for tok in argv[1:]:  # argv0 自身是解释器，不算「引用 skill 目录」
        if skills_root not in tok:
            continue
        cand = tok if os.path.isabs(tok) else os.path.join(base, tok)
        try:
            rp = os.path.realpath(cand)
        except (OSError, ValueError):
            return tok  # 文本引用 skill 目录但无法解析 → 保守命中
        if not (rp == skills_root or rp.startswith(skills_root + os.sep)):
            return tok  # 文本含 skills_root 但 realpath 未落地 ⇒ 不可校验的执行引用
    return None


# ---------------------------------------------------------------------------
# 完整性 + 首跑判定（纯读 —— 落 last_error / 首跑记录归调用方）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillGateCheck:
    """一个命中 skill 的闸判定结果。``tampered`` 非 None → 必须拒执行（首个问题文件的
    描述，直接可落 ``last_error``）；``pending_first_run`` = 尚无有效首跑记录、执行后应落
    记录的触达文件（{entrypoint_realpath: {version, entrypoint_hash}}，approved_at 由落库方补）。

    ``verified`` = 本次**逐字节校验通过**的 ``tampered:<rel>`` 标签集（issue #62）。run 端点据此
    **精确**清 ``last_error``：只清「这次真的验过的那个文件」记下的错，不因为验了 main.py 就把
    helper.py 的 tampered 一起抹掉（那会在 Settings 上造出 false-green —— 安全信号不能往绿的方向
    错）。``tampered`` 非 None 时本集是「问题文件之前」已过的部分，调用方不消费（那条路径拒执行）。"""

    skill_name: str
    tampered: Optional[str] = None
    pending_first_run: dict = field(default_factory=dict)
    verified: frozenset = frozenset()

    @property
    def needs_first_run(self) -> bool:
        return bool(self.pending_first_run)


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_READ_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _parse_json_dict(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def check_skill_gates(store: "AgentConfigStore", probe: SkillExecProbe) -> list:
    """对 probe 触达文件逐 skill 做完整性 + 首跑判定 → ``[SkillGateCheck, ...]``。

    只判定**有触达文件**的 skill（仅 cwd 命中、零触达文件 → 无完整性/首跑对象，不出项）。
    纯读、无副作用 —— run 端点据 tampered 拒 + 落 last_error、执行后落首跑记录；evaluate
    前置 gate 据「任一 tampered 或 needs_first_run」直接 ask。
    """
    checks: list = []
    for skill_name in sorted(probe.touched_files):
        files = probe.touched_files[skill_name]
        row = store.get_skill(skill_name)
        declared = _parse_json_dict(row.files_json if row else None)
        first_run = _parse_json_dict(row.first_run_approved if row else None)
        version = row.version if row else None

        try:
            from src.skills.pack_fetch import skill_dir

            root = os.path.realpath(skill_dir(skill_name))
        except Exception:  # noqa: BLE001 — 根不可得 → 视为 tampered（fail-closed）
            checks.append(SkillGateCheck(skill_name=skill_name, tampered="tampered:<unresolvable>"))
            continue

        tampered: Optional[str] = None
        pending: dict = {}
        verified: set = set()
        for rp in files:
            rel = rp[len(root) + 1:].replace(os.sep, "/") if rp.startswith(root + os.sep) else rp
            expected = declared.get(rel)
            if not isinstance(expected, str) or not expected:
                # 无行 / 无 files_json / 文件不在供应链清单 → 不受管控内容，拒执行。
                tampered = f"tampered:{rel}"
                break
            try:
                actual = _sha256_file(rp)
            except OSError:
                tampered = f"tampered:{rel}"
                break
            if actual != expected:
                tampered = f"tampered:{rel}"
                break
            verified.add(f"tampered:{rel}")  # 该文件这次逐字节验过 —— 它记的 last_error 可清
            rec = first_run.get(rp)
            valid = (
                isinstance(rec, dict)
                and rec.get("version") == version
                and rec.get("entrypoint_hash") == actual
            )
            if not valid:
                pending[rp] = {"version": version, "entrypoint_hash": actual}
        checks.append(
            SkillGateCheck(
                skill_name=skill_name,
                tampered=tampered,
                pending_first_run=pending,
                verified=frozenset(verified),
            )
        )
    return checks
