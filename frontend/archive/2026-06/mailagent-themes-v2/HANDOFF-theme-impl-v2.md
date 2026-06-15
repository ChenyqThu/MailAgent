# MailAgent · 主题系统 v2 — 前端实现 Handoff（Claude Code 交接 · 定稿版 2026-06-12）

> 配套规范：`HANDOFF-theme-spec-v2.md`（决策与数值的解释在那边；设置面板规范见其 §3.5）
> 配方源：`mailagent-themes-v2/theme-v2.css` —— **本文所有 CSS 都以它为准**，下面只写差异与落点。
> 像素对照：`mailagent-themes-v2/MailAgent Theme v2.html`（标题栏滑杆按钮 = 设置→通用→外观 的交互 mock；其中 `window.MA` store 的状态模型可直接照搬）。
> 定稿结论：玻璃气质默认 **tinted**；knob 默认 alpha .85 / blur 30px / sat 1.8 / mix 16% / ambient .20 / grain .07；气质+高级调节是用户设置。

涉及文件（均在 `frontend/`）：

| 文件 | 改动 |
|---|---|
| `src/shared/state/appearance.ts` | `SurfaceStyle` 删 `'liquid'` + 存储迁移 + IPC 联动；**新增** `GlassMood` + `GlassKnobs` 状态 |
| `src/electron/renderer/index.css` | accent 色值替换；`.glass-*` 体系重写（~L122-133、L714-870）；删 liquid 块 |
| `src/electron/main/index.ts` | `createWindow()` / `createPopoutWindow()` 加原生材质 opts |
| `src/electron/main/appearance.ts`（或新建 surface.ts） | `applyNativeSurface` + IPC handler |
| `src/shared/components/layout/SurfacePickerPopover.tsx` | 删液态选项（三选一 → 二选一） |
| **设置 → 通用 页面组件** | **新增**「外观」区块：主题/主题色/材质/玻璃气质/高级玻璃调节（§6） |
| `src/electron/renderer/index.html` | 首帧 bootstrap：旧值 `'liquid'` 迁移；新增 glassMood/knobs 的首帧应用 |
| `tailwind.config.ts` | **不动**（accent 仍走 `rgb(var(--c-accent) / <alpha-value>)`） |

---

## 1. 类型与状态（appearance.ts）

```ts
// Sprint N — v2: 液态档移除（评审结论：区分度低 + 费 GPU）
export type SurfaceStyle = 'frosted' | 'solid'

function readSurface(): SurfaceStyle {
  try {
    const v = localStorage.getItem(SURFACE_KEY)
    if (v === 'frosted' || v === 'solid') return v
    if (v === 'liquid') return 'frosted' // v1 存量迁移
  } catch { /* ignore */ }
  return 'frosted'
}

export function applySurface(surface: SurfaceStyle): void {
  const root = document.documentElement
  if (surface === 'frosted') root.removeAttribute('data-surface')
  else root.setAttribute('data-surface', surface)
  // v2 新增：联动原生 vibrancy（solid=关）
  const w = window as unknown as { electron?: { ipcRenderer?: { send: (c: string, v: unknown) => void } } }
  w.electron?.ipcRenderer?.send('appearance:surface', surface)
}

// bootAppearance() 内新增：主进程回写原生材质是否生效
w.electron?.ipcRenderer?.on?.('appearance:vibrancyState', (_e, active: boolean) => {
  document.documentElement.setAttribute('data-vib', active ? 'on' : 'off')
})
```

`index.html` 的 inline bootstrap（~L63 一带）同样把 `'liquid'` 映射成不写 attribute，并在首帧应用 glassMood + knobs（§1.1）。

### 1.1 玻璃气质 + 高级调节（新增状态，定稿：用户设置）

demo 的 `window.MA` store 就是参照实现，状态模型照搬：

```ts
export type GlassMood = 'neutral' | 'tinted' | 'bright'   // 默认 'tinted'
export interface GlassKnobs {       // 高级调节覆写; 缺省 = 跟随气质预设
  alpha?: number; blur?: number; sat?: number;
  mix?: number; ambient?: number; grain?: number;
}
const KNOB_VARS: Record<keyof GlassKnobs, [string, string]> = {
  alpha: ['--glass-alpha', ''], blur: ['--glass-blur', 'px'],
  sat: ['--glass-sat', ''], mix: ['--glass-accent-mix', '%'],
  ambient: ['--ambient', ''], grain: ['--grain', ''],
}

export function applyGlass(mood: GlassMood, knobs: GlassKnobs): void {
  const root = document.documentElement
  root.setAttribute('data-glass', mood)
  for (const k of Object.keys(KNOB_VARS) as (keyof GlassKnobs)[]) {
    const [cssVar, unit] = KNOB_VARS[k]
    if (knobs[k] != null) root.style.setProperty(cssVar, `${knobs[k]}${unit}`)
    else root.style.removeProperty(cssVar)   // 回到气质预设
  }
}
```

语义（规范 §3.5 R1–R5）：
- 覆写以 **inline CSS 变量**盖在 `[data-glass]` 预设上；未覆写的 knob 读 CSS 预设（UI 显示用 `getComputedStyle` 读生效值）。
- **切气质 → 清空 knobs**；「恢复默认」只清 knobs 不改气质。
- 持久化：`appearance.glassMood` / `appearance.glassKnobs`（JSON）两个 key，随现有 appearance 机制走 localStorage + 首帧 bootstrap。
- 亮色主题下 `alpha` 应用时 clamp 到 ≥0.72（护栏）。

## 2. 主进程（与 v1 handoff §5 相同，保留）

- `createWindow()` / `createPopoutWindow()`：macOS `vibrancy:'under-window', visualEffectState:'active', backgroundColor:'#00000000'`；Win11 `backgroundMaterial:'acrylic'`；Linux/Win10 不透明回退。
- `applyNativeSurface(win, surface)`：`solid` → `setVibrancy(null)` / `'none'`；`frosted` → 开。处理后 `webContents.send('appearance:vibrancyState', active)`。
- `registerSurfaceIpc()` 监听 `'appearance:surface'`；启动 `ready-to-show` 后用持久化值调一次，防首帧闪。
- 失焦不降档（`visualEffectState:'active'`）；`powerMonitor.isOnBatteryPower()` 时可选降为 solid（设置开关，P2）。

## 3. index.css 改动

### 3.1 Accent 色值整体替换

替换现有 `:root` / `:root[data-theme='light']` / `:root[data-accent=...]` 的 `--c-accent*` 三元组 → **用规范 §2 的 v2 表**（theme-v2.css 已是成品，直接拷）。同时在 `:root` 新增派生 token：

```css
--A: rgb(var(--c-accent));
--cta-top: oklch(from var(--A) 0.60 c h);   /* light 块覆盖为 0.56 */
--cta-bot: oklch(from var(--A) 0.49 calc(min(c, 0.12)) h);  /* light: 0.46, 无 min */
--acc-glow: oklch(from var(--A) l c h / 0.30);
```

注意：现有 `--c-cta-bg/-hover` 的消费方（`.btn-cta`）改走 `.acc-cta` 渐变配方（§3.4），`--c-cta-*` 可标记 deprecated 不删。

### 3.2 玻璃体系重写（替换 ~L122-133 的 `--glass*` 与 ~L714-870 的整段）

把 v1 的「每个 .glass-\* 各带 backdrop-filter + 各异 alpha」整段删掉，替换为 theme-v2.css 的结构：

1. **删除** `--glass` / `--glass-lg`（40px 全屏 blur 永久退役）、`--glass-stroke`（改名 `--hairline`，全局 grep 替换，亮色值见 theme-v2.css）。
2. **窗口基底**：v1 demo 用 `.win-base` div；生产里挂在 `body::before`（vibrancy 生效时）：

```css
html, body { background: transparent; }
body::before {            /* 玻璃 tint + 氛围光, OS 在它底下做 blur */
  content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-color: color-mix(in srgb, var(--glass-base) calc(var(--glass-alpha) * 100%), transparent);
  background-image:
    radial-gradient(120% 90% at 16% -12%, rgb(var(--c-accent) / var(--ambient)), transparent 58%),
    linear-gradient(180deg, rgb(255 255 255 / 0.045), transparent 16%);
}
/* 原生材质生效时不需要 CSS blur; 回退(data-vib=off)时画 --wp-fallback, 零 blur */
:root[data-vib='off'] body::before { background-color: transparent; background-image: var(--wp-fallback); }
:root[data-surface='solid'] body::before { background-color: rgb(var(--ink-0)); background-image: none; }
:root[data-surface='solid'], :root[data-vib='off'] { /* html/body 不透明兜底 */ }
```

3. **`.glass-*` 全部去 blur**，改 tier overlay（theme-v2.css §面板分层；`.glass-pop` 是唯一保留 blur(20px) 的类）。v1 的 `--wallpaper` aurora（多圆点）删除，由 `--wp-fallback` 取代。
4. **噪点 / specular**：`.grain` 元素挂在 app 最外层容器（`PageFrame` 根）末尾；`.specular` 加在 TitleBar 根上。配方照抄。
5. **liquid 块（~L820-870）整段删除**；`prefers-reduced-transparency` 块改为 theme-v2.css 版本。
6. `surface-swatch-liquid`（SurfacePicker 预览小块）删除。

### 3.3 受影响的存量样式排查

- `index.css` 里所有 `backdrop-filter: var(--glass-lg)` 的散点（~L919、L1795、L1931、L2845 等）：浮层类（popover/menu/侧滑）改 `.glass-pop` 配方；**非浮层一律去 blur 改 tier overlay**。目标：全应用同屏 backdrop-filter 区域 ≤ 2（OS 基底不算，CSS 只剩浮层）。
- `PageFrame.tsx` (~L36) 的强制 opaque 背景：仅 `data-surface='solid'` 或 `data-vib='off'` 时生效，否则会盖死 vibrancy（v1 handoff 已提，仍然有效）。
- `onboarding.css` L22 `background: rgb(var(--ink-0))`：onboarding 窗口若也走 vibrancy，需同样处理。

### 3.4 Accent 材质化（新增类，给组件挂）

照抄 theme-v2.css 的 `.acc-cta / .acc-select / .acc-bar / .acc-underline / .acc-pill` + solid 档收辉光的覆盖块。挂接点：

| 类 | 组件 |
|---|---|
| `.acc-cta` | 起草回复 CTA（替换 `.btn-cta` 平涂） |
| `.acc-select` + `.acc-bar`(伪元素配方) | EmailRow 选中、sidebar 选中邮箱 |
| `.acc-underline` | AI 面板激活 tab |
| `.acc-pill` | 未读计数 pill |

EmailRow/Sidebar 的左条是伪元素，无法挂类 —— 把 `.acc-bar` 的 background/box-shadow 直接写进对应伪元素 rule（demo 的 `app.css` 末尾有现成写法）。

## 4. 渲染层性能红线（v2 收紧）

1. CSS 永远不写 >20px 的 backdrop-filter；磨砂的重模糊只在 OS。
2. 同屏 CSS backdrop-filter 区域 ≤ 2（仅真浮层）。
3. 噪点/氛围光/specular 全是静态层 —— **禁止动画**它们。
4. 切档/换色过渡只 `transition: background-color, box-shadow`（280ms），不过渡 filter。
5. `color-mix`/相对色法（`oklch(from ...)`）由 Chromium 一次解析，无运行时成本，放心用；最低要求 Electron ≥ 28（Chrome 119+，现仓库满足）。

## 6. 设置 → 通用 → 外观（新增 UI）

控件清单、顺序、范围、默认值、行为规则（R1–R5）全部以规范 §3.5 为准；demo 的 `#settings` 面板是像素与交互参照。实现要点：

- 复用现有设置页的控件视觉词汇（segmented/swatch/slider），不要照搬 demo 的自制样式。
- 滑杆 `input` 事件直接 `setGlassKnob(k, v)` 实时预览；rAF 合并写入（同 appearance.ts 现有 C-06 模式）。
- 「实色」材质时玻璃气质与滑杆整体置灰（disabled，不隐藏）。
- 「基底模糊」滑杆：`data-vib=on` 时加说明文案「当前由系统提供模糊，此项仅在不支持的平台生效」（或直接隐藏，建议前者）。
- SurfacePickerPopover（快捷入口）保留 实色/磨砂 二选一；气质与高级调节**只**在设置页出现。

## 7. SurfacePickerPopover

- 三选一 → 二选一（实色 / 磨砂），文案沿用；`surface-swatch-liquid` 删除。
- 旧用户 localStorage 里的 `'liquid'` 已在 §1 迁移，无需 UI 处理。

## 8. demo → 生产 的类名映射

| demo (theme-v2.css) | 生产 |
|---|---|
| `.win-base.win-glass` | `body::before`（vibrancy tint 层） |
| `.glass / .glass-2 / .glass-3 / .glass-bar` | 同名类，含义不变（tier overlay 化） |
| `.glass-panel` | AI 面板容器（原先用 glass-pop 的非浮层，换这个） |
| `.glass-pop` | 真浮层专用（保留 blur） |
| `.grain` / `.specular` | PageFrame 根 / TitleBar |
| `--hairline` | 替换 `--glass-stroke` |
| `data-glass` 三档 + knob 覆写 | 用户设置（appearance store §1.1），默认 tinted + §3.1 定稿值 |
| demo `window.MA` store | `appearance.ts` 的参照实现（状态模型/重置语义/effective 读取） |

## 9. 验证

- 规范 §6 验收清单逐条过（含设置面板 R1–R5）。
- a11y：沿用 DESIGN.md §17 的 12 组合脚本，外加 `data-surface` 两档 = 24 截图。
- 性能：Activity Monitor 对比 v1 liquid 档 —— 磨砂常驻 GPU 应显著下降（blur 区域 5→1）；solid 档 0 blur。
- 回归重点：Streamdown/设置页等直接消费 `--glass-stroke` 或 `--glass-lg` 的散点（§3.3 grep 清单）。
