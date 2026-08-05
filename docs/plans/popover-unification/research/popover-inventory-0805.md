> **底稿性质**：2026-08-05 由只读盘点 agent 产出，原文一字未改（仅补本行出处）。
> 迁移方案见同目录 `plan.md`；这份是它引用的证据底稿，**不要在这里写方案**。

# 全 app popover 盘点（2026-08-05，popover-inventory agent 产出）

结论：仓库里**没有任何右键上下文菜单**（onContextMenu 全仓 0 命中）。共 **13 种底层实现** + 原生 `<select>` 第 14 类，约 50 个场景，其中 ~25 个独立弹层是手搓的。

## A. 底层实现种类汇总

| # | 实现 | 性质 | 代表文件 | 消费点 | 关键风险 |
|---|---|---|---|---|---|
| 1 | Radix Popover 包装 | 共享基座 | `src/shared/components/ui/popover.tsx` | 4 文件/9 处 | 唯一带自动翻转；z-50 |
| 2 | Radix Select 包装 | 共享基座 | `src/shared/components/ui/select.tsx` | 9 文件/14 处 | 与 #1 样式同族 API 不同 |
| 3 | Radix Tooltip 包装 | 共享基座 | `src/shared/components/ui/tooltip.tsx` | 仅 MessageTiming.tsx | 与 #4 重复造轮（保留双轨理由见 tooltip.tsx:5-8） |
| 4 | HoverTip 手搓 hover 芯片 | 共享基座 | `src/shared/components/ui/HoverTip.tsx` | 11 文件/22 处 | 无翻转无碰撞；portal 模式 rect 只量一次，滚动错位 |
| 5 | DrillMenu 手搓下钻栈 | 共享基座 | `src/shared/components/ui/DrillMenu.tsx` | EmailListHeader | 全仓唯一完整键盘导航+GSAP morph+ResizeObserver；正被重做 |
| 6 | useExitAnimation+createPortal+`.theme-popover` | 半共享 | `AccentPickerPopover.tsx` 等 5 文件 | TitleBar 系 | TitleBar backdrop-filter 造 stacking context 必须 portal；每文件复制 outside-click+Esc |
| 7 | useExitAnimation+absolute 无 portal | 半共享 | `AccountSwitcherPopover.tsx`、`EmailToolbar.tsx:409`、`MentionPopover.tsx:149`、`MonthView.tsx:295` | 4 处 | MonthView 自己实现垂直 flip |
| 8 | 裸 useState+absolute+手写 document 监听 | 散落手搓（最大族） | `ModelPicker.tsx:295`、`ComposerPlusMenu.tsx`、`ApprovalModePicker.tsx:196`、`CalendarToolbar.tsx:257`、`FolderPicker.tsx:368`、`ComposePanel.tsx:146`、`RecipientField.tsx:607`、`ComposeEditor.tsx:344` | 8 处 | 越界全靠逐控件手算像素（注释里有算式）；迁移收益最大也最危险 |
| 9 | 透明全屏遮罩+absolute 菜单 | 散落手搓 | `AssistantChatModal.tsx:377`、`ChatModalHistoryDropdown.tsx:56` | 2 处 | 无 Esc 无键盘导航 |
| 10 | 手算 viewport fixed 定位 | 散落手搓 | `ModelDetailCard.tsx`+`modelDetailCard.lib.ts`、`recipient-detail.tsx` | 2 处 | ModelDetailCard 有 placement 单测 |
| 11 | TipTap Suggestion+ReactRenderer 手挂 body | 散落手搓 | `editor-suggest.tsx`+`editor-extensions.ts:53-140` | slash+mention 2 菜单 | caret rect 锚定；键盘走 useImperativeHandle；stale-callback 幂等补丁 |
| 12 | assistant-ui `Unstable_TriggerPopover` | 外部库 | `AgentTriggerPopover.tsx:155` | 2 处 | 行为在库内，**不可直接换基座** |
| 13 | CSS-only :hover 浮层 | 纯 CSS | `.sync-tip`(index.css:3907)/`.cal-legend-tip`(:3934)/`.sb-pop`(:4541) | 3 处 | 恒挂载；.sync-tip/.sb-pop 键盘不可达 |
| 14 | 原生 `<select>` | — | ScheduleBuilder.tsx(×6 含 418 项 IANA 时区，注释明确故意原生)、EventFormModal.tsx:577、RRuleEditor.tsx、ChatsTab.tsx:181、AutomationPolicySection.tsx:510、onboarding/steps.tsx:1002,1965 | ~11 处 | 418 项需虚拟化才能迁；onboarding 样式隔离（不吃主 index.css token） |

共享度：45 处走共享基座（22 HoverTip+14 Select+9 Radix Popover）；~25 个独立弹层手搓分散 8 种实现。

## B. 逐场景清单（场地 | 文件 | 触发 | 形态 | 实现# | 风险）

### TitleBar
1. 强调色选择器 | `layout/AccentPickerPopover.tsx:118` | 点击 | 3×3 色板 radio 网格 | #6 | portal 必需；WebkitAppRegion no-drag 透传；无方向键
2. 材质选择器 | `layout/SurfacePickerPopover.tsx:99` | 点击 | 单选组(带 mini preview) | #6 | 宽 220 inline 覆盖 .theme-popover 264
3. 主题选择器 | `layout/ThemePickerPopover.tsx:99` | 点击 | 单选组 | #6 | showcase 必须双主题验
4. 系统告警详情 | `layout/SystemAlertBadge.tsx:140` | 点击徽标 | 富内容列表 | #6 | role=dialog 无 focus trap
5. Agent 待审批 | `agents/AgentPendingBadge.tsx:151` | 点击徽标 | 富内容列表可点行 | #6 宽320 | 开才拉的懒加载语义要保
（LocalePicker 是纯 toggle 非弹层）

### Sidebar
6. 账户切换 | `layout/AccountSwitcherPopover.tsx:65`（触发 Sidebar.tsx:358） | 点击 | 纯菜单 | #7 | **stretch 到容器宽**模式（left-2 right-2）；先展开侧栏延迟一 tick 开弹层时序；折叠态专门 CSS index.css:1267
7. 文件夹树 hover | `layout/SidebarFolderTree.tsx:29` | hover | 文本芯片 | #4 portal 模式 | overflow 裁剪是 portal prop 的由来

### 邮件列表
8. 筛选下钻菜单 | `email/EmailListHeader.tsx:478`+DrillMenu | 点击 | 多级+多选+单选+分节+kbd | #5 | 正被重做；push/pop 面板栈能力不能丢
9. BatchActionBar | 非 popover，勿迁

### 邮件详情/工具栏
10. 回复分裂菜单 | `email/EmailToolbar.tsx:409` | 点击 chevron | 菜单 3 项+kbd | #7 | **故意实心 bg-ink-2 不用 glass-pop**（半透明透正文发脏，411-414 注释）→ 基座需 surface 两档
11. 工具栏 hover | EmailToolbar.tsx:48 | hover | 芯片 | #4 | —
（ResyncConfirmDialog 是模态非弹层）

### Composer
12. 段落/字体/字号/行距 4 下拉 | `compose/ComposeEditor.tsx:265` OptionPopoverButton（调用 618/643/658/673） | 点击 | 单选组 listbox | #1 | 不用原生 select 因 Electron modal 误关 backdrop（263-264 注释）；**trigger 全挂 onMouseDown preventDefault 保 TipTap 选区** |
13. 文字色/高亮色板 ×2 | ComposeEditor.tsx:159 SwatchPopoverButton（709/722） | 点击 | 色板网格富内容 | #1 | `<input type=color>` 必须挂 Popover 外（系统取色面板会关 popover，155-158 血泪）
14. 插入表格 | ComposeEditor.tsx:383 TableInsertPopover | 点击 | 行×列 grid 选择 | #1 | z-[70] 单独抬高有层级冲突史
15. 链接/图片内联输入 | ComposeEditor.tsx:326 InlineInputBox | 点击 | url input 表单 | #8 | z-20 过低；无 outside-click
16. 重要性下拉 | `compose/ComposePanel.tsx:145` ImportanceSelect | 点击 | 单选组 | #8 | **最脆**：onBlur+120ms 定时器关闭，无 outside-click/Esc/键盘；迁移纯收益
17. 收件人自动补全 | `compose/RecipientField.tsx:602-607` | 输入自动开 | combobox 搜索+列表 | #8 | 完整 combobox a11y（aria-activedescendant）；**焦点留 input 的 combobox 模式**
18. 收件人 chip 详情卡 | `compose/recipient-detail.tsx:71` | 点击 chip | 富内容动作卡 | #10 fixed z-[60] | **capture-phase Esc+stopImmediatePropagation 防冒泡关 composer**（44-51）→ 基座需 Esc 层级栈
19. slash 块菜单 | `compose/editor-suggest.tsx:77` | 输入 `/` | 菜单(图标+副标题+分组) | #11 | caret rect 锚定；body 手挂非 React portal
20. @mention 联系人 | editor-suggest.tsx:131 | 输入 `@` | 单选列表 | #11 | 同上

### Chat/AI 面板（assistant/）
21. 模型选择器 | `assistant/components/ModelPicker.tsx:293` | 点击 | provider 分组富内容+menuitemradio，max-h 320 内滚 | #8 向上展开 w-264 | 布局红线 23-27 行：面板 360px、右缘 348 手算；打开 scrollIntoView；无方向键
22. 模型能力卡 | `ModelDetailCard.tsx:127`+lib | hover 行 | 富内容卡 | #10 portal 三档 placement | **最难迁**：必须 portal（双层 overflow hidden）；pointer-events-none 硬要求（否则 outside-click 误关选择器）；故意不透明 bg-ink-2（owner 08-05 拍板）；锚弹层底边防跳；四档场地宽
23. 「+」菜单 | `ComposerPlusMenu.tsx:161/:196`+ConnectorQuickPanel | 点击 | 一级菜单 196px；二级**同锚点换内容**表单面板 268px | #8 共享 POPOVER_SHELL 常量 | toggle 必须走 close() 重置 view（61-66 血泪）；input file 挂 wrapper 外
24. 审批模式选择器 | `ApprovalModePicker.tsx:186` | 点击 | 单选组+**内联危险确认换页** | #8 居中锚定 w-248 | 190-195 越界修复史（left-0 右缘 388>348）；saving 期整体 disabled
25. 会话历史 | `chat/ChatHistoryPopover.tsx:88` | 点击 | 富列表+内联删除二次确认，max-h 360 | 手搓+tailwindcss-animate（**第 3 套动效**） | outside-click 靠 DOM 属性选择器 `[data-chat-history-toggle]`；z-30 偏低
26. @mention 邮件搜索 | `chat/MentionPopover.tsx:149` | 点击 @ 按钮 | 搜索 input+200ms debounce+listbox | #7 | 故意不透明；autofocus input（combobox 焦点模型）
27. 消息耗时 | `MessageTiming.tsx:34` | hover | 多行明细 tooltip | #3（全仓唯一消费者） | 与 HoverTip 合并or双轨需 owner 拍板
28. 面板内 HoverTip 若干 | AiChatPanel.tsx:34、composer.tsx:29 等 | hover | 芯片 | #4 | —

### Chat 浮窗 Modal
29. 停靠模式菜单 | `modal/AssistantChatModal.tsx:377` ModeMenu | 点击 | menuitemradio ×2+action | #9 | 无 Esc 无键盘；实心 bg-ink-2+hairline（**第 4 种材质配方**）
30. 会话历史下拉 | `modal/ChatModalHistoryDropdown.tsx:56` | 点击标题 | 富列表 today/yesterday/earlier 分组，max-h 60vh | #9 | 与 #25 同一件事的第二套实现
31. ChatModalFab | 非 popover

### Agents 页
32. 会话行 ⋯ 菜单 | `agents/AgentThreadList.tsx:466` SessionRowMenu | 点击 hover 出现的 ⋯ | 菜单(改名/置顶/归档/恢复/删除 danger) | #1 side="right"（全仓唯一） | trigger opacity-0 group-hover，open 时强制可见 → 基座要回传 open 态给 trigger
33. @/slash trigger ×2 | `agents/AgentTriggerPopover.tsx:155` | 输入 @// | 多级+搜索（库内部） | #12 | **不可直接换**；要迁得重写 AgentComposer trigger 适配层
34. 模型/时区 Select 多处 | CustomAgentDrawer.tsx:607,675、ConfigDrawer.tsx:453、SearchConfigDrawer.tsx:311、PreprocessConfigDrawer.tsx:469,495、AutomationPolicySection.tsx:425,453,465、ModelSelectItems.tsx | 点击 | 单选组分组 | #2 | 全在 Drawer 里，portal z-index 协调
35. 原生 select | ScheduleBuilder.tsx:347-463(×6)、ChatsTab.tsx:181、AutomationPolicySection.tsx:510 | — | 原生 | #14 | 418 项 IANA 时区故意原生（459 注释）；**没有虚拟化方案不能动**

### 日历
36. 日历筛选 | `calendar/CalendarToolbar.tsx:257` | 点击 | menuitemcheckbox 多选+互斥"全部" | #8 z-30 | 仅 calendars>1 渲染；无键盘
37. 月视图 +N 更多 | `views/MonthView.tsx:293` | 点击 | 富内容事件列表 | #7+.more-pop | 全仓唯一自实现垂直 flip（240-268）；三 ref 合并；useFocusTrap；退场 lastPop 保内容
38. 同步状态详情 | CalendarToolbar.tsx:337 .sync-tip | hover 纯 CSS | 富内容 290px | #13 z-70 | 无 :focus-within 键盘不可达
39. 事件状态图例 | `CalendarStatusLegend.tsx:37` .cal-legend-tip | hover/focus | 说明表 230px | #13 | 有 :focus-within
40. 状态栏同步详情 | `layout/CalendarLayout.tsx:395` .sb-pop | hover/focus | k-v 行 288px 向上 | #13 | bottom 写死向上
41. 原生 select | EventFormModal.tsx:577、RRuleEditor.tsx:55,110 | — | 原生 | #14 | 模态内可能有"误关 backdrop"same bug 未被发现

### 设置页
42. 启用模型多选 | `settings/tabs/AiTab.tsx:290-372` | 点击 | 刷新行+checkbox 滚动列表 280px | #1 | trigger 手抄 SelectTrigger 类名字符串（294-302）迁移顺手收敛
43. 标题模型 Select | AiTab.tsx:596-620 | 点击 | 单选组含孤儿值兜底 | #2 | —
44. 模板 Select | `providers/ModelServicesSection.tsx:101` | 点击 | 单选组 260px | #2 | —
45. EnvField Select | `parts/EnvField.tsx:320` | 点击 | 单选组 | #2 | 通用渲染器一处改动多页影响
46. NotionAgentSkillConfig ×2 | :283,:325 | 点击 | 单选组 | #2 | —
47. 文件夹管理 ⋯ | `parts/FolderPicker.tsx:367` | 点击 hover ⋯ | 菜单+分隔+danger | #8 z-20 实心 bg-ink-1（**第 5 种材质**） | **无 outside-click 无 Esc**；长树滚动容器内，portal 后要滚动跟随

### Onboarding
48. 原生 select ×2 | `onboarding/steps.tsx:1002,1965` | — | 原生 | #14 | 独立渲染入口不吃主 index.css token

### 全局
49. HoverTip 22 调用点 | `ui/HoverTip.tsx` | hover/focus | 芯片 | #4 | 4 向定位无翻转；portal rect 只量一次
50. CommandPalette | `command/CommandPalette.tsx:979` | ⌘K | 搜索+listbox | 模态非 popover | 键盘导航参考基准

## C. 硬约束（代码注释里挖的，不要重蹈）

1. **材质 5 档并存**：glass-pop / 实心 bg-ink-2（三处都因"半透明透正文发脏"回退）/ 实心 bg-ink-1 / .theme-popover / .drill-shell 自制 glass。基座必须 `surface="glass"|"solid"` 开关。
2. **z-index 五档乱象**：20/30/50/60/70 无统一常量。
3. **动效 3 套并存**：GSAP useExitAnimation / tailwindcss-animate data-state / CSS transition。reduced-motion 只有前两套处理（GSAP 必须 JS 层短路）。
4. **焦点模型 3 种互斥**：menu 型（roving tabindex）/ combobox 型（焦点留 input + aria-activedescendant）/ inert 型（pointer-events-none 绝不吃焦点）。
5. **Esc 嵌套语义**：需要 Esc 层级栈（recipient-detail capture+stopImmediatePropagation；DrillMenu 子面板 Esc=返回上层）。
6. **编辑器场景 trigger/content 必须 onMouseDown preventDefault**（TipTap 选区）。
7. **锚定/越界逐控件手算**（基准"邮件面板 360px 右缘 348"）；换自动 collision 后所有手调 align 逐个复核，ApprovalModePicker 的居中锚定是补丁不是设计。
