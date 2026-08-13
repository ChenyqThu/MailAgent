// 灵动 bot 头像 —— 模块级共享 rAF ticker（本仓首个共享 ticker，prd §4.6-1）。
// 为什么不各实例自跑 rAF：多实例同屏（编辑器预览/chat 双位点）会各起一条 rAF 链，
// Strands 先例是单实例所以无所谓；这里统一成一条循环 + 隐藏页全局暂停，省电档

// 客户端 = 每帧回调（rAF 时间戳，performance.now 时基）。
// 「只 advance 未 settled 的实例」由客户端内部决定（engine.tick 返回 null 即跳过
// DOM 写入）——ticker 不理解引擎语义，职责只有一条循环的启停。
export type TickerClient = (now: number) => void

const clients = new Set<TickerClient>()
let rafId: number | null = null
let visibilityHooked = false

const hasDom = typeof document !== 'undefined' && typeof requestAnimationFrame !== 'undefined'

function loop(now: number): void {
  rafId = null
  if (clients.size === 0) return
  for (const client of clients) client(now)
  // 客户端可能在回调里 unregister 自己（如 IntersectionObserver 触发卸载）
  if (clients.size > 0) rafId = requestAnimationFrame(loop)
}

function start(): void {
  if (!hasDom || rafId !== null || clients.size === 0) return
  if (document.hidden) return // 隐藏页不起循环，visible 时再启
  rafId = requestAnimationFrame(loop)
}

function stop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function hookVisibility(): void {
  // 懒挂载 + 永不解绑：模块级单例监听一枚，代价恒定；解绑时机（clients 空）与
  // 再注册竞态不值得管理
  if (visibilityHooked || !hasDom) return
  visibilityHooked = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop()
    else start()
  })
}

export function registerTicker(client: TickerClient): void {
  if (!hasDom) return // SSR/纯 node 测试环境：静默 no-op，组件层不需要判环境
  hookVisibility()
  clients.add(client)
  start()
}

export function unregisterTicker(client: TickerClient): void {
  clients.delete(client)
  if (clients.size === 0) stop()
}

/** 测试探针：当前注册的实例数（reduced-motion / 卸载断言用），生产代码勿读 */
export function __instanceCount(): number {
  return clients.size
}
