"""MailAgent 长驻服务入口 (薄壳).

P1-4a packaging C-1 后, 真正的服务逻辑 (EmailNotionSyncApp + run_service) 已迁入
`src/service.py` —— 因为 `src/` 才是打包 venv site-packages 会装的包, 根 `main.py`
不在包内 (见 pyproject.toml `include = ["src*"]`)。本文件退化为薄壳, 只负责:
  1. 最前面 `load_dotenv()` 维持 env-only flag 行为 (handler 直读 os.environ 的变量,
     如 deeplink / island socket / CLI api-key, 不经 pydantic env_file 注入 environ)。
  2. `asyncio.run(run_service())` 拉起服务。

`python3 main.py` (dev / PM2) 与 `mailagent serve` 走同一个 run_service(), 行为完全一致。
"""

import asyncio

from dotenv import load_dotenv

# dogfood 2026-05-26: island_response 等 handler 直接 os.environ.get
# (MAILAGENT_FRONTEND_DEEPLINK_ENABLED / MAILAGENT_CLI_API_KEY), 但 .env 仅经 pydantic
# env_file 填 Settings 字段、不注入 os.environ。显式 load_dotenv 让这些 env-only 变量在
# handler 及其拉起的子进程里可达 (override=False 不覆盖 shell 已 export 的实值)。
# 必须在 import run_service 之前调, 与原 main.py 顺序一致。
#
# P0 packaging: 旧的裸 load_dotenv() 读 cwd/.env，打包后 cwd ≠ 项目根则 env-only
# flag 静默失效。改为显式传 DATA_ROOT/.env (与 config.py 同一解析入口)，不再依赖
# cwd。DATA_ROOT 默认 = 仓库根 → 生产 (PM2 cwd=项目根) 下解析为 <项目根>/.env，
# 与旧裸调用逐字节一致。MAILAGENT_ENV_FILE 设置时两者都读它。
# python-dotenv 在文件不存在时静默 no-op，行为与旧裸调用 (cwd 无 .env) 一致。
from src.config import _resolve_env_file  # noqa: E402

load_dotenv(_resolve_env_file())

from src.service import run_service  # noqa: E402

if __name__ == "__main__":
    asyncio.run(run_service())
