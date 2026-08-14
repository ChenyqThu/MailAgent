// 事项模块「资料来源」logo（批 8 / V3-19，手拷资产，非 npm 依赖）。同目录 NOTICE.md 是
// 归属声明的正本，改动本文件请同步那里的清单。
//
// 🔴 与 `../providers/brandIcons.tsx`（LLM 厂商 logo）的两处**有意不同**，别照抄它的形状：
//   ① 这里只有一套配色（各家官方品牌色），没有 mono/color 双变体 —— 品牌 logo 本来就不吃
//      `currentColor`，跟随文字明暗主题走会显得不像那家的标。
//   ② 调用点传的是数值 `size`（如 `<Icon size={13}/>`），不是像 brandIcons 那样固定
//      `size-4` 只吃 `className`。这里的 `size` 直接落在 `<svg>` 的 `width`/`height` 上，
//      配合默认的 `preserveAspectRatio="xMidYMid meet"`：这几家官方 viewBox 都不是正方形
//      （Notion 256×268、Confluence 256×246、Figma 256×384、Google Drive 256×229，只有
//      Jira 256×256 恰好方形），指定 width=height=size 会让内容按比例居中收缩，不会被拉伸。
//
// 资产来源见 NOTICE.md（design handoff 引用的 `logos.lndev.me` / `ln-dev7/logos-apps`）；
// path 数据与官方配色一个字符没动，只做了 JSX 化（`stop-color`→`stopColor`）与渐变 id
// 重命名（`ma-icon-<name>-<n>`，防与页面内其它 svg 撞，同 brandIcons 先例）。

/* eslint-disable mailagent/no-raw-hex -- 第三方品牌 logo 的官方配色是商标资产，不是主题 token（见文件头 + NOTICE.md） */

export interface AppLogoIconProps {
  size?: number | string
  className?: string
}

/** 与 `LucideIcon` 结构兼容（都接受 `size`/`className`），但**不是**同一个类型 ——
 *  这几枚不吃 `currentColor`、没有 `strokeWidth` 之类的描边参数，硬凑成 `LucideIcon` 的
 *  `ForwardRefExoticComponent` 形状没有意义。消费点用「成员索引 + `LucideIcon | AppLogoIcon`
 *  联合类型」承接（见 `matterResource.ts` / `matterLinkProviders.ts`），JSX 渲染两种类型都过。 */
export type AppLogoIcon = (props: AppLogoIconProps) => React.JSX.Element

/** Notion —— 白底圆角方块 + 黑色字形（官方双色 icon 标，非纯文字 wordmark）。 */
export function NotionLogo({ size = 16, className }: AppLogoIconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 256 268" width={size} height={size} className={className} aria-hidden>
      <path
        fill="#fff"
        d="M16.092 11.538L164.09.608c18.179-1.56 22.85-.508 34.28 7.801l47.243 33.282C253.406 47.414 256 48.975 256 55.207v182.527c0 11.439-4.155 18.205-18.696 19.24L65.44 267.378c-10.913.517-16.11-1.043-21.825-8.327L8.826 213.814C2.586 205.487 0 199.254 0 191.97V29.726c0-9.352 4.155-17.153 16.092-18.188"
      />
      <path
        fill="#000"
        d="M164.09.608L16.092 11.538C4.155 12.573 0 20.374 0 29.726v162.245c0 7.284 2.585 13.516 8.826 21.843l34.789 45.237c5.715 7.284 10.912 8.844 21.825 8.327l171.864-10.404c14.532-1.035 18.696-7.801 18.696-19.24V55.207c0-5.911-2.336-7.614-9.21-12.66l-1.185-.856L198.37 8.409C186.94.1 182.27-.952 164.09.608M69.327 52.22c-14.033.945-17.216 1.159-25.186-5.323L23.876 30.778c-2.06-2.086-1.026-4.69 4.163-5.207l142.274-10.395c11.947-1.043 18.17 3.12 22.842 6.758l24.401 17.68c1.043.525 3.638 3.637.517 3.637L71.146 52.095zm-16.36 183.954V81.222c0-6.767 2.077-9.887 8.3-10.413L230.02 60.93c5.724-.517 8.31 3.12 8.31 9.879v153.917c0 6.767-1.044 12.49-10.387 13.008l-161.487 9.361c-9.343.517-13.489-2.594-13.489-10.921M212.377 89.53c1.034 4.681 0 9.362-4.681 9.897l-7.783 1.542v114.404c-6.758 3.637-12.981 5.715-18.18 5.715c-8.308 0-10.386-2.604-16.609-10.396l-50.898-80.079v77.476l16.1 3.646s0 9.362-12.989 9.362l-35.814 2.077c-1.043-2.086 0-7.284 3.63-8.318l9.351-2.595V109.823l-12.98-1.052c-1.044-4.68 1.55-11.439 8.826-11.965l38.426-2.585l52.958 81.113v-71.76l-13.498-1.552c-1.043-5.733 3.111-9.896 8.3-10.404z"
      />
    </svg>
  )
}

/** Confluence —— 官方 Atlassian 蓝渐变双叶标。也代表 `provider==='atlassian'`（连接器 id，
 *  见 `matterResource.ts` DOC_PROVIDER_ICONS 上方注释：Atlassian 单个连接器同时覆盖
 *  Confluence 与 Jira，这枚 logo 是那个歧义下的近似选择，不是精确判定）。 */
export function ConfluenceLogo({ size = 16, className }: AppLogoIconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 256 246" width={size} height={size} className={className} aria-hidden>
      <defs>
        <linearGradient
          id="ma-icon-confluence-0"
          x1="99.14%"
          x2="33.859%"
          y1="112.708%"
          y2="37.755%"
        >
          <stop offset="18%" stopColor="#0052cc" />
          <stop offset="100%" stopColor="#2684ff" />
        </linearGradient>
        <linearGradient id="ma-icon-confluence-1" x1=".926%" x2="66.18%" y1="-12.582%" y2="62.306%">
          <stop offset="18%" stopColor="#0052cc" />
          <stop offset="100%" stopColor="#2684ff" />
        </linearGradient>
      </defs>
      <path
        fill="url(#ma-icon-confluence-0)"
        d="M9.26 187.33c-2.64 4.307-5.607 9.305-8.126 13.287a8.127 8.127 0 0 0 2.722 11.052l52.823 32.507a8.127 8.127 0 0 0 11.256-2.763c2.113-3.536 4.835-8.127 7.801-13.044c20.926-34.538 41.974-30.312 79.925-12.19l52.376 24.908a8.127 8.127 0 0 0 10.93-4.063l25.152-56.886a8.127 8.127 0 0 0-4.063-10.646c-11.052-5.201-33.034-15.562-52.823-25.111c-71.189-34.579-131.691-32.344-177.972 42.949"
      />
      <path
        fill="url(#ma-icon-confluence-1)"
        d="M246.115 58.232c2.641-4.307 5.607-9.305 8.127-13.287a8.127 8.127 0 0 0-2.723-11.052L198.696 1.386a8.127 8.127 0 0 0-11.58 2.682c-2.113 3.535-4.835 8.127-7.802 13.043c-20.926 34.538-41.974 30.313-79.925 12.19L47.176 4.515a8.127 8.127 0 0 0-10.93 4.063L11.093 65.465a8.127 8.127 0 0 0 4.063 10.645c11.052 5.202 33.035 15.563 52.823 25.112c71.351 34.538 131.854 32.222 178.135-42.99"
      />
    </svg>
  )
}

/** Jira —— 官方 Atlassian 蓝三重箭头标。仅用于 `MATTER_LINK_PROVIDERS`（粘贴链接按
 *  URL 路径能分清 Confluence/Jira）；`resource.provider` 单值场景恒落 Confluence 标，
 *  见 `ConfluenceLogo` 注释。 */
export function JiraLogo({ size = 16, className }: AppLogoIconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} className={className} aria-hidden>
      <defs>
        <linearGradient id="ma-icon-jira-0" x1="98.031%" x2="58.888%" y1=".161%" y2="40.766%">
          <stop offset="18%" stopColor="#0052cc" />
          <stop offset="100%" stopColor="#2684ff" />
        </linearGradient>
        <linearGradient id="ma-icon-jira-1" x1="100.665%" x2="55.402%" y1=".455%" y2="44.727%">
          <stop offset="18%" stopColor="#0052cc" />
          <stop offset="100%" stopColor="#2684ff" />
        </linearGradient>
      </defs>
      <path
        fill="#2684ff"
        d="M244.658 0H121.707a55.5 55.5 0 0 0 55.502 55.502h22.649V77.37c.02 30.625 24.841 55.447 55.466 55.467V10.666C255.324 4.777 250.55 0 244.658 0"
      />
      <path
        fill="url(#ma-icon-jira-0)"
        d="M183.822 61.262H60.872c.019 30.625 24.84 55.447 55.466 55.467h22.649v21.938c.039 30.625 24.877 55.43 55.502 55.43V71.93c0-5.891-4.776-10.667-10.667-10.667"
      />
      <path
        fill="url(#ma-icon-jira-1)"
        d="M122.951 122.489H0c0 30.653 24.85 55.502 55.502 55.502h22.72v21.867c.02 30.597 24.798 55.408 55.396 55.466V133.156c0-5.891-4.776-10.667-10.667-10.667"
      />
    </svg>
  )
}

/** Figma —— 官方五色圆环标。 */
export function FigmaLogo({ size = 16, className }: AppLogoIconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 256 384" width={size} height={size} className={className} aria-hidden>
      <path
        fill="#0acf83"
        d="M64 384c35.328 0 64-28.672 64-64v-64H64c-35.328 0-64 28.672-64 64s28.672 64 64 64"
      />
      <path
        fill="#a259ff"
        d="M0 192c0-35.328 28.672-64 64-64h64v128H64c-35.328 0-64-28.672-64-64"
      />
      <path fill="#f24e1e" d="M0 64C0 28.672 28.672 0 64 0h64v128H64C28.672 128 0 99.328 0 64" />
      <path fill="#ff7262" d="M128 0h64c35.328 0 64 28.672 64 64s-28.672 64-64 64h-64z" />
      <path
        fill="#1abcfe"
        d="M256 192c0 35.328-28.672 64-64 64s-64-28.672-64-64s28.672-64 64-64s64 28.672 64 64"
      />
    </svg>
  )
}

/** Google Drive —— 官方三色三角标。也代表 `googleDocs`（本仓的链接识别 key）与
 *  `googledrive`（连接器 id，见 `matterLinkProviders.ts` 与 `matterResource.ts` 的用法）：
 *  Google 官方没有单独的「Google 文档」logo，Docs/Sheets/Slides 的落地页都用这枚 Drive 标。 */
export function GoogleDriveLogo({ size = 16, className }: AppLogoIconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 256 229" width={size} height={size} className={className} aria-hidden>
      <path
        fill="#0066da"
        d="m19.354 196.034l11.29 19.5c2.346 4.106 5.718 7.332 9.677 9.678q17.009-21.591 23.68-33.137q6.77-11.717 16.641-36.655q-26.604-3.502-40.32-3.502q-13.165 0-40.322 3.502c0 4.545 1.173 9.09 3.519 13.196z"
      />
      <path
        fill="#ea4335"
        d="M215.681 225.212c3.96-2.346 7.332-5.572 9.677-9.677l4.692-8.064l22.434-38.855a26.57 26.57 0 0 0 3.518-13.196q-27.315-3.502-40.247-3.502q-13.899 0-40.248 3.502q9.754 25.075 16.422 36.655q6.724 11.683 23.752 33.137"
      />
      <path
        fill="#00832d"
        d="M128.001 73.311q19.68-23.768 27.125-36.655q5.996-10.377 13.196-33.137C164.363 1.173 159.818 0 155.126 0h-54.25C96.184 0 91.64 1.32 87.68 3.519q9.16 26.103 15.544 37.154q7.056 12.213 24.777 32.638"
      />
      <path
        fill="#2684fc"
        d="M175.36 155.42H80.642l-40.32 69.792c3.958 2.346 8.503 3.519 13.195 3.519h148.968c4.692 0 9.238-1.32 13.196-3.52z"
      />
      <path
        fill="#00ac47"
        d="M128.001 73.311L87.681 3.52c-3.96 2.346-7.332 5.571-9.678 9.677L3.519 142.224A26.57 26.57 0 0 0 0 155.42h80.642z"
      />
      <path
        fill="#ffba00"
        d="m215.242 77.71l-37.243-64.514c-2.345-4.106-5.718-7.331-9.677-9.677l-40.32 69.792l47.358 82.109h80.496c0-4.546-1.173-9.09-3.519-13.196z"
      />
    </svg>
  )
}
