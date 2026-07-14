"""
飞书告警通知模块

通过飞书群聊 Webhook 机器人发送告警卡片消息。
支持不同告警级别、冷却去重、可配置规则。

告警级别：
- critical (红色): 服务崩溃、健康检查失败、服务停止
- error (橙色): 同步失败、API 错误、连续错误
- warning (黄色): 重试失败、组件降级、dead_letter 累积
- info (蓝色): 服务启动、里程碑、恢复通知
"""

import hashlib
import hmac
import base64
import time
from datetime import datetime
from typing import Dict, Optional

import aiohttp
from loguru import logger


# 告警级别配置：颜色模板 + 图标
LEVEL_CONFIG = {
    "critical": {"template": "red", "icon": "🔴", "title": "严重告警"},
    "error": {"template": "orange", "icon": "🟠", "title": "错误告警"},
    "warning": {"template": "yellow", "icon": "🟡", "title": "警告"},
    "info": {"template": "blue", "icon": "🔵", "title": "通知"},
}


class FeishuAlertNotifier:
    """飞书告警通知器"""

    def __init__(
        self,
        webhook_url: str,
        secret: str = "",
        enabled_levels: str = "critical,error,warning",
        cooldown: int = 300,
    ):
        self.webhook_url = webhook_url
        self.secret = secret
        self.enabled_levels = set(
            l.strip() for l in enabled_levels.split(",") if l.strip()
        )
        self.cooldown = cooldown
        self._session: Optional[aiohttp.ClientSession] = None
        # 冷却记录: {alert_key: last_sent_timestamp}
        self._cooldown_map: Dict[str, float] = {}
        # 统计
        self._stats = {"sent": 0, "suppressed": 0, "failed": 0}

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            # trust_env=True → 尊重 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/NO_PROXY
            # (主机网络对飞书 webhook 的 TLS 被 reset 时可经环境代理出网);
            # 无 proxy 环境变量时行为与裸 ClientSession() 完全一致。
            self._session = aiohttp.ClientSession(trust_env=True)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    def _is_cooled_down(self, alert_key: str) -> bool:
        """检查告警是否在冷却期内"""
        last_sent = self._cooldown_map.get(alert_key, 0)
        if time.time() - last_sent < self.cooldown:
            self._stats["suppressed"] += 1
            return True
        return False

    def _mark_sent(self, alert_key: str):
        self._cooldown_map[alert_key] = time.time()
        # 清理过期的冷却记录
        now = time.time()
        self._cooldown_map = {
            k: v for k, v in self._cooldown_map.items()
            if now - v < self.cooldown * 2
        }

    async def send_alert(
        self,
        level: str,
        title: str,
        content: str,
        source: str = "MailAgent",
        details: Optional[Dict] = None,
        alert_key: str = "",
    ) -> bool:
        """发送告警

        Args:
            level: 告警级别 (critical/error/warning/info)
            title: 告警标题
            content: 告警内容
            source: 告警来源模块
            details: 额外详情（key-value 展示）
            alert_key: 去重键（相同 key 在冷却期内不重复发送），为空则用 level+title 生成
        """
        if not self.webhook_url:
            return False

        if level not in self.enabled_levels:
            return False

        # 冷却去重
        if not alert_key:
            alert_key = f"{level}:{title}"
        if self._is_cooled_down(alert_key):
            logger.debug(f"Alert suppressed (cooldown): [{level}] {title}")
            return False

        card = self._build_card(level, title, content, source, details)
        success = await self._send(card)
        if success:
            self._mark_sent(alert_key)
            self._stats["sent"] += 1
            logger.info(f"Alert sent: [{level}] {title}")
        else:
            self._stats["failed"] += 1

        return success

    def _build_card(
        self,
        level: str,
        title: str,
        content: str,
        source: str,
        details: Optional[Dict] = None,
    ) -> Dict:
        lc = LEVEL_CONFIG.get(level, LEVEL_CONFIG["info"])
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        elements = []

        # 告警内容
        elements.append({
            "tag": "markdown",
            "content": content,
        })

        # 详情字段（key-value 网格）
        if details:
            columns = []
            items = list(details.items())
            for i in range(0, len(items), 2):
                row_cols = []
                for k, v in items[i:i + 2]:
                    row_cols.append({
                        "tag": "column",
                        "width": "weighted",
                        "weight": 1,
                        "elements": [{"tag": "markdown", "content": f"**{k}**\n{v}"}],
                    })
                # 填充单数列
                if len(row_cols) == 1:
                    row_cols.append({
                        "tag": "column",
                        "width": "weighted",
                        "weight": 1,
                        "elements": [{"tag": "markdown", "content": " "}],
                    })
                elements.append({
                    "tag": "column_set",
                    "flex_mode": "bisect",
                    "background_style": "grey",
                    "columns": row_cols,
                })

        elements.append({"tag": "hr"})

        # 底部信息行
        elements.append({
            "tag": "markdown",
            "content": f"**来源**: {source}  |  **时间**: {now_str}",
        })

        return {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {
                    "content": f"{lc['icon']} {lc['title']} | {title}",
                    "tag": "plain_text",
                },
                "template": lc["template"],
            },
            "elements": elements,
        }

    async def _send(self, card: Dict) -> bool:

        payload: Dict = {"msg_type": "interactive", "card": card}

        if self.secret:
            timestamp = int(time.time())
            string_to_sign = f"{timestamp}\n{self.secret}"
            hmac_code = hmac.new(
                string_to_sign.encode("utf-8"), digestmod=hashlib.sha256
            ).digest()
            payload["timestamp"] = str(timestamp)
            payload["sign"] = base64.b64encode(hmac_code).decode("utf-8")

        try:
            session = await self._get_session()
            async with session.post(
                self.webhook_url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    if result.get("code") == 0:
                        return True
                    logger.error(f"Alert webhook error: {result}")
                else:
                    logger.error(f"Alert webhook HTTP {resp.status}")
                return False
        except Exception as e:
            logger.error(f"Alert send failed: {e}")
            return False

    def get_stats(self) -> Dict:
        return dict(self._stats)

    # ── 预定义告警快捷方法 ──

    async def alert_service_started(self, mailboxes: list, poll_interval: int):
        """服务启动通知"""
        await self.send_alert(
            level="info",
            title="服务已启动",
            content="MailAgent 邮件同步服务已启动运行。",
            source="main",
            details={
                "监听邮箱": ", ".join(mailboxes),
                "轮询间隔": f"{poll_interval}s",
                "启动时间": datetime.now().strftime("%H:%M:%S"),
            },
            alert_key="service_started",
        )

    async def alert_service_stopped(self, reason: str = "正常关闭"):
        """服务停止告警"""
        await self.send_alert(
            level="warning",
            title="服务已停止",
            content=f"MailAgent 服务已停止。\n**原因**: {reason}",
            source="main",
            alert_key="service_stopped",
        )

    async def alert_service_unhealthy(self, consecutive_errors: int):
        """服务不健康告警"""
        await self.send_alert(
            level="critical",
            title="服务健康检查失败",
            content=f"连续 **{consecutive_errors}** 次错误，服务已停止运行。\n请检查 Mail.app 和系统权限。",
            source="new_watcher",
            details={
                "连续错误数": str(consecutive_errors),
                "建议操作": "检查 pm2 logs / 重启服务",
            },
        )

    async def alert_consecutive_errors(self, count: int, last_error: str):
        """连续错误告警"""
        await self.send_alert(
            level="error",
            title=f"连续错误 ({count} 次)",
            content=f"轮询周期连续出错 **{count}** 次。\n**最近错误**: {last_error[:200]}",
            source="new_watcher",
            alert_key="consecutive_errors",
        )

    async def alert_dead_letters(self, count: int, threshold: int):
        """dead_letter 累积告警"""
        await self.send_alert(
            level="warning",
            title=f"死信队列累积 ({count} 封)",
            content=f"有 **{count}** 封邮件超过最大重试次数进入死信队列（阈值: {threshold}）。\n需要人工排查处理。",
            source="sync_store",
            details={
                "死信数量": str(count),
                "告警阈值": str(threshold),
                "排查命令": '`sqlite3 data/sync_store.db "SELECT * FROM email_metadata WHERE sync_status=\'dead_letter\'"`',
            },
            alert_key="dead_letters",
        )

    async def alert_sync_error(self, internal_id: int, subject: str, error: str):
        """同步失败告警"""
        await self.send_alert(
            level="error",
            title="邮件同步失败",
            content=f"邮件同步到 Notion 失败。\n**邮件**: {subject[:60]}\n**错误**: {error[:200]}",
            source="new_watcher",
            details={
                "Internal ID": str(internal_id),
                "主题": subject[:40],
            },
            alert_key=f"sync_error:{internal_id}",
        )

    async def alert_redis_disconnected(self, error: str):
        """Redis 断连告警"""
        await self.send_alert(
            level="error",
            title="Redis 连接断开",
            content=f"Redis 事件消费连接断开，将自动重连。\n**错误**: {error[:200]}",
            source="redis_consumer",
            alert_key="redis_disconnected",
        )

    async def alert_radar_unavailable(self):
        """SQLite 雷达不可用告警"""
        await self.send_alert(
            level="warning",
            title="SQLite 雷达不可用",
            content="SQLite 雷达组件不可用，新邮件检测降级。\n请检查 Full Disk Access 权限。",
            source="sqlite_radar",
            alert_key="radar_unavailable",
        )

    async def alert_notion_api_error(self, operation: str, error: str):
        """Notion API 错误告警"""
        await self.send_alert(
            level="error",
            title="Notion API 错误",
            content=f"Notion API 调用失败。\n**操作**: {operation}\n**错误**: {error[:200]}",
            source="notion",
            alert_key=f"notion_error:{operation}",
        )

    async def alert_recovery(self, component: str):
        """恢复通知"""
        await self.send_alert(
            level="info",
            title=f"{component} 已恢复",
            content=f"**{component}** 已恢复正常运行。",
            source=component.lower(),
            alert_key=f"recovery:{component}",
        )

    # ── E4 WP1/WP2: worker 监督 + 服务级告警 ──────────────────────────

    async def alert_worker_crashed(self, name: str, error: str, crash_count: int = 1):
        """worker 协程非预期死亡 (supervise 捕获, 即将退避重启)"""
        await self.send_alert(
            level="error",
            title=f"Worker 异常退出: {name}",
            content=(
                f"worker **{name}** 非预期死亡 (连续第 {crash_count} 次), "
                "supervise 将按退避表自动重启。\n"
                f"**错误**: {error[:300]}"
            ),
            source="supervise",
            details={
                "Worker": name,
                "连续 crash": str(crash_count),
                "排查命令": "`pm2 logs mail-sync --lines 50`",
            },
            alert_key=f"worker_crashed:{name}",
        )

    async def alert_worker_crashloop_stopped(self, name: str, crash_count: int):
        """worker 连续 crash-loop, supervise 已停止重启 (功能停摆直到服务重启)"""
        await self.send_alert(
            level="critical",
            title=f"Worker crash-loop 停摆: {name}",
            content=(
                f"worker **{name}** 连续 **{crash_count}** 次快速崩溃, "
                "supervise 已停止重启 —— 该功能停摆, 其余 worker 不受影响。\n"
                "**恢复**: 排查根因后 `pm2 restart mail-sync` (或重启 App)。"
            ),
            source="supervise",
            details={
                "Worker": name,
                "连续 crash": str(crash_count),
                "状态键": f"`worker.{name}.status=crashloop_stopped`",
            },
            alert_key=f"worker_crashloop_stopped:{name}",
        )

    async def alert_outbox_backlog(self, aged_pending: int, threshold: int):
        """outbox 积压 — 行龄 ≥5min 的 pending 超阈值 (FanoutWorker 可能卡死/落后)"""
        await self.send_alert(
            level="warning",
            title=f"Outbox 积压 ({aged_pending} 条 ≥5min 未派发)",
            content=(
                f"email_outbox 中行龄 ≥5min 仍为 pending 的条目达 **{aged_pending}** "
                f"条 (阈值: {threshold})。FanoutWorker 可能卡死或严重落后。\n"
                "**排查**: `mailagent admin stats --section outbox` + "
                "`pm2 logs mail-sync | grep fanout-worker`。"
            ),
            source="outbox",
            details={
                "积压条数 (≥5min)": str(aged_pending),
                "告警阈值": str(threshold),
            },
            alert_key="outbox_backlog",
        )

    async def alert_restart_frequency(self, count_24h: int, threshold: int):
        """mail-sync 重启频次异常 — 24h 内启动次数超阈值 (crash-loop / 反复被杀)"""
        await self.send_alert(
            level="warning",
            title=f"服务重启频繁 (24h 内 {count_24h} 次)",
            content=(
                f"mail-sync 最近 24h 内启动了 **{count_24h}** 次 (阈值: {threshold})。"
                "可能是进程级 crash-loop / OOM / 外部反复重启。\n"
                "**排查**: `pm2 logs mail-sync --lines 100` + 系统日志。"
            ),
            source="main",
            details={
                "24h 启动次数": str(count_24h),
                "告警阈值": str(threshold),
            },
            alert_key="restart_frequency",
        )

    # ── DavMail backend 健康告警 (roadmap §4.5.1 + §4.5.2 + §4.5.3) ─────

    async def alert_davmail_token_expiring(self, age_days: float):
        """DavMail OAuth refresh_token 接近过期 (≥80 天没 refresh)"""
        days_left = max(0.0, 90.0 - age_days)
        await self.send_alert(
            level="warning",
            title="DavMail OAuth token 即将过期",
            content=(
                f"davmail-poc/token/token.dat 已 **{age_days:.1f} 天**没刷新。"
                f"refresh_token 90 天有效期，预计剩余 **~{days_left:.0f} 天**。\n"
                "**建议**: 检查 davmail-poc 是否正常 refresh；接近 90 天需手动"
                "重走 O365Manual OAuth flow。"
            ),
            source="davmail_watchdog",
            details={
                "Token age": f"{age_days:.1f} 天",
                "估剩余": f"{days_left:.0f} 天",
                "排查命令": "`pm2 logs davmail-poc --lines 50`",
            },
            alert_key="davmail_token_expiring",
        )

    async def alert_davmail_token_critical(self, age_days: float):
        """DavMail OAuth refresh_token 极接近过期 (≥87 天)"""
        days_left = max(0.0, 90.0 - age_days)
        await self.send_alert(
            level="critical",
            title="DavMail OAuth token 即将失效（紧急）",
            content=(
                f"token.dat 已 **{age_days:.1f} 天**没刷新，预计剩余 "
                f"**~{days_left:.0f} 天**就要失效。\n"
                "**立即操作**: 重走 O365Manual OAuth flow，否则 IMAP/SMTP "
                "将停止工作，必须回切 applescript backend。"
            ),
            source="davmail_watchdog",
            details={
                "Token age": f"{age_days:.1f} 天",
                "估剩余": f"{days_left:.0f} 天",
                "回切命令": '`echo "MAILAGENT_BACKEND=applescript" >> .env && pm2 restart mail-sync`',
            },
            alert_key="davmail_token_critical",
        )

    async def alert_davmail_oauth_failure(self, log_excerpt: str):
        """davmail.log 出现 BadPaddingException / refresh_token expired 类错误"""
        await self.send_alert(
            level="critical",
            title="DavMail OAuth 续期失败",
            content=(
                "davmail-poc 日志检测到 OAuth 错误，refresh_token 可能已失效。\n"
                f"**日志行**: `{log_excerpt[:200]}`\n"
                "**立即操作**: 重走 O365Manual OAuth flow 或回切 applescript backend。"
            ),
            source="davmail_watchdog",
            details={
                "Token 路径": "davmail-poc/token/token.dat",
                "排查命令": "`tail -50 davmail-poc/logs/davmail.log`",
            },
            alert_key="davmail_oauth_failure",
        )

    async def alert_davmail_process_down(
        self, consecutive_fails: int, port: int, proto: str = "IMAP"
    ):
        """davmail-poc 进程死亡 — TCP probe 连续失败 ≥3 次"""
        await self.send_alert(
            level="critical",
            title=f"DavMail {proto} 端口不可达",
            content=(
                f"davmail-poc {proto} 端口 **{port}** 已连续 **{consecutive_fails}** "
                "次 TCP probe 失败（≥3min）。进程可能已死亡。\n"
                "**立即操作**: `pm2 status davmail-poc` + `pm2 restart davmail-poc`。"
            ),
            source="davmail_watchdog",
            details={
                "端口": str(port),
                "协议": proto,
                "连续失败": str(consecutive_fails),
                "重启命令": "`pm2 restart davmail-poc`",
            },
            alert_key=f"davmail_process_down:{proto}",
        )

    async def alert_davmail_process_recovered(self, proto: str = "IMAP"):
        """davmail-poc 进程恢复"""
        await self.send_alert(
            level="info",
            title=f"DavMail {proto} 已恢复",
            content=f"davmail-poc {proto} 端口已恢复响应。",
            source="davmail_watchdog",
            alert_key=f"davmail_process_recovered:{proto}",
        )

    async def alert_davmail_login_degraded(
        self, consecutive_fails: int, threshold: int
    ):
        """IMAP LOGIN 持续失败 (TCP 可达) — token 劣化「能发不能收」(L2a)"""
        await self.send_alert(
            level="critical",
            title="DavMail IMAP LOGIN 持续失败（token 劣化）",
            content=(
                f"IMAP 端口 TCP 可达但 LOGIN 已连续 **{consecutive_fails}** 次失败"
                f"（阈值 {threshold}）。SMTP 可能仍正常 ——「能发不能收」，疑似 "
                "DavMail 内部 token 状态劣化（如 AADSTS700003 / JVM 长跑劣化）。\n"
                "**建议操作**: `pm2 restart davmail-poc`；重启后仍失败则重走 "
                "O365Manual OAuth flow。"
            ),
            source="davmail_watchdog",
            details={
                "连续失败": str(consecutive_fails),
                "阈值": str(threshold),
                "重启命令": "`pm2 restart davmail-poc`",
            },
            alert_key="davmail_login_degraded",
        )

    async def alert_davmail_login_recovered(self):
        """IMAP LOGIN 恢复 (L2a)"""
        await self.send_alert(
            level="info",
            title="DavMail IMAP LOGIN 已恢复",
            content="IMAP LOGIN 探测恢复成功，token 劣化状态解除。",
            source="davmail_watchdog",
            alert_key="davmail_login_recovered",
        )

    async def alert_davmail_ews_throttling(self, count: int):
        """EWS throttling burst — 5min 内 ≥3 次 EWSThrottlingException"""
        await self.send_alert(
            level="warning",
            title="DavMail EWS throttling 触发",
            content=(
                f"davmail.log 5min 内 EWS throttle 事件 **{count}** 次。"
                "已自动暂停 uid-mapper backfill（写 "
                "`sync_state['davmail_uid_backfill_paused']=true`）。\n"
                "**自动恢复**: 5-30min 后 throttle 解除，watchdog 自动 resume。"
            ),
            source="davmail_watchdog",
            details={
                "事件数 (5min)": str(count),
                "暂停标记": "`davmail_uid_backfill_paused=true`",
                "解除方法": "等 throttle 自然解除 / 手动 `set_state('davmail_uid_backfill_paused','false')`",
            },
            alert_key="davmail_ews_throttling",
        )
