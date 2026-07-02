"""exec / 文件工具的 deny 地板 —— **任何 PolicyRule 都不能覆盖**（ADR-001 §7 D5）。

地板拒绝对一组敏感目标的读/写：``DATA_ROOT/.env``（全局密钥）· 各 backend-owned SQLite
（``agent_config.db`` / ``sync_store.db`` / ``ai_chat.db`` + wal/shm/journal —— 直写库绕过全部业务
不变式；三库路径都经各自的 resolver 取，随 env override 走）· ``token.dat``（davmail 凭据）·
``~/.ssh/**`` · ``~/Library/Keychains/**`` · 运行解释器根 + **完整 macOS .app bundle**（dev venv /
打包内嵌 python + Electron main 可执行体，防 agent 改写自身可执行体 = 持久化后门）·
``skill_secrets.key`` · skill ``.quarantine/**``（未审内容禁读写执行）。

**inode 级复核（codex P1-4）**：realpath 前缀能挡 symlink + ``..`` traversal，但**挡不住 hardlink**
（把敏感文件硬链进允许目录后 realpath 不暴露原路径）+ check→open 间的 rename race（TOCTOU）。故：
  1. 敏感**具体文件**在构造时 stat 缓存其 ``(st_dev, st_ino)``；
  2. ``file_read`` / ``file_write`` 一律 **open（``O_NOFOLLOW``）后再 fstat 复核** fd 的 inode 不在
     deny 集 —— **认 fd 不认 path**，覆盖 hardlink + TOCTOU；overwrite 的截断也**推迟到 inode 复核
     之后**（先 ``O_CREAT`` 开、验 inode、再 ``ftruncate``），防经 hardlink+overwrite 抹掉敏感文件。

**诚实边界（ADR-001 §7）**：``run_command`` 批准后即任意执行，地板对它只做 **argv/cwd 静态命中提示**
（``floor_hits``，供审批卡标红），**阻止不了子进程内部**读 ``.env`` / ssh key / DB —— exec 的最终防线
是 HITL + 白名单窄度 + 固定 env 基底（不含全局密钥），**不是文件访问隔离/沙箱**。本模块的注释与
docstring 不得把 run_command 地板表述为文件隔离。
"""

from __future__ import annotations

import os
import stat as _stat
import sys
from functools import lru_cache
from typing import Optional


class FloorDenied(Exception):
    """目标命中 deny 地板（敏感路径 / inode）。端点 → E_EXEC_FLOOR_DENIED (403)。"""

    def __init__(self, target: str, reason: str) -> None:
        super().__init__(f"denied by exec floor: {target} ({reason})")
        self.target = target
        self.reason = reason


# ---------------------------------------------------------------------------
# 路径解析（全部读 env 现值 —— 测试可 monkeypatch MAILAGENT_DATA_ROOT / _SKILLS_DIR /
# _AGENT_CONFIG_DB_PATH 后 reset_exec_floor_cache 重建）
# ---------------------------------------------------------------------------


def _data_root() -> str:
    """DATA_ROOT 现值：优先 ``MAILAGENT_DATA_ROOT``，否则回退 config.DATA_ROOT（仓库根）。"""
    root = os.environ.get("MAILAGENT_DATA_ROOT")
    if root:
        return os.path.abspath(os.path.expanduser(root))
    try:
        from src.config import DATA_ROOT

        return DATA_ROOT
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 .env
        return os.getcwd()


def _agent_config_db() -> Optional[str]:
    try:
        from src.agent_config.store import resolve_agent_config_db_path

        return resolve_agent_config_db_path()
    except Exception:  # noqa: BLE001
        return None


def _sync_store_db(data_root: str) -> str:
    try:
        from src.config import config as _cfg

        return _cfg.sync_store_db_path
    except Exception:  # noqa: BLE001 — config 构造失败 → 用默认位置
        return os.path.join(data_root, "data", "sync_store.db")


def _ai_chat_db(data_root: str) -> str:
    """ai_chat.db 现值：复用前端 owned schema 的 resolver（读 ``AI_CHAT_DB_PATH`` override，与
    sync_store/agent_config 一致），**不硬编码路径** —— 否则 override 时地板双失（P2-3）。"""
    try:
        from src.chat.db import resolve_ai_chat_db_path

        return resolve_ai_chat_db_path()
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 config → 回退默认位置
        return os.path.join(data_root, "frontend", "ai_chat.db")


def _skills_root() -> Optional[str]:
    try:
        from src.skills.pack_fetch import skills_data_root

        return skills_data_root()
    except Exception:  # noqa: BLE001
        return None


def _app_bundle_root() -> Optional[str]:
    """打包态 macOS ``.app`` bundle 根：从 ``sys.executable`` 上溯首个 ``*.app`` 目录。

    一条前缀树即覆盖整个 bundle —— 内嵌可重定位 CPython + Electron main 可执行体
    （``Contents/MacOS/*``）+ 全部 Resources，防 agent 改写自身可执行体做持久化后门（ADR-001 §7）。
    dev 态（解释器不在 ``.app`` 内）返回 None，由 ``sys.prefix`` / repo ``venv`` 兜底。
    """
    p = os.path.realpath(sys.executable)
    while True:
        if p.endswith(".app") and os.path.isdir(p):
            return p
        parent = os.path.dirname(p)
        if parent == p:  # 抵达文件系统根，未见 .app
            return None
        p = parent


# ---------------------------------------------------------------------------
# 地板
# ---------------------------------------------------------------------------

# 无论落在哪个目录、任何路径的这些 basename 都拒（davmail token.dat 位置随部署变化）。
_DENIED_BASENAMES: frozenset = frozenset({"token.dat"})
_DB_SUFFIXES = ("", "-wal", "-shm", "-journal")


class ExecFloor:
    """一次 env 快照下的敏感清单 + inode 缓存。经 :func:`get_exec_floor` 进程内缓存（reset 供测试）。"""

    def __init__(self) -> None:
        self._exact_files: set[str] = set()  # realpath 化的精确匹配文件
        self._prefix_trees: list[str] = []  # realpath 化的前缀目录
        self._sensitive_inodes: set[tuple[int, int]] = set()
        self._build()

    def _build(self) -> None:
        data_root = _data_root()

        exacts: list[str] = [os.path.join(data_root, ".env")]
        for db in (_agent_config_db(), _sync_store_db(data_root), _ai_chat_db(data_root)):
            if db:
                for suf in _DB_SUFFIXES:
                    exacts.append(db + suf)
        exacts.append(os.path.join(data_root, "data", "skill_secrets.key"))

        for p in exacts:
            rp = os.path.realpath(p)
            self._exact_files.add(rp)
            try:
                st = os.stat(rp)  # 存在则缓存 inode（hardlink 防线）；不存在仅靠 path-deny 兜底
                self._sensitive_inodes.add((st.st_dev, st.st_ino))
            except OSError:
                pass

        trees: list[Optional[str]] = [
            os.path.expanduser("~/.ssh"),
            os.path.expanduser("~/Library/Keychains"),
            sys.prefix,  # 运行解释器根（dev = venv / 打包 = 内嵌 python）
            sys.base_prefix,
            _app_bundle_root(),  # 打包态 .app bundle 根（内嵌 venv + Electron main + Resources 全覆盖）
            os.path.join(data_root, "venv"),  # dev 态 repo venv（sys.prefix 之外的显式覆盖）
        ]
        skills_root = _skills_root()
        if skills_root:
            trees.append(os.path.join(skills_root, ".quarantine"))
        for t in trees:
            if t:
                self._prefix_trees.append(os.path.realpath(t))

    # -- 判定 -------------------------------------------------------------

    def path_reason(self, realpath: str) -> Optional[str]:
        """realpath 化的路径命中敏感清单的原因（None = 未命中）。symlink/`..` 由调用方先 realpath。"""
        if realpath in self._exact_files:
            return "sensitive file"
        if os.path.basename(realpath) in _DENIED_BASENAMES:
            return "sensitive file (token.dat)"
        for pfx in self._prefix_trees:
            if realpath == pfx or realpath.startswith(pfx + os.sep):
                return "sensitive tree"
        return None

    def open_checked_read(self, path: str) -> int:
        """open 一个可读 fd，穿过 deny 地板（path + inode 双检 + 拒非常规文件）。调用方负责关 fd。"""
        rp = os.path.realpath(path)
        reason = self.path_reason(rp)
        if reason:
            raise FloorDenied(rp, reason)
        fd = os.open(rp, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) in self._sensitive_inodes:
                raise FloorDenied(rp, "sensitive file (inode)")
            if not _stat.S_ISREG(st.st_mode):
                raise FloorDenied(rp, "not a regular file")
        except BaseException:
            os.close(fd)
            raise
        return fd

    def open_checked_write(self, path: str, mode: str) -> tuple[int, bool]:
        """open 一个可写 fd（mode ∈ overwrite/append/create_new），返回 (fd, created)。

        inode 复核在**任何截断/写入之前**：overwrite 用 ``O_CREAT``（无 ``O_TRUNC``）开、验 inode、再
        ``ftruncate`` —— 防「hardlink 敏感文件到允许目录 + overwrite」在检查前就把内容抹了。
        """
        rp = os.path.realpath(path)
        reason = self.path_reason(rp)
        if reason:
            raise FloorDenied(rp, reason)
        existed = os.path.lexists(rp)
        flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CREAT
        if mode == "create_new":
            flags |= os.O_EXCL
        elif mode == "append":
            flags |= os.O_APPEND
        elif mode != "overwrite":
            raise ValueError(f"unknown write mode: {mode!r}")
        fd = os.open(rp, flags, 0o600)
        try:
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) in self._sensitive_inodes:
                raise FloorDenied(rp, "sensitive file (inode)")
            if not _stat.S_ISREG(st.st_mode):
                raise FloorDenied(rp, "not a regular file")
            if mode == "overwrite":
                os.ftruncate(fd, 0)  # 截断推迟到 inode 复核通过之后
        except BaseException:
            os.close(fd)
            raise
        return fd, (not existed)

    def run_command_floor_hits(self, argv: list[str], cwd: Optional[str]) -> list[str]:
        """run_command 的**静态**地板：argv 中可解析成路径的实参（+ cwd）realpath 后命中敏感清单
        → 收进 hits（供审批卡标红）。**不阻断执行**（run_command 无沙箱，见模块 docstring）。"""
        hits: list[str] = []
        base = cwd or _data_root()

        def _probe(token: str) -> None:
            cand = token if os.path.isabs(token) else os.path.join(base, token)
            try:
                rp = os.path.realpath(cand)
            except (OSError, ValueError):
                return
            reason = self.path_reason(rp)
            if reason:
                hits.append(f"{token} -> {rp} ({reason})")

        if cwd:
            _probe(cwd)
        for tok in argv:
            # 只探看起来像路径的（含分隔符 / 绝对 / . 开头）；纯选项/子命令不 realpath 噪音。
            if os.sep in tok or tok.startswith("."):
                _probe(tok)
        return hits


@lru_cache(maxsize=1)
def get_exec_floor() -> ExecFloor:
    """进程内 ExecFloor 单例（按当前 env 快照构建）。"""
    return ExecFloor()


def reset_exec_floor_cache() -> None:
    """test-only：清缓存，让测试切换 MAILAGENT_DATA_ROOT / _SKILLS_DIR 后重建地板。"""
    get_exec_floor.cache_clear()
