// 资料库 REST client 的组件侧取法 —— 形状逐字镜像 `components/contacts/hooks.ts` 的
// `useContactsApi`（`useMemo` 一次，baseUrl 由 `resolveApiBaseUrl()` 给）。
//
// 放在 `shared/hooks/` 而不是某个域的 components 目录：资料库的消费方跨域（⌘K 面板 /
// `/search` 页 / 事项关联弹窗 / compose 选附件），谁都不该从别人的 components 里拿它。

import { useMemo } from 'react'

import { createLibraryApi, type LibraryApi } from '@shared/api/library'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'

export function useLibraryApi(): LibraryApi {
  return useMemo(() => createLibraryApi(resolveApiBaseUrl()), [])
}
