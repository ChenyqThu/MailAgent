// V2.1 阶段 3 — 3c-4 cutover 测试替身：backend 注册表。
//
// cutover 删了生产 chat/registry.ts（backend 注册已收进 runtime.buildEngine 的本地
// backends map + getBackend closure，不再 module-global）。但 chat_dispatcher.test 需要
// 一个「注册 mock backend + 按 kind 查」的机制来注入脚本化 backend。这个替身复刻原
// registry.ts 的 register/get/reset 语义（module-global Map），让那些测试只改 import 路径。
//
// 错误信息保留 "No chat backend registered" 关键短语 —— dispatcher / runtime 的
// normalizeDispatchError 据此把 backend-missing 归 E_BACKEND_UNAVAILABLE，相关 test 断言它。

import type { BackendKind } from '../../../../src/shared/chat/model'
import type { ChatBackend } from '../../../../src/shared/chat/types'

const _backends = new Map<BackendKind, ChatBackend>()

export function registerChatBackend(backend: ChatBackend): void {
  _backends.set(backend.kind, backend)
}

export function getChatBackend(kind: BackendKind): ChatBackend {
  const b = _backends.get(kind)
  if (!b) {
    throw new Error(`No chat backend registered for kind="${kind}".`)
  }
  return b
}

export function listRegisteredBackendKinds(): BackendKind[] {
  return [..._backends.keys()]
}

/** Clear all registrations between specs. */
export function __resetBackendRegistry(): void {
  _backends.clear()
}
