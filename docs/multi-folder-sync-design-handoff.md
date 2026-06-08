# 多文件夹同步 — Claude Design Handoff（出 mockup 用）

> **给 claude design / 设计 session 的输入**：基于已定稿的 PRD，为「多文件夹同步」功能产出高保真 mockup，覆盖 **5 个界面** + 全部关键状态，支持**嵌套层级树**与**文件夹管理操作**，并与 MailAgent 现有设计系统**严格一致**。
>
> **最后更新**：2026-06-08

---

## 0. 你的任务

你是 MailAgent（macOS 邮件客户端，Electron + React + Tailwind）的设计师。为「多文件夹同步」出 **mockup 设计稿**，让前端能照稿实现。要求：

- 覆盖 §4 的 **5 个界面**的全部**关键状态**（§5）。
- **复用现有设计系统**（§3）——给成熟产品加功能，不是从零做品牌。
- **亮色 + 暗色**两套。
- 标注交互（hover/选中/禁用/加载/空态/展开收起/确认弹窗）。

> 开 session 后先 `Read frontend/DESIGN.md` + `frontend/src/shared/styles/tokens.css`，再看 §1 列的现有组件，**临摹现有风格**。可用 `frontend-design` 或 `impeccable` skill 提质量。

---

## 1. 必读文件

| 文件 | 作用 |
|---|---|
| `docs/multi-folder-sync-prd.md` | **权威需求**。重点看 §2.1 目标（含文件夹管理/层级）、§2.3 产品定位边界、§4.6/4.7 管理与层级、§9 出稿清单 |
| `frontend/DESIGN.md` | 设计系统主文档（含 §2.11 nav 三段铁律——**硬约束**） |
| `frontend/src/shared/styles/tokens.css` | 设计 token：色板（coral + ink 灰阶）、间距、圆角 |
| `frontend/src/shared/styles/typography.css` | 排版尺度 |
| `frontend/src/shared/components/layout/Sidebar.tsx` | **界面③扩展它**——临摹 NavRow / CountRight / MAILBOXES 段 |
| `frontend/src/shared/components/settings/tabs/SyncTab.tsx` | **界面①放这里**——临摹 Section / EnvField |
| `frontend/src/shared/components/settings/parts/` | 复用：`Section` / `PageHeader` / `EnvField` / `EmptyState` / `EnvBadge` |
| `frontend/src/electron/renderer/onboarding/steps.tsx` + `components.tsx` | **界面②插一步**——临摹现有步骤 + 多选 |

---

## 2. 功能背景（30 秒）

MailAgent 把公司 Exchange 邮箱同步进来（AI 分类 + Notion 归档 + 统一查看）。**现状只同步收件箱/发件箱**，但用户用 Outlook 规则把邮件分流到自定义文件夹（实测 18 个：Jira/Notion/DMS固件发布/Bugzilla/待办…，部分还可能有父子层级），目前完全看不到。

**本功能**：让用户**发现并勾选**要同步的文件夹（白名单，默认不选），勾选后邮件像收件箱一样**完整接入**（查看/AI/Notion/搜索/读写）；并支持**在 App 内新建/重命名/删除文件夹**、按**树形层级**呈现。旧的「存档/草稿箱」入口（一个从未真正工作的半成品）由本功能统一接管。

**🔴 产品定位边界（重要，影响视觉气质）**：MailAgent 是**重要邮件的 AI Agent**，不是完整邮件客户端的替代。所以「查看 + 管理」可以完整，但整体气质要**克制、专业、信息密度高**——文件夹管理操作要低调（藏在 hover/右键，不喧宾夺主），不要做成 Outlook 那种重管理界面。

---

## 3. 设计系统约束（硬性）

**先读 `tokens.css` 拿真实色值**，要点：

- **色板**：`coral` = 唯一强调色（选中/高亮/计数 pill）；`ink` 灰阶承载 90% 界面（`ink-fg`主→`ink-fg-3`最弱；`ink-3`/`ink-4` hover/选中背景）。状态色 ok/warn 已有 token。**不引入新颜色**。
- **数字**：`font-mono tabular-nums`（邮件计数）。
- **气质**：紧凑、克制、macOS 原生感。小留白、小字号、小圆角。**不要**大圆角卡片、大阴影、鲜艳渐变、营销感。
- **🔴 Sidebar 三段铁律**（DESIGN.md §2.11）：左侧只能三个 section header（`MAILBOXES`/`AI AGENTS`/`VIEW`）。自定义文件夹**挂在 MAILBOXES 段内**，**绝不新增第四个 header**。
- **复用组件语言**：设置页 = `PageHeader` + `Section` + 字段行；侧栏 = `NavRow`。新组件长得像它们的亲戚。
- **双主题**：亮/暗都从 token 取色。

---

## 4. 要设计的 5 个界面

### 界面① Settings → 同步 Tab → 「自定义文件夹同步」区（核心）

**位置**：`SyncTab.tsx` 现有「文件夹同步」Section 重构。一个**动态文件夹树**（从后端实时拉，区别于纯文本 EnvField）。

**布局**（一个 Section 内）：
- Section header：标题「自定义文件夹同步」+ helper（「选择要同步进 MailAgent 的文件夹；邮件将享受 AI 分类、Notion 同步等能力。」）。
- **操作行**：`[🔄 刷新]` + 右侧状态（「共 18 个文件夹 · 上次刷新 2 分钟前」）+ `[+ 新建文件夹]`（低调，放右侧）。
- **文件夹树**（可滚动，**支持层级缩进 + 展开/收起**）：
  ```
  [☑]  📁 DMS固件发布          728 封    · 已同步 2 分钟前        ⋯
  [☐]  ▸ 📁 项目              (有子文件夹，可展开)                ⋯
       [☑]   📁 2026 Q2        156 封                            ⋯
  [☐]  📁 Jira               3,458 封   ⚠ 较大                   ⋯
  [🔒] 📥 收件箱            （系统 · 始终同步）
  [🔒] 📤 发件箱            （系统 · 始终同步）
  ```
  - 每行：勾选框 + 展开 chevron（有子才显）+ 文件夹图标 + 名称 + 邮件数（mono）+ 状态 + **行尾 `⋯` 操作菜单**（hover 显）。
  - **层级**：子文件夹左缩进；父行有展开/收起 chevron。
  - **勾选语义**：勾父文件夹时弹「仅本级 / 含全部子文件夹」。
  - **系统文件夹**（收件箱/发件箱）：lock 图标、灰态、不可取消、`⋯` 菜单禁用。
  - **大文件夹**（>1000 封）：`⚠ 较大` 徽标（warn token）+ hover tooltip。
  - 行 hover = `ink-3` 背景。
- **`⋯` 操作菜单**（hover/右键）：`新建子文件夹` / `重命名` / `删除`。系统文件夹这三项灰态禁用（tooltip「系统文件夹不可改」）。
- **底部**：同步窗口（首次窗口 N 天 + 单文件夹上限 N 封）+ `[保存]`。

### 界面② Onboarding 「选择文件夹」步骤

现有 onboarding（约 7 步）**邮箱配置后**插入一步。临摹 `steps.tsx` 版式。
- 标题「选择要同步的文件夹」+ 副标题「可稍后在设置修改」。
- 主体：文件夹**树形多选**（缩进 + 展开/收起），每项勾选 + 名 + 邮件数。
- 系统文件夹默认选中 + 锁定；自定义默认全不选。
- 大文件夹轻量提示。
- 底部 `[跳过]`（弱）+ `[继续]`（coral）。强调**可跳过**。
- onboarding 步骤里**不放**文件夹管理操作（保持引导简洁）。

### 界面③ Sidebar — MAILBOXES 段呈现文件夹树

`Sidebar.tsx` MAILBOXES 段，现有「收件箱/发件箱/标旗/全部」**之后**追加已勾选文件夹。
- 每个文件夹一行 `NavRow`：「📁」图标 + 名 + `CountRight` 计数。
- **嵌套层级**：父子按**缩进 + 展开/收起 chevron**呈现（不是平铺）。
- **🔴 不新增 section header**——MAILBOXES 段内往下排。
- 文件夹多/深时「展开更多 / 折叠」控件防过长。
- 选中态 `row-selected`（`ink-4` + coral 计数 pill）。
- **收起态侧栏**（56px）：只显图标 + hover tooltip 名；嵌套在收起态如何处理也给个方案。

### 界面④ 文件夹邮件列表头部（上下文 + 路径）

点击某文件夹后右侧列表顶部标识当前位置。
- 面包屑/标题，**体现层级路径**（如 `项目 / 2026 Q2`）。
- 临摹现有收件箱列表头，给示意即可。

### 界面⑤ 文件夹管理操作的弹窗/交互（davmail 支持前提）

界面①的 `⋯` 菜单触发的具体交互：
- **新建子文件夹**：小弹窗或 inline 输入（选父文件夹 + 输名字 + 确认）。
- **重命名**：inline 编辑或小弹窗（预填当前名）。
- **删除**：**二次确认弹窗**——醒目说明「将删除 Exchange 上的该文件夹 + 本地已同步的 N 封邮件副本，不可撤销」+ `[取消]` / `[删除]`（删除按钮用 warn/危险态）。
- 操作进行中：loading；失败：错误反馈（说明 Exchange 操作失败、本地回滚）。
- **气质提醒**：这些是「偶尔用」的管理动作，UI 要克制——不要常驻大按钮，藏在 hover/右键 + 轻量弹窗即可。

---

## 5. 必须覆盖的状态

| 状态 | 表现 |
|---|---|
| **加载中** | 拉文件夹树时骨架/spinner |
| **空态** | 无自定义文件夹 → `EmptyState` + 引导 |
| **门控态** | 非 davmail → 整区禁用 + 「需要 davmail 后端」 |
| **树：展开 vs 收起** | 父节点两态 + chevron 朝向 |
| **大文件夹警示** | `⚠ 较大` + tooltip |
| **同步状态** | 已同步+时间 / 同步中 spinner / 错误 |
| **保存中/成功** | 按钮 loading + 反馈 |
| **选中 vs 未选**（Sidebar） | row-selected + 计数 pill 两态 |
| **管理操作菜单** | hover 显 `⋯`；系统文件夹禁用态 |
| **删除二次确认弹窗** | 危险态按钮 + 影响说明 |
| **新建/重命名输入** | inline 或弹窗 + 校验态 |
| **管理操作失败** | 错误反馈 + 本地回滚提示 |

---

## 6. 产出要求

- **形式**：高保真 mockup（非线框）。React/HTML+CSS 静态稿更佳（可直接对接实现），或图片稿。
- **主题**：亮 + 暗各一套。
- **范围**：界面①②③⑤ 必出，④ 示意即可。
- **标注**：交互态 + 复用了哪个现有组件 + 用了哪些 token。
- **一致性自检**：和现有 Sidebar/SyncTab 截图并排不违和；三段 nav 铁律没破；没引入新颜色/圆角尺度；**管理操作克制不喧宾夺主**（守 AI Agent 气质）。

**交付后**：mockup 连同 PRD + design + handoff 进新 session（worktree），P3/P4 照稿实现。

---

## 附：可直接喂给 claude design 的启动 prompt

见仓库根的对话交付，或用下面这段：

> 你是 MailAgent（Electron+React+Tailwind 的 macOS 邮件客户端）的设计师。先读 `docs/multi-folder-sync-prd.md`（尤其 §2.1/§2.3/§4.6/§4.7/§9）、`docs/multi-folder-sync-design-handoff.md`、`frontend/DESIGN.md`、`frontend/src/shared/styles/tokens.css`，以及现有的 `Sidebar.tsx` / `SyncTab.tsx` / `onboarding/steps.tsx`。为「多文件夹同步」出高保真 mockup，覆盖 design-handoff §4 的 5 个界面（含**嵌套层级树** + **文件夹管理操作** + **删除二次确认**）+ §5 全部状态，亮暗双主题。严格复用现有设计系统（coral/ink、NavRow/Section/EnvField、Sidebar 三段 header 铁律），且**管理操作要克制**——MailAgent 是 AI 邮件 Agent 不是完整邮件客户端，文件夹管理藏在 hover/右键、轻量弹窗，不喧宾夺主。用 `frontend-design` 或 `impeccable` skill 提质量。
