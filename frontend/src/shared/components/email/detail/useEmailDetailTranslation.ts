// Immersive translation state, queries, mutations, auto-enable, LLM upgrade,
// and alt+t shortcut extracted from EmailDetail.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useShortcut } from '@shared/hooks/useShortcut'
import { qk } from '@shared/lib/queryKeys'
import type { TranslateBatchResult, TranslationSegment } from '@shared/api/types'
import type { TranslateStatus } from '../EmailToolbar'

const llmAgentUpgradeFired = new Set<number>()

function isAbortFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: string }).code
  return err.name === 'AbortError' || code === 'E_ABORTED'
}

interface UseEmailDetailTranslationOpts {
  internalId: number | null
  langIsEn: boolean
}

export interface EmailDetailTranslationController {
  showTranslation: boolean
  translateError: { code: string; message: string } | null
  hasCache: boolean
  isTranslating: boolean
  translateStatus: TranslateStatus
  activeSegments: TranslationSegment[] | null
  toggleTranslation: () => void
  startTranslate: () => void
  retranslate: () => void
  dismissTranslateError: () => void
}

/** Manages bilingual email translation cache, on-demand/retranslate mutations, and shortcut. */
export function useEmailDetailTranslation({
  internalId,
  langIsEn
}: UseEmailDetailTranslationOpts): EmailDetailTranslationController {
  const mailApi = useMailApi()
  const queryClient = useQueryClient()

  const [showTranslation, setShowTranslation] = useState(false)
  const [translateError, setTranslateError] = useState<{ code: string; message: string } | null>(
    null
  )
  const [ephemeralSegments, setEphemeralSegments] = useState<TranslationSegment[] | null>(null)
  const [lastInternalId, setLastInternalId] = useState<number | null>(internalId)

  // React 19 "Adjusting state on prop change" pattern on internalId transition.
  if (lastInternalId !== internalId) {
    setLastInternalId(internalId)
    setShowTranslation(false)
    setTranslateError(null)
    setEphemeralSegments(null)
  }

  // The cleanup is a real side-effect (renderer → main IPC), so it stays in an effect.
  useEffect(() => {
    const prior = internalId
    return () => {
      if (prior !== null) mailApi.ai.abortTranslate(prior)
    }
  }, [internalId, mailApi])

  // 不加 keepPreviousData: 它驱动 auto-on effect, 旧 cache 不能漏给新邮件.
  const translationCacheQ = useQuery({
    queryKey: qk.email.translation(internalId, 'zh'),
    queryFn: () => mailApi.ai.getCached(internalId as number, 'zh'),
    enabled: internalId !== null,
    staleTime: Infinity,
    retry: false
  })

  const handleTranslateSuccess = useCallback(
    (result: TranslateBatchResult) => {
      if (result.cacheWriteFailed) {
        setEphemeralSegments(result.segments.length > 0 ? result.segments : null)
        setShowTranslation(true)
        setTranslateError({
          code: 'E_CACHE_WRITE_FAILED',
          message: 'Translation cache write failed'
        })
      } else {
        setTranslateError(null)
        setEphemeralSegments(
          result.cacheKept ? null : result.segments.length > 0 ? result.segments : null
        )
        setShowTranslation(true)
      }
      // 让 cacheQ 重新拉, 保持 source/fetchedAt 等 meta 字段口径一致。
      if (internalId !== null) {
        void queryClient.invalidateQueries({
          queryKey: qk.email.translation(internalId, 'zh')
        })
      }
    },
    [internalId, queryClient]
  )

  const handleTranslateError = useCallback((err: unknown) => {
    if (isAbortFailure(err)) return
    const e = err instanceof Error ? err : new Error(String(err))
    const code = (e as Error & { code?: string }).code ?? 'E_UPSTREAM'
    setTranslateError({ code, message: e.message })
  }, [])

  const translateMut = useMutation({
    mutationFn: async () => {
      if (internalId === null) throw new Error('no email selected')
      return mailApi.ai.translateBatch(internalId, 'zh')
    },
    onSuccess: handleTranslateSuccess,
    onError: handleTranslateError
  })

  const retranslateMut = useMutation({
    mutationFn: async () => {
      if (internalId === null) throw new Error('no email selected')
      await mailApi.ai.deleteCached(internalId, 'zh')
      return mailApi.ai.translateBatch(internalId, 'zh')
    },
    onSuccess: handleTranslateSuccess,
    onError: handleTranslateError
  })

  // Cache 命中 + 仍是同一封邮件 → 默认 ON (Path A 让用户打开即看双语)。
  // useRef 防止用户手动 dismiss 后又被 effect 翻回 ON (auto-on 仅触发一次)。
  const autoOnFiredRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (internalId === null) return
    if (autoOnFiredRef.current.has(internalId)) return
    const cache = translationCacheQ.data
    if (cache && cache.segments.length > 0) {
      autoOnFiredRef.current.add(internalId)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- cache 命中+同邮件首次自动开译文（ref guard 仅一次）。响应异步 translationCacheQ 数据，effect 合理；render 期间替代会改触 refs 规则（render 写 ref）。React Compiler 迁移债。
      setShowTranslation(true)
    }
  }, [internalId, translationCacheQ.data])

  // Path A 的 llm_agent 译文覆盖率偏低；英文邮件命中后后台升级成 Path B cache。
  // 不复用 translateMut，避免 loading/toast/showTranslation 等用户可见副作用。
  useEffect(() => {
    if (internalId === null || !langIsEn) return
    const cache = translationCacheQ.data
    if (!cache || cache.source !== 'llm_agent') return
    if (llmAgentUpgradeFired.has(internalId)) return
    llmAgentUpgradeFired.add(internalId)
    void (async () => {
      try {
        await mailApi.ai.translateBatch(internalId, 'zh')
        await queryClient.invalidateQueries({
          queryKey: qk.email.translation(internalId, 'zh')
        })
      } catch (err) {
        console.warn('llm_agent translation cache upgrade failed', err)
      }
    })()
  }, [internalId, langIsEn, mailApi, queryClient, translationCacheQ.data])

  const toggleTranslation = useCallback(() => {
    if (internalId === null) return
    setShowTranslation((prev) => !prev)
  }, [internalId])

  const startTranslate = useCallback(() => {
    setTranslateError(null)
    setEphemeralSegments(null)
    translateMut.mutate()
  }, [translateMut])

  const retranslate = useCallback(() => {
    setTranslateError(null)
    setEphemeralSegments(null)
    retranslateMut.mutate()
  }, [retranslateMut])

  const dismissTranslateError = useCallback(() => {
    setTranslateError(null)
  }, [])

  // ⌥T toggle. `useShortcut` short-circuits in editable contexts so typing "t" doesn't fire.
  useShortcut('alt+t', toggleTranslation)

  const cache = translationCacheQ.data
  const cacheSegments = cache && cache.segments.length > 0 ? cache.segments : null
  const resolvedSegments =
    cacheSegments ?? (ephemeralSegments && ephemeralSegments.length > 0 ? ephemeralSegments : null)
  const hasCache = !!cacheSegments
  const hasDisplaySegments = !!resolvedSegments
  const isTranslating = translateMut.isPending || retranslateMut.isPending
  const translateStatus: TranslateStatus = translateError
    ? 'error'
    : isTranslating
      ? 'loading'
      : showTranslation && hasDisplaySegments
        ? 'translated'
        : 'idle'

  return {
    showTranslation,
    translateError,
    hasCache,
    isTranslating,
    translateStatus,
    activeSegments: showTranslation && hasDisplaySegments ? resolvedSegments : null,
    toggleTranslation,
    startTranslate,
    retranslate,
    dismissTranslateError
  }
}
