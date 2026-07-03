"""MailAgent V2 远程访问本地 FastAPI 后端 (mailagent-api).

bind 127.0.0.1:8200, 经 cloudflared tunnel 暴露给 https://mail.chenge.ink。
设计依据: frontend/REMOTE-ACCESS.md §3 (FastAPI 设计) + §6.3 (CF Access JWT 二次校验)
        + frontend/BACKEND-INTERFACES.md §2.4 (端点表)。

布局:
  app.py        FastAPI 实例 + CORS + 统一响应中间件 + 全局异常处理 + 启动 loopback assert
  deps.py       依赖注入 (EmailRepository / config) — FastAPI Depends 用
  auth.py       Cloudflare Access JWT 二次校验 (verify_cf_access)
  schemas/      pydantic 模型 (复用 docs/cli-schema 形状) — 由并行 agent 创建
  routers/      email / attachment / llm / admin 端点 (Phase 3 填充; 写端点均经 in-process
                service 层调用, E2-C 起不再 fork 子进程调 CLI)
"""
