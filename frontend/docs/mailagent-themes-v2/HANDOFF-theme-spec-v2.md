# MailAgent · 主题系统 v2 — 设计规范 Handoff（磨砂 & 主题色重做 · **定稿版 2026-06-12**）

> 状态：**定稿**。玻璃气质默认 = **染色 tinted**，knob 默认值见 §3.1；气质与高级调节作为**用户设置**暴露在「设置 → 通用 → 外观」（§3.5）。
> 取代 `mailagent-themes/HANDOFF-surface-themes.md`（v1）中的三档材质规格。
> 像素参照（可交互）：`mailagent-themes-v2/MailAgent Theme v2.html`（标题栏滑杆按钮 = 设置面板 mock）
> 配方源文件（production-shaped CSS，可直接 diff/搬运）：`mailagent-themes-v2/theme-v2.css`
> 实现步骤见同目录 `HANDOFF-theme-impl-v2.md`；Claude Code 启动 prompt 见 `PROMPT-claude-code.md`。

---

## 0. 这次改了什么（决策记录）

| 决策 | 内容 | 理由 |
|---|---|---|
| **砍掉「液态」档** | `SurfaceStyle` 收敛为 `solid \| frosted` 两档 | 液态做不出真实折射、与磨砂区分度低、费 GPU（用户拍板） |
| **磨砂重构：一块玻璃** | 整窗只有一层 blur 基底；面板不再各带 backdrop-filter / 各异 alpha | 修复「面板深浅不一、整窗花」；性能也从 5 个 blur 区域降为 1 个 |
| **玻璃染色** | accent 用 `color-mix` 揉进玻璃基色（4–9%）+ 高 saturate | 修复「发灰浑浊」；让主题色与材质氛围连贯 |
| **噪点 + 镜面高光** | 一层静态 SVG 噪点 + 标题栏 1px specular | 修复「质感太平」，零逐帧成本 |
| **accent 全面重调（oklch）** | 6 色统一 L/C，coral 从 hue≈40（橙）移到 hue 28（真珊瑚） | 修复「coral 偏橙发闷」；6 色亮度彩度一致 |
| **单光源氛围光** | 窗口左上角一个 accent radial，替代壁纸里多个不连贯的模糊圆点 | 修复「各区域模糊圆点不连贯」 |
| **回退壁纸重画** | 无 vibrancy 平台的内置壁纸 = accent 派生的单光源渐变场 | 同上，且换 accent 自动跟色 |
| **定稿：染色为默认气质** (06-12) | knob 默认 = §3.1 的定稿值（alpha .85 / blur 30 / sat 1.8 / mix 16% / ambient .20 / grain .07） | 评审拍板 |
| **气质+高级调节 = 用户设置** (06-12) | 不再是评审期 A/B，进「设置→通用」，默认值即定稿值 | 给用户可控的个性化空间，同时出厂体验可控 |

## 1. 维度模型（4 + 1 维）

```html
<html
  data-theme="dark|light"            <!-- 明暗 -->
  data-accent="(无)=coral|cobalt|teal|rose|slate|olive"
  data-surface="(无)=frosted|solid"  <!-- 液态已删除 -->
  data-vib="on|off"                  <!-- 主进程回写: 原生 vibrancy 是否生效 -->
  data-glass="neutral|tinted|bright" <!-- 玻璃气质 — 用户设置, 默认 tinted -->
>
```

- `data-glass` 是**持久化用户设置**（设置→通用，§3.5），默认 `tinted`。高级调节（knob 覆写）同样持久化，以 inline CSS 变量形式盖在气质预设之上。
- 其余维度与 v1 一致：互相独立、localStorage 各一个 key、首帧 inline bootstrap 防闪。

## 2. Accent v2 — oklch 重调的 6 色

**设计源（真源）是 oklch，RGB triplet 是导出物。** 调色只动 oklch，重新导出 triplet。

- 暗色：`oklch(0.75 0.135 H)`（slate C=.035、olive C=.105、teal C=.125 刻意压低）
- 亮色：`oklch(0.50 0.14 H)`（teal 用 L .485 过 AA）
- hover (`-hi`)：L −0.05；深档 (`-dim`)：暗色 L .47 / 亮色 L .36

| Accent | Hue | 暗 accent | 暗 hi | 暗 dim | 亮 accent | 亮 hi | 亮 dim |
|---|---|---|---|---|---|---|---|
| coral (默认) | 28 | `248 138 125` | `230 123 110` | `142 63 54` | `164 60 51` | `144 40 34` | `104 35 29` |
| cobalt | 262 | `126 173 255` | `111 157 242` | `55 89 152` | `52 95 178` | `36 77 158` | `30 58 113` |
| teal | 178 | `55 199 174` | `25 183 158` | `0 110 91` | `0 117 95` | `0 100 80` | `0 77 61` |
| rose | 357 | `241 136 175` | `224 120 160` | `138 61 92` | `158 58 100` | `138 39 84` | `100 34 62` |
| slate | 250 | `158 176 196` | `142 161 180` | `76 93 110` | `82 101 122` | `66 84 104` | `47 63 79` |
| olive | 122 | `163 185 108` | `147 169 92` | `81 99 18` | `89 108 23` | `73 91 0` | `53 68 0` |

**对比度验证（已算）**：暗色 accent 对 ink-1/2/3 全部 ≥ 6.6:1；亮色全部 ≥ 4.75:1；CTA 渐变底端白字全 6 色 ≥ 5.6:1。换色值后请用脚本复测（实现 handoff §7）。

## 3. 磨砂材质规范 —「一块玻璃」

结构（自底向上）：

```
真实桌面
 └─ ① 玻璃基底（整窗唯一一层 blur）
      生产 = OS vibrancy/acrylic + html 透明 + 一层 CSS tint
      tint = color-mix(ink-0 ← white --glass-white-mix ← accent --glass-accent-mix)
             @ alpha --glass-alpha
      + 氛围光: radial(左上, accent / --ambient) — 全窗唯一的 accent 光源
      + 顶部 4% 白渐变（玻璃受光面）
 └─ ② 面板分层 .glass-* — 【无 backdrop-filter】只有均匀白色 overlay (--tier-*)
 └─ ③ 噪点 .grain — 静态 SVG turbulence, overlay/multiply 混合
 └─ ④ 镜面高光 .specular::after — 标题栏上沿 1px 渐变
 └─ ⑤ 内容（文本永远实色）
```

### 3.1 调参 token（全部在 `:root`）— **定稿默认值 (tinted)**

| Token | 暗（定稿默认） | 亮（护栏微调） | 说明 |
|---|---|---|---|
| `--glass-alpha` | **0.85** | 0.85 | 基底 tint 不透明度。**护栏：暗 ≥0.50 / 亮 ≥0.72** |
| `--glass-blur` | **30px** | 30px | **仅回退路径/demo 生效**；macOS/Win11 由 OS 扫blur |
| `--glass-sat` | **1.8** | 1.4 | 透过色饱和增益 — 抗发灰主力。亮色超 1.5 会脏，故下调 |
| `--glass-bright` | 1.0 | 1.06 | 亮色玻璃要奶白，靠提亮不是靠加白字 |
| `--glass-accent-mix` | **16%** | 16% | accent 揉入玻璃基色比例（neutral=0 / bright=6%） |
| `--glass-white-mix` | 0% | 10% | 基色抬白（bright 档暗 10% / 亮 40%） |
| `--grain` | **0.07** | 0.07 | 噪点 opacity；暗用 overlay、亮用 multiply 混合 |
| `--ambient` | **0.20** | 0.16 | 左上 accent 氛围光强度（neutral=0）。亮色防眩光下调 |

> 亮色列中偏离定稿值的两项（sat 1.4 / ambient 0.16）是可读性护栏，其余与暗色共用同一默认。

### 3.2 面板分层 `--tier-*`（面板差异的唯一来源）

| 层 | 类名 | 暗 | 亮 |
|---|---|---|---|
| 标题栏/状态栏 | `.glass-bar` | `white/.04` | `white/.38` |
| 侧栏 | `.glass` | `transparent`（最透） | `transparent` |
| 列表 | `.glass-2` | `white/.03` | `white/.32` |
| 详情（阅读面） | `.glass-3` | `white/.065`（最亮） | `white/.62` |
| AI 面板 | `.glass-panel` | `white/.045` | `white/.44` |
| 真浮层（popover/menu） | `.glass-pop` | 唯一保留自带 blur(20px) 的层 + hairline + pop-shadow | 同 |

### 3.3 玻璃气质三档（用户设置预设，默认染色）

| 档 | `data-glass` | 一句话 | knob 差异（相对定稿默认） |
|---|---|---|---|
| **染色（默认）** | `tinted` | accent 揉进玻璃 + 单光源氛围光，品牌感最强 | 无（即 :root 默认值） |
| 银纱 | `neutral` | 近中性、克制，最接近 macOS 系统材质，阅读优先 | mix 0% · alpha .88/.90 · sat 1.5/1.25 · ambient 0 · grain .05 |
| 亮砂 | `bright` | 基色抬白、整体提亮，轻盈接近 acrylic | white-mix 10%/40% · alpha .78/.76 · sat 1.7 · bright 1.06+ · ambient .12 |

切换气质 = 加载该档预设并**清空高级调节覆写**（§3.5 行为规则 R2）。

### 3.4 实色档 & 降级

- `data-surface="solid"`：不透明 ink-0/1/2/3 梯度；噪点、specular、一切发光 box-shadow 全关（实色 = 安静）。
- `prefers-reduced-transparency: reduce` → 等价 solid。
- `data-vib="off"`（Linux/Win10）→ 窗内自绘 `--wp-fallback`（accent 派生单光源渐变场，见 theme-v2.css），**零 blur**（壁纸本身是平滑渐变，无需模糊）；详情层 alpha 加深一档保可读。

### 3.5 设置 → 通用 → 外观（用户设置规范）

demo 中的设置面板 mock（标题栏滑杆按钮打开）即交互参照。控件清单与顺序：

| 控件 | 形态 | 选项/范围 | 默认 |
|---|---|---|---|
| 主题 | segmented | 暗色 / 亮色（如已有「跟随系统」保留三态） | 暗色 |
| 主题色 | 6 色 swatch | coral/cobalt/teal/rose/slate/olive | coral |
| 窗口材质 | segmented | 实色 / 磨砂 | 磨砂 |
| 玻璃气质 | segmented | 银纱 / 染色 / 亮砂 | 染色 |
| 高级玻璃调节 | 6 滑杆 + 「恢复默认」 | 不透明度 0.50–0.95/0.01 · 基底模糊 8–40px/1 · 饱和增益 1–2.2/0.05 · Accent 染色 0–20%/1 · 氛围光 0–0.30/0.01 · 噪点 0–0.12/0.005 | §3.1 定稿值 |

行为规则：
- **R1** 玻璃气质与高级调节仅在「磨砂」材质下可用；「实色」时置灰（不隐藏，避免控件跳动）。
- **R2** 切换气质清空高级调节覆写（滑杆回到该档预设值）；「恢复默认」只清覆写、不改气质。
- **R3** 「基底模糊」仅在无原生 vibrancy（`data-vib=off`）时生效 — macOS/Win11 上显示但加说明文案，或直接隐藏（实现二选一，建议加文案）。
- **R4** 所有控件实时预览（拖动即生效），无「应用」按钮；全部持久化。
- **R5** 滑杆范围即护栏：不透明度下限 0.50（亮色主题下实现层 clamp 到 0.72），噪点上限 0.12。用户调不出不可读的组合。

## 4. Accent 材质化表达（配方类）

accent 预算规则不变（每主界面 ≤4 处），但每一处从「平涂」升级为「发光体」。全部用相对色法从 `--c-accent` 派生，换色自动跟：

| 配方类 | 用在 | 做法 |
|---|---|---|
| `.acc-cta` | 主 CTA（起草回复） | 纵向渐变 `--cta-top → --cta-bot`（暗 L .60→.49 / 亮 .56→.46）+ 内顶白高光 + `0 0 18px` accent 辉光；白字全色 AA |
| `.acc-select` + 左光条 | 选中行 / 选中邮箱 | 左 3px 渐变光条带 9px 辉光 + 向右衰减的 accent wash（13%→0） |
| `.acc-underline` | 激活 tab 下划线 | accent 实色 + 8px 辉光 |
| `.acc-pill` | 未读计数 pill | accent/.16 底 + accent/.32 描边 + 内顶 1px 白光 |
| 氛围光 | 窗口基底（§3） | 全窗**唯一**的环境级 accent，单光源、方向固定左上 |

约束：
- **solid 档全部辉光归零**（box-shadow 收掉），保留渐变与 wash。
- 辉光只许出现在上面列出的位置，不得自行给新组件加 glow。
- 语义色（crit/ok/warn/info/ai）不受 accent 影响，规则照旧。

## 5. 可读性护栏

- 暗色 `--glass-alpha` ≥ 0.50，亮色 ≥ 0.72；详情层（`--tier-detail`）暗 ≥ white/.06、亮 ≥ white/.55。
- 验收必须在**亮色壁纸**（demo 的「暖」）下查：14px 中文正文、11px mono 时间戳、fg-2 级灰字。
- 噪点 opacity 暗 ≤ 0.08 / 亮 ≤ 0.10，超过会污染小字号。
- 任何文本不得落在无 tier overlay 的裸玻璃上（侧栏文字可以，因为侧栏字号 ≥13.5px 且 fg-1 级以上）。

## 6. 验收清单

- [ ] 默认出厂态 = 暗色 · coral · 磨砂 · 染色 · §3.1 定稿 knob 值，与 demo 首屏一致。
- [ ] 设置→通用→外观：控件清单/行为符合 §3.5（R1–R5 逐条过）；重启后设置保持。
- [ ] 三档气质肉眼可区分；面板之间**无深浅跳变**（整窗均匀，分层只靠 tier overlay 的细微差）。
- [ ] 磨砂下透出的桌面色**鲜活不发灰**（对照 v1：`mailagent-themes/MailAgent Surface Themes.html`）。
- [ ] 切 accent：玻璃 tint、氛围光、CTA 渐变、光条、pill 全部同步换色，无残留旧色。
- [ ] coral 读作珊瑚色（粉红倾向），不是橙。
- [ ] 亮色磨砂呈奶白色，文字全部 AA；暗色亮壁纸下正文可读。
- [ ] solid：无任何 blur/辉光/噪点；reduced-transparency 等价 solid；设置中玻璃控件置灰。
- [ ] 回退壁纸是连贯的单光源渐变（无散落圆点），换 accent 跟色。
- [ ] 12 组合（6 accent × 2 theme）× 2 surface 截图过一遍 a11y 脚本。
