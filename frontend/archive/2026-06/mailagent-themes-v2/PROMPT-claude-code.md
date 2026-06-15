# Claude Code 实施包 — MailAgent 主题系统 v2（定稿 2026-06-12）

## 怎么交接

把整个 `mailagent-themes-v2/` 文件夹拷进仓库（建议放 `frontend/docs/theme-v2/`），需要的文件：

| 文件 | 角色 |
|---|---|
| `HANDOFF-theme-impl-v2.md` | **任务主文档** — 改哪些文件、怎么改、红线 |
| `HANDOFF-theme-spec-v2.md` | 数值真源 — 色表、knob 默认值、护栏、设置面板规范（§3.5）、验收清单（§6） |
| `theme-v2.css` | 配方源 CSS — token / 材质结构 / accent 配方可整段搬运 |
| `MailAgent Theme v2.html` + `app.css` + `tweaks.jsx` | 像素与交互对照（`window.MA` store = appearance 状态模型参照） |

然后用下面的 prompt 启动 Claude Code（在 `frontend/` 仓库根）。

---

## Prompt（直接粘贴）

```
请实施 MailAgent 主题系统 v2（磨砂材质 & 主题色重做，已定稿）。

先按顺序通读这四份材料，再动手：
1. docs/theme-v2/HANDOFF-theme-impl-v2.md —— 任务主文档，改动文件清单与落点
2. docs/theme-v2/HANDOFF-theme-spec-v2.md —— 所有数值的真源（色表/玻璃 knob/护栏/设置面板规范 §3.5/验收 §6）
3. docs/theme-v2/theme-v2.css —— 配方源 CSS，token 与材质结构直接以它为准搬运
4. docs/theme-v2/MailAgent Theme v2.html —— 像素对照 demo；其中 window.MA store 是
   appearance 状态模型的参照实现（气质预设 + knob 覆写 + 重置语义）

核心定稿结论（与文档冲突时以此为准）：
- 材质收敛为两档：solid 实色 / frosted 磨砂（liquid 液态档删除，存量 localStorage 值迁移为 frosted）
- 磨砂 = 「一块玻璃」架构：OS vibrancy/acrylic 扛唯一一层重模糊，CSS 只画 tint+氛围光；
  面板 .glass-* 一律无 backdrop-filter，只叠 tier overlay；唯一保留 blur 的类是真浮层 .glass-pop
- 玻璃气质默认 tinted（染色），knob 出厂默认：--glass-alpha 0.85 / --glass-blur 30px /
  --glass-sat 1.8 / --glass-accent-mix 16% / --ambient 0.20 / --grain 0.07
  （亮色护栏微调：sat 1.4 / ambient 0.16，见规范 §3.1）
- 玻璃气质（银纱/染色/亮砂）+ 6 个高级玻璃调节滑杆 = 用户设置，新增到「设置 → 通用 → 外观」，
  行为规则 R1–R5 见规范 §3.5（实色置灰、切气质清空覆写、恢复默认只清覆写、实时预览、范围即护栏）
- 6 个 accent 全部换成规范 §2 的 oklch v2 色值；accent 材质化配方（.acc-cta/.acc-select/
  .acc-bar/.acc-underline/.acc-pill）照 theme-v2.css 搬

建议按 5 个独立提交推进：
1. appearance.ts + index.html bootstrap：SurfaceStyle 删 liquid + 迁移；新增 GlassMood/GlassKnobs
   状态（impl §1.1），首帧防闪
2. index.css：accent 色值替换 + 派生 token（--A/--cta-*/--acc-glow）+ accent 材质化类（impl §3.1、§3.4）
3. index.css：玻璃体系重写 —— body::before 基底、.glass-* tier 化、grain/specular、
   solid 与 reduced-transparency 与 data-vib=off 回退、删 liquid 块、--glass-stroke → --hairline
   全局替换、§3.3 的散点 backdrop-filter 清理
4. 主进程：vibrancy/acrylic 窗口参数 + applyNativeSurface + IPC + data-vib 回写（impl §2）
5. 设置 → 通用 → 外观 UI + SurfacePickerPopover 二选一化（impl §6、§7）

红线（impl §4）：CSS 永不写 >20px 的 backdrop-filter；同屏 CSS blur 区域 ≤2（仅真浮层）；
噪点/氛围光/specular 禁止动画；过渡只 background-color/box-shadow 280ms，不过渡 filter；
不改 tailwind.config.ts，不加新依赖。

完成标准：规范 §6 验收清单逐条通过；6 accent × 2 theme × 2 surface = 24 组合跑现有 a11y
对比度脚本；亮色磨砂下 14px 中文正文与 11px mono 时间戳肉眼可读。
```

---

## 备注

- demo 的 `app.css` 是 demo 专属（桌面模拟、窗口 chrome、设置面板 mock 样式），**不要搬**；生产设置页复用现有控件视觉词汇。
- `--glass-blur` 在 macOS/Win11 上不生效（OS 扛模糊），只在 `data-vib=off` 回退路径和 demo 里有意义 —— 设置里该滑杆建议加说明文案。
- 若 Electron < 28 报 `oklch(from …)` 解析问题，先升 Electron；不要用预计算色值替代相对色法（会断掉换 accent 自动跟色）。
