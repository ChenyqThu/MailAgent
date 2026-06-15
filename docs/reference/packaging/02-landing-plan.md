# MailAgent 一体化打包：落地计划

> 文档类型：落地计划（执行级）
> 上游：[`01-architecture-analysis.md`](./01-architecture-analysis.md)（架构分析 + 已敲定决策）
> 日期：2026-05-29
> 范围：把「Electron 前端 + Python 后端 + DavMail JVM + PM2」收敛为一个可分发的 macOS `.app`，并把后端功能做成可独立开关的插件控制面。
> 状态：待评审 → 转 Sprint 排期

---

## 0. 阅读指南

本文是**执行手册**，回答「按什么顺序做、每步做什么、做到什么算完、谁来扛风险」。架构「为什么这样选」不在本文复述，见上游分析文档。

**严格遵循已敲定的 8 项架构决策**（见 §1.2），本文不另立方案：

1. Python 运行时 = **嵌入式 CPython venv via `extraResources`**（arm64/x64 分包，不做 universal，不用 PyInstaller，不引导自装）。
2. 进程托管 = **新增 `BackendLifecycleManager`** 取代 PM2 运行时依赖。
3. 数据目录 = **全量 `userData` 化**（`DATA_ROOT = ~/Library/Application Support/MailAgent`）。
4. Python config = **`env_file` 与全部数据路径绝对化**，CLI fork cwd == `.env` 所在目录。
5. DavMail/JVM = **首发不捆绑 JRE、不默认 davmail**；AppleScript 为零依赖默认 backend；davmail 独立后续轨道。
6. 签名/公证 = 短期 ad-hoc + `afterSign` 递归签名；**中期申请 Apple Developer Program（$99/y）+ notarytool 公证**。
7. 体积 = **拆 pandas/numpy 为可选插件**（.app ~400MB → ~300MB）。
8. 插件控制面 = 复用 `env:get/set` + `MANAGED_ENV_KEYS` 白名单 + `services:restart`（改 kill+respawn），按 feature bundle 分组。

**一条主线判断**：这不是「打包问题」，而是「先补齐缺失的运行时编排层（进程托管 + 路径解耦 + onboarding 门控）再打包」。打包工具链已基本就位，编排层是工作量主体。

---

## 1. 总体路线图

### 1.1 Phase 总览

| Phase | 名称 | 目标 | 工作量（人天） | 前置依赖 |
|---|---|---|---|---|
| **P0** | 路径解耦与数据目录改造 | Python/前端所有硬编码路径走 `DATA_ROOT`，开发模式不回归 | 4–6 | 无（可立即起） |
| **P1** | Python 运行时打包 + 进程托管 | 嵌入式 venv 进 `extraResources`，`BackendLifecycleManager` 取代 PM2，afterSign 批量签名 | 8–12 | P0 |
| **P2** | onboarding 框架（检测 + 门控） | `app.whenReady` → 检测信号 → 门控分流（新/老/半装）→ 主窗口 | 5–7 | P1（需 lifecycle 就绪信号） |
| **P3** | 新用户流（AppleScript 默认 + 配置向导） | 全新用户零命令行装完即用（AppleScript backend）；davmail 标企业可选 | 6–9 | P2 |
| **P4** | 老用户流（继承 + 幂等迁移 + backfill 引导） | 老用户静默继承；v2/低版本引导迁移；backfill 后台化 | 4–6 | P2 |
| **P5** | 插件控制面 | feature bundle 分组 UI + 依赖/降级可视化 + 两类重启区分 | 6–9 | P1（restart 改造）、P3（写 .env 路径稳定） |
| **P6** | 签名/公证/自动更新/分发 | Apple Developer 公证 + notarytool + electron-updater 全量 channel 验证 | 4–6（+账号审批等待） | P1（afterSign 框架） |

**总计**：约 **37–55 人天**（不含 davmail 生产化独立轨道、不含 Apple 账号审批等待时间）。

> ⚠ **工时口径（C-11）**：37–55 人天产出的是 **MVP = M1–M4 = 内部 ad-hoc 可用**。**「对外可发布」= MVP + M5（公证）**，而 M5 含 **Apple Developer Program 账号审批等待（数天–数周）是关键路径阻塞项**，不计入上述人天。因此 **P6-1（申请 Apple 账号）应升级为与 P0 并行启动的「零号任务」**，否则代码做完仍发不出去（Gatekeeper「已损坏」阻断）。切勿把「37–55 天」误读为「届时即可对外发布」。

### 1.2 关键路径与并行窗口

```
P0 ──┬─→ P1 ──┬─→ P2 ──┬─→ P3 ──┐
     │        │        │        ├─→ (集成 MVP)
     │        │        └─→ P4 ──┘
     │        └─→ P6（afterSign 框架先行，公证待账号）
     └─→ P5 的「env-parser/白名单分组映射」纯前端部分可与 P1/P2 并行起草
```

- **P0 是全局前置**：路径不解耦，后面全部白做（打包后 CWD 非项目根 → Python 起不来）。
- **P3 与 P4 可并行**（都依赖 P2 的门控框架，但新/老用户流互不耦合）。
- **P6 的 afterSign 框架**应在 P1 同期搭好（漏签即 SIGKILL，越早暴露越好）；公证本身等 Apple 账号。
- **DavMail 生产化（合规 + OAuth localhost redirect + JVM 托管 + Graph 迁移）是独立大项目，明确从首发剥离**，不进本路线图主线（见 §6.3）。

---

## 2. 各 Workstream 任务清单

> 标注：`[seq]` = 必须串行（有前置依赖）；`[par]` = 可与同 Phase 内其他任务并行；`[fe]`/`[py]`/`[ci]` = 前端/Python/打包流水线落点。

### P0 — 路径解耦与数据目录改造

| # | 任务 | 落点 | 类型 | 验收 |
|---|---|---|---|---|
| P0-1 | 定义 `DATA_ROOT` 解析单一入口（env `MAILAGENT_DATA_ROOT` → 默认 `~/Library/Application Support/MailAgent`） | `src/config.py` 顶部 + 前端 `lib/data-root.ts`（新建） | `[py][fe]` | 单测：env 注入 / 缺省两路径都正确 |
| P0-2 | `config.py` `env_file` 绝对化：`SettingsConfigDict(env_file=os.path.join(DATA_ROOT, '.env'))` | `src/config.py:7-11` | `[py][seq after P0-1]` | 在非项目根 CWD 启动 `Config()` 不抛 ValidationError |
| P0-3 | `config.py` 数据路径前缀替换为 `DATA_ROOT`：`sync_store_db_path`/`attachment_storage_dir`/`log_file`/`llm_*_prompt_path` 默认值改 `DATA_ROOT/...` | `src/config.py:25,36,60,211,217` | `[py][seq after P0-1]` | 4 类路径 resolve 后均落在 `DATA_ROOT` 下 |
| P0-4 | `main.py` 显式 `load_dotenv(os.path.join(DATA_ROOT, '.env'))`（取代裸 `load_dotenv()`） | `main.py:16` | `[py][seq after P0-1]` | env-only flag（deeplink/island socket）在非项目根 CWD 也生效 |
| P0-5 | prompts 模板「不存在则从 bundle 复制」逻辑（用户可定制保留） | `src/llm_agent` context loader | `[py][par]` | 首启复制模板；二次启动保留用户改动 |
| P0-6 | 前端 `getProjectRoot()`/`projectVenvBin()`/`resolveDbPath()`/`resolveEnvPath()` 默认值改走 `DATA_ROOT`（保留 env override 优先级不变） | `cli_runner.ts:41-55`、`db.ts:45-58`、`lib/env-path.ts:24-66` | `[fe][seq after P0-1]` | 三处不再硬编码 `~/Documents/MailAgent`，dev 模式回退仍工作 |
| P0-7 | `attachment.ts` 倒推逻辑核对：确保 `DATA_ROOT/data/sync_store.db` 与 `DATA_ROOT/data/attachments/` 层级不变 | `attachment.ts:212-283` | `[fe][seq after P0-6]` | `dirname(dirname(dbPath))` 仍正确还原绝对路径，零代码改动验证 |
| P0-8 | `ai_chat.db` 路径迁入 `DATA_ROOT`（新增 `chatDbPath` 覆写字段），保留 `AI_CHAT_DB_PATH` env | `chat_db.ts:170` | `[fe][par]` | 新装落 `DATA_ROOT`；老用户迁移见 P4 |
| P0-9 | CLI fork cwd 强制等于 `.env` 所在目录（== `DATA_ROOT`） | `cli_runner.ts` execa `cwd` | `[fe][seq after P0-6]` | 写命令在 `Config()` 阶段不 exit=1 |

**P0 硬约束**：`db` 与 `attachments` 必须保持 `DATA_ROOT/data/` 同级（attachment.ts 用 `dirname(dirname(dbPath))` 倒推），不可拆分。

### P1 — Python 运行时打包 + 进程托管

| # | 任务 | 落点 | 类型 | 验收 |
|---|---|---|---|---|
| P1-1 | 嵌入式 venv 构建脚本（arm64/x64 分包，剥 dev deps：pytest/pip/setuptools/pygments） | `frontend/scripts/build-python-venv.sh`（新建） | `[ci]` | 产出 `resources/python/{arch}/venv`，core ~150M（pandas/numpy 拆后） |
| P1-2 | `electron-builder.yml` `extraResources` 纳入 venv + scripts + prompts 模板 | `frontend/electron-builder.yml` | `[ci][seq after P1-1]` | `.app/Contents/Resources/python/` 内含完整 venv |
| P1-3 | `getMailagentBin()` 打包模式从 `process.resourcesPath` 推导（dev 模式回退 `DATA_ROOT/venv`） | `cli_runner.ts:41-55` | `[fe][seq after P1-2]` | packaged app 内 fork CLI 成功 |
| P1-4a | **🔴 定义后端服务 spawn 契约（C-1 致命，前置）**：`mailagent` CLI 无 `serve` 子命令，长驻服务是仓库根 `main.py`（不在 `src/` 包内 → venv site-packages 不含）。采纳方案 A：`EmailNotionSyncApp` 迁入 `src/service.py`，新增 `@app.command() serve` 包装它（`asyncio.run`），`main.py` 退化为 `from src.service import EmailNotionSyncApp` 薄壳。同步核对 P1-2 bundle 清单确含 `src/`（`pip install .` 装入 site-packages）。备选 B：spawn `python3 main.py` 并把 `main.py`+`src/` 显式加入 extraResources。 | `src/service.py`（新建）+ `src/cli/main.py` 加 serve + `main.py` 改薄壳 | `[py][seq before P1-4]` | `mailagent serve` 能起 EmailNotionSyncApp；打包 venv 内 `python -c "import src.service"` 成功；`main.py` 与 `serve` 行为一致 |
| P1-4 | **`BackendLifecycleManager` 新建**：`app.whenReady` 后 `createWindow` 前 `spawn(MAILAGENT_BIN, ['serve'], ...)`（注入 `MAILAGENT_PROJECT_ROOT`/`MAILAGENT_ENV_FILE`/`SYNC_STORE_DB_PATH` 三 env），`before-quit` SIGTERM + waitpid | `frontend/src/electron/main/backend_lifecycle.ts`（新建） | `[fe][seq after P1-4a,P1-3]` | spawn → 存活；退出 app → 后端被优雅终止无僵尸进程 |
| P1-5 | 健康探测改直读 SQLite `sync_state`（取代 `admin:health` CLI fork 500ms） | `backend_lifecycle.ts` + 复用 `db.ts` readonly 连接 | `[fe][seq after P1-4]` | 5s 轮询 < 5ms；DB 未就绪时正确判 not-ready |
| P1-6 | DB 就绪门控：就绪判据 = `db_version==EXPECTED` **且**关键表（`email_metadata`/`email_body`/`email_outbox`）均 exists（复用 `admin.py:193` 逻辑但直读，不走 CLI fork）；处理迁移期 `CREATE INDEX` 锁表致轮询遇 `SQLITE_BUSY` 的退避；更稳为 `serve` 打印 `READY` 哨兵行握手（C-8） | `backend_lifecycle.ts` + `index.ts:368` | `[fe][seq after P1-5]` | 全新装：等建表完成再开主窗口，IPC 不报 `sync_store.db not found`；建表中途/锁表期不误判就绪 |
| P1-6b | **SSE 端口动态分配（C-5）**：spawn 时探测空闲端口 → 注入 `SSE_LOCAL_PORT` → 同步设前端 `MAILAGENT_SSE_URL`，解决 9200 被占/多实例 SSE 静默失效 | `backend_lifecycle.ts` + `events_bridge.ts` | `[fe][par]` | 9200 被占时仍能建立 SSE；多实例各用独立端口 |
| P1-7 | `.env` 变更走 `kill + re-spawn`（取代 `pm2 restart`），保留 `restartRequired` 横幅 | `services.ts:81-160` 改写 + `backend_lifecycle.ts` | `[fe][seq after P1-4]` | `env:set` 后 banner → 一键 restart 走 kill+respawn |
| P1-8 | **`afterSign` hook：递归 `codesign` 所有 `.so/.dylib`**（lxml/pydantic_core/qh3/calamine/PyObjC + libpython）+ `codesign --verify --deep` gate | `frontend/scripts/afterSign.js`（新建）+ `electron-builder.yml` | `[ci][seq after P1-2]` | hardenedRuntime 下子进程不被 SIGKILL(9)；verify gate 0 漏签 |
| P1-9 | 拆 **pandas（numpy 随之移除，无直接 import）** 为可选插件包。注意 pandas 实有 **3 处** import：`attachment_text.py:277`(懒) / `office_converter.py:147`(懒) / **`project_progress/xlsx_parser.py`（C-6 原文漏）**——拆后 project_progress（企业周报）须缺 pandas 时 fail-open 或一并归入可选包 | `requirements.txt` 拆分 + 三处 lazy import + 缺失时降级 | `[py][par]` | core 281M→~150M；插件未装时 office 转换 + project_progress 均 fail-open warning，不崩 |
| P1-10 | `better-sqlite3` rebuild + 分 arch 打包流程核对（`build:mac` 顺序不可乱） | `frontend/package.json` scripts | `[ci][par]` | arm64/x64 各自 ABI 正确，asarUnpack `.node` 可 dlopen |

**P1 硬约束**：当前 Electron **完全不 spawn/kill/health-watch main.py**，仅间接调外部 pm2 且假设已托管——这是打包最大空白点，P1-4~P1-7 是本方案核心交付。

### P2 — onboarding 框架（检测 + 门控）

| # | 任务 | 落点 | 类型 | 验收 |
|---|---|---|---|---|
| P2-1 | 检测信号聚合函数：`existsSync(resolveDbPath())` + db_version + `existsSync(resolveEnvPath())` + 必填 5 项覆盖 + `existsSync(mailagentBin())` | `frontend/src/electron/main/onboarding/detect.ts`（新建） | `[fe][seq after P1-6]` | 毫秒级同步完成；正确区分 新/老/半装/低版本 四态 |
| P2-2 | 门控插入点：`app.whenReady` → 检测 → `createWindow()` 或 `createOnboardingWindow()` | `index.ts:368` 处插门控 | `[fe][seq after P2-1]` | 检测失败开引导窗；通过开主窗 |
| P2-3 | `onboarding_done` 标记写 `settings.json`（userData，DEFAULTS 加字段） | `settings.ts:70-78` | `[fe][par]` | 完成后写 true，二次启动快速跳过 |
| P2-4 | 轻量 onboarding `BrowserWindow`（参考 `createPopoutWindow` 模式）+ 步骤路由 | `frontend/src/electron/main/onboarding/window.ts`（新建）+ renderer 页面 | `[fe][seq after P2-2]` | 独立窗口可渲染步骤；完成后关闭并开主窗 |
| P2-5 | 四类用户分流路由（新/老/半装/低版本 db_version<17） | `onboarding/detect.ts` + renderer 路由 | `[fe][seq after P2-1]` | 四态各进对应流程，无误判 |

**P2 状态机**（基于调查的检测信号）：

```
                 ┌─ DB 存在 + version==17 + .env 齐全 + bin 存在 ─→ 老用户(静默继承, P4)
app.whenReady ──┤
   检测三信号    ├─ DB 存在 + version<17 ─────────────────────→ 低版本(迁移引导, P4)
                 ├─ bin/.env 存在 + DB 不存在 ──────────────────→ 半装(一键启动+轮询DB, P4)
                 └─ 三信号全缺 ──────────────────────────────→ 新用户(完整向导, P3)
```

### P3 — 新用户流（AppleScript 默认 + 配置向导）

| # | 任务 | 落点 | 类型 | 验收 |
|---|---|---|---|---|
| P3-1 | 向导 Step：账户配置表单（`USER_EMAIL` + Notion `NOTION_TOKEN`/`EMAIL_DATABASE_ID`/`CALENDAR_DATABASE_ID` + `MAIL_ACCOUNT_NAME`），走 `env:set` IPC 写 `.env` | renderer onboarding + `env.ts` | `[fe][seq after P2-4]` | 5 必填项写入 `DATA_ROOT/.env`；secret 走 keychain |
| P3-2 | secret 槽位：`NOTION_TOKEN` 等敏感项走 keychain（keytar），`.env` 仅占位 | `keychain.ts` + `env.ts` redact | `[fe][par]` | keychain 存；`env:get` redact 为 `***` |
| P3-3 | **首发默认 backend = AppleScript**：向导默认 `MAILAGENT_BACKEND=applescript`，零额外依赖 | `.env` 写入 + 向导默认值 | `[fe][seq]` | 新用户走 AppleScript，不触碰 davmail/JVM |
| P3-4 | FDA 权限引导：检测 SQLite/AppleScript 读 Mail.app 是否被 FDA 拦截，显式引导「系统设置 → 完全磁盘访问」+ 状态检测 | `onboarding/fda-check.ts`（新建） | `[fe][seq after P3-3]` | 未授权时给引导卡 + 重检按钮；授权后放行 |
| P3-5 | 首次同步：向导触发 `mailagent init`（fetch-cache → all），进度反馈 | `init` 命令组 via callCli + renderer 进度 | `[fe][seq after P3-4]` | init 完成 → DB 有数据 → 进主窗 |
| P3-6 | davmail 标「企业 M365 可选」：向导折叠区，依赖系统 Java 检测 + 引导式配置（不自动 OAuth） | renderer 折叠区 + `java -version` 探测 | `[fe][par]` | 普通用户看不到；企业用户展开后有 Java/cipher key/OAuth 文档引导 |

**P3 硬约束**：davmail OAuth O365Manual 需 DevTools 抓 code，普通用户不可行；首发 **不**在向导内做 davmail 自动 OAuth，仅文档引导。AppleScript 是默认零依赖路径。

### P4 — 老用户流（继承 + 幂等迁移 + backfill 引导）

| # | 任务 | 落点 | 类型 | 验收 |
|---|---|---|---|---|
| P4-1 | 老用户静默继承：三信号全绿 → 后台写 `settings.json`（`onboarding_done=true` + 默认值），不打断；缺 keychain secret 在 Settings 显橙色 pill | `onboarding/detect.ts` + `settings.ts` | `[fe][seq after P2-5]` | 老用户首装 .app 不见向导；直接进主窗 |
| P4-2 | 数据目录继承策略：默认 `MAILAGENT_PROJECT_ROOT` 指向旧 `~/Documents/MailAgent`（迁移成本最低）**或** 引导整体复制到 `DATA_ROOT`（保持 `data/` 层级） | `onboarding/migrate.ts`（新建） | `[fe][seq after P4-1]` | 二选一，attachment 倒推不失败；二者均需 db+attachments 同级移动 |
| P4-2a | **🔴 就地继承防双 writer + 强制备份（C-2 高）**：就地继承前检测旧后端是否在跑（扫 `pm2 jlist` / 探测 9200 端口占用），在跑则提示停止确认单一 writer；**就地继承同样强制备份**（内嵌新代码必然触发 in-place 不可逆迁移 → 必然改旧库，不豁免）；文案明确「升级后旧版后端/PM2 将无法再用此数据库」 | `onboarding/detect.ts` + `migrate.ts` | `[fe][seq before P4-4]` | 旧后端在跑时不静默并发写；就地继承也产出 .bak；用户知情确认后才继续 |
| P4-3 | `ai_chat.db` + `token.dat` + cipher key 配对迁移（davmail 老用户） | `onboarding/migrate.ts` | `[fe][seq after P4-2]` | token.dat 与 `DAVMAIL_POC_CIPHER_KEY` 一起迁且配对，否则 token 失效 |
| P4-4 | 低版本（db_version<17）迁移引导：v3+ 启动一次自动迁到 v17（内置幂等）；**v2 用户给明确提示引导跑 `migrate_sync_store_v3.py`**（不自动，破坏性） | renderer 迁移页 + 文档链接 | `[fe][seq after P2-5]` | v3+ 静默升级；v2 不静默退出（当前仅 WARNING），给可见提示 |
| P4-5 | 迁移前强制备份提示：`cp sync_store.db sync_store.db.bak.$(date)` | renderer 迁移页 | `[fe][seq before P4-4]` | 迁移按钮前置备份步骤不可跳过 |
| P4-6 | backfill 引导后台化：`backfill body → notion_backfill → backfill metadata` 顺序提示，后台任务 + 进度，不阻塞主流程 | renderer backfill 面板 + callCli | `[fe][par]` | 顺序正确（body 先填 SSoT）；后台跑，新邮件正常工作 |
| P4-7 | `notion_backfill.py` 挂入 mailagent CLI（当前只能 `python3 -m` 调用） | `src/cli/commands/backfill.py` 加子命令 | `[py][par]` | packaged 环境可经 CLI 调用，不依赖 `python3 -m` |

**P4 硬约束（来自迁移调查）**：
- backfill 顺序强制：先 `backfill body/metadata` 填满 SSoT，再开 `NOTION_READ_FROM_SQLITE` / 前端 / KOS，否则空值覆写 Notion 的 To/CC。
- 迁移单向不可降级：回滚 = 代码 + DB 备份一起还原，同版本。
- v2→v3 主键反转不内置（`_init_database` 检到 v2 仅 WARNING + return），必须外部脚本。

### P5 — 插件控制面

| # | 任务 | 落点 | 类型 | 验收 |
|---|---|---|---|---|
| P5-1 | feature bundle 分组映射表：邮件同步核心(不可关) / Notion 集成 / AI 智能 / 灵动岛 / 日历 / 飞书 / 企业高级（默认折叠） | `frontend/src/electron/main/lib/feature-bundles.ts`（新建） | `[fe][par]` | 30+ bool 开关按场景收敛，不裸暴露 42 key |
| P5-2 | 读当前态走 `env:get`（白名单含全部插件总开关） | 复用 `env.ts` | `[fe][seq after P5-1]` | UI 正确反映当前 `.env` 开关态 |
| P5-3 | 写 `.env` 走 `env:set` + `env-parser` 行级原子写（不破坏注释，非白名单抛 `E_INVALID_KEY`） | 复用 `env-parser.ts` | `[fe][seq after P5-1]` | 改一个开关只动一行，注释保留 |
| P5-4 | **两类重启区分 UI**：①mail-sync 重启走 `BackendLifecycleManager.restart()`（kill+respawn）；②Notion Agent harness 因 chat/config 直读 `process.env` 须**重启 Electron**；③灵动岛走 `island:setEnabled` 免重启 | renderer 控制面 + `services.ts`/`island.ts` | `[fe][seq after P1-7]` | 三类切换路径正确；UI 明确提示哪类重启 |
| P5-5 | 依赖/可用性/降级可视化：父开关关→子开关置灰+tooltip；凭证缺失（LLM 开但 keychain 无 key）→橙色「未配置」pill；外部依赖未就绪（ping-island.app/davmail JVM/Java）→安装引导 | renderer 控制面 | `[fe][seq after P5-1]` | 依赖拓扑根=`MAILAGENT_BACKEND`，下游 CalDAV/folder/uid_backfill 按可用性置灰 |
| P5-6 | 白名单外特殊处理：`MAILAGENT_BACKEND` 暂不热切换（标手动+文档）；KOS 三 OAuth 凭据保持手动 .env 标企业；`DAVMAIL_POC_CIPHER_KEY` 建议迁 keychain | renderer + 文档 | `[fe][par]` | 这三类不出现在常规开关 UI，单独「高级/企业」区 |
| P5-7 | LLM 双跑防护：启用本地 LLM 前提示关闭 Notion Custom Agent（否则竞争写 AI Action/Priority） | renderer AI 智能区 | `[fe][par]` | 开 `LLM_AGENT_ENABLED` 前有警示 |

**P5 依赖拓扑（来自插件调查）**：

```
MAILAGENT_BACKEND (根, 暂不热切换)
  ├─ davmail ─→ CalDAV(日历) / folder_sync / uid_backfill 可用
  └─ applescript ─→ folder_sync 不启动
Notion 集成: Notion 同步 → Notion Agent CLI → 读 SSoT (父子链)
AI 智能: LLM(双前提: enabled + keychain key) + 每日巡检(双开关: ping_island + daily_digest) + 翻译
灵动岛: ping_island_enabled (前端可运行时切, 唯一例外)
```

### P6 — 签名/公证/自动更新/分发

| # | 任务 | 落点 | 类型 | 验收 |
|---|---|---|---|---|
| P6-1 | 申请 **Apple Developer Program（$99/y）**（**尽早启动，审批是等待瓶颈**） | 行政 | `[seq, 越早越好]` | 拿到 Team ID + 证书 |
| P6-2 | `afterSign` 框架（P1-8 已搭）切换到正式 Developer ID 签名 | `electron-builder.yml` `identity` | `[ci][seq after P6-1]` | 用正式证书签名，非 ad-hoc |
| P6-3 | `notarytool` 公证集成 + `staple` | `electron-builder.yml` `notarize:true` + CI | `[ci][seq after P6-2]` | Gatekeeper 不再「已损坏」；普通用户机首启放行 |
| P6-4 | electron-updater 全量 channel 验证（zip + `latest-mac.yml` + blockmap） | `electron-builder.yml` `publish: github` | `[ci][par]` | 自动更新链路通；签名/公证后的包可正常更新 |
| P6-5 | arm64/x64 分包发布矩阵（Rust .so arch-specific，不做 universal） | CI 矩阵 | `[ci][par]` | 两 arch 各自 dmg+zip，下载页正确分发 |
| P6-6 | entitlements 核对：`cs.allow-unsigned-executable-memory` / `cs.disable-library-validation` / `cs.allow-dyld-environment-variables` 已含（捆绑子进程必需） | `build/entitlements.mac.plist` | `[ci][par]` | 公证时 disable-library-validation 提供合理性说明 |

**P6 硬约束**：hardenedRuntime 下漏签任一 `.so` 即 SIGKILL(9)；`notarize:false` 在 macOS 14+ 默认配置遭 Gatekeeper 彻底阻断——**公证是 onboarding 对外发布成功率的决定性前置，非 polish**。

---

## 3. 关键技术改造点（文件/模块级落点）

### 3.1 硬编码路径解耦清单

| 改造点 | 当前 | 目标 | 文件:行 |
|---|---|---|---|
| Python `env_file` | `env_file=".env"`（相对 CWD） | `os.path.join(DATA_ROOT, '.env')` | `src/config.py:7-11` |
| Python `sync_store_db_path` | `"data/sync_store.db"` | `DATA_ROOT/data/sync_store.db` | `src/config.py:60` |
| Python `attachment_storage_dir` | `"data/attachments"` | `DATA_ROOT/data/attachments` | `src/config.py:36` |
| Python `log_file` | `"logs/sync.log"` | `DATA_ROOT/logs/sync.log` | `src/config.py:25` |
| Python prompt 路径 | `"prompts/email_*.md"` | `DATA_ROOT/prompts/email_*.md` | `src/config.py:211,217` |
| Python `load_dotenv()` | 裸调用（CWD/.env） | `load_dotenv(DATA_ROOT/.env)` | `main.py:16` |
| 前端 CLI bin | `~/Documents/MailAgent/venv/bin/mailagent` | `process.resourcesPath/python/venv/...`（packaged）/ `DATA_ROOT/venv`（dev） | `cli_runner.ts:41-55` |
| 前端 project root | `~/Documents/MailAgent` | `DATA_ROOT`（== `.env` 所在 == CLI cwd） | `cli_runner.ts:51-55` |
| 前端 db fallback | `~/Documents/MailAgent/data/sync_store.db` | `DATA_ROOT/data/sync_store.db` | `db.ts:45-58` |
| 前端 .env fallback | `~/Documents/MailAgent/.env` | `DATA_ROOT/.env` | `lib/env-path.ts:24-66` |
| 前端 chat db | `~/.mailagent/frontend/ai_chat.db` | `DATA_ROOT/ai_chat.db` | `chat_db.ts:170` |

**不需改**（已正确）：`settings.json`/`appearance.json`（已 userData 化）、`reader.py` 临时目录（`tempfile.gettempdir()`）、`attachment.ts` 倒推逻辑（保持 `data/` 同级即零改）。

### 3.2 main.py 守护进程化（取代 PM2）

**新建 `frontend/src/electron/main/backend_lifecycle.ts`**，职责：

1. `start()`：`app.whenReady` 后、`createWindow` 前 `child_process.spawn(MAILAGENT_BIN, ['serve'], { cwd: DATA_ROOT, env: { MAILAGENT_PROJECT_ROOT, MAILAGENT_ENV_FILE, SYNC_STORE_DB_PATH } })`（注入 3 env）。**`serve` 子命令须先由 P1-4a 落地**（`mailagent` CLI 当前无 serve，长驻服务是 `main.py`，见 C-1）；spawn 的不是 `main.py`，而是 `mailagent serve` → `src.service.EmailNotionSyncApp`。
2. `waitReady()`：**直读 SQLite `sync_state`**（取代 `admin:health` CLI fork 500ms），轮询 `_init_database()` 完成信号 → DB 就绪门控 → 放行 `createWindow`。
3. `restart()`：`kill + re-spawn`（取代 `pm2 restart`），供 `env:set` 后 banner 调用。
4. `stop()`：`before-quit` 时 `SIGTERM` + `waitpid`，无僵尸进程。

**改造 `services.ts:81-160`**：`services:restart` 从调 pm2 改为调 `BackendLifecycleManager.restart()`；`services:status` 改读 lifecycle 内部状态 + SQLite。**彻底移除运行时 PM2 依赖**（PM2 仅保留为开发/服务器部署的可选方式，见 §6.1）。

### 3.3 CLI bin 解析改造

`cli_runner.ts:getMailagentBin()` 保持三级回退**顺序**不变，仅改第二级默认值：
- ① `$MAILAGENT_BIN`（不变）
- ② 打包模式 = `process.resourcesPath/python/venv/bin/mailagent`；dev 模式 = `DATA_ROOT/venv/bin/mailagent`（用 `app.isPackaged` 分支）
- ③ PATH `which()`（不变）

`cwd` 从 `getProjectRoot()` 改为 `DATA_ROOT`（== `.env` 所在），保证 pydantic 读到正确 `.env`。

### 3.4 迁移触发器

- **自动（v3→v17）**：后端启动一次 `_init_database()` 即幂等升级，`BackendLifecycleManager.waitReady()` 等其完成再开窗（P1-6）。无需额外迁移 CLI。
- **半自动（v2→v3）**：`detect.ts` 读 db_version；检到 v2 → onboarding 迁移页给可见提示 + 备份步骤 + 引导跑 `scripts/archive/migrate_sync_store_v3.py`（**不自动跑**，破坏性主键反转）。修补当前「仅 WARNING 静默退出」的体验空白。
- **backfill（手动后台）**：P4-6 面板按 `body → notion_backfill → metadata` 顺序触发，后台 + 进度。

### 3.5 插件开关读写

- **读**：`env:get`（白名单 `MANAGED_ENV_KEYS` 已含全部插件总开关）。
- **写**：`env:set` + `env-parser.ts` 行级原子写（write `.env.tmp` → rename；非白名单抛 `E_INVALID_KEY`）。
- **生效**：mail-sync 类走 `BackendLifecycleManager.restart()`（kill+respawn）；Notion Agent harness 走重启 Electron（chat/config 直读 `process.env`）；灵动岛走 `island:setEnabled`（免重启，唯一运行时例外）。
- **分组**：`feature-bundles.ts` 把 42 key 映射为 7 个 feature bundle（§2 P5-1）。

---

## 4. 风险登记册

| ID | 风险 | 概率 | 影响 | 缓解 | 负责模块/Phase |
|---|---|---|---|---|---|
| R1 | **davmail 合规红线 + EWS 2026-10-01 关停**：伪装 client_id 不可分发、OAuth UX 不可行、关停后链路归零 | 高 | 致命 | 首发默认 AppleScript；davmail 剥离为 IT 审批 / Graph 独立轨道 | P3 / 独立轨道 §6.3 |
| R2 | **公证缺失致 Gatekeeper 阻断**：ad-hoc + `notarize:false` 在普通用户机首启「已损坏」 | 高 | 致命 | 尽早申请 Apple Developer Program（$99/y）+ notarytool | P6 |
| R3 | **main.py 无人托管**：当前 Electron 不 spawn/kill/health-watch，仅间接 pm2 | 高（现状必然） | 高 | `BackendLifecycleManager`（本方案核心交付） | P1-4~P1-7 |
| R4 | **Python config 相对 CWD**：打包后 CWD 非项目根，`Config()` 必填字段 ValidationError，Python 起不来 | 高（现状必然） | 高 | `env_file` + 全部数据路径绝对化 + 显式 `load_dotenv` 路径 | P0-2~P0-4 |
| R5 | **afterSign 漏签 .so 致 SIGKILL**：hardenedRuntime 下任一未签名 `.so/.dylib` 被 SIGKILL(9)，Rust/C 扩展易漏 | 中高 | 高 | 批量 `codesign` + `codesign --verify --deep` gate（CI 强制） | P1-8 |
| R6 | **FDA 权限**：SQLite + AppleScript 读 Mail.app 需手动授予完全磁盘访问，entitlements 无法自动获取 | 高（必然） | 中 | onboarding 显式引导 + 授权状态检测 + 重检按钮 | P3-4 |
| R7 | **native 模块 ABI + 跨 arch**：better-sqlite3 Node ABI≠Electron ABI；Rust .so arch-specific | 中 | 中 | 每次 Electron 升级重跑 `rebuild:electron`；arm64/x64 分包；`build:mac` 顺序不可乱 | P1-10 / P6-5 |
| R8 | **老用户数据迁移**：db + attachments + ai_chat.db + token.dat/cipher key 配对须一起迁且保层级 | 中 | 中 | 默认指旧路径（成本最低）或整体复制保 `data/` 层级；token.dat 与 cipher key 配对迁移 | P4-2~P4-3 |
| R9 | **SQLite WAL 并发**：前端 `writeFlagDirect` 与后端 FanoutWorker 并发写同一 WAL，busy_timeout=500ms 是唯一保护 | 中 | 中 | 打包后必须共享同一 WAL 文件不可分离；保持单写者分工（前端只读+有限写） | P0-7 / P1 |
| R10 | **env-only flag 静默失效**：cwd 非 .env 目录时 `load_dotenv` 找不到，deeplink/island socket 默认值，无报错难调试 | 中 | 中 | P0-4 显式 `load_dotenv(DATA_ROOT/.env)`；CLI cwd 强制 == DATA_ROOT | P0-4 / P0-9 |
| R11 | **半装用户首次 init 耗时**：6-7 万封大邮箱 init/backfill 数分钟~2h，用户卡在引导页 | 中 | 中 | backfill 后台化 + 进度反馈 + 增量优先（新邮件正常，历史逐步补） | P3-5 / P4-6 |
| R12 | **backend probe 失败 exit(1) + autorestart=false**：davmail 配置不对则进程起不来不自动重启 | 中 | 中 | 友好错误界面 + lifecycle 捕获 spawn 失败导回 onboarding | P1-4 / P3-6 |
| R13 | **LLM 双跑**：本地 LLM + 未停 Notion Custom Agent 竞争写 AI Action/Priority | 中 | 低中 | 开 `LLM_AGENT_ENABLED` 前 UI 警示关闭 Notion Custom Agent | P5-7 |
| R14 | **体积失控**：嵌入 venv + 全量下载更新（无增量 patch） | 低（已缓解） | 低中 | 拆 pandas/numpy（281M→~150M，.app ~400→~300MB）；剥 dev deps | P1-9 |

---

## 5. 里程碑与 MVP 边界

### 5.1 MVP 定义（先支持哪类用户）

**MVP 目标用户 = 全新 AppleScript 用户 + 老用户继承**，明确**不含 davmail 一键分发**。

| MVP 必须 | MVP 不含（后续轨道） |
|---|---|
| 嵌入式 venv 打包 + afterSign 签名通过 | davmail 自动 OAuth（O365Manual DevTools 抓 code 不可行） |
| `BackendLifecycleManager` spawn/kill/health/门控 | Graph API 迁移（Issue #404 未 merge） |
| Python config 绝对化（不崩） | 捆绑 JRE |
| onboarding 检测 + 四态分流 | KOS 企业功能默认开放（保持手动 .env） |
| 新用户 AppleScript 配置向导 + FDA 引导 | 公证（MVP 可先 ad-hoc 内部分发，对外发布前补 P6） |
| 老用户静默继承 + v3→v17 自动迁移 | `MAILAGENT_BACKEND` 热切换 |
| 插件控制面（feature bundle 分组 + 依赖可视化） | |

### 5.2 里程碑

| 里程碑 | 内容 | 退出标准 | 依赖 Phase |
|---|---|---|---|
| **M1：后端能在包内起来** | P0 + P1 完成 | 双击 dev-packaged .app，后端 spawn 成功、DB 就绪门控通过、CLI fork 不崩、子进程不被 SIGKILL | P0,P1 |
| **M2：新用户装完即用（内部 ad-hoc）** | + P2 + P3 | 干净机器（无 ~/Documents/MailAgent）装 .app → 向导填 Notion+邮箱 → FDA 授权 → init 同步 → 收件箱有邮件（AppleScript） | P2,P3 |
| **M3：老用户无缝继承** | + P4 | 现有 v17 用户装 .app 不见向导、直接进主窗、数据完整；v2 用户得到可见迁移提示 | P4 |
| **M4：插件可配可控** | + P5 | 控制面按 bundle 分组切换开关；两类重启正确；依赖置灰/降级 pill/安装引导可见 | P5 |
| **M5：对外可发布** | + P6 | 公证通过、Gatekeeper 放行、自动更新链路通、arm64/x64 分发矩阵就绪 | P6 |

**MVP = M1 + M2 + M3 + M4**（内部 ad-hoc 分发可用）；**M5 = 对外发布门槛**。

---

## 6. 回滚与兼容策略

### 6.1 不破坏现有 PM2 部署

- `BackendLifecycleManager` 只在 **packaged 模式（`app.isPackaged`）** 接管 spawn；**dev 模式与服务器部署继续走 PM2**（`pm2 start main.py --interpreter ./venv/bin/python3` 不变）。
- `main.py` 不强制要求由 Electron 托管：它仍可独立 `python3 main.py` 或 PM2 启动；lifecycle 只是「装完即用」场景的一个上层 spawner。
- `services.ts` 改造保留对外 IPC 契约（`services:restart/status`）不变，仅切换内部实现（packaged → lifecycle，dev → pm2）。

### 6.2 AppleScript fallback 始终可用

- **首发默认 backend = AppleScript**，本身就是零依赖 fallback 路径，打包不削弱它。
- davmail 回切 AppleScript 的现有约束保持：**回切必须 reset `last_max_row_id`**（否则 AppleScript 看 davmail 的 UIDNEXT 致新邮件静默不同步）——迁移/切换 UI 须保留此步骤（不在 MVP 暴露热切换，手动文档保障）。
- `backfill body` 走 AppleScript（即使主 backend 是 davmail），打包后 Mail.app 依赖 + FDA 必须可用，不破坏。

### 6.3 davmail 作为独立后续轨道（不进 MVP 主线）

davmail 生产化是独立大项目，与本打包计划解耦推进：
- **🔴 供应链前置（C-4 高）**：`davmail-poc/`（含 `davmail.jar` 856K + `lib/` 6M）**整目录被 gitignore，不在版本控制**。该轨道动工前须先解决 CI 可复现获取：vendored release artifact 或下载脚本 + 校验 hash，否则连构建都起不来。
- 合规：走公司 IT 审批申请独立 Graph API 应用注册（推荐），或每用户自注册 Azure AD（UX 差）。
- OAuth UX：用 localhost HTTP redirect 替代 oob（需验证 well-known client_id 是否接受，PoC 结论 `redirect_uri_mismatch`；正规 Graph 注册可配任意 localhost redirect）。
- JVM 托管：依赖系统 Java（Temurin），引导式配置；不捆绑 JRE。
- 死线：EWS 2026-10-01 关停，Graph 迁移（Issue #404）未 merge——若届时仍未就绪，davmail 路径归零，但**因 MVP 默认 AppleScript，主产品不受影响**。

### 6.4 迁移回滚

- 迁移单向不可降级：回滚 = **代码 + DB 备份一起还原**，两者同版本（v3→v17 无 downgrade 脚本）。
- 迁移前强制 `cp data/sync_store.db data/sync_store.db.bak.$(date +%Y%m%d-%H%M%S)`（P4-5），这是唯一后悔药。
- 老用户继承默认走「指向旧 `~/Documents/MailAgent`（`MAILAGENT_PROJECT_ROOT` 覆写）」而非强制搬迁，迁移成本与风险最低；整体复制为可选高级路径。

---

## 7. 附录：Phase → 决策 对照

| 架构决策 | 落地 Phase | 核心任务 |
|---|---|---|
| 嵌入式 CPython venv（extraResources） | P1 | P1-1~P1-3 |
| BackendLifecycleManager 取代 PM2 | P1 | P1-4~P1-7 |
| DATA_ROOT userData 化 | P0 | P0-1~P0-9 |
| config.py 绝对化 | P0 | P0-2~P0-4 |
| 首发默认 AppleScript / davmail 剥离 | P3 / §6.3 | P3-3, P3-6 |
| afterSign 递归签名 + 公证 | P1 / P6 | P1-8, P6-1~P6-3 |
| 拆 pandas/numpy 可选插件 | P1 | P1-9 |
| 插件控制面 feature bundle | P5 | P5-1~P5-7 |
