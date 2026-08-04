"""建连前置检查 —— 多实例互斥（08-01 阶段 2 PR-2）。

**为什么必须有**：飞书长连接**不广播** —— 同一个自建应用同时有多个客户端连着时，
一条消息只会**随机**投给其中一个（C6 README §6②）。而仓库里 pm2 的 ``mail-sync``
与打包 ``.app`` 同跑今天**既不会被阻止也不会报错**，只会静默双跑
（dossier Q1：孤儿清扫刻意放过 pm2；SSE 端口冲突只 warning）。两者都开着 IM 时，
owner 在飞书里说的话会被随机一个进程吃掉 —— 表现为「时灵时不灵」，最难排查的形态。

**owner 拍板（PRD 08-04 补充）**：建连前检测，命中即**不建连** + 告警 + 状态可见；
**不做跨进程强锁**。

判据 = pm2 里有个 online 的 ``mail-sync``，**且它不是本进程**。后半句不能省：
serve 本身常常*就是*那个 pm2 进程，只看「有没有 online 的 mail-sync」会 100% 自己
把自己判成冲突。用 **pid 比对**而不是 pm2 注入的 env 猜测 —— pm2 直接 spawn
``venv/bin/python3 main.py``，jlist 报的 ``pid`` 就是我们的 ``os.getpid()``。

⚠️ **已知不对称（有意）**：只判得了「pm2 侧有另一个 mail-sync」这个方向。
反过来「本进程是 pm2 mail-sync、同时 owner 又开着 .app」pm2 是看不见的
（.app 的子进程不在 pm2 托管下），要判得靠全局进程扫描 —— owner 已拍板不做强锁，
故这里如实**不判**，靠 PR-4 设置页把 ``bot_app_name``/连接状态摆出来让人自己发现。

🔴 常量（``pm2``/``mail-sync``/timeout）从 ``src.services.guards`` **import**，不手抄
（CLAUDE.md「跨边界手抄常量必建一致性闸」）；只有「读 jlist 并按 pid 排除自己」这段
判定逻辑是本模块自己的 —— ``guards.check_pm2_conflict`` 是给 **CLI 写命令**用的
（语义是「有 mail-sync 在跑就别并发写库」，它连自己都会算进去，且抛异常），
与我们要的判据不同。
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Optional

from loguru import logger

from src.services.guards import PM2_CMD, PM2_TIMEOUT, TARGET_PROC


def detect_pm2_conflict(*, runner: Any = None) -> Optional[str]:
    """有冲突 → 返回**人话理由**（落状态 + 告警用）；无冲突 / 判不了 → None。

    pm2 不可用（没装 / timeout / 非 JSON / 非零退出）→ **graceful skip**：判不了就
    不阻挠建连（与 ``guards.check_pm2_conflict`` 同纪律 —— 检测本身不该变成新的
    单点故障）。

    Args:
        runner: 可选，测试注入 ``subprocess.run`` 替身。
    """
    run = runner or subprocess.run
    try:
        result = run(
            [PM2_CMD, "jlist"], capture_output=True, text=True, timeout=PM2_TIMEOUT
        )
    except FileNotFoundError:
        logger.debug("[im-feishu] pm2 未安装，跳过多实例检测")
        return None
    except subprocess.TimeoutExpired:
        logger.warning(f"[im-feishu] pm2 jlist 超时（>{PM2_TIMEOUT}s），跳过多实例检测")
        return None
    except Exception as exc:  # noqa: BLE001 — 检测失败不阻挠建连
        logger.warning(
            f"[im-feishu] pm2 jlist 失败（{type(exc).__name__}），跳过多实例检测"
        )
        return None

    if getattr(result, "returncode", 0) != 0:
        logger.debug(f"[im-feishu] pm2 jlist exit {result.returncode}，跳过多实例检测")
        return None

    try:
        procs = json.loads(result.stdout or "[]")
    except (json.JSONDecodeError, TypeError):
        logger.warning("[im-feishu] pm2 jlist 输出不是 JSON，跳过多实例检测")
        return None
    if not isinstance(procs, list):
        return None

    self_pid = os.getpid()
    for proc in procs:
        if not isinstance(proc, dict):
            continue
        if proc.get("name") != TARGET_PROC:
            continue
        env = proc.get("pm2_env") or {}
        if env.get("status") != "online":
            continue
        pid = proc.get("pid")
        if isinstance(pid, int) and pid == self_pid:
            continue  # 本进程**就是**那个 pm2 mail-sync —— 不是冲突
        return (
            f"pm2 的 {TARGET_PROC} 正在运行（pid={pid}）且不是本进程（pid={self_pid}）。"
            "飞书长连接不广播，两个实例同连会随机分走消息 → 本进程不建立连接。"
            f"处置：只保留一个 —— 用打包 .app 就 `pm2 stop {TARGET_PROC}`，"
            "用 pm2 就退出 .app。"
        )
    return None
