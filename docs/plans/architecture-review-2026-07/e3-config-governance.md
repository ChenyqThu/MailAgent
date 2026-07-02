# E3 — 配置治理（flag registry 统一 + 手抄常量灭点）

> 所属：[架构 Review 2026-07](./README.md) 路线图 Next 阶段。
> 性质：把「flag/常量靠人肉在 4+ 处保持一致」的事故类别（历史上已发生多起）变成机器校验。

## 1. 背景：这是一个反复发生的事故类别

历史事故（memory / issue 已登记）：pydantic `Field(env=)` 静默失效改用 validation_alias（9 flag 修复 `2d6b96df`）、vite define 漏加导致 renderer 读不到 flag、`EXPECTED_DB_VERSION` 手抄漏改卡启动 120s（后加兜底测试）、env-only flag 不经 `load_dotenv` 不进 environ。每次都是同一根因：**同一配置事实存在多份手抄副本，无机器对账**。

## 2. 现状盘点（2026-07-02）

### 2.1 四种 flag 载体

| 载体 | 规模 | 读取方 | 已知坑 |
|---|---|---|---|
| pydantic `src/config.py` | ~140 Field，其中 validation_alias 14 处 | Python 主服务/serve-api（部分热读 `dotenv_values`） | Field(env=) 不生效；翻 flag 是否需重启因字段而异 |
| env-only `os.environ` 直读 | 少量（如部分 gateway 相关） | Python | 必须 main.py `load_dotenv` 先行（memory: reference_mailagent_env_only_flags） |
| Node main env（`envBool`） | WRITE_TOOLS / SEND_TOOL / AG_UI_MIRROR / SKILL_SELF_MOUNT / ISLAND 等（`frontend/src/electron/main/ai_gateway_lifecycle.ts`） | Electron main / gateway | 与 Python 侧同名 flag 语义须人肉对齐 |
| vite define | 7+ 个 `__MAILAGENT_*__`，**electron.vite.config.ts 与 vite.web 两份手抄镜像** | renderer/web | 漏一份 → 两宿主行为分叉 |

### 2.2 手抄常量

- `EXPECTED_DB_VERSION`（`frontend/src/electron/main/backend_lifecycle.ts:64`）手抄 Python `SyncStore.DB_VERSION`——已有 `frontend/tests/main/db_version_consistency.test.ts` 兜底，**这个模式就是本 epic 要推广的样板**。
- CLAUDE.md「关键开关现状」表：人肉维护，已发现漂移实例（`src/config.py:459 agent_harness_enabled default=True` vs 表中「false」）。
- `.env.example`（~380 行）与 config.py 字段集：无机器对账。

### 2.3 「代码默认 ≠ 生产实际」偏离面

CLAUDE.md 表中 ★ 项（`MAILAGENT_BACKEND`、`MAILAGENT_OUTBOX_ENABLED` 等）。注意：**部分偏离是有意的产品决策**（如打包 app 新用户默认 applescript = 零依赖零合规首发），不能一刀切对齐——需要一张「偏离决策表」区分「有意保留」与「欠收口」。

## 3. 方案：先校验、后收敛、可选生成

一步到位的「单一 YAML 生成全部载体」改造大、收益后置。推荐三阶段：

### Step 1 — 一致性校验网（先做，~2 天，高杠杆零风险）

复制 `db_version_consistency.test.ts` 模式，新增机器对账测试：

1. **vite define 双镜像对账**（vitest）：解析 `electron.vite.config.ts` 与 `vite.web.config.ts` 的 define 键集，断言相等。
2. **config.py ↔ .env.example 对账**（pytest）：pydantic 模型字段（含 alias）全集 vs `.env.example` 键集，双向 diff 输出缺失/多余（允许显式豁免清单）。
3. **跨语言同名 flag 清单**（vitest 或 pytest 单侧即可）：登记「同一 flag 多载体读取」的显式映射表（如 `MAILAGENT_MEM0_CAPTURE`→Node、`_RETRIEVAL`→Python），测试断言映射表里的每个 env 键在对应载体源文件中出现——防止改名/删除时漏一侧。
4. **CLAUDE.md 开关表对账**（pytest，宽松版）：抽取表中 flag 名与默认值列，与 config.py 实际默认值比对，漂移则 fail（先修已知漂移：`agent_harness_enabled`）。

全部挂进 E0 的 CI 测试闸。

### Step 2 — 收敛载体（~2-3 天）

- env-only `os.environ` 直读全部收编 pydantic（validation_alias），消灭第 2 种载体。
- Node main env 键名统一加 `MAILAGENT_` 前缀并在 Step 1 的映射表登记（已基本符合，补漏即可）。
- 明确并文档化「翻 flag 是否需重启」的规则（pydantic 冷读 / dotenv_values 热读 / Node spawn 时注入），写进 `.env.example` 头部说明。

### Step 3 — 偏离决策表 + 默认值对齐（~1 天 + 评审）

逐项评审 ★ 偏离：

| flag | 现默认 | 生产 | 建议 |
|---|---|---|---|
| `MAILAGENT_OUTBOX_ENABLED` | false | on | **翻 true**（E2 子包 B 前置） |
| `MAILAGENT_BACKEND` | applescript | davmail | **保留偏离**（新用户零依赖首发是产品决策），在表中登记理由 |
| 其余 ★ 项 | — | — | 逐项归类「翻默认 / 有意保留 + 理由」 |

产出固化为本目录 `e3-defaults-decision-table.md`，CLAUDE.md 开关表说明列引用它。

### 可选 Step 4 — 单源生成（暂缓）

flags.yaml → 生成 .env.example 段落 / vite define 两份 / CLAUDE.md 表片段。**建议暂缓**：Step 1 的校验网已消除事故面，生成器引入构建复杂度，等校验网跑稳一个季度再评估。

## 4. 验收

- [ ] 4 项对账测试进 CI 并全绿（含修复现存漂移）
- [ ] `grep -rn "os.environ.get\|os.getenv" src/ --include='*.py'`（排除 config.py 与豁免清单）趋零
- [ ] 偏离决策表落盘且 CLAUDE.md 开关表与 config.py 实测一致

## 5. 风险与量级

- 风险：低——Step 1 纯增测试；Step 2 收编 env-only flag 时注意 pydantic 冷读语义变化（逐个确认读取时机），有 `reference_pydantic_v2_field_env_ignored` 与 `reference_mailagent_env_only_flags` 两条 memory 的坑单可查。
- 量级：合计 ~1 周内。无前置依赖，可与 E1/E2 并行。
