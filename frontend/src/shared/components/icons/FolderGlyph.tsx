// `folder_pref.icon` → 渲染出的图标。查表 + 渲染收在这一个组件里。
//
// 为什么不是让调用方自己 `const Icon = folderIcon(key)` 再 `<Icon />`：那是在 render 里
// 把一个变量当组件名用，`react-hooks/static-components` 会拦（它没法确认那个变量每次
// render 都是同一个引用；引用变了 React 会把子树当新组件、状态全丢）。这里查表结果确实
// 是模块级的稳定引用，但与其在三个调用点各写一遍注释绕过，不如收成一个静态组件。

import * as React from 'react'

import type { AnimatedIconProps } from './AnimatedIcon'
import { folderIcon } from './folderIcons'

export interface FolderGlyphProps extends AnimatedIconProps {
  /** `folder_pref.icon` 的原值。null / 不认识 → 兜底 folder。 */
  iconKey: string | null | undefined
}

export function FolderGlyph({ iconKey, ...rest }: FolderGlyphProps): React.ReactElement {
  return React.createElement(folderIcon(iconKey), rest)
}
