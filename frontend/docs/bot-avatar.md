# 灵动 Bot 头像（bot-avatar）

> Grok 风格的状态化 SVG 头像模块：3D 参数曲面身体 + 贴合曲面的两只眼睛，按 agent 运行状态转头/眨眼/换表情/呼吸漂移。
> 出自 task `08-12-living-bot-avatar`（2026-08）：v1 引擎自 Grok bot 原型提炼（烘焙轮廓 + 弹簧 morph）；
> **v2（2026-08-13）整体换代为参数化 3D 几何**，移植自 owner fork 的
> [bible-strong-avatar-lab](https://github.com/ChenyqThu/bible-strong-avatar-lab)。全量替换了旧 `@oreo-design/avatar` 体系。
> 🔴 **出处与许可**：v2 的 geometry/surfaces/ambient/表情参数表派生自 avatar-lab（上游
> smontlouis/bible-strong-avatar-lab，**AGPL-3.0**）。v1「表情数据描摹自 Grok 须重绘」红旗已随数据换源解除；
> 但若 MailAgent 对外分发，AGPL 的源码提供义务是 owner 知情决策项（台账见 task research/avatar-lab-v2-analysis.md §5）。
> **0813 成品目录化**（owner 拍板「直接照搬库」）：studio 成品 avatar 目录（10 个成品的调参几何 + 组合身体）
> 与 27 条 studio 精修表情全量搬入；owner 称已获上游作者 X 私信授权（2026-08-13）。

## v2 引擎模型（与 v1 的代际差异）

- **表情 = 15 个数值参数**（头部欧拉角 ×3 + 双眼宽/高/位置/角度 + 间距 + 透视），27 个表情是一张 27×11 的参数表
  （`expressions.ts`，0813 起 = avatar-lab **studio 精修表**：同 id 数值再调过、另加 2 条新表情 25/26；
  索引语义与 POOLS 引用不变——🔴 studio 文档里数组是乱序的，本表按 id 编号重排，闸在 expressions.test.ts）。
  v1 的 `expressions.json`（烘焙 48 点轮廓）已删除。
- **真 3D 转头**：表情的 headX/Y/Z 经四元数 → 透视投影（focal 620），头部轮廓随姿态实时重投影；
  眼睛是圆角矩形**贴合在曲面上**（`surfaceFrontSampleAt`），转头时随曲面弯曲、转到背面（法线和 ≤0）隐藏。
- **过渡 = 逐字段插值**：spring（状态切换 420ms，有过冲回弹）/ smooth（池内轮换 500ms）；
  头/眼角度族过渡前做 nearest-angle 折叠（不绕远路）。v1 的临界阻尼弹簧 morph 退役。
- **状态驻留闸（0813 净新增）**：`setState` 带 600ms min-dwell 去抖 —— 驻留未满时新状态只排队
  （仅保留最新目标，不播中间态；折回当前态即撤销排队），期满由 tick 一次性切到最新目标。
  收「快速 stage 抖动（thinking↔calling-tool↔writing）逐次 spring 重定向 = 持续甩头」；
  600ms = 420ms spring 播完 + 观感余量，且 < 最短表情轮换节奏（searching 1000ms）。
  `STATE_MIN_DWELL_MS` 是引擎模块内常量，勿 env 化。
- **眨眼 = 高度插值**（5px 下限，闭 42% 二次加速 / 睁 58% 二次减速）——眨眼中眼形保持圆角（v1 是 scaleY 压缩）；
  时长按状态分档（BLINK 表第三元：calm 420ms / reactive 220ms…）。
- **ambient 空闲微动（v2 净新增）**：`AMBIENT` 表按状态配 eyes（microSaccades/shake）× body（slowDrift/shake），
  确定性 sin-hash 噪声（可回放）。ambient 活跃的 animated 实例**永不 settle**，引擎内部 30fps 限频兜功耗。
- **gaze**（v1 特性保留、v2 重实现）：指针 → 头部朝向（yaw ±10° / pitch ±7°）+ 眼睛偏移叠加。

## 模块地图（`frontend/src/shared/bot-avatar/`，零外部依赖，桌面 + 远程 web 通用）

| 文件 | 职责 |
|---|---|
| `surfaces.ts` | 8 种曲面原语的采样层（superellipsoid 家族 + capsule/cone/cylinder 剖面）：`surfacePointAt`（经纬→点，头轮廓用）/ `surfaceFrontSampleAt`（脸面坐标→正面点+法线，眼睛贴合用）/ `surfacePresets` 出厂尺寸 |
| `geometry.ts` | 3D 姿态与投影渲染：四元数、`poseFromExpression`、`renderAvatar(pose, surface, blink, bodyNodes)` → 头/背层/前层/双眼 path；sphere/capsule 走椭球解析投影，cube/diamond 顶点凸包，cylinder/cone 采样凸包（模块级 cache；mickey 耳/cursor 锥内建复合背层已随自编形状退役删除）；附属曲面 = lab accessoryLayers 同款（17×49 采样凸包 + 逐帧按相机深度 z 排序分背/前层，阈值 = 自身深度半径 ×0.1）；`Expression`/`BodyNodeDef` 类型 + `expressionFields` + `nearestEquivalentAngle` |
| `expressions.ts` | 27 表情参数表（studio 精修版，索引语义不变）+ `NEUTRAL_EXPRESSION`；**改一行 = 改所有引用该索引的状态的脸** |
| `ambient.ts` | 空闲微动纯函数：`applyAmbientMotion`（眼抖/头漂进表情参数）+ `ambientBodyOffset`（身体平移）；确定性噪声，同 (expression, elapsed) 恒同输出 |
| `states.ts` | 39 态五张表（GROUPS/POOLS/EXPR_CADENCE/BLINK[+时长档]/**AMBIENT**）+ **MailAgent 状态映射单源**：`turnStageToBotState`（TurnStage 8 值）/ `runStateToBotState`（headless run 6 值投影），Record 全射——上游加态漏映射 = typecheck 红 |
| `shapes.ts` | 形状词表 = **10 个 lab 成品形状**（0813 成品目录化 + 自编形状退役：Grok bot→sphere / Strobi→strobi[与 Grok bot 仅 depth 差 0.0367，lab 数据如此] / Nova→capsule / Citrus→cone / Cubee→cube——后二者调参值根治 raw preset 的 viewBox 溢出实测 204/176→126/150；+5 个成品 freddy/sunee/kirby/cloudee/onee，前四者带**组合身体**；自编 cylinder/diamond/mickey/cursor 已退役）→ `BotShapeDef {primary, nodes}`；`LEGACY_BOT_SHAPE_MAP`（v1 8 形双射 + v2 退役 4 形就近入座）；`BACK_PATH_COUNT`/`FRONT_PATH_COUNT`（附属曲面槽位，逐帧 z 排序在背/前层间迁移）；`BOT_AVATAR_SHAPES` 是 parity 闸抽取锚点；viewBox `-150 -150 300 300`（组合身体按 lab 语义可少量出界，BotAvatar svg overflow:visible 镜像 lab） |
| `colors.ts` | 11 色双主题值（light/dark 各一）；浅色身体（white/yellow/gray）有 per-color eye 覆写（背景色眼睛在浅色主题会隐形）；`BOT_AVATAR_COLORS` 同为闸锚点 |
| `engine.ts` | 零 React/GSAP 纯 TS 引擎：参数化过渡 + 按态池随机调度 + 眨眼排程 + ambient + gaze（`{random, now}` 可注入）；`tick()` 空闲返回 null = settle 后零重绘（**ambient 态例外**：30fps 限频出帧）；`staticFrame(exprIndex, shapeDef)` 带模块级缓存（键 = SHAPES 的 `BotShapeDef` 单例 × 表情索引，列表同款实例零重复计算，组合身体同享缓存） |
| `ticker.ts` | 模块级共享 rAF 单例（全仓首个）：注册制启停、`visibilitychange` 暂停、SSR 安全、测试用 `__instanceCount()` |
| `staticBlink.ts` | **静态档眨眼 registry**（0813 净新增，模块级单例镜像 ticker 形状）：静态位点也眨眼但不建引擎不进共享 ticker —— 单枚 setTimeout 臂向「下一次最早眨眼」，rAF 只在 220-420ms 眨眼窗口内存活；窗口内用 `blinkScaleAt`+`renderAvatar` 高度插值重算眼 path（与 animated 档同保真度，**不是** CSS scaleY 近似），走完严格回写 `staticFrame` 缓存帧；并发上限 2（成本与实例数解耦）；节奏 = `BLINK` 表逐字；reduced-motion / `BLINK=null` 态在组件层不注册 |
| `BotAvatar.tsx` | React 组件双档：**静态档是默认**（零 ticker 零定时器，state 变化=离散换帧）；`animated` 显式声明才动（引擎 + ticker + IntersectionObserver 可见性裁剪）；`mouseInteractive` 头/眼跟全局指针（仅 animated）；`useReducedMotion()` JS 层短路恒走静态；clipPath id 经 `useId` 每实例唯一；头 path 每帧变（3D 转头）→ head 与 clipPath 都由 writeFrame 直写 |
| `random.ts` | `deriveBotAvatar`（agent_id 确定性派生，NULL 行默认外观）/ `mapLegacyGeneratedToBot`（oreo 行确定性映射）/ `randomBotAvatar` / `shuffleBotAvatar`（确定性递进 ≠ 当前）——golden 测试钉死，防重构静默换脸；v2 换词表是一次**有意的**全量换脸（索引算法未动，golden 随双射重钉） |
| `useBotAvatarTheme.ts` | 主题 hook（`data-theme` MutationObserver + useSyncExternalStore） |

## avatar_json 三种 kind 与 resolve 链

| kind | 形状 | 语义 |
|---|---|---|
| `{type:'bot', shape, color}` | canonical | 编辑器保存的选择；shape 词表 = 10 个 lab 成品形状（组合身体是形状名在 TS 侧的派生数据，wire 结构不变），v1 8 形名（blob→sphere / squircle→cube / egg→strobi / wedge→cone / hex→sunee / cloud→cloudee / teardrop→onee / capsule→capsule，保持双射）与 v2 退役 4 形（cylinder→capsule / diamond→sunee / mickey→cloudee / cursor→onee）经 `LEGACY_BOT_SHAPE_MAP` 读侧换脸，存量行不迁移不回写 |
| `{type:'image', data:'data:image/…;base64,…'}` | 上传（不变） | ≤150KB webp/png/jpeg，服务端 `_normalize_avatar_image` 复核，禁外链 |
| 无 `type` 键 `{shape, palette, …}` | legacy oreo（只读） | 存量行零迁移，渲染时经 `mapLegacyGeneratedToBot` 确定性映射 |
| `NULL` | 派生态 | 前端按 agent_id `deriveBotAvatar`（内置 agent 全靠它）；编辑器「重置」写回 NULL |

- resolve 单源 `frontend/src/shared/components/agents/agentAvatarIdentity.ts::resolveAgentAvatar` —— **恒返回 bot config**（上传态在 `AgentAvatar` 外壳层短路渲 `<img>`，不进 resolve）。
- 后端校验：`src/reports/wire.py::config_patch_to_db` 的 bot 分支（shape/color 白名单 + 键集合恰为 {type,shape,color}）；**写侧只认 v2 词表**；分支排序 None → image → bot → legacy 兜底。
- P9 导入导出：bot **原样导出**、image → null（`src/agents/plugin_compat.py`，`tests/api/test_agent_plugins.py` 钉死）。

## 跨语言 parity 闸

`tests/config/test_bot_avatar_vocab_parity.py`：Python `BOT_AVATAR_SHAPES/COLORS`（wire.py，canonical）↔ TS 同名导出（shapes.ts/colors.ts）+ `AVATAR_IMAGE_MAX_BYTES` 150KB 两侧（0804 旧债一并入闸）。TS 侧契约 = `export const BOT_AVATAR_SHAPES = […] as const` 恰好一次、数组字面量勿改计算生成；抽取失败必红（canary 钉死）。**改词表 = 两侧 + 断言三处一起动**。

## 渲染档位纪律（性能红线）

- **静态是默认档**：8 个既有渲染位点（Agents 卡/会话列表行/报告卡/run 历史/@mention/审批卡…）全部经 `AgentAvatar` 静态渲染，列表恒静态——**新增 animated 位点须过性能评估**。静态帧有模块级缓存（shape×表情），列表数百实例只算一次几何。
- animated 位点现存 3 处常驻：chat 回合头像 `TurnPresence`（28px）、面板头 `AssistantPanelBotAvatar`（20px）、编辑器预览（48px，+mouseInteractive +showcase 巡演）；另有 **hover 瞬时位点**（0813）：Agents 页六张卡（主 Agent + 5 类 agent 卡）hover 时经 `useAvatarHoverShowcase` 转 animated + 随机换动作，离开即回静态——鼠标只有一个，同屏至多一张卡在动，性能评估随 hook 注释记录。
- **showcase 巡演**（`useShowcaseState`）：从 12 态表现力池每 2.4s 随机换动作（不连续重复）；reduced-motion 恒 'idle'（巡演不得绕过静态纪律）。消费点 = 编辑器预览（Bot tab 常开）+ hover 卡。
- 🔴 **v2 新边界**：ambient 活跃状态（多数状态 body slowDrift）的 animated 实例**常驻 30fps 重绘**（不 settle）——这是「空闲也活着」的有意代价，仅限上述 3 位点；改 `AMBIENT` 表 = 改动画位点常驻功耗。
- **静态档眨眼（0813）不破静态地板**：静态位点经 `staticBlink.ts` registry 低频眨眼——间隙真 idle（无周期唤醒无 rAF 无样式计算，只有一枚臂向下次眨眼的 timeout）、并发上限 2 把最坏帧成本钉成常数（同屏数百实例 = 每个眨得更稀的优雅降级）、眨眼帧走引擎同款高度插值（两档观感一致）。眨眼只重算眼 path，**只传 `primary` 不传 `nodes`**（眼几何不依赖附属曲面，传了等于每个眨眼帧白付一遍凸包）。静态档的**表情轮换**仍有意不做（离散换帧无过渡 = glitch 观感，加过渡 = 开动画通道破纪律）——但 `expressionIndex` prop 允许消费点**指定**静态表情（FAB 低频换脸即用它），此时眨眼基线必须跟随同一索引，否则眨眼那一刻脸会跳回池首。
- reduced-motion：JS 层短路（CSS media 对 JS 动画无效），animated 自动退化静态、**静态档眨眼同样不注册**；测试环境全局 reduce（`tests/setup.ts`），测真动画路径需 stub matchMedia。
- 机器验收：10 形 × 代表表情的头/眼/背/前几何 sanity + 双眼不重叠 + 27 表情全量无 NaN + **viewBox 溢出闸**
  （单曲面成品 ≤150 / 组合身体 ≤200；自编形状退役后曾经的 cylinder/mickey 遗留溢出不复存在，
  `tests/shared/bot-avatar/shapes.test.tsx`）。
- 组合身体的代价：附属曲面每帧 17×49 采样 + 凸包（模块级 cache 只免采样、不免投影）——静态档进 `staticFrame`
  模块缓存零增量；animated 档最重的 sunee（8 节）每帧 ≈ 2.7× 一个圆角 cylinder 头的投影量，仅限 3 个 animated 位点。

## chat 嵌入（TurnPresence）

- 挂载：进行中回合的**最新 assistant 消息**内容上方（`message.tsx` + `AgentMessage.tsx` 两面同款），run 全程常驻；历史消息/只读回放零头像。**不能放 assistant-ui Empty slot**（parts 非空即卸载，头像要跨 writing/tool 阶段存活）。
- 文字区沿用 TurnStatusLine 三代 shimmer 治理的显隐纪律（connecting/thinking shimmer、stalled/error 静态、writing/calling-tool/awaiting-approval 只留头像不出字）；**DotMatrix 已从消息流退役**（头像即动效载体），`ThreadRunStatusBar`（composer 药丸）与 DotMatrix 本体不动、两条并存。
- celebrate 时序：下降沿到 idle 且消息 status='complete'（abort 不庆祝）→ celebrate 2.5s → 380ms 淡出卸载；边沿经 prev ref 去重，重渲染不重播；reduced-motion 直接消失。
- 会话头像：agent 会话经 `resolveAgentAvatar`；interactive 默认会话 = **主 agent 身份**（见下），未配置回官方形象 `OFFICIAL_ASSISTANT_AVATAR`（sphere/orange，`agentAvatarIdentity.ts` 导出）。

## 主 agent 身份（0813）

- 持久层 = `agent_config.db` owner_settings `assistant_identity`（JSON `{name, avatar}`），端点
  `GET/PUT /api/agent/assistant-identity`（owner-only，校验复用 wire.py 的 bot 词表 + image 规则——不手抄第二份）。
- renderer 投影 = `shared/assistant/assistantIdentity.ts`（模块级 store + useSyncExternalStore，
  **不走 react-query**——TurnPresence 挂在多种宿主里，不能假设树上有 QueryClientProvider；
  显示型数据读失败静默用默认值，60s TTL；设置页写完 `primeAssistantIdentity` 即时广播）。
- 消费点：`TurnPresence`（名字进「{name} 思考中…」ICU 插值 + 回合头像）、`AssistantPanelBotAvatar`、
  `AiChatPanel` 标题（名字压过 i18n `chat.title`）。avatar 为上传图时 chat 两位点渲染静态 img
  （表情对图片无意义）；bot 配置照常动画。
- 配置面 = Agents 页顶部「主 Agent」卡（`MainAssistantCard.tsx`）：名字（≤40 字符，trim，空折 null）
  + `AgentAvatarEditor` 复用（value 恒喂官方形象兜底，重置 = 回官方脸）；系统提示词指路到
  设置 → AI → 身份文档（不重复可写面）。

## 改动指南

- **加形状**：surfaces.ts 加原语（或复用现有 type 调 `SHAPES` 尺寸）→ shapes.ts 词表 + `BACK_PATH_COUNT` → 两侧词表（TS + wire.py）+ parity 断言 → 跑 shapes 几何 sanity → 编辑器网格自动跟随词表。
- **加颜色**：colors.ts 双主题值（浅色补 eye 覆写）→ 两侧词表 + 断言。
- **改状态映射/节奏/微动**：只动 states.ts（单源）；上游 TurnStage/run_state 加值会因 Record 全射在 typecheck 红；改 AMBIENT 先过性能纪律（见上）。
- **调表情**：expressions.ts 参数行（15 参数比 v1 的 96 个点好调一个数量级）；所有引用该索引的状态池同时变脸，先过设计评审。
