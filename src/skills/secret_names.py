"""Skill secret 名的 env-name 约束 + reserved deny-list —— **单一真源**（W2 安装校验 + W3 注入两处复用）。

script skill 声明的 secret（``manifest.secrets[].name``）会在脚本执行时注入子进程 env（W3）。若允许
它叫 ``PATH`` / ``NODE_OPTIONS`` / ``DYLD_INSERT_LIBRARIES`` 这类名字，注入即**覆盖执行环境**实现
劫持；若叫 ``NOTION_TOKEN`` 这类全局密钥名，也会混淆审计与泄漏面。故 secret 名必须：
  ① 过 env-name 正则（``^[A-Z][A-Z0-9_]{0,63}$``）；
  ② 不落在 reserved deny-list（= exec 子进程 env 固定白名单基底的允许名 ∪ 显式 deny 的执行劫持 /
     密钥泄漏名，规格见 ADR-002 §7）。

W2（``pack_verify`` / manifest 校验）安装时拒；W3（exec 端点注入）注入时二重拒 —— 两处引用本模块，
避免 deny-list 漂移。
"""

from __future__ import annotations

import os
from typing import Mapping, Optional

import re

# env 变量名正则：大写字母开头，[A-Z0-9_]，≤64 字符（POSIX 命名，收窄到大写 = skill secret 约定）。
SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")

# exec 子进程固定 PATH（**硬编码**安全值，非继承 —— 防 PATH 前置注入劫持；run_command 与 skill
# 脚本执行共用同一 exec 端点固定 env，本值是其 PATH 分量单源）。
FIXED_EXEC_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

# exec 子进程固定 env 白名单基底的允许名（W3 会用这份**构造** env）—— secret **不得**同名覆盖它们。
FIXED_ENV_ALLOW_NAMES: frozenset = frozenset(
    {"PATH", "HOME", "TMPDIR", "LANG", "TZ", "USER", "LOGNAME", "SHELL"}
)
# 允许名里的前缀族（LC_* locale 变量，如 LC_ALL / LC_CTYPE）。
FIXED_ENV_ALLOW_PREFIXES: tuple = ("LC_",)

# 显式 deny 的整名（既是密钥泄漏面又是执行劫持面）。
RESERVED_DENY_NAMES: frozenset = frozenset(
    {
        "NOTION_TOKEN",
        "LLM_API_KEY",
        "GITHUB_TOKEN",
        "SSH_AUTH_SOCK",
        "PYTHONPATH",
        "NODE_OPTIONS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        # W3 review P2-①：shell / 解释器**执行劫持**名（一个 secret 叫这些名 → 注入即改变脚本
        # 的启动行为，等价任意代码执行）。BASH_ENV/ENV = 非交互 shell 启动时 source 的文件；
        # IFS/CDPATH/GLOBIGNORE = 词法/路径解析劫持；PERL*/RUBY*/PYTHON* = 各解释器的库路径 /
        # 启动脚本 / 选项注入。
        "BASH_ENV",
        "ENV",
        "IFS",
        "CDPATH",
        "GLOBIGNORE",
        "PERL5LIB",
        "PERLLIB",
        "RUBYLIB",
        "RUBYOPT",
        "PYTHONSTARTUP",
        "PYTHONHOME",
    }
)
# 显式 deny 的前缀族（整族禁用：MAILAGENT_* 全局配置 / AWS_* 云凭据 / DYLD_* dylib 注入劫持 /
# BASH_FUNC_* 导出的 bash 函数（shellshock 类）/ LD_* Linux 动态链接器劫持（跨平台稳，macOS 对应
# DYLD_ 已在上）。
RESERVED_DENY_PREFIXES: tuple = ("MAILAGENT_", "AWS_", "DYLD_", "BASH_FUNC_", "LD_")


def is_reserved_secret_name(name: str) -> bool:
    """name 是否落在 reserved（允许基底名 ∪ deny 名/前缀）——落中即不可作 skill secret 名。"""
    if name in FIXED_ENV_ALLOW_NAMES or name in RESERVED_DENY_NAMES:
        return True
    for p in FIXED_ENV_ALLOW_PREFIXES + RESERVED_DENY_PREFIXES:
        if name.startswith(p):
            return True
    return False


def validate_secret_name(name: str) -> Optional[str]:
    """校验一个 skill secret 名；合法返回 ``None``，否则返回英文拒因（pack_verify / 注入端共用）。"""
    if not isinstance(name, str) or not SECRET_NAME_RE.match(name):
        return (
            f"secret name {name!r} must match {SECRET_NAME_RE.pattern} "
            "(uppercase letter, then [A-Z0-9_], <=64 chars)"
        )
    if is_reserved_secret_name(name):
        return (
            f"secret name {name!r} is reserved — it would override the fixed execution "
            "environment or masquerade as a global credential"
        )
    return None


def build_fixed_base_env(source_env: Optional[Mapping[str, str]] = None) -> dict[str, str]:
    """构造 exec 子进程的固定 env 白名单基底（**不** ``dict(os.environ)`` 继承 —— 防全局密钥 /
    执行劫持变量泄漏进 agent 触发的子进程）。

    PATH 恒 = 硬编码 ``FIXED_EXEC_PATH``（非继承）；其余 ``FIXED_ENV_ALLOW_NAMES`` + ``LC_*``
    前缀族从 ``source_env``（默认 ``os.environ``）**择取存在者**带过去。W3 在此基底上叠加
    per-skill secret（经 ``validate_secret_name`` 保证不覆盖任何基底名）。
    """
    src: Mapping[str, str] = os.environ if source_env is None else source_env
    env: dict[str, str] = {"PATH": FIXED_EXEC_PATH}
    for name in FIXED_ENV_ALLOW_NAMES:
        if name == "PATH":
            continue
        val = src.get(name)
        if val is not None:
            env[name] = val
    for key, val in src.items():
        if any(key.startswith(p) for p in FIXED_ENV_ALLOW_PREFIXES):
            env[key] = val
    return env
