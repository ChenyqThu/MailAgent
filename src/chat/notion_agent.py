"""notion-agent 后端 —— Python 复刻 frontend ``chat/backends/notion_agent.ts``。

serve-api ``POST /api/chat/notion-agent`` 在 asyncio 进程内 spawn
``notion-agent chat --stream``（https://github.com/chenyqthu/notion-agent-cli），逐字节复刻
TS 后端语义，输出「语义 event SSE」（每行 ``data: {ChatStreamEvent}``），供远程 UI 进程
（3b-5 的 ``HttpChatPlatform.notionAgentStream`` fetch + parseSse）消费 —— 与 custom-api
后端在 UI 进程产出的 event 同形。

逐一对齐 TS 的硬骨头（设计 §8 风险 / handoff ground truth）：
  - **extractTurn**：history 尾 last user.content 作 prompt；从 assistant 行
    ``metadata.thread_id``（或 legacy ``model='notion-agent:<id>'``）取已有 thread_id（续轮
    ``--thread-id``）。
  - **formatEmailContextHeader**：首轮（无 thread_id）注入 ``[参考邮件] … notion.so/<pageNoDash>``
    让 agent loadPage；续轮跳过（thread_id 带 context）。无 notionPageId 兜底给元数据。
  - **spawn**：``notion-agent chat --stream [--thread-id <id>] [--model <m>]``，prompt 经 stdin
    （防 ARG_MAX / shell 转义）。bin resolve：env ``NOTION_AGENT_BIN`` → PATH → ``~/.local/bin/notion-agent``。
  - **流式**：stdout delta → ``chunk``；UTF-8 跨 chunk 用增量 decoder；尾 trim ``\\n+$``。
  - **thread 探测**：首轮 snapshot ``~/.notionagents/threads/*.json`` before，spawn 后 diff 新增
    （mtime 最新）→ 新 thread_id → metadata；续轮跳过。
  - **串行 gate**（防 trust-rule strict 模式）：见 ``notion_agent_gate.py``。
  - **idle watchdog**：无输出超 ``NOTION_AGENT_IDLE_TIMEOUT_MS``（默认 600s）→ kill →
    ``E_NOTION_AGENT_TIMEOUT``；每 chunk re-arm（用 ``asyncio.wait_for`` 逐读包裹）。
  - **exit 分类**（authoritative，先于 stderr）：75→RATE_LIMIT / 77→AUTH / 127→NOT_INSTALLED /
    其余→stderr 关键词兜底（trust-rule-denied / token_v2 / cloudflare）→FAIL。
  - **safeErrorMessage**：stderr 可能含 token_v2 cookie，分类后返回固定文案，**不把 stderr
    透给 client**（C-04 同纲）。

abort 在 Python 用 **asyncio 任务取消** 表达（对应 TS ``AbortSignal``）：StreamingResponse 的
generator 被取消 / 客户端断连 → ``CancelledError`` / ``GeneratorExit`` 在当前 ``await`` 抛出 →
``finally`` 杀子进程 + 释放 gate（对齐 llm-proxy 的 generator finally 清理纪律）。
"""

from __future__ import annotations

import asyncio
import codecs
import json
import os
import re
import shutil
import time
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Set, Tuple

from src.chat.notion_agent_gate import NotionAgentSerialGate, notion_agent_gate

# CLI 持久化每 thread 状态文件（一个 ``<thread_id>.json`` per thread）。镜像 CLI 默认账户目录；
# 不传 ``--account`` → 默认生效。模块级常量，测试可 monkeypatch 重定向到 tmp。
THREADS_DIR = os.path.join(os.path.expanduser("~"), ".notionagents", "threads")

# idle（无输出）看门狗默认窗口。非总 wall-clock 上限 —— 每个 stdout chunk re-arm，健康长流不
# 触发；仅 stalled/hung 进程（整窗无输出）触发。覆盖 NOTION_AGENT_IDLE_TIMEOUT_MS（ms）。
_DEFAULT_IDLE_TIMEOUT_MS = 600_000.0

_bin_cache: Optional[str] = None


# ── 二进制解析（env → PATH → pipx 默认）────────────────────────────────────


def resolve_notion_agent_bin() -> str:
    """解析 ``notion-agent`` 二进制并缓存。搜索序：

    1. ``$NOTION_AGENT_BIN``（全路径，ops 逃生口）
    2. ``which notion-agent``（PATH；pipx ``ensurepath`` 后默认命中）
    3. ``~/.local/bin/notion-agent``（pipx 装但未 PATH 集成）
    """
    global _bin_cache
    if _bin_cache:
        return _bin_cache
    from_env = os.environ.get("NOTION_AGENT_BIN")
    if from_env and os.path.exists(from_env):
        _bin_cache = from_env
        return from_env
    resolved = shutil.which("notion-agent")
    if resolved:
        _bin_cache = resolved
        return resolved
    fallback = os.path.join(os.path.expanduser("~"), ".local", "bin", "notion-agent")
    _bin_cache = fallback
    return fallback


def _reset_bin_cache() -> None:
    """test-only —— 清二进制路径缓存，让测试切换 env。"""
    global _bin_cache
    _bin_cache = None


# ── thread 探测（snapshot before / diff after）────────────────────────────


def snapshot_thread_files() -> Set[str]:
    """首轮前 snapshot ``<thread_id>.json`` 文件名集合供事后 diff。目录缺失 → 空集。"""
    try:
        return {f for f in os.listdir(THREADS_DIR) if f.endswith(".json")}
    except OSError:
        return set()


def detect_new_thread_id(before: Set[str]) -> Optional[str]:
    """首轮后找 CLI 刚写的 thread 状态文件（after 有、before 无）。多个新增（罕见并发首轮）→
    mtime 最新者胜。返回裸 thread_id（去 ``.json``）或 None。"""
    try:
        fresh = [
            f
            for f in os.listdir(THREADS_DIR)
            if f.endswith(".json") and f not in before
        ]
    except OSError:
        return None
    if not fresh:
        return None

    def _mtime(name: str) -> float:
        try:
            return os.stat(os.path.join(THREADS_DIR, name)).st_mtime
        except OSError:
            return 0.0

    newest = max(fresh, key=_mtime)
    return re.sub(r"\.json$", "", newest)


# ── prompt / thread_id 抽取 + email context header ─────────────────────────


def format_email_context_header(ctx: Optional[Dict[str, Any]]) -> str:
    """首轮注入的邮件引用 header（逐字节对齐 TS ``formatEmailContextHeader``）。

    有 notionPageId → 给 Notion 页 URL 让 agent 自己 loadPage 索引正文/附件/线程（省 token）。
    无 notionPageId（罕见未同步邮件）→ 给最小元数据（不含正文）。``None`` → ``''``。
    """
    if not ctx:
        return ""
    notion_page_id = ctx.get("notionPageId")
    if notion_page_id:
        page_no_dash = str(notion_page_id).replace("-", "")
        return "\n".join(
            [
                "[参考邮件] 我正在看下面这封邮件(已同步到 Notion)。回答前请读取该页面，",
                "获取它的主题 / 正文 / 附件 / 线程等完整内容，并据此检索关联信息：",
                f"https://www.notion.so/{page_no_dash}",
                "",
                "",
            ]
        )
    lines: List[str] = ["[参考邮件] 当前邮件未同步到 Notion, 仅提供元数据:"]
    lines.append(f"internal_id: {ctx.get('internalId')}")
    subject = ctx.get("subject")
    if subject:
        lines.append(f"主题: {subject}")
    sender_name = ctx.get("senderName")
    sender_addr = ctx.get("senderAddr")
    if sender_name or sender_addr:
        name = sender_name or ""
        addr = sender_addr or ""
        joiner = " " if (name and addr) else ""
        addr_part = f"<{addr}>" if addr else ""
        lines.append(f"发件人: {name}{joiner}{addr_part}".strip())
    date_iso = ctx.get("dateIso")
    if date_iso:
        lines.append(f"日期: {date_iso}")
    lines.append("")
    lines.append("")
    return "\n".join(lines)


def extract_turn(req: Dict[str, Any]) -> Tuple[str, Optional[str]]:
    """抽取本轮 user 消息 + 已有 thread_id（喂回 notion-agent ``--thread-id``）。

    prompt = history 尾最近 user.content（之前的历史 notion-agent 已经 server-side 经
    ``--thread-id`` 知道）。thread_id 从最近 assistant 行的结构化 ``metadata.thread_id`` 取；
    v1 行写成 ``model='notion-agent:<id>'`` 前缀 —— 两者都读，metadata 优先。
    """
    history: List[Dict[str, Any]] = req.get("history") or []
    prompt = ""
    for m in reversed(history):
        if m.get("role") == "user":
            prompt = m.get("content") or ""
            break

    thread_id: Optional[str] = None
    for m in reversed(history):
        if m.get("role") != "assistant":
            continue
        meta_raw = m.get("metadata")
        if meta_raw:
            try:
                meta = json.loads(meta_raw)
                v = meta.get("thread_id") if isinstance(meta, dict) else None
                if isinstance(v, str) and len(v) > 0:
                    thread_id = v
                    break
            except (ValueError, TypeError):
                # metadata 损坏 —— 忽略，下方试老格式。
                pass
        model = m.get("model")
        if isinstance(model, str) and model.startswith("notion-agent:"):
            thread_id = model[len("notion-agent:") :]
            break
    return prompt, thread_id


# ── exit 分类 + 安全错误文案 ────────────────────────────────────────────────


def classify_exit(exit_code: Optional[int], stderr: str) -> str:
    """exit code → E_* 事件码。CLI ≥0.1.11 的结构化 exit code authoritative（先于 stderr）。

    75 → trust-rule rate limit（反自动化守卫；retry_after≈300s，isRetryable:false → 必退避不 retry）
    77 → auth/credential 失效（重跑 ``notion-agent init``）
    127 → PATH 上找不到二进制
    其余 → <0.1.11 fallback + 防御：唯一信号是人读 stderr 行（trust-rule-denied / token_v2 /
    cloudflare 子串）。
    """
    if exit_code == 75:
        return "E_NOTION_AGENT_RATE_LIMIT"
    if exit_code == 77:
        return "E_NOTION_AGENT_AUTH"
    if exit_code == 127:
        return "E_NOTION_AGENT_NOT_INSTALLED"

    haystack = stderr.lower()
    if "trust-rule-denied" in haystack or "trust_rule" in haystack:
        return "E_NOTION_AGENT_RATE_LIMIT"
    if "token_v2" in haystack or "unauthorized" in haystack:
        return "E_NOTION_AGENT_AUTH"
    if "cloudflare" in haystack or "network" in haystack:
        return "E_NOTION_AGENT_NETWORK"
    return "E_NOTION_AGENT_FAIL"


def safe_error_message(code: str, exit_code: Optional[int]) -> str:
    """分类码 → renderer 安全文案。raw stderr 只留 serve-api 日志；client 只见通用措辞，
    故印进 stderr 的 token_v2 cookie 永不越界（C-04 同纲）。"""
    if code == "E_NOTION_AGENT_AUTH":
        return "notion-agent authentication failed — re-run `notion-agent init`"
    if code == "E_NOTION_AGENT_RATE_LIMIT":
        return (
            "notion-agent rate-limited by Notion anti-automation (trust-rule) — "
            "backing off ~5min"
        )
    if code == "E_NOTION_AGENT_NETWORK":
        return "notion-agent network error — check connection / Cloudflare"
    if code == "E_NOTION_AGENT_NOT_INSTALLED":
        return "notion-agent CLI not found on PATH"
    return f"notion-agent exited with code {exit_code if exit_code is not None else '?'}"


def _idle_timeout_ms() -> float:
    raw = os.environ.get("NOTION_AGENT_IDLE_TIMEOUT_MS")
    if raw is not None:
        try:
            parsed = int(raw)
            if parsed > 0:
                return float(parsed)
        except ValueError:
            pass
    return _DEFAULT_IDLE_TIMEOUT_MS


# ── 语义 event SSE 序列化 ───────────────────────────────────────────────────


def sse_encode(event: Dict[str, Any]) -> bytes:
    """event dict → SSE 行 ``data: {json}\\n\\n``（UTF-8）。

    键名 camelCase（durationMs/finalContent/inputTokens…）—— 历史上对齐 `shared/chat/
    types.ts` 的 `ChatStreamEvent`（S3 已随 harness 引擎整体删除该文件，此流式端点现无
    前端调用方；notion-agent 会话现只经非流式 `/notion-agent-once` 或历史行只读回放，
    见 remote-chat-report-architecture.md §6）。``ensure_ascii=False`` 保 CJK 可读（UTF-8
    编码）。
    """
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")


# ── 子进程适配（生产用 asyncio subprocess；测试注入 fake）──────────────────


class _SubprocessHandle:
    """把 asyncio subprocess 适配 ``run_notion_agent`` 期望的接口
    （``read_chunk`` / ``wait`` / ``read_stderr`` / ``kill``）。

    stderr **后台 drain**（避免 stderr pipe 撑爆死锁，镜像 execa ``buffer:{stderr:true}``）；
    stdin **不 drain 直接 write+close**（StreamWriter 内存缓冲，随 stdout 被读时由事件循环 flush，
    不会因大 prompt + CLI 先写 stdout 而死锁）。
    """

    def __init__(self, proc: "asyncio.subprocess.Process") -> None:
        self._proc = proc
        self._stderr_buf = b""
        self._stderr_task: asyncio.Future = asyncio.ensure_future(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        if self._proc.stderr is None:
            return
        try:
            self._stderr_buf = await self._proc.stderr.read()
        except Exception:
            # 进程被 kill / 读中断 —— 保留已读部分（best-effort）。CancelledError 不吞，让取消传播。
            pass

    async def read_chunk(self) -> bytes:
        if self._proc.stdout is None:
            return b""
        return await self._proc.stdout.read(4096)

    async def wait(self) -> Optional[int]:
        return await self._proc.wait()

    async def read_stderr(self) -> str:
        if not self._stderr_task.done():
            try:
                await self._stderr_task
            except Exception:
                pass
        return self._stderr_buf.decode("utf-8", errors="replace")

    def kill(self) -> None:
        if self._proc.returncode is None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
        if not self._stderr_task.done():
            self._stderr_task.cancel()


async def _default_spawn(bin_path: str, args: List[str], stdin_data: bytes) -> _SubprocessHandle:
    proc = await asyncio.create_subprocess_exec(
        bin_path,
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    if proc.stdin is not None:
        try:
            # write+close 不 drain：StreamWriter 内存缓冲，随读 stdout 由事件循环 flush，避免死锁。
            proc.stdin.write(stdin_data)
            proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
    return _SubprocessHandle(proc)


# 注入点：生产 = _default_spawn / module gate；测试传 fake spawn + 独立 gate。
SpawnFn = Callable[[str, List[str], bytes], "Any"]


def _tool_call_event(
    tool_args: Dict[str, Any],
    status: str,
    *,
    duration_ms: Optional[int] = None,
    detail: Optional[str] = None,
) -> Dict[str, Any]:
    ev: Dict[str, Any] = {
        "type": "tool_call",
        "name": "notion-agent chat",
        "args": tool_args,
        "status": status,
    }
    if duration_ms is not None:
        ev["durationMs"] = duration_ms
    if detail is not None:
        ev["detail"] = detail
    return ev


async def run_notion_agent(
    req: Dict[str, Any],
    *,
    spawn: Optional[SpawnFn] = None,
    gate: Optional[NotionAgentSerialGate] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """复刻 TS ``runNotionAgent``：yield 语义 event dict（端点经 ``sse_encode`` 转 SSE）。

    ``spawn`` / ``gate`` 注入供测试（默认 = ``_default_spawn`` + 模块单例 gate）。
    """
    spawn = spawn or _default_spawn
    gate = gate or notion_agent_gate

    prompt, thread_id = extract_turn(req)
    if not prompt:
        yield {
            "type": "error",
            "code": "E_INVALID_ARG",
            "message": "notion-agent backend: history has no user message to answer",
        }
        return

    # 首轮（无 thread_id）前置 email context header 让 agent 看到正文；续轮跳过（thread_id
    # 已 server-side 带 context，重发只白吃 token）。
    ctx_header = "" if thread_id else format_email_context_header(req.get("emailContext"))
    enriched_prompt = f"{ctx_header}我的问题：\n{prompt}" if ctx_header else prompt

    model = req.get("model")
    bin_path = resolve_notion_agent_bin()
    args: List[str] = ["chat", "--stream"]
    if thread_id:
        args += ["--thread-id", thread_id]
    if model:
        args += ["--model", model]
    # prompt 经 stdin（无 positional arg）—— 长邮件正文不进 argv（ARG_MAX）+ 免 shell 转义。

    tool_args = {"threadId": thread_id, "model": model}
    start = time.monotonic()
    yield _tool_call_event(tool_args, "running")

    # 串行 gate（预防层）：阻塞直到无其他 notion-agent 子进程在跑 AND min-interval 已过。
    # 等待期间被取消 → CancelledError 传播（从未持有 gate，无需 release）。
    release = await gate.acquire()

    decoder = codecs.getincrementaldecoder("utf-8")()
    accumulated = ""
    idle_s = _idle_timeout_ms() / 1000.0
    idle_timed_out = False
    proc: Optional[Any] = None
    try:
        # 首轮才 snapshot（此刻至多一个 notion-agent 在跑，事后 diff 无歧义）。续轮已知 thread_id。
        before = None if thread_id else snapshot_thread_files()

        proc = await spawn(bin_path, args, enriched_prompt.encode("utf-8"))

        # idle 看门狗：逐读包 wait_for(idle_s)，每个 chunk 自然 re-arm；整窗无输出 → kill + 超时。
        while True:
            try:
                chunk = await asyncio.wait_for(proc.read_chunk(), timeout=idle_s)
            except asyncio.TimeoutError:
                idle_timed_out = True
                proc.kill()
                break
            if not chunk:
                break  # EOF
            delta = decoder.decode(chunk)
            if delta:
                accumulated += delta
                yield {"type": "chunk", "delta": delta}
        tail = decoder.decode(b"", final=True)
        if tail and not idle_timed_out:
            accumulated += tail
            yield {"type": "chunk", "delta": tail}

        # 等进程退出 —— 仍受 idle 看门狗覆盖（镜像 TS：idle timer 持续 armed 到 ``await child``
        # 之后才 disarm，notion_agent.ts:339-340）。stdout EOF 但进程 hang 在 cleanup / 网络等待 /
        # 只留 stderr 不退 → 仍 kill + 报超时；否则一个卡住的 notion-agent 会永久 wedge 串行 gate，
        # 阻死后续所有 /api/chat/notion-agent 调用（codex review HIGH）。
        if idle_timed_out:
            # 读阶段看门狗已 kill —— reap 子进程（SIGKILL 后即退）。
            exit_code = await proc.wait()
        else:
            try:
                exit_code = await asyncio.wait_for(proc.wait(), timeout=idle_s)
            except asyncio.TimeoutError:
                idle_timed_out = True
                proc.kill()
                exit_code = await proc.wait()  # 已 kill → 即退
        stderr_text = await proc.read_stderr()

        # idle 看门狗触发（读阶段整窗无输出 / EOF 后 wait 阶段 hang）→ 报超时。先于 exit_code
        # 判（看门狗已 kill 子进程）。
        if idle_timed_out:
            idle_sec = round(idle_s)
            yield _tool_call_event(
                tool_args,
                "error",
                duration_ms=_ms_since(start),
                detail=f"no output for {idle_sec}s",
            )
            yield {
                "type": "error",
                "code": "E_NOTION_AGENT_TIMEOUT",
                "message": "notion-agent idle timeout (no output)",
            }
            return

        if exit_code != 0:
            # exit≠0：先 classify（exit code authoritative），再返回固定安全文案 —— stderr 里
            # 可能印的 token_v2 cookie 不越界 client（C-04）。raw stderr 留 serve-api 日志。
            code = classify_exit(exit_code, stderr_text)
            safe = safe_error_message(code, exit_code)
            yield _tool_call_event(
                tool_args, "error", duration_ms=_ms_since(start), detail=safe
            )
            yield {"type": "error", "code": code, "message": safe}
            return

        # exit 0 — finalize。trim 尾部换行（``--stream`` 末尾有裸 print 行终止符）。
        text = re.sub(r"\n+$", "", accumulated)
        new_thread_id = thread_id or detect_new_thread_id(before or set())
        metadata: Optional[Dict[str, Any]] = (
            {"thread_id": new_thread_id} if new_thread_id else None
        )

        yield _tool_call_event(
            tool_args,
            "ok",
            duration_ms=_ms_since(start),
            detail=(f"thread={new_thread_id[:8]}" if new_thread_id else None),
        )
        # ``--stream`` 不报 token 数；给 0 让成本核算层 shape 统一。metadata 携 thread_id。
        yield {
            "type": "usage",
            "inputTokens": 0,
            "outputTokens": 0,
            "costUsd": None,
            "model": model,
            "metadata": metadata,
        }
        yield {
            "type": "done",
            "finalContent": text,
            "model": model,
            "metadata": metadata,
        }
    except asyncio.CancelledError:
        # 客户端断连 / abort —— 静默（无 done/usage），finally 清理。
        raise
    except Exception as exc:  # noqa: BLE001 — 兜底未分类失败 → FAIL（对齐 TS catch）。
        message = str(exc)
        yield _tool_call_event(
            tool_args, "error", duration_ms=_ms_since(start), detail=message
        )
        yield {"type": "error", "code": "E_NOTION_AGENT_FAIL", "message": message}
    finally:
        # 每条退出路径都释放 gate + 杀子进程（normal done / error / timeout / 取消 / 异常 /
        # 消费方提前 break）。否则崩/取消的调用会把 gate wedge 死。两者均幂等。
        if proc is not None:
            proc.kill()
        release()


def _ms_since(start: float) -> int:
    return round((time.monotonic() - start) * 1000)
