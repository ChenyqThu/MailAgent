# Phase 1·T6 — MailAgent Mascot 出图规格

> **状态**：2026-05-23 立项。Phase 1·T4 ship 时用 SF Symbol fallback（briefcase / person.crop.circle / ant / envelope）—— 视觉差异已可见但不足以体现 MailAgent 品牌。T6 用真 pixel-art GIF/PNG 替换。
>
> **本文档目标**：给生图 AI（Midjourney / Stable Diffusion / DALL-E / NanoBanana / etc）+ 设计验收用。包含 4 只 mascot 的角色 brief、视觉风格 token、prompt 模板、文件命名、合格验收清单。
>
> **关联**：
> - PRD: `~/.claude/plans/ultrathink-session-curious-cloud.md` §5.1 Phase 1·T6
> - 视觉契约：MailAgent 主仓 `frontend/mockup-dynamic-island.html` v4 §3 「专属 Mascot 系统」
> - 现有占位 imageset: `PingIsland/Assets.xcassets/Mail{Logo,MascotWork,MascotPersonal,MascotDev}.imageset/`

---

## 0. 总览

| Mascot id | 角色 | 用途 | 默认 SF Symbol fallback |
|---|---|---|---|
| `default` (MailLogo) | 通用 mail logo | profile 注册（settings → clients 列表）+ scenario 兜底 | `envelope.fill` |
| `work` (MailMascotWork) | **Postman 信使** | 公司域邮件（@omadanetworks.com 等用户公司域）| `briefcase.fill` |
| `personal` (MailMascotPersonal) | **Pidgeon 衔信灰鸽** | 个人邮箱（Gmail / iCloud / QQ / 163 等）| `person.crop.circle.fill` |
| `dev` (MailMascotDev) | **DevBot 绿色终端机器人** | 开发者通知（GitHub / Sentry / Vercel / Stripe 等机器邮件）| `ant.fill` |

domain → mascot id 映射规则在 plugin 端 `src/notify/island_dispatch.py:_resolve_mascot()`（envelope.metadata.mailagent.mascot 决定 fork 端选哪个 imageset）。

---

## 1. 通用视觉风格（4 只共享）

| 维度 | 要求 |
|---|---|
| **风格** | **8-bit / 16-bit pixel art**（参考 Ping Island 原 Hermes / Claude 等 mascot 风格 — 像素感强、轮廓清晰、颜色块状）|
| **尺寸** | **64×64 PNG transparent**（导出时同时给 32×32 + 128×128 三档 @1x/@2x/@3x for Asset Catalog）|
| **背景** | **完全透明** —— PNG alpha channel，不要任何白底/纯色背景方块 |
| **轮廓** | 1-2 px 深色外轮廓（深色 = 角色主色调降 50% 明度），让 mascot 在 32×32 灵动岛缩略时仍清晰 |
| **风格情绪** | **可爱但不卡通过头** — 不要 Disney 大眼睛 / 不要 chibi。Pixel game style（Stardew Valley / Undertale / Octopath Traveler tier）|
| **正面朝向** | mascot 正脸 / 3/4 侧脸，**面向观众**。不要侧身/背面/动作 pose |
| **动效** | GIF 可选（≤ 8 帧，呼吸 / 眨眼），但 PNG 静态也 OK（fork 端可后续替换）|
| **禁止** | ❌ 真实照片风 / 3D 渲染 / glossy 反光 / Material Design 拟物 / Memoji 风 / Apple SF Symbol 风 |

**风格 reference**：
- 参考 1: Ping Island 自带 mascot — `~/Documents/ping-island/PingIsland/Assets.xcassets/HermesMascot.imageset/` `ClaudeMascot.imageset/` 看现有 mascot 风格（同一画风更好融入）
- 参考 2: Stardew Valley 角色头像（pixel-art portrait）
- 参考 3: 16-bit JRPG 角色立绘

---

## 2. 四只 Mascot 角色 brief

### 2.1 Postman 信使（work）

**身份**：橙色制服的邮政信使，背后挎一个小邮包，手里也许拿一封信。

**视觉关键**：
- 主色调：橙色 `#C26A3E`（mockup §3 已定）—— 帽子 + 制服外套
- 副色：奶白 `#F8C99C` 面部，深棕 `#5A2E15` 邮包/腰带，白色信封点缀
- 表情：**专业、可靠、略严肃**（不是傻乐）—— 眼睛是简单的两个黑点像素，嘴巴微微抿着
- 配饰：邮政帽（圆顶 + 短檐）+ 制服领口的小铜扣
- pose：正脸或 3/4 面，肩膀以上

**给生图 AI 的 prompt 模板**：
```
pixel art portrait of a friendly postal worker, 16-bit retro game style,
warm orange uniform with brass buttons, postal cap, square shoulders,
serious but kind expression, two small black dot eyes, slight mouth,
small white envelope visible on shoulder, transparent background,
clean outlined sprite, character bust shot from chest up,
no anti-aliasing, distinct color blocks, palette: orange #C26A3E, cream #F8C99C, dark brown #5A2E15, accent white
--ar 1:1 --style raw --v 6
```

**合格验收**：
- ✅ 一眼看出是"信使 / 邮政员"职业
- ✅ 橙色为绝对主色（占面积 > 40%）
- ✅ 严肃专业感（看到这只就知道是「工作邮件」严肃场景）
- ✅ pixel 风格鲜明，不是涂抹模糊的"伪 pixel" AI 输出
- ✅ 64×64 缩到 32×32 看仍清晰可辨

---

### 2.2 Pidgeon 衔信灰鸽（personal）

**身份**：一只温和的灰色信鸽，嘴里衔着一张小纸条/小信。

**视觉关键**：
- 主色调：灰 `#6B707A`（mockup §3 已定）—— 身体 + 翅膀
- 副色：浅灰 `#C8CDD4` 头部 + 腹部，深灰 `#454A53` 翅膀阴影，纯白小纸片在嘴里
- 表情：**温和、低调、有点呆萌**（personal 邮件不打扰的气质）
- 形态：**站姿**（不是飞行）、圆胖体型、橙色小爪子（不要太抢眼）
- pose：正脸或 3/4 面，**嘴里必须有一小张白色纸/信**（key visual hint）

**给生图 AI 的 prompt 模板**：
```
pixel art portrait of a chubby gray homing pigeon, 16-bit retro game style,
soft fluffy body, light gray head and belly, darker wings,
calm and slightly sleepy expression, small black dot eyes,
holding a small white folded paper note in beak (very visible),
transparent background, clean outlined sprite, standing pose facing forward,
no anti-aliasing, distinct color blocks, palette: medium gray #6B707A, light gray #C8CDD4, dark gray #454A53, paper white, orange feet
--ar 1:1 --style raw --v 6
```

**合格验收**：
- ✅ 一眼看出是"鸽子 / 信鸽"（不是其他鸟）
- ✅ 嘴里**必须**有可见的小纸/信件（不然失去 personal mail 隐喻）
- ✅ 温和气质（不要凶狠或战斗姿态）
- ✅ 灰色为绝对主色（不要其他鸟 species 干扰，鸽子就该灰）
- ✅ 站姿圆胖，不是飞行

---

### 2.3 DevBot 绿色终端机器人（dev）

**身份**：一个绿色像素机器人，胸口有终端屏幕显示 `>_` cursor，整体是「赛博 + 像素」气质。

**视觉关键**：
- 主色调：薄荷绿 `#5DBA8C`（mockup §3 已定）—— 机身金属外壳
- 副色：深绿 `#2E6E48` 阴影/关节，亮绿 `#A8FFB8` 眼睛/cursor 高光（CRT 屏幕发光感），深灰 `#3D5045` 屏幕背景
- 表情：**机器感、冷静、专业** —— 两只方形 LED 眼睛（绿光），可能有天线
- 配饰：胸口 / 头部有一块小 CRT 屏幕，屏幕里像素 `>_` 字符闪烁
- pose：正脸，方头方脑，整体几何感强

**给生图 AI 的 prompt 模板**：
```
pixel art portrait of a friendly green retro robot, 16-bit cyber game style,
mint green metallic body with darker green shadows,
two square glowing LED eyes in bright green,
small CRT terminal screen on chest showing pixel `>_` cursor in bright green,
slight antenna on head, transparent background, clean outlined sprite,
character bust shot, no anti-aliasing, distinct color blocks,
palette: mint green #5DBA8C, dark green #2E6E48, glow green #A8FFB8, dark slate #3D5045
--ar 1:1 --style raw --v 6
```

**合格验收**：
- ✅ 一眼看出是"机器人 / 程序员的工具"
- ✅ 胸口/头部**必须**有终端屏幕（`>_` cursor 或 code line 视觉）
- ✅ 绿色为绝对主色（不要混蓝/紫，绿是 dev/terminal 文化色）
- ✅ 方头方脑几何感（不要圆润可爱风）
- ✅ 不要给机器人加表情过多人化（不要笑脸）

---

### 2.4 Mail Logo 通用兜底（default）

**身份**：一个**简单的信封图形**，作为 MailAgent 整体品牌 logo（不是有"人格"的角色）。

**视觉关键**：
- 主色调：MailAgent 主题色 coral `#E5654B`（默认）—— 信封封口三角
- 副色：奶白 `#F0E8DE` 信纸/底色，深棕 `#7E3D32` 阴影
- 形态：**经典信封外形**（长方形 + V 字封口）—— 不要花哨变形
- 可选：信封中央有一个像素邮票（小方块 + 不规则锯齿边），或者 wax seal（蜡封）
- pose：正面、对称、稳重 —— 它是 logo 不是角色

**给生图 AI 的 prompt 模板**：
```
pixel art icon of a classic envelope, 16-bit retro game style,
warm coral red color with V-shaped flap, cream white paper showing,
small wax seal or pixel stamp in center, slight shadow underneath,
transparent background, clean outlined icon, centered composition,
symmetrical and stable, no anti-aliasing, distinct color blocks,
palette: coral #E5654B, cream #F0E8DE, dark brown #7E3D32, accent gold
--ar 1:1 --style raw --v 6
```

**合格验收**：
- ✅ 一眼看出是"邮件 / 信封"（最直观的 mail metaphor）
- ✅ Coral 红色为绝对主色
- ✅ 对称稳重，作为 brand logo 而非角色
- ✅ 不要拟人化、不要添加眼睛嘴巴
- ✅ 64×64 缩到 16×16 menu bar 图标尺寸仍能识别（最关键验收）

---

## 3. 文件交付清单

每只 mascot 需要交付 **3 档分辨率 PNG**（也可加 1 个 GIF 动效，可选）：

```
PingIsland/Assets.xcassets/MailLogo.imageset/
├── Contents.json            (已存, 不动)
├── MailLogo.png             # 64×64 @1x
├── MailLogo@2x.png          # 128×128 @2x
└── MailLogo@3x.png          # 192×192 @3x

PingIsland/Assets.xcassets/MailMascotWork.imageset/
├── Contents.json            (已存, 不动)
├── MailMascotWork.png       # 64×64 @1x
├── MailMascotWork@2x.png    # 128×128 @2x
└── MailMascotWork@3x.png    # 192×192 @3x

PingIsland/Assets.xcassets/MailMascotPersonal.imageset/
├── Contents.json            (已存, 不动)
├── MailMascotPersonal.png   # 64×64
├── MailMascotPersonal@2x.png
└── MailMascotPersonal@3x.png

PingIsland/Assets.xcassets/MailMascotDev.imageset/
├── Contents.json            (已存, 不动)
├── MailMascotDev.png        # 64×64
├── MailMascotDev@2x.png
└── MailMascotDev@3x.png
```

**注意**：
- `Contents.json` 已经存在（Sprint 1 fork commit `67c8fd9` 已 ship），**不要重新生成**
- PNG 文件直接放到对应 `*.imageset/` 目录覆盖现有 CSS 像素占位
- 不需要交付 SVG（Asset Catalog 不直接用 SVG，加载性能也 PNG 更优）

---

## 4. 验收 checklist（给用户用）

**对每只 mascot 检查**：

- [ ] **风格一致**：4 只 mascot 跟 Ping Island 原 Hermes/Claude 等 mascot 风格相容（不要混 anime 跟 pixel 两套风格）
- [ ] **角色辨识度**：blind test — 给一个不知情的人看，能不能猜出 4 只各自是什么 + 跟什么场景关联
- [ ] **缩略可读**：64×64 缩到 32×32（灵动岛真实显示尺寸）仍能看清主特征
- [ ] **轮廓清晰**：不要 AI 常见的"模糊涂抹"伪 pixel —— 边缘应该是清晰像素阶梯
- [ ] **配色符合 mockup §3**：work=橙 / personal=灰 / dev=绿 / default=coral，主色占面积 >40%
- [ ] **透明背景**：PNG 打开看 alpha 是不是真透明（不能有白色 / 灰色背景方块）
- [ ] **正面朝向**：mascot 面向观众，不是侧身/背面
- [ ] **不卡通过头**：不是 Disney chibi / 不是 Memoji / 不是 3D 渲染 / 不是 SF Symbol 风

**不合格情形（重做）**：
- ❌ 4 只风格不统一（看起来像不同游戏的角色）
- ❌ 角色辨识度低（要解释才能看懂）
- ❌ 配色跑偏（work 不橙、dev 不绿）
- ❌ AI 模糊涂抹的伪 pixel（不锐利）
- ❌ 背景不透明（有白/灰底）

---

## 5. 验证流程（出图后）

1. **放图到 imageset**：把 PNG 按 §3 命名放到对应 `*.imageset/` 目录
2. **改 MailAgentSessionView 的 mascot fallback** —— 把 SF Symbol 替换为 `Image("MailMascotWork")` 等真 imageset 引用（PingIsland/UI/Views/MailAgentSessionView.swift `mascotStyle` helper 当前用 `Image(systemName:)`，需要切换到 `Image("MailMascotXxx")` 加 `.resizable()` `.scaledToFit()`）
3. **xcodebuild build** 验证 imageset 加载
4. **手测**：`nc -U /tmp/island.sock` 喂一个 `MailReceivedUrgent` envelope 含 `mailagent.mascot=work`，看灵动岛上是不是真出 Postman 像素图

---

## 6. Prompt 库整合（一个 prompt 出全 4 只）

如果生图 AI 支持 batch / 一致性约束，建议放到同一个 prompt 让 4 只共享视觉语言：

```
Generate 4 pixel art mascot portraits for a desktop mail app, all in
matching 16-bit retro game style, transparent background, 64x64 pixel
resolution, character bust shot facing forward:

1. POSTMAN (work): friendly postal worker in warm orange uniform with
   brass buttons and postal cap, small white envelope on shoulder,
   serious professional expression. Palette: #C26A3E orange, #F8C99C
   cream face, #5A2E15 dark brown details.

2. PIDGEON (personal): chubby gray homing pigeon with light gray belly
   and darker wings, holding a small white folded paper note in beak,
   calm sleepy expression, standing pose. Palette: #6B707A gray,
   #C8CDD4 light gray, #454A53 dark gray, orange feet.

3. DEVBOT (dev): friendly green retro robot with mint green metallic
   body, square glowing green LED eyes, small CRT terminal screen on
   chest showing pixel `>_` cursor, slight antenna. Palette: #5DBA8C
   mint, #2E6E48 dark green, #A8FFB8 glow green, #3D5045 dark slate.

4. MAIL_LOGO (default): classic envelope icon in coral red with V-flap,
   cream white paper inside, small wax seal in center, symmetrical and
   stable (not a character). Palette: #E5654B coral, #F0E8DE cream,
   #7E3D32 dark brown.

All 4 sharing identical art style: clean outlined sprites, no anti-
aliasing, distinct color blocks, character at chest-up height (except
mascot #4 which is just an icon), transparent PNG output.

Reference style: Stardew Valley character portraits / 16-bit JRPG sprites
NOT: 3D rendered / glossy / Disney chibi / Memoji / Apple SF Symbol
```

---

**完工标志**：4 个 `*.imageset/` 内有真 PNG（不是 CSS 占位），MailAgentSessionView 引用从 SF Symbol fallback 切到真 imageset，灵动岛实测显示。

**作者**：Claude Opus 4.7（1M context），代表 chenyqthu
**日期**：2026-05-23
