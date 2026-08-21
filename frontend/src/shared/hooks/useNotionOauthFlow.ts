// task 08-20 Notion OAuth — 授权流的 renderer 状态机（Lane 3）。
//
// 一份状态机，两处皮肤：设置页（AccountsTab，token 化组件）与 onboarding
//（.ob 作用域样式、中文硬编码原型）。视觉没法共用，流程语义必须共用 —— 否则
// 「按 attemptId 丢弃旧事件」这类判据会在两处各写一遍、各错一遍。
//
// 权威在 main（notion_oauth.ts）：attempt 生命周期、state 校验、code 一次性、
// env 原子写全在那边。本 hook 只做三件事：
//   1. 发起 / 取消 / 提交选择；
//   2. 订阅 `notionOauth:status`，**按 attemptId 过滤**（旧 attempt 的迟到事件丢弃）；
//   3. 把 phase / errorCode / 候选列表暴露给 UI。
//
// 有意不做的事：
//   * 组件卸载**不**取消在途 attempt —— 授权是浏览器里进行的，main 收到回调就会
//     原子写 env，用户切个 Tab 不该让它作废（切回来看到 idle 是诚实的：renderer
//     不再持有这次 attempt 的事件流，再点「连接」main 会原子替换旧 attempt）。
//   * 不缓存任何候选/展示信息到 storage —— attempt 结束 main 就清了，renderer 跟随。

import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  NotionDbCandidate,
  NotionOauthErrorCode,
  NotionOauthPhase
} from '@shared/lib/notionOauthContract'
import {
  cancelNotionOauth,
  listNotionDatabases,
  selectNotionDatabases,
  startNotionOauth,
  subscribeNotionOauthStatus
} from '@shared/lib/notionOauthIpc'

export interface NotionOauthDoneInfo {
  workspaceName: string
  emailDbTitle: string
  calendarDbTitle: string
}

export interface NotionOauthFlow {
  /** null = 空闲（从未发起 / 上一次已收尾并被 dismiss）。 */
  phase: NotionOauthPhase | null
  errorCode: NotionOauthErrorCode | null
  /** need_selection 阶段的候选列表；其它阶段为 null。 */
  candidates: NotionDbCandidate[] | null
  /** done 事件带的展示信息（不含 token）。 */
  doneInfo: NotionOauthDoneInfo | null
  /** start / selectDatabases 调用在途。 */
  busy: boolean
  start: () => void
  cancel: () => void
  submitSelection: (emailDbId: string, calendarDbId: string) => void
  /** 收起「已完成 / 失败」提示，回到空闲态。 */
  dismiss: () => void
}

export interface UseNotionOauthFlowOptions {
  /** NOTION_OAUTH_ENV_KEYS 已由 main 原子写入后触发（设置页据此刷新 env 快照 + 标记需重启）。 */
  onWritten?: (info: NotionOauthDoneInfo) => void
}

export function useNotionOauthFlow(options: UseNotionOauthFlowOptions = {}): NotionOauthFlow {
  const { onWritten } = options
  const [phase, setPhase] = useState<NotionOauthPhase | null>(null)
  const [errorCode, setErrorCode] = useState<NotionOauthErrorCode | null>(null)
  const [candidates, setCandidates] = useState<NotionDbCandidate[] | null>(null)
  const [doneInfo, setDoneInfo] = useState<NotionOauthDoneInfo | null>(null)
  const [busy, setBusy] = useState(false)

  // 当前 attempt。事件过滤读它 —— 存 ref 而非 state，订阅 effect 才不用随每次
  // attempt 重挂（重挂窗口里到达的事件会被漏掉）。
  const attemptRef = useRef<string | null>(null)
  const aliveRef = useRef(true)
  // onWritten 存 ref（订阅 effect 只跑一次；调用方传内联闭包不该导致重订阅）。
  // 用 effect 写 ref 而不是渲染期赋值 —— 渲染期改 ref 是 react-hooks/refs 的坑。
  const onWrittenRef = useRef<UseNotionOauthFlowOptions['onWritten']>(undefined)
  useEffect(() => {
    onWrittenRef.current = onWritten
  }, [onWritten])

  useEffect(() => {
    aliveRef.current = true
    const dispose = subscribeNotionOauthStatus((event) => {
      if (!aliveRef.current) return
      // 🔴 只认当前 attempt：旧 attempt 的迟到事件（含 main 原子替换时发的
      // cancelled）必须丢弃，否则会把新一次授权的界面打回错误态。
      if (!event?.attemptId || event.attemptId !== attemptRef.current) return
      setPhase(event.phase)
      if (event.phase === 'error') {
        setErrorCode(event.errorCode ?? null)
        setCandidates(null)
        attemptRef.current = null
        return
      }
      setErrorCode(null)
      if (event.phase === 'done') {
        const info: NotionOauthDoneInfo = {
          workspaceName: event.workspaceName ?? '',
          emailDbTitle: event.emailDbTitle ?? '',
          calendarDbTitle: event.calendarDbTitle ?? ''
        }
        setDoneInfo(info)
        setCandidates(null)
        attemptRef.current = null
        onWrittenRef.current?.(info)
        return
      }
      if (event.phase === 'need_selection') {
        const id = event.attemptId
        void listNotionDatabases(id)
          .then((list) => {
            if (!aliveRef.current || attemptRef.current !== id) return
            setCandidates(Array.isArray(list) ? list : [])
          })
          .catch(() => {
            if (!aliveRef.current || attemptRef.current !== id) return
            setCandidates([])
          })
      }
    })
    return () => {
      aliveRef.current = false
      dispose()
    }
  }, [])

  const start = useCallback((): void => {
    setBusy(true)
    setErrorCode(null)
    setDoneInfo(null)
    setCandidates(null)
    setPhase(null)
    void startNotionOauth()
      .then((res) => {
        if (!aliveRef.current) return
        setBusy(false)
        if (res?.ok) {
          attemptRef.current = res.attemptId
          // waiting_callback 事件可能已在 invoke resolve 前到达并被过滤掉
          //（那时 attemptRef 还是 null），故这里显式落一次起始 phase。
          setPhase('waiting_callback')
        } else {
          attemptRef.current = null
          setPhase('error')
          setErrorCode(res?.errorCode ?? 'upstream_error')
        }
      })
      .catch(() => {
        if (!aliveRef.current) return
        setBusy(false)
        attemptRef.current = null
        setPhase('error')
        setErrorCode('network_error')
      })
  }, [])

  const cancel = useCallback((): void => {
    const id = attemptRef.current
    attemptRef.current = null
    setPhase(null)
    setErrorCode(null)
    setCandidates(null)
    setBusy(false)
    if (id) void cancelNotionOauth(id).catch(() => undefined)
  }, [])

  const submitSelection = useCallback((emailDbId: string, calendarDbId: string): void => {
    const id = attemptRef.current
    if (!id) return
    setBusy(true)
    setErrorCode(null)
    void selectNotionDatabases({ attemptId: id, emailDbId, calendarDbId })
      .then((res) => {
        if (!aliveRef.current) return
        setBusy(false)
        // 成功时后续 writing / done 由 status 事件推进；失败留在 need_selection
        //（main 侧 attempt 未终结）让用户改选。
        if (!res?.ok) setErrorCode(res?.errorCode ?? 'selection_invalid')
      })
      .catch(() => {
        if (!aliveRef.current) return
        setBusy(false)
        setErrorCode('selection_invalid')
      })
  }, [])

  const dismiss = useCallback((): void => {
    setPhase(null)
    setErrorCode(null)
    setDoneInfo(null)
    setCandidates(null)
  }, [])

  return { phase, errorCode, candidates, doneInfo, busy, start, cancel, submitSelection, dismiss }
}
