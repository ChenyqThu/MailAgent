# Third-party notice — external app / connector logos

`appLogos.tsx` 里的 5 枚 logo path 数据逐字取自设计交付物的 `matters/logos/*.svg`
（`.trellis/tasks/08-12-matters-design-alignment/design-src-v3/matters/logos/`），
该目录本身由设计交付文档 `HANDOFF-列表与资料-v3.md` §行 118/174 引用为出处：

> logo 用 [logos.lndev.me](https://logos.lndev.me/)（GitHub `ln-dev7/logos-apps`，SVG）

拷入清单（组件名 ← 设计交付的 svg 文件名 ← 对应的品牌）：

| 组件 | 上游文件 | 品牌 |
|---|---|---|
| `NotionLogo` | `logos/notion.svg` | Notion |
| `ConfluenceLogo` | `logos/confluence.svg` | Atlassian Confluence |
| `JiraLogo` | `logos/jira.svg` | Atlassian Jira |
| `FigmaLogo` | `logos/figma.svg` | Figma |
| `GoogleDriveLogo` | `logos/google-drive.svg` | Google Drive |

设计交付里还有 5 枚本批**没有收**（`google-calendar` / `microsoft-sharepoint` / `slack` /
`dropbox` / `gmail`）—— 本仓当前没有任何一条 `resource.provider` 取值路径会产出
`googlecalendar`/`sharepoint`/`slack`/`dropbox`/`gmail`（`MATTER_LINK_PROVIDERS` 的 8 家
链接识别、`DOC_PROVIDER_ICONS` 的连接器 provider 落库形状都够不到这几家），先不收：
真有资料来源落在这几家时再从设计交付目录里补，不预先搬空整个上游图标库进 bundle
（同 `../providers/NOTICE.md` 的既有纪律：「宁可窄不要宽」，`src/shared/` 同时进桌面
renderer 与远程 web 两个 bundle）。

**授权/来源核实的诚实边界**：设计交付文档只写了站点名与 GitHub repo 名，本批**没有**
另外核实 `ln-dev7/logos-apps` 这个仓库本身的开源许可条款（是否 MIT / CC0 / 其它）——
这与 lobehub 那份 NOTICE 不同，那份核实过上游 `@lobehub/icons-static-svg` 的 MIT 协议。
但无论收录这些 SVG 的**集合**用什么协议开源，都不改变下一条：

各家 logo 的**商标权**归各自公司所有（Notion / Atlassian / Figma / Google）。收录这几个
图形只是为了在「资料来源」这个展示位上标出「这份资料来自哪个产品」，不代表任何形式的
品牌关联、认可或背书；集合层面的开源许可（不管条款是什么）**从不覆盖**logo 图形本身的
商标权。真要对外分发前如果这一点成为顾虑，应先独立核实上游仓库的具体许可条款。

**为什么手拷而不是加依赖**：同 `../providers/NOTICE.md` 的既有理由——只用得到 5 枚
图形，为它们单独加一个 npm 包（且这类 logo 包通常也是整包一堆 `.svg` 文件，不是按需
tree-shake 的组件库）不划算；`src/shared/` 同时进两个 bundle，体积要精打细算。

改动只做了 JSX 化（`stop-color` → `stopColor`）与渐变 `id` 重命名（`ma-icon-<name>-<n>`，
防止与页面内其它 svg 的渐变 id 相撞，抄 `../providers/brandIcons.tsx` 的既有先例）；
path 数据与官方配色一个字符没动。
