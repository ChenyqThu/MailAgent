"""DavMail 认证失效自助重连（task 10-28-davmail-self-reauth）。

公司租户的条件访问策略把登录有效期卡在 30 天（``AADSTS70043``），DavMail 的 refresh token
每 30 天必然失效一次。本模块把原来的命令行流程（起临时 DavMail 实例、往 stdin 喂回调 URL）
换成纯 Python：生成授权链接 → 用户贴回回调 → 换 refresh token → 按 DavMail 的格式加密写进
``token.dat`` → 正式端口 IMAP LOGIN 验证。

**格式来源**：DavMail 6.7.0 jar 的 ``O365Token`` / ``StringEncryptor`` / ``Settings`` 字节码。
- 加密值 = ``{AES}`` + base64(AES-128-CBC 密文)，密钥 = PBKDF2-HMAC-SHA256(口令, 盐, 10000 次,
  16 字节)，IV 也是这个盐。口令 = IMAP 认证密码（cipher key），盐 = ``davmail.oauth.fingerprint``。
- ``token.dat`` 是 Java Properties：``<小写用户名>=<加密值>``，值里的 ``=`` 被转义成 ``\\=``。
- 格式被 ``tests/mail/davmail_golden/`` 的 golden 样本锁住（由真实 DavMail jar 生成）。万一上游
  改了格式，写入后的 LOGIN 验证会立即失败并恢复备份，不会静默写坏。

🔴 授权码与 token 原文只活在局部变量里：不进日志、不进异常文案、不进返回值。日志只记阶段和
AADSTS 错误码。
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Optional
from urllib.parse import unquote, urlencode

from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from loguru import logger

from src.mail.davmail_properties import (
    _atomic_write,
    _decode,
    properties_path,
    read_values,
    resolve_davmail_root,
)
# 写侧在这里，读侧（到期倒计时）在 watchdog；键名单源在 watchdog
from src.mail.davmail_watchdog import AUTH_LAST_INTERACTIVE_AT_KEY

if TYPE_CHECKING:
    from src.config import Config

DEFAULT_FINGERPRINT = "davmailgateway!&"
# DavMail 没配 clientId 时用的默认值（O365ManualAuthenticator 常量）
DEFAULT_CLIENT_ID = "facd6cff-a294-4415-b59f-c5b01937d7bd"
DEFAULT_TENANT_ID = "common"
DEFAULT_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"
LOGIN_URL = "https://login.microsoftonline.com"
EWS_RESOURCE = "https://outlook.office365.com"
PBKDF2_ITERATIONS = 10000
_ENC_PREFIX = "{AES}"

_TOKEN_TIMEOUT_SECS = 30.0
_LOGIN_TIMEOUT_SECS = 15
# 重启后 JVM 起来要几秒，按间隔重试几次 LOGIN
_POST_RESTART_ATTEMPTS = 4
_POST_RESTART_WAIT_SECS = 5.0
# 备份里是加密的 refresh token，每次重认证新增一份，只留最近几份
BACKUP_KEEP = 5
_BACKUP_INFIX = ".pre-reauth-"

STAGE_PARSE = "parse"
STAGE_EXCHANGE = "exchange"
STAGE_WRITE = "write"
STAGE_VERIFY = "verify"
STAGE_DONE = "done"

_PROP_KEYS = (
    "davmail.mode",
    "davmail.authentication",
    "davmail.enableGraph",
    "davmail.enableOidc",
    "davmail.oauth.clientId",
    "davmail.oauth.tenantId",
    "davmail.oauth.redirectUri",
    "davmail.oauth.tokenFilePath",
    "davmail.oauth.fingerprint",
)


class ReauthError(Exception):
    """可直接展示给用户的失败。``message`` 永不包含授权码 / token。"""

    def __init__(self, stage: str, code: str, message: str) -> None:
        super().__init__(f"{stage}:{code}")
        self.stage = stage
        self.code = code
        self.message = message


@dataclass(frozen=True)
class OAuthSettings:
    client_id: str
    tenant_id: str
    redirect_uri: str
    token_file: Path
    fingerprint: str
    username: str
    password: str = field(repr=False)


@dataclass(frozen=True)
class ReauthResult:
    ok: bool
    stage: str
    code: str
    message: str


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------


def _is_true(raw: Optional[str]) -> bool:
    return (raw or "").strip().lower() == "true"


def load_oauth_settings(cfg: "Config") -> OAuthSettings:
    """从 ``davmail.properties`` + App 配置组出换 token 所需参数。不满足条件 → ReauthError(stage=config)。"""
    from src.mail.backend.imap_client import DavMailConnectionError, get_cipher_key

    path = properties_path(resolve_davmail_root(cfg))
    try:
        raw = read_values(path, _PROP_KEYS)
    except OSError:
        raise ReauthError(
            "config",
            "E_PROPERTIES_MISSING",
            f"找不到 DavMail 配置文件 {path}，请检查 DAVMAIL_ROOT 设置。",
        ) from None
    props = {k: (_unescape(v).strip() if v is not None else "") for k, v in raw.items()}

    mode = props["davmail.mode"]
    auth_mode = props["davmail.authentication"] or mode
    if "graph" in mode.lower() or _is_true(props["davmail.enableGraph"]) or _is_true(
        props["davmail.enableOidc"]
    ):
        raise ReauthError(
            "config",
            "E_GRAPH_UNSUPPORTED",
            "DavMail 当前是 Graph / OIDC 模式，App 内重新认证暂不支持，请用命令行流程。",
        )
    if not auth_mode.startswith("O365"):
        raise ReauthError(
            "config",
            "E_MODE_UNSUPPORTED",
            f"DavMail 当前认证方式是 {auth_mode or '未设置'}，不是 O365 OAuth，无需在这里重新认证。",
        )
    token_path = props["davmail.oauth.tokenFilePath"]
    if not token_path:
        raise ReauthError(
            "config",
            "E_TOKEN_PATH_MISSING",
            "DavMail 未配置 token 文件路径（davmail.oauth.tokenFilePath），App 内重新认证暂不支持。",
        )
    username = (getattr(cfg, "user_email", "") or "").strip()
    if not username:
        raise ReauthError("config", "E_USER_EMAIL_MISSING", "未配置 USER_EMAIL。")
    try:
        password = get_cipher_key(cfg)
    except DavMailConnectionError:
        raise ReauthError(
            "config",
            "E_CIPHER_KEY_MISSING",
            "未配置 DavMail 认证密码（DAVMAIL_POC_CIPHER_KEY），无法写入登录信息。",
        ) from None

    return OAuthSettings(
        client_id=props["davmail.oauth.clientId"] or DEFAULT_CLIENT_ID,
        tenant_id=props["davmail.oauth.tenantId"] or DEFAULT_TENANT_ID,
        redirect_uri=props["davmail.oauth.redirectUri"] or DEFAULT_REDIRECT_URI,
        token_file=Path(token_path),
        fingerprint=props["davmail.oauth.fingerprint"] or DEFAULT_FINGERPRINT,
        username=username,
        password=password,
    )


def build_authorize_url(settings: OAuthSettings) -> str:
    """与 DavMail ``O365Authenticator.buildAuthorizeUrl`` 的 EWS 分支同形。"""
    query = urlencode(
        {
            "client_id": settings.client_id,
            "response_type": "code",
            "redirect_uri": settings.redirect_uri,
            "response_mode": "query",
            "login_hint": settings.username,
            "resource": EWS_RESOURCE,
        }
    )
    return f"{LOGIN_URL}/{settings.tenant_id}/oauth2/authorize?{query}"


# ---------------------------------------------------------------------------
# 回调解析
# ---------------------------------------------------------------------------

_CODE_PARAM_RE = re.compile(r"[?&#]code=([^&#\s]+)")
_ERROR_PARAM_RE = re.compile(r"[?&#]error=([^&#\s]+)")
_AADSTS_RE = re.compile(r"AADSTS(\d+)")
_BARE_CODE_RE = re.compile(r"^[A-Za-z0-9._~+/=%-]{20,}$")


def parse_callback(text: str) -> str:
    """从用户贴回的内容里取授权码。

    接受：oob 回调 URL、nativeclient 回调 URL、只贴 code 本身，首尾空白不计。
    """
    s = (text or "").strip()
    if not s:
        raise ReauthError(STAGE_PARSE, "E_EMPTY", "请先粘贴登录后浏览器地址栏里的完整地址。")
    match = _CODE_PARAM_RE.search(s)
    if match:
        return unquote(match.group(1))
    if _ERROR_PARAM_RE.search(s):
        aadsts = _AADSTS_RE.search(unquote(s))
        raise ReauthError(
            STAGE_PARSE,
            f"AADSTS{aadsts.group(1)}" if aadsts else "E_LOGIN_ERROR",
            describe_aadsts(aadsts.group(1) if aadsts else None),
        )
    if "://" in s or s.startswith("urn:") or "?" in s:
        raise ReauthError(
            STAGE_PARSE,
            "E_NO_CODE",
            "地址里没有 code=。按 F12 打开 Network 面板重新登录，复制最后一个红色请求的 Request URL。",
        )
    if not _BARE_CODE_RE.match(s):
        raise ReauthError(STAGE_PARSE, "E_INVALID", "粘贴的内容不像授权码，请复制完整的回调地址。")
    return s


_AADSTS_MESSAGES = {
    "70008": "授权码已过期（大约 10 分钟有效），请点「重新获取链接」再登录一次。",
    "54005": "这个授权码已经用过了，请点「重新获取链接」重新登录。",
    "70043": "登录已超过公司规定的有效期，请点「重新获取链接」重新登录。",
    "700082": "登录已超过公司规定的有效期，请点「重新获取链接」重新登录。",
    "9002313": "授权码不完整，请复制完整的回调地址后重试。",
    "50126": "用户名或密码不对，请点「重新获取链接」重新登录。",
    "50076": "这次登录需要多因素验证，请在浏览器里完成验证后，点「重新获取链接」重试。",
    "50079": "这次登录需要多因素验证，请在浏览器里完成验证后，点「重新获取链接」重试。",
    "50158": "这次登录需要额外的安全验证，请在浏览器里完成后，点「重新获取链接」重试。",
    "53003": "公司的访问策略拦截了这次登录，请联系 IT 确认设备或网络是否符合要求。",
    "50020": "登录的账号不属于公司租户，请用工作邮箱账号登录。",
    "50034": "账号不存在，请确认用工作邮箱账号登录。",
    "65001": "这个应用还没有被授权访问邮箱，请联系 IT 管理员。",
    "700016": "DavMail 配置的应用（clientId）不被公司租户接受，请检查 davmail.oauth.clientId。",
}


def describe_aadsts(code: Optional[str]) -> str:
    if code and code in _AADSTS_MESSAGES:
        return _AADSTS_MESSAGES[code]
    if code:
        return f"微软返回错误 AADSTS{code}，请点「重新获取链接」重试；仍失败请联系管理员。"
    return "微软登录返回错误，请点「重新获取链接」重试。"


# ---------------------------------------------------------------------------
# 换 token
# ---------------------------------------------------------------------------


def _jwt_account(id_token: str) -> Optional[str]:
    """只取 id_token 里的账号名用来比对，不验签（token 是刚从 HTTPS 拿到的）。"""
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:  # noqa: BLE001 — 解析不了就不比对，LOGIN 验证仍兜底
        return None
    for key in ("upn", "unique_name", "preferred_username", "email"):
        value = claims.get(key)
        if isinstance(value, str) and value:
            return value.removeprefix("live.com#")
    return None


async def exchange_code(
    settings: OAuthSettings, code: str, *, transport: Any = None
) -> str:
    """授权码换 refresh token。``access_token`` 丢弃。失败 → ReauthError(stage=exchange)。"""
    import httpx

    url = f"{LOGIN_URL}/{settings.tenant_id}/oauth2/token"
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.redirect_uri,
        "client_id": settings.client_id,
    }
    # 每次新建 client：httpx 只在构造时读系统代理，常驻进程复用 client 会一直用失效的代理。
    try:
        async with httpx.AsyncClient(timeout=_TOKEN_TIMEOUT_SECS, transport=transport) as client:
            resp = await client.post(url, data=form)
    except httpx.HTTPError as exc:
        raise ReauthError(
            STAGE_EXCHANGE,
            "E_NETWORK",
            f"连不上微软登录服务（{type(exc).__name__}），请检查网络或代理后重试。",
        ) from None

    try:
        body = resp.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}

    if resp.status_code != 200 or body.get("error"):
        codes = body.get("error_codes")
        aadsts: Optional[str] = None
        if isinstance(codes, list) and codes:
            aadsts = str(codes[0])
        else:
            m = _AADSTS_RE.search(str(body.get("error_description") or ""))
            aadsts = m.group(1) if m else None
        raise ReauthError(
            STAGE_EXCHANGE,
            f"AADSTS{aadsts}" if aadsts else f"HTTP_{resp.status_code}",
            describe_aadsts(aadsts),
        )

    refresh_token = body.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token:
        raise ReauthError(
            STAGE_EXCHANGE, "E_NO_REFRESH_TOKEN", "微软没有返回可长期使用的登录信息，请重新获取链接再试。"
        )

    id_token = body.get("id_token")
    if isinstance(id_token, str):
        account = _jwt_account(id_token)
        if account and account.lower() != settings.username.lower():
            raise ReauthError(
                STAGE_EXCHANGE,
                "E_ACCOUNT_MISMATCH",
                f"登录的账号是 {account}，不是 {settings.username}。请在浏览器里切换到正确的账号后重新获取链接。",
            )
    return refresh_token


# ---------------------------------------------------------------------------
# 加解密（DavMail StringEncryptor）
# ---------------------------------------------------------------------------


def _cipher(password: str, fingerprint: str) -> Cipher:
    salt = fingerprint.encode("utf-8")
    key = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=16, salt=salt, iterations=PBKDF2_ITERATIONS
    ).derive(password.encode("utf-8"))
    return Cipher(algorithms.AES(key), modes.CBC(salt))


def encrypt_token(plaintext: str, password: str, fingerprint: str = DEFAULT_FINGERPRINT) -> str:
    padder = padding.PKCS7(128).padder()
    data = padder.update(plaintext.encode("utf-8")) + padder.finalize()
    enc = _cipher(password, fingerprint).encryptor()
    return _ENC_PREFIX + base64.b64encode(enc.update(data) + enc.finalize()).decode("ascii")


def decrypt_token(value: str, password: str, fingerprint: str = DEFAULT_FINGERPRINT) -> str:
    """口令或盐不对 → ValueError（同 DavMail 的 BadPadding）。"""
    if not value.startswith(_ENC_PREFIX):
        raise ValueError("not an encrypted DavMail value")
    dec = _cipher(password, fingerprint).decryptor()
    data = dec.update(base64.b64decode(value[len(_ENC_PREFIX):])) + dec.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    return (unpadder.update(data) + unpadder.finalize()).decode("utf-8")


# ---------------------------------------------------------------------------
# Java Properties（token.dat）
# ---------------------------------------------------------------------------

_UNESCAPE_MAP = {"t": "\t", "n": "\n", "r": "\r", "f": "\f"}


def _unescape(s: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch != "\\" or i + 1 >= len(s):
            out.append(ch)
            i += 1
            continue
        nxt = s[i + 1]
        if nxt == "u" and i + 6 <= len(s):
            try:
                out.append(chr(int(s[i + 2:i + 6], 16)))
                i += 6
                continue
            except ValueError:
                pass
        out.append(_UNESCAPE_MAP.get(nxt, nxt))
        i += 2
    return "".join(out)


def _escape(s: str, *, is_key: bool) -> str:
    """对齐 ``java.util.Properties.store`` 的 saveConvert（key 转义空格，value 只转义开头空格）。"""
    out: list[str] = []
    for i, ch in enumerate(s):
        if ch == " ":
            out.append("\\ " if is_key or i == 0 else " ")
        elif ch == "\\":
            out.append("\\\\")
        elif ch in "\t\n\r\f":
            out.append("\\" + {"\t": "t", "\n": "n", "\r": "r", "\f": "f"}[ch])
        elif ch in "=:#!":
            out.append("\\" + ch)
        elif ord(ch) < 0x20 or ord(ch) > 0x7E:
            out.append(f"\\u{ord(ch):04X}")
        else:
            out.append(ch)
    return "".join(out)


def _split_line(line: str) -> Optional[tuple[str, str]]:
    """一行 → (反转义后的 key, 反转义后的 value)；注释 / 空行 → None。不处理续行（Java store 不会写出续行）。"""
    s = line.lstrip(" \t\f").rstrip("\r\n")
    if not s or s[0] in "#!":
        return None
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\":
            i += 2
            continue
        if ch in "=: \t\f":
            break
        i += 1
    key = s[:i]
    rest = s[i:].lstrip(" \t\f")
    if rest[:1] in ("=", ":"):
        rest = rest[1:].lstrip(" \t\f")
    return _unescape(key), _unescape(rest)


def read_token_value(path: Path, username: str) -> Optional[str]:
    """读 token 文件里某账号的加密值（重复 key 后者生效，同 Java）。"""
    text, _ = _decode(Path(path).read_bytes())
    found: Optional[str] = None
    for line in text.splitlines():
        parsed = _split_line(line)
        if parsed and parsed[0].lower() == username.lower():
            found = parsed[1]
    return found


def write_token_file(
    path: Path, username: str, encrypted: str, *, now: Optional[datetime] = None
) -> Optional[Path]:
    """把一个账号的加密值写进 token 文件，其余行原样保留。返回备份路径（原文件不存在 → None）。"""
    path = Path(path)
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    backup: Optional[Path] = None
    if path.exists():
        backup = path.with_name(f"{path.name}.pre-reauth-{stamp}")
        shutil.copy2(path, backup)
        text, _ = _decode(path.read_bytes())
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        text = "#Oauth tokens\n"

    # DavMail 存取都用小写用户名
    new_line = f"{_escape(username.lower(), is_key=True)}={_escape(encrypted, is_key=False)}\n"
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    replaced = False
    for line in lines:
        parsed = _split_line(line)
        if parsed and parsed[0].lower() == username.lower():
            if not replaced:
                out.append(new_line)
                replaced = True
            continue
        out.append(line)
    if not replaced:
        if out and not out[-1].endswith(("\n", "\r")):
            out[-1] += "\n"
        out.append(new_line)
    _atomic_write(path, "".join(out).encode("latin-1"))
    return backup


def prune_backups(path: Path, keep: int = BACKUP_KEEP) -> None:
    """只删 ``<token 文件名>.pre-reauth-<时间戳>``，按文件名里的时间戳保留最新 ``keep`` 份。

    按文件名排序而不是 mtime：备份用 copy2 生成，mtime 是旧 token 文件的修改时间。
    删除失败只记 warning，不影响认证结果。
    """
    path = Path(path)
    prefix = path.name + _BACKUP_INFIX
    backups = sorted(
        (p for p in path.parent.glob(f"{prefix}*") if p.is_file()),
        key=lambda p: p.name[len(prefix):],
        reverse=True,
    )
    for old in backups[keep:]:
        try:
            old.unlink()
        except OSError:
            logger.warning(f"[davmail-reauth] prune backup failed: {old}")


def restore_token_file(path: Path, backup: Optional[Path]) -> None:
    """用备份覆盖回去；原来就没有文件 → 删掉新写的。"""
    path = Path(path)
    if backup is None:
        path.unlink(missing_ok=True)
        return
    _atomic_write(path, Path(backup).read_bytes())


# ---------------------------------------------------------------------------
# 验证 + 编排
# ---------------------------------------------------------------------------


def verify_login(cfg: "Config") -> bool:
    """正式端口真实 IMAP LOGIN 一次（阻塞，调用方放线程里跑）。写法同 watchdog 的 LOGIN 探测。"""
    from src.mail.backend.imap_client import imap_connect

    try:
        imap = imap_connect(cfg, timeout=_LOGIN_TIMEOUT_SECS)
    except Exception as exc:  # noqa: BLE001 — 任何失败都只算验证不通过
        logger.info(f"[davmail-reauth] verify login failed: {type(exc).__name__}")
        return False
    try:
        imap.logout()
    except Exception:  # noqa: BLE001
        pass
    return True


def _fail(stage: str, code: str, message: str) -> ReauthResult:
    logger.warning(f"[davmail-reauth] failed stage={stage} code={code}")
    return ReauthResult(ok=False, stage=stage, code=code, message=message)


async def complete_reauth(
    cfg: "Config",
    settings: OAuthSettings,
    callback: str,
    *,
    sync_store: Any,
    exchange: Optional[Callable[[OAuthSettings, str], Awaitable[str]]] = None,
    verify: Optional[Callable[["Config"], bool]] = None,
    restart: Optional[Callable[[], Awaitable[tuple[bool, str]]]] = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> ReauthResult:
    """贴回的回调 → 换 token → 备份并写 token.dat → LOGIN 验证（失败重启 DavMail 再试，仍失败恢复备份）。"""
    # 运行时从模块取默认实现，测试 monkeypatch 模块属性即可替换
    from src.mail import davmail_restart

    exchange = exchange or exchange_code
    verify = verify or verify_login
    restart = restart or davmail_restart.restart_davmail_via_pm2

    try:
        code = parse_callback(callback)
        refresh_token = await exchange(settings, code)
    except ReauthError as err:
        return _fail(err.stage, err.code, err.message)

    encrypted = encrypt_token(refresh_token, settings.password, settings.fingerprint)
    try:
        backup = await asyncio.to_thread(
            write_token_file, settings.token_file, settings.username, encrypted
        )
    except OSError as exc:
        return _fail(
            STAGE_WRITE,
            "E_WRITE_FAILED",
            f"写入 token 文件失败（{type(exc).__name__}），原文件未改动。请检查 {settings.token_file} 的权限。",
        )

    try:
        stored = await asyncio.to_thread(read_token_value, settings.token_file, settings.username)
        readback_ok = stored is not None and (
            decrypt_token(stored, settings.password, settings.fingerprint) == refresh_token
        )
    except (OSError, ValueError):
        readback_ok = False
    if not readback_ok:
        await asyncio.to_thread(restore_token_file, settings.token_file, backup)
        return _fail(STAGE_WRITE, "E_READBACK_MISMATCH", "写入后读回校验不一致，已恢复原来的 token 文件。")

    ok = await asyncio.to_thread(verify, cfg)
    if not ok:
        # 正式 DavMail 每次新连接都重读 token 文件，通常不用重启；LOGIN 仍失败时再重启一次
        restarted, _detail = await restart()
        logger.info(f"[davmail-reauth] verify failed, restart davmail ok={restarted}")
        if restarted:
            for _ in range(_POST_RESTART_ATTEMPTS):
                await sleep(_POST_RESTART_WAIT_SECS)
                ok = await asyncio.to_thread(verify, cfg)
                if ok:
                    break
    if not ok:
        await asyncio.to_thread(restore_token_file, settings.token_file, backup)
        return _fail(
            STAGE_VERIFY,
            "E_VERIFY_FAILED",
            "新的登录信息已写入，但 DavMail 仍然登录失败，已恢复原来的 token 文件。"
            "请确认 DavMail 在运行，然后点「重新获取链接」再试。",
        )

    try:
        await asyncio.to_thread(
            sync_store.set_state, AUTH_LAST_INTERACTIVE_AT_KEY, str(int(time.time()))
        )
    except Exception as exc:  # noqa: BLE001 — 认证已经成功，记录失败只影响到期倒计时
        logger.warning(
            f"[davmail-reauth] record {AUTH_LAST_INTERACTIVE_AT_KEY} failed: {type(exc).__name__}"
        )
    try:
        await asyncio.to_thread(prune_backups, settings.token_file)
    except OSError:
        logger.warning(f"[davmail-reauth] prune backups failed: {settings.token_file.parent}")

    logger.info(f"[davmail-reauth] done stage={STAGE_DONE}")
    return ReauthResult(ok=True, stage=STAGE_DONE, code="OK", message="已恢复，邮件同步会自动继续。")
