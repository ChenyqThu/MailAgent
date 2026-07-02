"""per-skill 密钥加解密单点（S2 W3，ADR-002 §7 D5）—— Fernet 密文落 ``agent_config.db``，
master key 单条进 macOS 登录 Keychain（fallback 0600 keyfile）。

**为什么不是 api_keys 的 sha256**：skill 密钥执行时要**可逆取回**注入子进程 env，威胁模型与
api_keys（单向 hash 校验）完全不同 —— 必须加密静态存储、可解密。

**master key 通道**：
  - 主通道 = 登录 Keychain 单条 generic-password（``/usr/bin/security``）。创建走 ``security -i``
    stdin 交互管道喂完整命令行 —— key 值**不进 argv**（防 ``ps``/argv 泄漏）；读取 ``find-generic-
    password -w`` 拿回值（capture 到本进程，不落日志）。ACL 用 ``-A``（owner 拍板：免弹窗，dev/打包
    两态可自动化 —— 仍有 Keychain 静态加密 + 登录态门槛，严格优于明文落盘）。
  - fallback = ``DATA_ROOT/data/skill_secrets.key``（0600），仅 Keychain 不可用（security 不存在 /
    非 0 退出 / 超时 3s）时启用 + ``logger.warning`` 显式声明「与密文同盘 = 混淆非加密」。
  - master key 值**永不落日志**；两通道都拿不到 → ``MasterKeyUnavailable``，调用方跳过该 skill 的
    secret 注入（不阻断 run 本身）。

**信任边界（诚实声明，ADR-002 §9）**：Fernet + Keychain **不防本机同用户运行的恶意 app**（同用户
进程可读 Keychain 条目 / attach 本进程内存）—— 防的是「静态落盘泄漏 + stdout/stderr 回显泄漏」，不是
「本机主动攻击者」。单 owner 桌面产品前提下接受。
"""

from __future__ import annotations

import getpass
import os
import subprocess
import sys
import threading
from typing import Optional

from loguru import logger

from src.skills.secret_names import validate_secret_name

# ── Keychain 常量 ────────────────────────────────────────────────────────────────────
_SECURITY_BIN = "/usr/bin/security"
_KEYCHAIN_SERVICE = "MailAgent-SkillSecrets"
_SECURITY_TIMEOUT_SEC = 3.0
# `security find-generic-password` 在条目不存在时返回 errSecItemNotFound（44）——这是**正常**
# （首次用时尚未创建），与「Keychain 本身不可用」区分开。
_ERR_SEC_ITEM_NOT_FOUND = 44


class MasterKeyUnavailable(RuntimeError):
    """两个通道（Keychain + keyfile）都拿不到/建不出 master key。调用方跳过 secret 注入。"""


class _KeychainUnavailable(Exception):
    """Keychain 通道本身不可用（security 缺失 / 超时 / 非「未找到」的错误退出）→ 触发 keyfile fallback。

    与「条目未找到」（``find`` rc=44，Keychain 正常但还没存过 key）明确区分。
    """


# ── master key 进程内缓存（首次解析后缓存 —— 不反复弹 security；fallback 判定也随之缓存）─────
_cached_key: Optional[bytes] = None
_cache_lock = threading.RLock()


# ── 路径（keyfile fallback）——镜像 exec_floor._data_root 解析纪律 ─────────────────────────


def _data_root() -> str:
    root = os.environ.get("MAILAGENT_DATA_ROOT")
    if root:
        return os.path.abspath(os.path.expanduser(root))
    try:
        from src.config import DATA_ROOT

        return DATA_ROOT
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 .env
        return os.getcwd()


def _keyfile_path() -> str:
    """keyfile fallback 位置（deny 地板已把它列入禁读写清单，防 agent 经 file_read 偷 master key）。"""
    return os.path.join(_data_root(), "data", "skill_secrets.key")


def _keychain_account() -> str:
    """Keychain 条目 account 名 = 当前用户（getpass 在无 pwd 环境可抛 → 兜底固定名）。"""
    try:
        return getpass.getuser()
    except Exception:  # noqa: BLE001 — CI / 无 /etc/passwd
        return "mailagent"


# ── Keychain 子进程（唯一 subprocess 缝，测试 monkeypatch 此函数）─────────────────────────


def _run_security(
    args: list[str], *, stdin_text: Optional[str] = None
) -> subprocess.CompletedProcess:
    """跑一次 ``security``（唯一 subprocess 缝）。``stdin_text`` 非 None → 经 stdin 喂（值不进 argv）。

    security 不存在 / 超时 / OSError → ``_KeychainUnavailable``（触发 keyfile fallback）。
    返回 CompletedProcess（调用方按 returncode 分支：0 / 44=未找到 / 其它=不可用）。
    """
    if sys.platform != "darwin" or not os.path.exists(_SECURITY_BIN):
        raise _KeychainUnavailable("security(1) not available (non-macOS or missing)")
    try:
        return subprocess.run(  # noqa: S603 — 固定 binary + 固定 argv，值经 stdin
            [_SECURITY_BIN, *args],
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=_SECURITY_TIMEOUT_SEC,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        raise _KeychainUnavailable(f"security invocation failed: {exc}") from exc


def _keychain_read() -> Optional[bytes]:
    """从登录 Keychain 读 master key。返回 key bytes / None（Keychain 正常但条目未创建）。

    值经 ``-w`` 打到 stdout（capture 到本进程，**不落日志**）。Keychain 本身不可用 → ``_KeychainUnavailable``。
    """
    proc = _run_security(
        ["find-generic-password", "-w", "-s", _KEYCHAIN_SERVICE, "-a", _keychain_account()]
    )
    if proc.returncode == 0:
        val = (proc.stdout or "").strip()
        if not val:
            raise _KeychainUnavailable("keychain returned an empty master key")
        return val.encode("ascii")
    if proc.returncode == _ERR_SEC_ITEM_NOT_FOUND:
        return None  # 正常：还没存过 key
    # 其它非 0（钥匙串锁定 / 权限 / 未知）→ 视为不可用，走 fallback（诊断信息不含 key 值）。
    raise _KeychainUnavailable(f"security find-generic-password exited {proc.returncode}")


def _keychain_write(key: bytes) -> None:
    """把 master key 存进登录 Keychain（``security -i`` stdin 喂命令行 → 值**不进 argv**）。

    ``-U`` 存在则更新；``-A`` 允许任意 app 读（owner 拍板：免弹窗）。key = Fernet key（url-safe
    base64，无空白字符 → security -i 的空白分词安全，无需引用）。
    """
    account = _keychain_account()
    cmd = (
        f"add-generic-password -U -A -s {_KEYCHAIN_SERVICE} -a {account} "
        f"-w {key.decode('ascii')}\n"
    )
    proc = _run_security(["-i"], stdin_text=cmd)
    if proc.returncode != 0:
        raise _KeychainUnavailable(f"security add-generic-password exited {proc.returncode}")


# ── keyfile fallback ─────────────────────────────────────────────────────────────────


def _keyfile_read() -> Optional[bytes]:
    try:
        with open(_keyfile_path(), "rb") as fh:
            val = fh.read().strip()
        return val or None
    except FileNotFoundError:
        return None


def _keyfile_write(key: bytes) -> None:
    """写 0600 keyfile（``os.open`` mode 位 + ``fchmod`` 保证 0600，不受 umask 影响）+ warning。"""
    path = _keyfile_path()
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)  # umask-proof
        os.write(fd, key)
    finally:
        os.close(fd)
    logger.warning(
        "skill secret master key stored in keyfile fallback ({}) — same-disk as the "
        "ciphertext = obfuscation, NOT real key isolation (Keychain unavailable)",
        path,
    )


# ── master key 解析（缓存）────────────────────────────────────────────────────────────


def _load_or_create_master_key() -> bytes:
    """按优先级取/建 master key：Keychain（读→建）→ keyfile fallback（读→建）。"""
    # 1) Keychain 主通道。
    try:
        existing = _keychain_read()
        if existing is not None:
            return existing
        key = _generate_key()
        _keychain_write(key)
        return key
    except _KeychainUnavailable as exc:
        logger.warning(
            "Keychain unavailable for skill secret master key ({}) — falling back to keyfile", exc
        )
    # 2) keyfile fallback。
    existing = _keyfile_read()
    if existing is not None:
        return existing
    key = _generate_key()
    _keyfile_write(key)
    return key


def _generate_key() -> bytes:
    from cryptography.fernet import Fernet

    return Fernet.generate_key()


def _get_master_key() -> bytes:
    """进程内缓存的 master key（首次解析后缓存 —— 不反复弹 security；fallback 判定随之缓存）。"""
    global _cached_key
    with _cache_lock:
        if _cached_key is not None:
            return _cached_key
        key = _load_or_create_master_key()
        _cached_key = key
        return key


def reset_master_key_cache() -> None:
    """test-only：清 master key 缓存，让测试切换 Keychain/keyfile 通道后重解析。"""
    global _cached_key
    with _cache_lock:
        _cached_key = None


def _fernet():
    from cryptography.fernet import Fernet

    return Fernet(_get_master_key())


# ── 加解密低阶原语 ────────────────────────────────────────────────────────────────────


def encrypt_secret(plaintext: str) -> bytes:
    """明文 → Fernet 密文（落 ``skill_secrets.value_ciphertext``）。"""
    return _fernet().encrypt(plaintext.encode("utf-8"))


def decrypt_secret(ciphertext: bytes) -> str:
    """Fernet 密文 → 明文（注入子进程 env 前解密）。"""
    return _fernet().decrypt(ciphertext).decode("utf-8")


# ── 公共 API（端点 + exec 注入消费）──────────────────────────────────────────────────


def _store():
    from src.agent_config.store import get_agent_config_store

    return get_agent_config_store()


def set_secret(skill_name: str, secret_name: str, value: str, *, store=None) -> None:
    """写/替换一个 per-skill 密钥（Fernet 加密落库）。secret 名过 ``validate_secret_name``
    （env-regex + reserved deny，防覆盖执行环境 / 冒充全局密钥）。值任何形态**不进日志**。"""
    reason = validate_secret_name(secret_name)
    if reason:
        raise ValueError(reason)
    ciphertext = encrypt_secret(value)
    (store or _store()).upsert_skill_secret(skill_name, secret_name, ciphertext)


def get_secret(skill_name: str, secret_name: str, *, store=None) -> Optional[str]:
    """取一个 per-skill 密钥明文（无 → None）。调用栈外**不缓存**明文。"""
    ciphertext = (store or _store()).get_skill_secret_ciphertext(skill_name, secret_name)
    if ciphertext is None:
        return None
    return decrypt_secret(ciphertext)


def get_secrets_for_skill(skill_name: str, *, store=None) -> dict[str, str]:
    """一个 skill 的全部密钥（名→明文），供 exec 端点注入子进程 env。

    注入侧**二重校验**（安装侧 pack_verify 是第一重）：非法/reserved 名的密钥（DB 被外部污染的
    理论情形）跳过 + warning；解密失败（master key 轮换 / 密文损坏）跳过 + warning —— 都不阻断
    整个 run（缺 secret 的脚本自然失败，但不因一个坏 secret 连累其它）。
    """
    out: dict[str, str] = {}
    for name, ciphertext in (store or _store()).list_skill_secret_ciphertexts(skill_name):
        if validate_secret_name(name) is not None:
            logger.warning(
                "skipping skill secret with reserved/invalid name during injection "
                "(skill={}, name={})",
                skill_name,
                name,
            )
            continue
        try:
            out[name] = decrypt_secret(ciphertext)
        except Exception:  # noqa: BLE001 — 值不进异常消息/日志
            logger.warning(
                "failed to decrypt skill secret during injection (skill={}, name={}) — skipping",
                skill_name,
                name,
            )
    return out


def delete_secret(skill_name: str, secret_name: str, *, store=None) -> bool:
    """删一个 per-skill 密钥（owner ``DELETE .../secrets/{name}``）。幂等（无行 False）。"""
    return (store or _store()).delete_skill_secret(skill_name, secret_name)
