// 09-02 对话域拆分 —— composer 文本与标签草稿快照之间的桥。渲染 null，住在 runtime provider
// **里面**（同 ChatPromptDispatcher）：composer.text / setText 都要 thread 上下文，provider 之外
// 拿不到。
//
// 只做两件事：runtime 挂载时把宿主给的初值写进**空** composer；之后把输入框文本同步进宿主
// （宿主存 ref，不落任何存储 —— 落 localStorage 的时机由宿主定：切标签 / 卸载时写一次）。
//
// 🔴 runtime 会在同一个标签内重挂（切会话的 navEpoch / settle 后的 `:rN`），composer 文本随之
// 清零，所以初值每次挂载都取一次，宿主的 `restore` 要返回**最新**文本而不是「打开标签时那份」。

import { useEffect, useRef } from 'react'
import { useAui, useAuiState } from '@assistant-ui/react'

export interface ComposerDraftBridgeProps {
  /** 取当前应恢复的文本（'' = 没有）。每次 runtime 挂载都会调一次。 */
  restore: () => string
  /** 输入框文本变化时回调（同步宿主 ref 用；不要在这里写存储）。 */
  onChange: (text: string) => void
}

export function ComposerDraftBridge({ restore, onChange }: ComposerDraftBridgeProps): null {
  const aui = useAui()
  const text = useAuiState((state) => state.composer.text)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // 恢复只在挂载时做一次，且只往空 composer 里写（新 runtime 的 composer 恒为空；
  // 非空说明用户已经在打字，不覆盖）。
  useEffect(() => {
    const initial = restore()
    if (initial !== '' && text === '') aui.composer().setText(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 挂载那一次不回调：此时 text 是 runtime 的空初值，回调出去会把宿主刚交来的初值清掉
  // （上面的 setText 还没落地）。
  const prevTextRef = useRef(text)
  useEffect(() => {
    if (prevTextRef.current === text) return
    prevTextRef.current = text
    onChangeRef.current(text)
  }, [text])

  return null
}
