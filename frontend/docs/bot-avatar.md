# 灵动 Bot 头像（bot-avatar）

> Grok 风格的状态化 SVG 头像模块：身体形状 + 两只可 morph 的眼睛，按 agent 运行状态眨眼/换表情/转头。
> 出自 task `08-12-living-bot-avatar`（2026-08，引擎自 Grok bot 原型提炼），全量替换了旧 `@oreo-design/avatar` 体系。
> 🔴 **出处红线**：`expressions.json` 的眼睛轮廓数据描摹自 Grok（x.ai）bot——内部 dogfood 已获 owner 知情确认（2026-08-13），**对外发布场景须重绘自有表情集**（引擎与数据刻意解耦，换 JSON 即可）。

## 模块地图（`frontend/src/shared/bot-avatar/`，零外部依赖，桌面 + 远程 web 通用）

| 文件 | 职责 |
|---|---|
| `expressions.json` | 25 表情 × 2 眼 × 48 点轮廓（36.7KB 单行，**勿手改/勿格式化**；再生成用 `frontend/scripts/extract-bot-expressions.mjs <原型html>`，脚本断言 25×2×48） |
| `states.ts` | 39 态四张表（GROUPS/POOLS/EXPR_CADENCE/BLINK，原型 1:1）+ **MailAgent 状态映射单源**：`turnStageToBotState`（TurnStage 8 值）/ `runStateToBotState`（headless run 6 值投影），Record 全射——上游加态漏映射 = typecheck 红 |
| `shapes.ts` | 8 形 body path + 每形 `eyeAnchor`（眼组平移/身体缩放/眼睛缩放/turnAt）；`BOT_AVATAR_SHAPES` 是 parity 闸抽取锚点 |
| `colors.ts` | 11 色双主题值（light/dark 各一）；浅色身体（white/yellow/gray）有 per-color eye 覆写（背景色眼睛在浅色主题会隐形）；`BOT_AVATAR_COLORS` 同为闸锚点 |
| `engine.ts` | 零 React/GSAP 纯 TS 引擎：弹簧 morph（f=7 临界阻尼）/ 320ms 眨眼（闭 42% 开 58%）/ gaze ±13.2/±8.4 / 球面投影转头（中心 114.2705、半径 105、depth≤0.02 隐藏）/ 按态池随机调度（`{random, now}` 可注入）；`tick()` 空闲返回 null = **settle 后零重绘** |
| `ticker.ts` | 模块级共享 rAF 单例（全仓首个）：注册制启停、`visibilitychange` 暂停、SSR 安全、测试用 `__instanceCount()` |
| `BotAvatar.tsx` | React 组件双档：**静态档是默认**（零 ticker 零定时器，state 变化=离散换帧）；`animated` 显式声明才动（引擎 + ticker + IntersectionObserver 可见性裁剪）；`mouseInteractive` 眼睛跟全局指针（仅 animated）；`useReducedMotion()` JS 层短路恒走静态；clipPath id 经 `useId` 每实例唯一 |
| `random.ts` | `deriveBotAvatar`（agent_id 确定性派生，NULL 行默认外观）/ `mapLegacyGeneratedToBot`（oreo 行确定性映射）/ `randomBotAvatar` / `shuffleBotAvatar`（确定性递进 ≠ 当前）——golden 测试钉死，防重构静默换脸 |
| `useBotAvatarTheme.ts` | 主题 hook（`data-theme` MutationObserver + useSyncExternalStore） |

## avatar_json 三种 kind 与 resolve 链

| kind | 形状 | 语义 |
|---|---|---|
| `{type:'bot', shape, color}` | 新 canonical | 编辑器保存的选择 |
| `{type:'image', data:'data:image/…;base64,…'}` | 上传（不变） | ≤150KB webp/png/jpeg，服务端 `_normalize_avatar_image` 复核，禁外链 |
| 无 `type` 键 `{shape, palette, …}` | legacy oreo（只读） | 存量行零迁移，渲染时经 `mapLegacyGeneratedToBot` 确定性映射 |
| `NULL` | 派生态 | 前端按 agent_id `deriveBotAvatar`（内置 agent 全靠它）；编辑器「重置」写回 NULL |

- resolve 单源 `frontend/src/shared/components/agents/agentAvatarIdentity.ts::resolveAgentAvatar` —— **恒返回 bot config**（上传态在 `AgentAvatar` 外壳层短路渲 `<img>`，不进 resolve）。
- 后端校验：`src/reports/wire.py::config_patch_to_db` 的 bot 分支（shape/color 白名单 + 键集合恰为 {type,shape,color}）；分支排序 None → image → bot → legacy 兜底，存量行为字节级不变。
- P9 导入导出：bot **原样导出**、image → null（`src/agents/plugin_compat.py`，`tests/api/test_agent_plugins.py` 钉死）。

## 跨语言 parity 闸

`tests/config/test_bot_avatar_vocab_parity.py`：Python `BOT_AVATAR_SHAPES/COLORS`（wire.py，canonical）↔ TS 同名导出（shapes.ts/colors.ts）+ `AVATAR_IMAGE_MAX_BYTES` 150KB 两侧（0804 旧债一并入闸）。TS 侧契约 = `export const BOT_AVATAR_SHAPES = […] as const` 恰好一次、数组字面量勿改计算生成；抽取失败必红（canary 钉死）。**改词表 = 两侧 + 断言三处一起动**。

## 渲染档位纪律（性能红线）

- **静态是默认档**：8 个既有渲染位点（Agents 卡/会话列表行/报告卡/run 历史/@mention/审批卡…）全部经 `AgentAvatar` 静态渲染，列表恒静态——**新增 animated 位点须过性能评估**。
- animated 位点现存 3 处：chat 回合头像 `TurnPresence`（28px）、面板头 `AssistantPanelBotAvatar`（20px）、编辑器预览（48px，+mouseInteractive）。
- reduced-motion：JS 层短路（CSS media 对 JS 动画无效），animated 自动退化静态；测试环境全局 reduce（`tests/setup.ts`），测真动画路径需 stub matchMedia。
- 防重叠机器验收：8 形 × 25 表情全组合断言 `eyeScale ≤ (distance-5)/(ΣhalfWidth)`（`tests/shared/bot-avatar/shapes.test.tsx`），新形状调参靠它兜底。

## chat 嵌入（TurnPresence）

- 挂载：进行中回合的**最新 assistant 消息**内容上方（`message.tsx` + `AgentMessage.tsx` 两面同款），run 全程常驻；历史消息/只读回放零头像。**不能放 assistant-ui Empty slot**（parts 非空即卸载，头像要跨 writing/tool 阶段存活）。
- 文字区沿用 TurnStatusLine 三代 shimmer 治理的显隐纪律（connecting/thinking shimmer、stalled/error 静态、writing/calling-tool/awaiting-approval 只留头像不出字）；**DotMatrix 已从消息流退役**（头像即动效载体），`ThreadRunStatusBar`（composer 药丸）与 DotMatrix 本体不动、两条并存。
- celebrate 时序：下降沿到 idle 且消息 status='complete'（abort 不庆祝）→ celebrate 2.5s → 380ms 淡出卸载；边沿经 prev ref 去重，重渲染不重播；reduced-motion 直接消失。
- 会话头像：agent 会话经 `resolveAgentAvatar`；interactive 默认会话 = 官方助手形象 `{shape:'blob', color:'orange'}`（`OFFICIAL_ASSISTANT_BOT_CONFIG`）。

## 改动指南

- **加形状**：shapes.ts 加 path+eyeAnchor → `BOT_AVATAR_SHAPES` 两侧词表（TS + wire.py）+ parity 断言 → 跑防重叠闸（超标调小 eyeScale）→ 编辑器网格自动跟随词表。
- **加颜色**：colors.ts 双主题值（浅色补 eye 覆写）→ 两侧词表 + 断言。
- **改状态映射/节奏**：只动 states.ts（单源）；上游 TurnStage/run_state 加值会因 Record 全射在 typecheck 红。
- **换表情集**（对外发布前置）：重绘 25×2×48 同构数据替换 expressions.json，引擎零改动；golden/防重叠测试会指认幅度异常。
