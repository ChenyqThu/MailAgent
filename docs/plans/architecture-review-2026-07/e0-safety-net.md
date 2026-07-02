# E0 — 安全网（CI 测试闸 / 数据完整性 / 迁移守卫 / 发布收尾自动化）

> 所属：[架构 Review 2026-07](./README.md) 路线图 **Now** 阶段（≤2 周）。
> 性质：小改动、高杠杆、零功能变化。**E1/E2 的前置**——减法和接口收口都需要网兜着才敢动。

## 1. 背景

三个事实（2026-07-02 核实）：

1. **CI 没有任何测试闸**：`.github/workflows/` 仅有 `build-mac.yml` 一个 workflow，全文对 pytest / vitest / agent_eval 零命中——从 tag 到签名发布，唯一的机器闸是 typecheck（藏在 `pnpm run build` 里）。CLAUDE.md 立的纪律（改引擎必跑 agent_eval、DB_VERSION 两侧一致）全靠人肉自觉。
2. **用户数据无安全网**：`sync_store.db`（DB v29）、`agent_config.db`、`ai_chat.db`、attachments 无自动备份、无启动完整性检查；app 已分发给非开发者用户，DB 损坏 = 无回退。
3. **迁移吞错 + 无降级守卫**：`src/mail/sync_store.py:1504-1547`（v27/v29）把 ALTER 包在 `except sqlite3.OperationalError → logger.warning("skipped")` 里——PRAGMA 已先挡掉「列已存在」，所以 except 抓到的只会是真失败；但 `:1550-1553` 无条件 `INSERT OR REPLACE db_version = DB_VERSION`——**真失败被吞后版本号照样前进，永不重试**。同时无 `current_version > DB_VERSION` 的降级守卫。

## 2. 工作包

### WP1 — CI 测试闸（~2 天）

**新增 `.github/workflows/ci-test.yml`**（push/PR 到 main 触发）+ **`build-mac.yml` 在 electron-builder 前插同一测试 job**（tag 发布也过闸）：

```yaml
# 骨架（macos-14, 与 build 同 runner 族）
- pip install -e ".[cli,dev]"
- venv/python -m pytest tests/ -q -x --ignore=tests/agent_eval   # 后端全量
- venv/python -m pytest tests/agent_eval -q                      # 零-LLM 硬闸 R1-R8（~0.1s）
- (cd tests/agent_eval && python -m runner.run_baseline --compare)  # baseline 回归闸
- cd frontend && pnpm install && pnpm test                       # vitest（electron-as-node）
- cd frontend && pnpm rebuild:electron                           # 🔴 test 后必须切回 Electron ABI 再 build
```

要点：
- **把 ABI 纪律固化成流水线顺序**：`pnpm test` 含 rebuild:node，其后必须 `pnpm rebuild:electron` 才能进 build（历史 0.2.3 事故的机器化解法）；本地 dogfood 构建同理由 `packaging-preflight` agent 把关。
- 首跑先测全量 pytest 耗时；若 > ~10 min，拆「required 子集」（`tests/agent_eval` + services + sync + repository）进闸、全量放 nightly/手动。**agent_eval 与 baseline compare 无论如何必进闸**。
- baseline compare 的已知坑：`--compare` 对 synthetic 恒 REGRESSED，真 gate 看 iteration（memory: harness-polish）——workflow 里写对调用方式。
- vitest 需要 electron 二进制与 better-sqlite3：runner 上 `pnpm install` 后按仓库现有 vitest electron-as-node 配置即可（`frontend/tests/` 已在本地这样跑）。

验收：故意让一个测试失败 push 分支 → CI 红；tag 流水线在测试红时不产出 draft release。

### WP2 — 数据完整性与备份（~2 天）

1. **启动完整性检查**：`BackendLifecycleManager` spawn Python 前（或 Python 启动早期）对三库跑 `PRAGMA quick_check`；失败 → 不静默：UI 弹「数据库校验失败」+ 指引恢复，日志 + （开启时）飞书告警。
2. **滚动备份**：spawn 前对 `sync_store.db` / `agent_config.db` / `ai_chat.db` 做备份（SQLite backup API 或 `VACUUM INTO`，避免直接 copy 撕裂 WAL），保留最近 3 份于 `<DATA_ROOT>/backups/`，按大小/日期轮转。attachments 体量大，首期不备份（登记为已知边界）。
3. **恢复路径文档化**：`docs/reference/packaging/` 增「数据恢复」小节：从 backups/ 回滚步骤 + `quick_check` 验证命令。

落点：`frontend/src/electron/main/backend_lifecycle.ts`（时机钩子）+ Python 侧 `src/mail/sync_store.py` 或独立 `src/cleanup/`；实现放哪侧以「打包/开发两形态都生效」为准——**推荐 Python 启动早期做**（pm2 开发态同样受益），main 侧只做失败 UI。

验收：手工损坏一个副本库 → 启动被拦 + 提示恢复；备份目录轮转正确；升级/重装后备份仍在 userData。

### WP3 — 迁移守卫修正（~1 天）

1. v27/v29 pattern 修正：except 分支里 PRAGMA 复查目标列，仍缺失 → `raise`（真失败中断迁移，不 bump version）；「列已存在」维持 no-op。
2. `_init_database` 版本写入改为「迁移全部成功才写」（现状 `:1550` 无条件写）。
3. 加降级守卫：`current_version > DB_VERSION` → 拒绝启动并明示「数据库来自更新版本」（防旧版本 app 打开新库静默降 marker）。
4. 同步更新 `/db-migration` skill 的迁移模板，让未来迁移默认带这三条纪律。

验收：单测——模拟 ALTER 失败 → version 不前进且下次启动重试；模拟 version=99 旧代码启动 → 拒绝。

### WP4 — release 转正式自动化（~0.5 天）

现状：CI 传 draft 后必须手动 `gh release edit --draft=false --latest`（CLAUDE.md 三处 🔴），漏做 → `releases/latest` 停旧版、auto-update feed 不更新。

方案（推荐 b，保留人工 dogfood 窗口）：
- a. build 成功即自动转正式——省事但失去 tag 后人工验包窗口；
- b. **新增 `promote-release.yml`（workflow_dispatch，输入 tag）**：一键 `gh release edit <tag> --draft=false --latest --title ... --notes-file ...` + 自动验证 `releases/latest == tag`——把「手动步骤」变成「手动点一下的机器步骤」，不可能做错做漏一半。

验收：下一次发版走 promote workflow，`gh api repos/.../releases/latest --jq .tag_name` 正确。

### WP5 —（顺手，~0.5 天）Python 依赖锁定

`requirements.txt` 53 行全部 `>=` 下界、零 `==`（2026-07-02 核实）——嵌入式 venv 每次 provision 都可能拉到不同版本，打包再现性弱、也是过往「传递依赖漂移断链」注释（caldav/vobject 段）的根因。
方案：`pip-compile`（或 `uv pip compile`）从 requirements.txt 产 `requirements.lock.txt`，`frontend/scripts/build-python-venv.sh` 改用 lock 安装；升级依赖 = 重新 compile + 提交 lock diff。
验收：连续两次 provision 的 `pip freeze` 一致。

## 3. 顺序与量级

WP1 与 WP2/3/5 互不依赖可并行；WP4 独立。合计 ~1 周（单人）。全部完成后 E1/E2 才建议开工。

## 4. 风险

| 风险 | 缓解 |
|---|---|
| CI mac runner 时长/费用上涨 | 拆 required 子集 + push 只跑增量 job；tag 全量 |
| quick_check 在大库上的耗时 | quick_check 对 ~9k 邮件级库应 <1s；实测超预算则降级为仅备份不检查 |
| VACUUM INTO 备份期间写锁 | 在 Python 服务启动早期（worker 未起）执行，天然无并发写 |
