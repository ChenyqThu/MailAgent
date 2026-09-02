# 资料库 UI mockup

task `09-02-library-knowledge-base`（状态 planning，**未开工**）。这份 mockup 是给 owner
review「表现方案 + 找功能缺漏」用的，同时作为后续开发的直接参考。

设计 SSoT 是 `.trellis/tasks/09-02-library-knowledge-base/design.md`；下面每个场景都标了
它依据的章节号。**mockup 与 design 冲突时以 design 为准**，但第 ④ 节列的是做的过程中
发现的 design 缺口 —— 那些需要 owner 拍板。

---

## ① 怎么起

```bash
pnpm -C frontend exec vite --config mockups/library/vite.config.ts
# 或用 .claude/launch.json 里的启动项：library-mockup（端口 5202）
```

打开 <http://localhost:5202/>。左边一列是场景导航（A–G 分组），中间渲染场景，
每个场景顶部有一条**状态条**用来切换该场景的各种状态。

- 主题固定 dark、语言固定 zh-CN（`<html class="dark" data-theme="dark">`，与
  `mockups/stakeholder` 同款）。但布局只用 token、不写死颜色，文案全在 `strings.ts`，
  落地时换 light / en-US 不需要动结构。
- 全部数据来自 `fixtures.ts`；所有写入只改本地 state，没有后端。
- 建议窗口宽 ≥ 1500px 看：仿真的应用窗口是「56 导轨 + 336 二级栏 + 内容区 + dock」。

### 文件清单

| 文件 | 作用 |
|---|---|
| `vite.config.ts` | 独立 vite 配置。复用主仓 tailwind 主题 + `@shared` / `@renderer` alias，只换扫描范围与端口（照 stakeholder 先例） |
| `index.html` | 固定 dark 的壳 |
| `main.tsx` | 单页应用：场景导航 + 场景切换 |
| `mockup.css` | **只有 mockup 脚手架**用得着的样式（场景导航 / 画布外框 / 系统对话框占位 / 拖入覆盖层）。一条都不进主仓 |
| `strings.ts` | 全部界面文案。落地时逐条搬进 `locales/{zh-CN,en-US}/common.json` 的 `library` 段 |
| `fixtures.ts` | 假数据。形状照 design §1.2 的 `library_file` / `library_mount` / `library_history` 逐字对齐 |
| `scenes/index.ts` | 场景注册表（id / 分组 / 标题），与下面的场景表一一对应 |
| `scenes/{a,b,c,d,e,f,g}-*.tsx` | 七组场景 |
| `parts/shell.tsx` | 应用外壳的**仿制**：导轨 / 二级栏 / 内容区 / dock / peek |
| `parts/tree.tsx` | 文件夹树（多根 + 分组 + 展开折叠 + 选中 + 节点菜单） |
| `parts/folderView.tsx` | 文件夹视图（网格 / 列表 / 排序 / 过滤 / 空态 / 拖入 / 扫描中） |
| `parts/preview.tsx` | 预览面（文件头 / 六类预览 / 状态横幅 / 历史抽屉 / 关联区 / 文件夹选择器） |
| `parts/fileMeta.ts` | 类型 → 图标色调 / 中文名 / 打开方式 / 创建者显示名 / frontmatter 剥离 |
| `parts/kit.tsx` | mockup 脚手架件：状态条 / 场景标题 / 系统对话框占位 / 说明条 / toast / Pill |
| （无 `copies/`） | 这一轮没有做任何忠实副本，原因逐条见第 ③ 节 |

---

## ② 场景清单

37 个场景，全部可交互（按钮 / 菜单 / 弹窗 / 右键菜单都真能点开）。

| id | 名称 | design 章节 | 状态轴 | 复用的真组件 | 仿制 / 副本 |
|---|---|---|---|---|---|
| **A1** | 一级域整体 | §2.1 | 二级栏 展开·折叠；宽度 280·336·420 | `ui/collapsible` `ui/Popmenu` `ui/segmented` `icons/animated/folder-tree` `format` `attachmentPreview.pickIconTone` | 外壳（`parts/shell`）·树（`parts/tree`） |
| **A2** | 多根树 | §1.1 §2.2 §8.2 | 挂载 全正常·@工作区不可用；拖入 否·悬停 | 同上 | 树 |
| **A3** | 节点菜单 | §2.3 §8.2 | 节点类型 文件夹·挂载ro·挂载rw·投影根·废纸篓 | `ui/Popmenu`（真件，含下钻 morph 与键盘导航） | — |
| **A4** | 折叠态 peek | §2.1 | 固定折叠态；hover 导轨「资料库」格 | authored `.nav-peek` CSS | peek 浮层 |
| **B1** | 网格 / 列表双视图 | §2.3 | 文件夹 投影区·my-docs·agent-docs·@工作区；视图 网格·列表；排序 名称·大小·类型·时间 | `ui/segmented` `ui/Popmenu` `format.formatFileSize` `pickIconTone` | 磁贴（照 `AttachmentList` 配方重排） |
| **B2** | 空 / 拖入 / 扫描中 | §2.3 §8.2 | 空文件夹·拖入中·索引扫描中 | 同上 | — |
| **B3** | 文件夹过滤 vs 全库搜索 | §2.3 §9.1 | 两个输入框都能打字 | 同上 | — |
| **C1** | 文件头与动作 | §2.3 | 文件 md我的·office投影·md agent·md 挂载rw·pdf 挂载ro | `ui/button` `ui/drawer` `TranslatedBody` | — |
| **C2** | markdown 三态 | §2.4 §4 | 只读·编辑·保存冲突(409) | `TranslatedBody`（Streamdown 真渲染） | 编辑态照 `StandingDocsSection` 的 textarea + 保存/取消范式 |
| **C3** | html 无脚本沙箱 | §2.4（L7） | — | `<iframe srcdoc sandbox="allow-same-origin">`（`EmailBodyFrame` 同款姿势） | 见第 ③ 节 |
| **C4** | 图片 + lightbox + OCR | §2.4 | 有 OCR·无 OCR | `ui/segmented` | lightbox（照 `ImageLightbox` 形态） |
| **C5** | PDF 解析 / 原件 | §2.4（L10） | PoC 通了·PoC 没通 | `ui/segmented` `ui/button` | 原件是占位块（见「未 mock 项」） |
| **C6** | office / csv 三态 | §2.4（L18） | docx·csv·抽取中·失败·不支持 | `TranslatedBody` 渲染解析版 markdown（含表格） | — |
| **C7** | video / 大文件 / 其他 | §2.4 | mp4·.numbers·iCloud 占位 | — | — |
| **C8** | missing / trashed / 挂载不可用 | §1.2 §8.2 §9.0 | 三态 | — | — |
| **C9** | 历史抽屉与回滚 | §4 | 抽屉 打开·关闭；行内「查看快照」可展开 | `ui/drawer`（真件，含 spring 进场 + Esc 关闭） | — |
| **C10** | 关联事项与来源跳转 | §9.2 §9.4 | 两个事项·事项+来源邮件·事项+来源会话·零关联 | — | — |
| **C11** | 另存到资料库 | §1.1 §9.4 | 入口 预览动作·邮件附件行；对话框 开·关 | `ui/dialog` `ui/checkbox` `ui/button` | 目标文件夹选择器 |
| **C12** | 移到… | §2.3 | 对话框 开·关 | 同上 | 同上 |
| **C13** | 删除确认与废纸篓 | §1.5 §8.2（L6） | 库内确认·挂载区确认·废纸篓视图 | `ui/dialog` | — |
| **D1** | 添加挂载文件夹 | §8.2 | ①触发系统对话框 ②确认面板 ③超2万 ③拒挂 | `ui/input` `ui/segmented` `ui/button` | 系统对话框 = 占位卡（不 mock） |
| **D2** | 设置页「资料库」区 | §1.5 §8.2 §9.1 | 语义检索 未下载·下载中·已就绪·重建索引中 | `ui/switch` `ui/button` `ui/separator` | 设置页 Section / Row 外壳 |
| **E1** | 全库搜索面 | §9.1 | 有结果(hybrid)·语义未下载·1字拦截·空结果 | — | 结果行 `HitRow` |
| **E2** | ⌘K 第五 lane | §9.1 | — | — | palette 外壳（`CommandPalette` 拉不进来，见 ③） |
| **E3** | /search 页结果组 | §9.1 | — | — | 同上 |
| **F1** | 第 8 张能力卡 | §5.2（L12） | 档位 关闭·只读·可写；触发源 手动·无人值守 | — | `CapabilityCards.tsx` 里的 `CapabilityCard` / `TierButtons` 是**文件内私有**组件，类名逐字重排 |
| **F2** | 工具审批档 7 行 | §5.1 §5.3 | 每行三档可切；delete→免卡 弹红确认 | `connectors/parts` 的 `SegIconSelect` + `ToolCategoryGroup`（真件） | — |
| **F3** | 对话里的工具卡 | §5.1 §4 | 卡片 search·read·write·delete·move·409重试；阶段 待确认·已授权·已完成·已拒绝 | `ui/collapsible` `ui/button` | `_cardShell.tsx` 的 `CardFrame` / `CardParams` / `ApprovalActions` 类名逐字重排 |
| **F4** | data-library chip + composer 提示 | §1.4（L3） | 入库 已归档·失败回落；提示 第一次·看过了 | — | 气泡与 composer |
| **F5** | @ 提及（对话 / 群聊） | §9.3（L14） | 场地 AgentComposer·GroupComposer；弹层 开·关 | — | 两套 composer（Lexical / 裸文本）都拉不进来 |
| **F6** | library 型通知 | §9.4 | — | — | 通知面板 |
| **F7** | custom_agent_call 带引用 | §5.1 §9.5 | 引用列表可折叠 | `ui/collapsible` | 卡壳同 F3 |
| **G1** | 事项关联与提案 | §9.2 §9.5 | agent 提案 未确认·已确认·已忽略；关联弹窗可开 | `ui/dialog` `ui/checkbox` `ui/segmented` | `LibraryPickerDialog`（design §9.5 要新建的组件），外壳抄 `MatterLinkResourceModal` |
| **G2** | compose 从资料库选附件 | §9.4 §9.5 | 弹窗可开、chip 可删 | 同上 | 同上 |
| **G3** | 邮件附件行「另存到资料库」 | §9.4 | 行菜单可开 | `ui/Popmenu` | 附件磁贴 |
| **G4** | 深链落地 | §9.5 | 目标 正常·missing·trashed | — | toast |
| **G5** | 报告「导出到资料库」 | L15（P3 可选） | 弹窗可开 | `ui/dialog` | — |

---

## ③ 真实复用 vs 仿制

### 直接 import 的真组件（一行没改）

`ui/button` · `ui/input` · `ui/dialog`（+Header/Footer/Title/Description） · `ui/drawer` ·
`ui/segmented` · `ui/switch` · `ui/checkbox` · `ui/separator` · `ui/collapsible`
（`CollapseChevron` + `CollapsibleRegion`） · `ui/Popmenu`（含下钻 morph / 键盘导航 / portal 档） ·
`layout/PageFrame` 的语义（`<main>` 与 dock 是兄弟） · `email/TranslatedBody`（Streamdown） ·
`email/attachmentPreview.pickIconTone` · `format.formatFileSize` · `lib/cn` ·
`components/icons/animated/folder-tree`（`FolderTreeIcon`） ·
`connectors/parts` 的 `SegIconSelect` / `ToolCategoryGroup` · `@shared/i18n`（zh-CN 初始化）。

另外**直接复用了主仓 authored CSS**（`src/electron/renderer/index.css`）：
`.nav-rail` / `.nav-rail-cell` / `.railbtn` / `.raillabel` / `.railbadge` / `.nav-panel` /
`.nav-panel-header` / `.nav-peek` / `.row` / `.row-selected` / `.acc-select` / `.kbd` /
`.seg` / `.scrollbar-thin`。所以导轨几何、选中左光条 + accent wash、hover 明度与真 app 逐像素一致。

### 为什么没有 `copies/`

需要「照搬」的六类东西都不适合做忠实副本，理由各不相同、落地时的处理方式也不同，
逐条说明比留一份会腐烂的拷贝有用：

| 拉不进来的组件 | 为什么 | mockup 里怎么办 | 落地怎么办 |
|---|---|---|---|
| `Sidebar` / `IconRail` / `NavPeek` | 依赖 `navigation/registry` + zustand + TanStack router | 借它们的 authored CSS 类**仿制**外壳（`parts/shell.tsx`） | 整个丢掉 —— 按 design §2.1 往 registry 加一条 entry，外壳白拿 |
| `CapabilityCards` 的 `CapabilityCard` / `TierButtons` | 是**文件内私有**组件，没有 export | 类名逐属性重排（`scenes/f-agent.tsx`） | 删掉重排的那份，直接往原文件加第 8 张卡 |
| `_cardShell` 的 `CardFrame` / `CardParams` / `ApprovalActions` | export 了，但绑 `useTranslation` 的 key 与 assistant-ui 的 `respondToApproval` runtime | 类名逐属性重排（`scenes/f-agent.tsx`） | 直接用真件，只写卡的 body |
| `EmailBodyFrame` | 绑邮件 detail 形状 + IPC 外链拦截 + cid 重写 | 用它的**姿势**（`srcdoc` + `sandbox="allow-same-origin"` 无脚本） | 走它的 `htmlOverride` 入参 |
| `MatterLinkResourceModal` | 绑 matters 的 api / store / 乐观并发协议 | 外壳与底部条按它的类名重排成 `LibraryPicker` | 新建 `shared/components/library/LibraryPickerDialog.tsx`（design §9.5 已排） |
| `CommandPalette` / `SearchResultGroups` / `NotificationPanel` / `AgentComposer` / `GroupComposer` | 全部绑 router / store / Lexical / assistant-ui | 按它们的行与组头形态重排 | 各自加一组 / 一档，纯加法 |

判据是同一条：**能 import 的一律 import，import 不动的不做副本、只借形态**。副本会在
主仓改动后静默腐烂，而 mockup 是一次性产物 —— 留一份会过期的拷贝比不留更坏。

---

## ④ 未 mock 项

按「为什么不 mock」分三类。

**A. 系统级窗口（有意不 mock，用占位卡标出触发点）**

1. `dialog.showOpenDialog({properties:['openDirectory']})` —— 添加挂载文件夹（D1 ①、A3 底部）。
2. `shell.openPath` —— 「用系统应用打开」「用 Word / Excel / 浏览器 / 预览打开」（C1 C3 C5 C6 C7 按钮存在，点了不做事）。
3. `shell.showItemInFolder` —— 「在访达中显示」（同上）。
4. `shell.trashItem` —— 挂载区删除走系统废纸篓（C13 有占位卡）。

**B. 需要真实运行时才有意义的**

5. **PDF 原件内嵌**（C5 的「原件」页签是占位块）：design §2.4 / L10 明写要在 P1 内做 PoC，
   四条路（iframe → loopback `/inline` + CSP frame-src + `plugins:true` → 独立窗口 → pdf.js）
   都得在本机 Electron 上实测。mockup 里画一个假的 PDF 只会给人「已经能用」的错觉。
6. **真实文件与缩略图**：图片是内联 SVG（`parts/preview.tsx` 的 `FAKE_IMAGE`），
   `readDataUrl` 的 25 MB 上限、`THUMBNAIL_MAX_BYTES` 1 MB 回落类型图标这两条判据只在注释里。
7. **树的虚拟化退化**：design §2.2 说单文件夹 < 500 项不虚拟化、超阈值退化成 `react-window`
   并放弃 `layoutId` pill。mockup 数据量太小，看不出这一档。
8. **beUI `file-tree` 的收编呈现层**（分支连线的弹性绘制、选中 pill 的 `layoutId` 滑动、
   `AnimatePresence mode="popLayout"` 换图标）：mockup 用 authored 类摆信息结构，
   动效等收编时按 `docs/motion-gsap.md` 的登记流程做。
9. **拖拽导入的真实 drop 事件**：B2 的「拖入中」是状态钮切出来的，没接 `dragover`。
10. **搜索的真实防抖 / seq 失效**（180ms / 250ms）与 FTS 的 snippet 生成。

**C. 有意留在 design 而不进 mockup 的**

11. 远程 web 只读面（P3）、Windows（L5：v1 macOS only）。
12. 语义检索的实际召回效果（P3；D2 只画了下载 / 索引进度的 UI 面）。
13. 邮件面 `ThreadComposer` 的资料库入口（design 明说 v1 不做，留 P3）。
14. 日历 / 通讯录 / 今日域 —— design §9.4 的表里标 ❌，不造 UI 槽位。

---

## ⑤ 做 mockup 时发现的设计缺漏 / 矛盾

按「要不要 owner 拍板」排序。**这一节是本文档最该被读的部分。**

### 🔴 需要拍板

**F1. markdown 的 frontmatter 在只读预览里怎么处理 —— design 没写，而它每份文档都会撞上。**
design §2.3 说「名称列 md 取 `frontmatter.title` 回落文件名」，说明 frontmatter 是一等概念；
但 §2.4 的 markdown 行只写「只读 `TranslatedBody`」。实测：Streamdown **不认 YAML frontmatter**，
`---` 被当成分隔线、`title: xxx` 当成正文，于是每份带 frontmatter 的文档顶部都多出一段
元数据噪音（这是我在 C2 场景第一次渲染时直接看到的）。mockup 已经按「渲染前剥掉、
编辑态 textarea 仍是原文」处理（`parts/fileMeta.ts::stripFrontmatter`），但这是我替 owner
做的决定，需要确认。备选：把 frontmatter 渲染成文件头上的一行元信息（title / summary / tags）。
连带问题：`library_read` 返回给模型的正文要不要也剥掉？（我倾向**不剥**——frontmatter 对模型是有用的元数据。）

**F2. 「另存解析版为 markdown」生成的文件，与原文件的关系在 UI 上无处可查。**
design §2.3 定义了 `source='derived'` + `source_ref=原文件 id`，L18 也说清了「此后独立演化」。
但没有任何一处 UI 说要**显示**这层关系。做 C1 / C10 的时候发现两个方向都缺：
① 解析版文件的头部没有「派生自 X」的回链；② 原文件也不知道自己被另存过。
后果是用户过三个月看到 `服务协议-2026（解析版）.md` 完全想不起它从哪来，
更糟的是原件更新后解析版是旧的、而 UI 上看不出来。
建议至少做单向（解析版 → 原文件的回链 chip），代价约 10 行。

**F3. 「另存到资料库」之后没有去处，用户不知道文件去了哪。**
design §1.1 / §9.4 只定义了端点 `POST /library/keep-attachment`。C11 做出来才发现：
点完「确定」之后如果只弹一句 toast，用户下一步得自己去树里找。建议 toast 带一个
「打开」按钮直接深链过去（`/library?file={新 id}` 的形状 §9.5 已经有了，零新增机制）。
同样的缺口在 G5「导出到资料库」和 F4 的「已归档」chip 上都存在 —— 后者 design 说了 chip 可点开，
前两者没说。**建议统一成一条：凡是「东西进了资料库」的动作，回执里恒带一个跳过去的入口。**

**F4. 投影区的排序 / 分组与「三万张内嵌图」的过滤只写在服务端，UI 上没有出口。**
design §1.1 说投影是 `WHERE is_inline = 0` 并按 `{YYYY-MM}` 分组。做 B1 时发现两个问题：
① 分组粒度写死按月，一个重附件月份（实测 fixture 里 2026-07 有 51 个）就是一屏找不到东西，
而文件夹级过滤只能按文件名搜 —— 用户想按「发件人」或「邮件主题」筛没有入口，
但那两列**恰好就是投影区的「来源」列**。建议投影区的过滤框改成同时匹配 filename 与 source_ref。
② 内嵌图被过滤掉是对的，但用户不知道「过滤了」——设计上要不要在说明行里提一句？

**F5. 挂载根的 `mode` 切换（只读 ⇄ 可写）没定义「切成只读时，正在编辑的文件怎么办」。**
design §8.2 给了菜单项（A3 已画），但没写状态转换。三种可能：拒绝切换 / 切换并把编辑器降级成只读并保留草稿 / 切换并丢弃。
同类缺口还有「卸载挂载根时，事项里挂着的那些 `library:{id}` 怎么办」——按 §9.0 的 id 语义应该是标
`missing` 而不是删行，但 §8.2 只说「只删挂载行与索引」，两处口径要对齐（**「删索引」与「id 永不悬空」直接冲突**）。

### 🟡 建议但不阻塞

**F6. 「解析视图」这个词在 UI 上到处出现，但用户不一定知道它是什么。**
C5 / C6 里 PDF 的解析版是纯文本、Office 的是 markdown、csv 的是表格 —— 三种质量差别很大
（design §2.4 自己也承认 pdf lane 默认不开）。mockup 里各加了一行说明，但这是我编的文案。
建议统一一句用户语言的解释，且**三类各写各的**（把 PDF 的「纯文本带页分隔」说成和 Office 的
markdown 一样，用户打开就会失望）。

**F7. `text_status` 的四个值在列表里全部露出，密度上撑不住。**
B1 的磁贴里同时挂「来源」「解析状态」「文件状态」三个 pill，已经很挤了；列表视图里我
干脆没放解析状态。建议：只有**异常态**（pending / failed）进列表，`extracted` 与
`unsupported` 不显示（unsupported 从类型就能推断）。这是 mockup 里我已经这么做了的，
但 design §2.3 的列定义里没提，写下来免得实现时四态全画。

**F8. 历史面板的 `changed_by='external'` 行没有变更说明，占位文案要有人定。**
design §4 说外部编辑「补记 `changed_by='external'`」，但那条记录天生没有 `change_note`。
C9 里我填的是「（无变更说明 —— 应用之外的改动，打开时对账补记）」。这条文案值得定下来，
因为它是用户唯一一次被告知「我们做了尽力而为的对账」的地方。

**F9. 「对话」按钮预置 @ 提及之后，用户看到的是什么，design 没写。**
L16 拍板「不加第五档 `ConversationContextSource`，按钮 = 预置一条 @ 提及」。
问题是：预置之后**光标在哪、有没有预置的提示语**？空 composer 里孤零零一个 chip
会让人不知道该说什么。建议连带预置一句灰色 placeholder（如「问问这份文件…」），
或者干脆不预置正文，靠 chip 自己说明上下文。mockup 里 C1 的「对话」只弹了个 toast 说明动作。

**F10. `library_move` 的 ask 理由在卡片上说不清楚。**
design §5.1 的理由是「改路径 = 别人的引用可能断」，但 §9.0 又说跨模块引用键恒为
`library:{id}`、id 永不重算 —— 所以事项 / 通知 / 消息里的引用其实**不会断**。
真正会断的只有「别的 agent 手里记着的路径字符串」和「用户自己写在文档里的相对链接」。
F3 的卡片文案我按后者写了，但 design 的表述会让实现者写出错误的警示语。建议改掉 §5.1 那半句。

**F11. 废纸篓没有「永久删除」入口，只有「清空废纸篓」。**
L6 拍板软删 30 天。C13 做出来发现：用户想立刻彻底删掉某一个文件（例如误存了敏感附件）
只能等 30 天或者清空整个废纸篓。这在「误把公司合同拖进库」这种场景下是真实的痛点。
建议加一个单行的「立即永久删除」（带二次确认），或者明确写进 design 说这是有意不做的。

**F12. 挂载区的删除文案与库内不同，但入口是同一个菜单项。**
C13 的两个确认框内容差别很大（一个进 `.trash` 可恢复，一个进系统废纸篓）。
菜单项都叫「删除」。建议挂载区的菜单项直接改叫「移到系统废纸篓」，
把差异前移到菜单而不是等确认框才说 —— 确认框是最后一道，不该承担全部解释责任。

### ⚪ 记录性的观察（不需要拍板）

**F13.** design §2.1 的加域清单在 `NavPeek.PAGE_LISTS` 那一条标了 🔴「漏加不会红」。
A4 场景就是画给这一条看的：折叠态 hover 出的 peek 如果回落成空 `DomainPanel`，
用户看到的是一个**空浮层**，而不是报错。加域时这一步最容易漏。

**F14.** 导轨 rail order 9 是快照下唯一的空位（r2 调研的原话）。**这个快照会过期** ——
另一个 session 正在改 `registry.ts`（对话域拆分批）。落地前必须重读那三个文件。

**F15.** `pickIconTone` 吃的是附件行的形状 `{content_type, filename, size_bytes}`。
library 行本来就带 mime，直接传即可；但如果实现时想按 `kind` 传，要记得 `kind` 的词表
（markdown/html/pdf/office/image/text/other）与 `pickIconTone` 的判据（mime 前缀 + 扩展名）
不是一回事 —— mockup 里用 `parts/fileMeta.ts::MIME_BY_KIND` 做了一次反推，那是 mockup 的权宜，
**落地不要抄这张表**。

**F16.** 主仓 `index.css` 里有两处被设计钩子标为 `side-tab` 的「粗色边」（L4619 / L4624）。
本批次没碰那个文件（硬约束：只在 `mockups/library/` 下写文件），也不建议顺手改 ——
它是主题 v3 的既有配方，改它属于另一件事。
