// W8 模型选择器 — 厂商 logo 组件出口。映射表与解析逻辑在 ./providerIconMap（.ts，零 JSX），
// 本文件只导出组件（react-refresh/only-export-components）。资产授权见 NOTICE.md。

import { Cpu } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

import { resolveProviderIcon } from './providerIconMap'

/** 厂商 logo（mono，吃 currentColor）。未匹配 → lucide Cpu，尺寸与 mono logo 对齐。
 *  🔴 `render(props)` 直接调用而非 `<Icon/>`：表里的值是无 hook 的纯 SVG 渲染函数，
 *  当组件用会触发 react-hooks/static-components（抄 ToolTraceCard.toolKindIconEl 先例）。 */
export function ProviderBrandIcon({
  providerId,
  protocol,
  className
}: {
  providerId: string | null | undefined
  protocol?: LlmProviderProtocol | null
  className?: string
}): React.JSX.Element {
  const render = resolveProviderIcon(providerId, protocol)
  if (render) return render({ className })
  return <Cpu strokeWidth={2} className={cn('size-4 shrink-0', className)} aria-hidden />
}
