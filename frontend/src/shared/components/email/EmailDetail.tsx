// DESIGN.md §5 + mockup-inbox.html line 850+. flex-1 detail column with
// bg-ink-3 (one tier brighter than EmailList's ink-2). Vertical structure:
//   - 48px EmailToolbar
//   - scroll container (scrollbar-thin) with max-w-[820px] inner:
//       - subject block with EN lang pip + monospace inline code
//       - one-tap translate banner (Sprint 3 wires the click)
//       - From/To/Date/Mailbox/Thread meta grid (80px label col)
//       - AIFieldsBlock 3×8 (V1) bordered + header strip
//       - mail-body content (DOMPurified iframe)
//       - Attachments 2-col grid
//       - Footer (internal_id + Notion link)

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { ArrowLeft, ChevronDown, ExternalLink, Languages, Mail, RotateCcw } from 'lucide-react'

import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { cn } from '@shared/lib/cn'
import { ShimmerText } from '@shared/components/ShimmerText'
import { useMailApi } from '@shared/hooks/useMailApi'
import { formatDate, formatRelativeTime } from '@shared/format'
import { parseSender } from '@shared/lib/mail_parse'
import { mapLanguage } from '@shared/lib/ai_mapping'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useIsBelowLg } from '@shared/hooks/useMediaQuery'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useActiveEmail, pickNext, pickPrev } from '@shared/state/active-email'

import { EmailBodyFrame } from './EmailBodyFrame'
import { EmailToolbar, type TranslateStatus } from './EmailToolbar'
import { AttachmentList } from './AttachmentList'
import { AIFieldsBlock } from '../ai/AIFieldsBlock'
import { ComposePanel, ComposePanelInner } from './compose/ComposePanel'
import { closeCompose, useComposeStore } from '@shared/state/compose'
import type { ComposeMode } from '@shared/api/types'

interface Props {
  internalId: number | null
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <>
      <span className="text-ink-fg-2 font-mono text-aux">{label}</span>
      <span className="text-ink-fg-1 break-words">{value}</span>
    </>
  )
}

// Sprint 13 round 9 — long recipient list collapser.  100 ASCII chars
// or ~50 CJK glyphs is roughly two display lines at text-aux; beyond
// that the To/Cc row dominates the meta grid and crowds out everything
// below.  Inline "more"/"less" button on the right-hand side keeps the
// full address book one click away.
function ExpandableValue({ text, max = 100 }: { text: string; max?: number }): React.ReactElement {
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  if (text.length <= max) return <span className="text-ink-fg-1">{text}</span>
  return (
    <span className="text-ink-fg-1">
      {shown ? text : text.slice(0, max).trimEnd() + '… '}
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className={cn(
          // 用户验收: 10px 在 text-aux(14px) 文本流里太小难点 → 升一档到
          // text-meta(12px), 对齐字阶 token (仍小于正文一档, 保持辅助操作感)。
          'text-meta text-coral hover:text-coral-hover',
          'transition-colors duration-fast ml-1 align-baseline',
          'focus:outline-none focus-visible:underline'
        )}
      >
        {shown ? t('emailDetail.less') : t('emailDetail.more')}
      </button>
    </span>
  )
}

// ---- immersive translation banner ------------------------------------------

/** 错误 banner: 紧贴 subject 下方显示。仅 translateMut 出错时挂出, 用户可
 *  retry / dismiss。沉浸式架构下译文显示在 EmailBodyFrame 内嵌, 这里只承担
 *  错误反馈。 */
function TranslationErrorBanner({
  errorCode,
  onRetry,
  onDismiss
}: {
  errorCode: string | null
  onRetry(): void
  onDismiss(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const isNoKey = errorCode === 'E_NO_LLM_KEY'
  const isNoBody = errorCode === 'E_NO_BODY'
  return (
    <div
      className={cn(
        'mt-2 flex items-start gap-3 px-3 py-2 rounded-md',
        'text-aux text-fail border border-fail/30 bg-fail/10'
      )}
    >
      <Languages size={14} strokeWidth={2} className="shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-medium">
          {isNoKey
            ? t('translate.noKey')
            : isNoBody
              ? t('translate.noBody')
              : t('translate.failed')}
        </div>
        {errorCode && <div className="text-meta font-mono text-ink-fg-3 mt-1">{errorCode}</div>}
      </div>
      {!isNoKey && !isNoBody && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 px-2 py-1 rounded text-aux text-fail hover:bg-fail/15 transition-colors duration-fast inline-flex items-center gap-1"
        >
          <RotateCcw size={11} strokeWidth={2} />
          {t('translate.retry')}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-meta font-mono text-ink-fg-3 hover:text-ink-fg-1 px-1"
      >
        ×
      </button>
    </div>
  )
}

function EmptyShell({ children }: { children: React.ReactNode }): React.ReactElement {
  // <lg 详情覆盖列表时，loading / error 等空态分支没有 EmailToolbar 的返回
  // 按钮，这里自带一个返回入口防止窄屏卡死（仅选中态显示；未选中态整列已被
  // InboxLayout 隐藏）。≥lg 三栏并排无需返回，lg:hidden 收起 → 桌面零回归。
  const { t } = useTranslation()
  const belowLg = useIsBelowLg()
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const setActive = useActiveEmail((s) => s.setActive)
  return (
    <main
      aria-label="inbox-main"
      className="relative flex-1 min-w-0 bg-ink-3 flex items-center justify-center"
    >
      {belowLg && activeId !== null && (
        <button
          type="button"
          onClick={() => setActive(null)}
          aria-label={t('toolbar.backToList', { defaultValue: '返回列表' })}
          className="lg:hidden absolute top-2 left-2 inline-flex items-center justify-center w-8 h-8 rounded-md text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
      )}
      {children}
    </main>
  )
}

// Sprint 5 §2.2 — single pending bit per write op. Per-button enums let
// EmailToolbar disable the right control without coupling all 4 to one
// global "any write in flight" flag (user can re-run AI while a Notion
// resync is still streaming back).
type PendingMap = {
  resync: boolean
  llmRun: boolean
  read: boolean
  flag: boolean
  archive: boolean
}

const NO_PENDING: PendingMap = {
  resync: false,
  llmRun: false,
  read: false,
  flag: false,
  archive: false
}

const llmAgentUpgradeFired = new Set<number>()

interface WriteErrorShape {
  code?: string
  message: string
}

function asWriteError(err: unknown): WriteErrorShape {
  if (err instanceof Error) {
    return { code: (err as Error & { code?: string }).code, message: err.message }
  }
  return { message: String(err) }
}

export function EmailDetail({ internalId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const [showTranslation, setShowTranslation] = useState(false)
  const [pending, setPending] = useState<PendingMap>(NO_PENDING)
  const [propsExpanded, setPropsExpanded] = useState(false)
  const [lastInternalId, setLastInternalId] = useState<number | null>(internalId)
  // React 19 "Adjusting state on prop change" pattern (react.dev/learn/you-might-not-need-an-effect):
  // resetting derived state on a prop transition is a render-time concern,
  // not an effect concern.
  if (lastInternalId !== internalId) {
    setLastInternalId(internalId)
    setShowTranslation(false)
    setPending(NO_PENDING)
    setPropsExpanded(false)
    // Switching emails closes any open composer so it can't write to the
    // wrong source message (the store is single-composer per window).
    closeCompose()
  }

  // The cleanup is a real side-effect (renderer → main IPC), so it stays
  // in an effect. No setState in the body — only the unmount-time abort.
  useEffect(() => {
    const prior = internalId
    return () => {
      if (prior !== null) mailApi.ai.abortTranslate(prior)
    }
  }, [internalId, mailApi])

  // 切邮件时 (queryKey 含 internalId) 用 keepPreviousData 让上一封 detail/ai
  // 数据继续显示直到新数据到达, 避免整面板闪 Loading 态 + body iframe 卸载重挂
  // 这种 ~200-1000ms 的卡顿. translationCacheQ 不加是因为它驱动 auto-on
  // effect, 旧 cache 不能漏给新邮件.
  const detailQ = useQuery({
    queryKey: ['email', internalId],
    queryFn: () => mailApi.email.get(internalId as number),
    enabled: internalId !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData
  })

  const aiQ = useQuery({
    queryKey: ['email', internalId, 'ai'],
    queryFn: () => mailApi.email.aiFields(internalId as number),
    enabled: internalId !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData
  })
  const ai = aiQ.data ?? null
  // Route through mapLanguage so the EN pip survives LLM enum drift
  // ("English" / "en" / "en-US" all resolve to 'en'). NOTES 2026-05-17 #7.
  const langRaw = ai?.labels_raw?.language
  const langIsEn = mapLanguage(typeof langRaw === 'string' ? langRaw : null) === 'en'

  // ---- immersive translation ----------------------------------------------
  //
  // 双路径数据流:
  //   - Path A: LLM 分类时顺带写 email_translation (source='llm_agent') →
  //             用户打开邮件即命中 cache, 自动 inject。
  //   - Path B: 用户按 "翻译" 触发 translateBatch (source='on_demand') →
  //             跑完写 cache 并 invalidate cacheQ, 自动 inject。
  //
  // showTranslation:
  //   - true 时把 cache.segments 透传给 EmailBodyFrame 触发 inject;
  //   - false 时传 null 触发 clear。
  // cache 命中 + langIsEn 时, useEffect 自动把 showTranslation 翻 true (默认开)。

  const translationCacheQ = useQuery({
    queryKey: ['email', internalId, 'translation', 'zh'],
    queryFn: () => mailApi.ai.getCached(internalId as number, 'zh'),
    enabled: internalId !== null,
    staleTime: Infinity,
    retry: false
  })

  // 翻译失败的 banner state (mutation 不写 cacheQ.error, 单独承接)
  const [translateError, setTranslateError] = useState<{ code: string; message: string } | null>(
    null
  )

  const translateMut = useMutation({
    mutationFn: async () => {
      if (internalId === null) throw new Error('no email selected')
      return mailApi.ai.translateBatch(internalId, 'zh')
    },
    onSuccess: () => {
      setTranslateError(null)
      setShowTranslation(true)
      // 让 cacheQ 重新拉, 同时 translateBatch 已经写 cache; queryClient.setQueryData
      // 直接放结果可省一次 IPC, 但 getCached 返 source/fetchedAt 等 meta 字段,
      // 用 invalidate 让 cacheQ 重读保持口径一致。
      if (internalId !== null) {
        void queryClient.invalidateQueries({
          queryKey: ['email', internalId, 'translation', 'zh']
        })
      }
    },
    onError: (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = (e as Error & { code?: string }).code ?? 'E_UPSTREAM'
      setTranslateError({ code, message: e.message })
    }
  })

  const retranslateMut = useMutation({
    mutationFn: async () => {
      if (internalId === null) throw new Error('no email selected')
      await mailApi.ai.deleteCached(internalId, 'zh')
      return mailApi.ai.translateBatch(internalId, 'zh')
    },
    onSuccess: () => {
      setTranslateError(null)
      setShowTranslation(true)
      if (internalId !== null) {
        void queryClient.invalidateQueries({
          queryKey: ['email', internalId, 'translation', 'zh']
        })
      }
    },
    onError: (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = (e as Error & { code?: string }).code ?? 'E_UPSTREAM'
      setTranslateError({ code, message: e.message })
    }
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
          queryKey: ['email', internalId, 'translation', 'zh']
        })
      } catch (err) {
        console.warn('llm_agent translation cache upgrade failed', err)
      }
    })()
  }, [internalId, langIsEn, mailApi, queryClient, translationCacheQ.data])

  // 显示原文 / 显示译文 切换。在 Path B 翻译中按显示原文不取消 mutation, 因为
  // 写 cache 是有价值的; 用户随时可以再切回译文。
  const toggleTranslation = useCallback(() => {
    if (internalId === null) return
    setShowTranslation((prev) => !prev)
  }, [internalId])

  // "翻译" 按钮: 没 cache 时启动 translateBatch (Path B)
  const startTranslate = useCallback(() => {
    setTranslateError(null)
    translateMut.mutate()
  }, [translateMut])

  // "重新翻译": delete + 重跑
  const retranslate = useCallback(() => {
    setTranslateError(null)
    retranslateMut.mutate()
  }, [retranslateMut])

  const dismissTranslateError = useCallback(() => {
    setTranslateError(null)
  }, [])

  // ⌥T toggle. `useShortcut` short-circuits in editable contexts so typing
  // "t" in an input doesn't fire (DESIGN.md §9.5).
  useShortcut('alt+t', toggleTranslation)

  // ---- Sprint 5 §2.2 — write action handlers --------------------------------
  //
  // Each handler:
  //   1. flips the per-button `pending` bit
  //   2. fires the mailApi.* IPC + awaits its envelope
  //   3. invalidates the `['email', id]` / `['email', id, 'ai']` queries on
  //      success so the panel re-reads fresh data
  //   4. surfaces success/error toast with i18n strings
  //
  // We don't toggle the pending bit back on a stale internalId — the
  // setPending(NO_PENDING) reset on prop change covers that.

  // Compose — open the reply / reply-all / forward composer (overlays the
  // detail body). Replaces the half-finished AppleScript handleCreateDraft;
  // the real draft + send now run through `mailApi.email.draft|send`.
  // Toolbar prev/next — wire the ∧/∨ buttons to the same list navigation as
  // J/K (pickPrev/pickNext over the order EmailList publishes to the store).
  // undefined at the head/tail boundary (pick returns the same id → no move)
  // so IconOnlyBtn disables the button there, matching the no-wrap J/K rule.
  const orderedIds = useActiveEmail((s) => s.orderedIds)
  const setActive = useActiveEmail((s) => s.setActive)
  const prevId = pickPrev(orderedIds, internalId)
  const nextId = pickNext(orderedIds, internalId)
  const onPrev = prevId !== null && prevId !== internalId ? () => setActive(prevId) : undefined
  const onNext = nextId !== null && nextId !== internalId ? () => setActive(nextId) : undefined

  const openCompose = useComposeStore((s) => s.openCompose)
  const composeOpen = useComposeStore((s) => s.open)
  const composeFor = useComposeStore((s) => s.internalId)
  const handleOpenCompose = useCallback(
    (mode: ComposeMode): void => {
      if (internalId === null) return
      openCompose(internalId, mode)
    },
    [internalId, openCompose]
  )

  // 灰白蒙版 bug 修复 — compose store 是全局开关, 渲染条件原本只看 `open`:
  // 在邮件 A 开过 compose 后切视图/切邮件 (没有任何人调 closeCompose), overlay
  // 的 bg-ink-3 实心层会盖在任何后续详情上 (用户: 草稿箱↔收件箱往返后正文蒙灰白)。
  // 双保险: ① overlay 只在 store.internalId === 当前详情时渲染 (scope 校验);
  // ② 切邮件时把 stale 的 open store 清掉, 防止切回原邮件时 compose 凭空弹回。
  const composeOpenHere = composeOpen && composeFor === internalId
  useEffect(() => {
    if (composeOpen && composeFor !== internalId) {
      useComposeStore.getState().closeCompose()
    }
    // composeOpen/composeFor 故意不进依赖 — 只在切邮件 (internalId 变) 时清
    // stale store, 打开瞬间 (open 变 true 且 composeFor === internalId) 不触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalId])

  // B1 — compose overlay 进/退场. backdrop:false (root 即铺满整个详情区的覆盖层,
  // 非居中卡片). 整列覆盖面板用「淡入 + 上滑」(y:20, 无 scale) —— scale 适合居中小卡片,
  // 套到整列覆盖层会变成"整列缩放"观感不对。closeCompose() 触发退场后延迟卸载。
  const { shouldRender: composeShouldRender, scopeRef: composeScopeRef } =
    useExitAnimation<HTMLDivElement>(composeOpenHere, {
      backdrop: false,
      from: { autoAlpha: 0, y: 20 }
    })

  // B2 — 切邮件时正文内容区交叉淡入. internalId 变化时 from autoAlpha:0 (120ms),
  // overwrite:'auto' 让快速 J/K 连切打断上一个 tween. 仅淡入正文滚动容器 (不含
  // toolbar, 避免 toolbar 闪). keepPreviousData 防内容闪。reduced-motion 短路.
  const bodyScopeRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      if (reduceMotion) return
      const el = bodyScopeRef.current
      if (!el) return
      gsap.from(el, { autoAlpha: 0, duration: DUR.fast, overwrite: 'auto' })
    },
    { dependencies: [internalId, reduceMotion], scope: bodyScopeRef }
  )

  // Warm the reply compose plans after the detail settles, so the reply /
  // reply-all CTAs open instantly instead of waiting ~2s for the mailagent CLI
  // subprocess (the draftPlan dry-run forks a Python process; cost is the
  // interpreter + import chain, not the SQL). Same query key as ComposePanel
  // (['compose','plan',id,mode], staleTime Infinity) → the panel's useQuery
  // hits warm cache. Debounced 600ms so rapid J/K arrow-through doesn't fork
  // processes per email; forward stays on-demand (rarer + collects attachment
  // bytes, heavier to warm speculatively).
  useEffect(() => {
    if (internalId === null || internalId < 0) return
    const id = internalId
    const timer = setTimeout(() => {
      for (const mode of ['reply', 'reply-all'] as const) {
        void queryClient.prefetchQuery({
          queryKey: ['compose', 'plan', id, mode],
          queryFn: () => mailApi.email.draftPlan({ internalId: id, mode }),
          staleTime: Infinity,
          retry: false
        })
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [internalId, queryClient, mailApi])

  // Archive — IMAP MOVE INBOX→Archive + Mailbox→存档 via `mailagent email archive`
  // (davmail-only; CLI rejects applescript backend with E_INVALID_ARG). On success
  // the email leaves the inbox list, so we jump to the next (or prev) email and
  // invalidate the list + this email's queries.
  const handleArchive = useCallback(async (): Promise<void> => {
    if (internalId === null) return
    const archivingId = internalId
    setPending((p) => ({ ...p, archive: true }))
    try {
      await mailApi.email.archive(archivingId)
      toastSuccess(t('toolbarToast.archiveOk'))
      if (nextId !== null && nextId !== archivingId) setActive(nextId)
      else if (prevId !== null && prevId !== archivingId) setActive(prevId)
      await queryClient.invalidateQueries({ queryKey: ['emails'] })
      await queryClient.invalidateQueries({ queryKey: ['email', archivingId] })
    } catch (err) {
      const e = asWriteError(err)
      toastError(t('toolbarToast.archiveFail'), e.code ? `${e.code} · ${e.message}` : e.message)
    } finally {
      setPending((p) => ({ ...p, archive: false }))
    }
  }, [internalId, mailApi, queryClient, t, nextId, prevId, setActive])

  const handleResync = useCallback(
    async ({ dryRun }: { dryRun: boolean }): Promise<void> => {
      if (internalId === null) return
      setPending((p) => ({ ...p, resync: true }))
      try {
        await mailApi.email.resync(internalId, { dryRun, replaceExisting: !dryRun })
        toastSuccess(t(dryRun ? 'toolbarToast.resyncOkDry' : 'toolbarToast.resyncOk'))
        if (!dryRun) {
          await queryClient.invalidateQueries({ queryKey: ['email', internalId] })
          await queryClient.invalidateQueries({ queryKey: ['email', internalId, 'ai'] })
        }
      } catch (err) {
        const e = asWriteError(err)
        const key =
          e.code === 'E_AUTH'
            ? 'toolbarToast.resyncFailAuth'
            : e.code === 'E_PM2_RUNNING' || e.code === 'E_PM2_CONFLICT'
              ? 'toolbarToast.resyncFailPm2'
              : 'toolbarToast.resyncFailGeneric'
        toastError(t(key), e.code ? `${e.code} · ${e.message}` : e.message)
      } finally {
        setPending((p) => ({ ...p, resync: false }))
      }
    },
    [internalId, mailApi, queryClient, t]
  )

  const handleLlmRun = useCallback(async (): Promise<void> => {
    if (internalId === null) return
    setPending((p) => ({ ...p, llmRun: true }))
    try {
      await mailApi.llm.run(internalId, { force: true })
      toastSuccess(t('toolbarToast.llmOk'))
      await queryClient.invalidateQueries({ queryKey: ['email', internalId, 'ai'] })
    } catch (err) {
      const e = asWriteError(err)
      toastError(t('toolbarToast.llmFailGeneric'), e.code ? `${e.code} · ${e.message}` : e.message)
    } finally {
      setPending((p) => ({ ...p, llmRun: false }))
    }
  }, [internalId, mailApi, queryClient, t])

  // Sprint 15 D 块 — Optimistic UI for read/flag toggle. 直接 setQueryData
  // 让 detail panel 瞬时翻, 避免 CLI fork 500ms + invalidate 双重 await 卡顿;
  // 同步更新 ['emails'] 列表 cache, 这样 EmailRow 不需要等 5s poll 也能反映新
  // 状态. CLI 失败再 invalidate 回真值 + toast.
  const optimisticDetail = useCallback(
    (patch: Record<string, unknown>) => {
      if (internalId === null) return
      queryClient.setQueryData(['email', internalId], (old: unknown) =>
        old && typeof old === 'object' ? { ...(old as object), ...patch } : old
      )
      queryClient.setQueriesData({ queryKey: ['emails'] }, (old: unknown) => {
        if (!Array.isArray(old)) return old
        return old.map((e) =>
          e && typeof e === 'object' && (e as { internal_id?: number }).internal_id === internalId
            ? { ...(e as object), ...patch }
            : e
        )
      })
    },
    [internalId, queryClient]
  )

  const handleToggleRead = useCallback(
    async (currentIsRead: boolean): Promise<void> => {
      if (internalId === null) return
      const target = !currentIsRead
      setPending((p) => ({ ...p, read: true }))
      optimisticDetail({ is_read: target })
      try {
        await mailApi.email.flag(internalId, { isRead: target })
        toastSuccess(t('toolbarToast.flagOk'))
      } catch (err) {
        // Rollback — refetch to真实 SQLite state
        await queryClient.invalidateQueries({ queryKey: ['email', internalId] })
        await queryClient.invalidateQueries({ queryKey: ['email', internalId, 'ai'] })
        const e = asWriteError(err)
        toastError(
          t('toolbarToast.flagFailGeneric'),
          e.code ? `${e.code} · ${e.message}` : e.message
        )
      } finally {
        setPending((p) => ({ ...p, read: false }))
      }
    },
    [internalId, mailApi, optimisticDetail, queryClient, t]
  )

  const handleToggleFlag = useCallback(
    async (currentIsFlagged: boolean): Promise<void> => {
      if (internalId === null) return
      const target = !currentIsFlagged
      setPending((p) => ({ ...p, flag: true }))
      optimisticDetail({ is_flagged: target })
      try {
        await mailApi.email.flag(internalId, { isFlagged: target })
        toastSuccess(t('toolbarToast.flagOk'))
      } catch (err) {
        await queryClient.invalidateQueries({ queryKey: ['email', internalId] })
        await queryClient.invalidateQueries({ queryKey: ['email', internalId, 'ai'] })
        const e = asWriteError(err)
        toastError(
          t('toolbarToast.flagFailGeneric'),
          e.code ? `${e.code} · ${e.message}` : e.message
        )
      } finally {
        setPending((p) => ({ ...p, flag: false }))
      }
    },
    [internalId, mailApi, optimisticDetail, queryClient, t]
  )

  // Sprint 17 — 打开未读邮件自动标已读 (Outlook / Apple Mail / Gmail 标准 UX).
  // optimistic 立即翻 UI; CLI 在背景跑, 失败静默 (auto-markRead 是辅助, 不该
  // 打扰用户). useRef 记录已 marked 的 id 防止 cache invalidate 后重渲再次触发
  // (虽然 optimistic 已经把 is_read 写回 cache, 但 race 安全起见加这层防护).
  const autoMarkedRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (internalId === null) return
    const data = detailQ.data
    if (!data || data.is_read) return
    if (autoMarkedRef.current.has(internalId)) return
    autoMarkedRef.current.add(internalId)
    optimisticDetail({ is_read: true })
    void mailApi.email.flag(internalId, { isRead: true }).catch(() => {
      // 静默 — auto-markRead 失败不打扰用户; 用户仍可在 toolbar 手动标
    })
  }, [internalId, detailQ.data, mailApi, optimisticDetail])

  if (internalId === null) {
    return (
      <EmptyShell>
        <div className="text-aux text-ink-fg-2">
          <Mail size={28} strokeWidth={1.5} className="inline-block opacity-30 mb-2" />
          <div>{t('empty.state')}</div>
        </div>
      </EmptyShell>
    )
  }

  if (detailQ.isLoading) {
    return (
      <EmptyShell>
        <ShimmerText text={t('emailDetail.loading')} neutral className="text-aux" />
      </EmptyShell>
    )
  }

  if (detailQ.isError || !detailQ.data) {
    return (
      <EmptyShell>
        <div className="text-aux text-fail">
          {detailQ.error instanceof Error ? detailQ.error.message : 'Email not found.'}
        </div>
      </EmptyShell>
    )
  }

  const email = detailQ.data

  // 草稿点开即编辑 — 草稿不走只读详情 + 收件箱工具栏, 直接进可编辑 compose
  // (From 只读 / To·主题·正文可编辑, 顶部 发送/放弃[删除草稿])。所有 hook 已在上方
  // 执行, 此处条件 return 合法。key 让切换不同草稿时重挂 (fresh editor + 重新回填)。
  if (['草稿箱', '草稿', 'Drafts'].includes(email.mailbox ?? '')) {
    return (
      <ComposePanelInner
        key={`draft-${email.internal_id}`}
        internalId={email.internal_id}
        mode="draft-edit"
        onClose={() => setActive(null)}
      />
    )
  }

  const fromParsed = parseSender(email.sender)
  const fromName = email.sender_name || fromParsed.name
  const fromAddr = fromParsed.email || email.sender
  // Sprint 13 — AttachmentList now owns the inline / derived filter so it
  // can surface derived-from children inline as "→ pdf · 142 KB" chips
  // instead of cluttering the grid with sibling tiles. We just hand it
  // the full list.
  const allAttachments = email.attachments ?? []

  // Translate state → toolbar prop derivation.
  const cache = translationCacheQ.data
  const hasCache = !!cache && cache.segments.length > 0
  const isTranslating = translateMut.isPending || retranslateMut.isPending
  const translateStatus: TranslateStatus = translateError
    ? 'error'
    : isTranslating
      ? 'loading'
      : showTranslation && hasCache
        ? 'translated'
        : 'idle'

  return (
    // mockup L2036 — `<section class="glass-3 flex-1 min-w-0 flex flex-col">`.
    // Previous `bg-ink-3` was a solid ink, not the Liquid Glass surface; that's
    // what the user flagged as "正文背景没统一 mockup 毛玻璃风格". `.glass-3`
    // (authored in index.css) layers a translucent ink-3 on top of the
    // wallpaper + backdrop-filter blur(40px).
    <main aria-label="inbox-main" className="relative flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      {/* Compose overlay — reply / reply-all / forward composer covers the
          detail column when open for this email (store-gated). Rendered above
          the body so the user composes against the same surface.
          bg-ink-3 实心底: ComposePanel 自身是 glass-3 (ink-3/0.55) 半透明, 作为
          接管整个详情列的工作面会透出底下邮件正文导致看不清内容; overlay 语义就是
          "遮盖详情列", 加实心 ink-3 底 (= 详情列标称色) 既挡住正文又保留面板玻璃层次. */}
      {composeShouldRender && (
        <div ref={composeScopeRef} className="absolute inset-0 z-20 flex flex-col bg-ink-3">
          <ComposePanel />
        </div>
      )}
      <EmailToolbar
        onBack={() => setActive(null)}
        translate={{
          langIsEn,
          status: translateStatus,
          // 没 cache 时点击启动 batch 翻译; 有 cache 时纯 toggle 显示/隐藏。
          onToggle: hasCache ? toggleTranslation : startTranslate
        }}
        onOpenCompose={handleOpenCompose}
        onResync={handleResync}
        resyncState={{ pending: pending.resync }}
        onLlmRun={handleLlmRun}
        llmRunState={{ pending: pending.llmRun }}
        onToggleRead={() => void handleToggleRead(email.is_read)}
        isRead={email.is_read}
        readState={{ pending: pending.read }}
        onToggleFlag={() => void handleToggleFlag(email.is_flagged)}
        isFlagged={email.is_flagged}
        flagState={{ pending: pending.flag }}
        isImportant={email.is_important === true}
        notionUrl={email.notion_url}
        onArchive={handleArchive}
        archiveState={{ pending: pending.archive }}
        onPrev={onPrev}
        onNext={onNext}
      />

      <div ref={bodyScopeRef} className="flex-1 overflow-y-auto scrollbar-thin">
        {/* Sprint 14 round 14 user feedback: "邮件标题、元数据、AI Field、
            正文内容(含历史线程内容)应该在一个页面, 用一个滚动条. 先实现
            这个, 再考虑向上滚动冻结标题栏试试".

            Layout: ONE scroll container above (this <div>).  All inner
            sections (subject / meta / AI / body iframe / attachments)
            live in normal flow so the email pane has exactly one
            scrollbar.  iframe sets overflow:hidden + scrolling="no"
            (EmailBodyFrame round 7) so the body iframe never paints a
            second scrollbar; height syncs via postMessage.

            Sticky subject (round 14 试探性): just the title strip
            stays pinned at the top while the user scrolls down. The
            strip is ~60px (h1 + optional lang banner) so plenty of
            scroll room remains for the body — this is the same trick
            round 8 tried with meta + AIFields, but only the subject is
            cheap enough to keep without strangling the scroll area. */}
        <div
          className={cn(
            'sticky top-0 z-10',
            // sticky 标题: 不再叠一层不透明 ink-3。之前 bg-ink-3/0.78 是叠在 <main>
            // 的 glass-3 (ink-3/0.55) 之上, 合成约 0.86 白 → 浅色下成了突兀纯白块,
            // 与 toolbar / 正文衔接不上。改为透明, 与它们共用 <main> 同一块 glass-3
            // 面; 只保留 backdrop-blur + saturate: 滚动时把从其下穿过的正文磨成毛玻璃
            // (frost) 遮罩, 而非靠不透明度遮罩。
            'backdrop-blur-2xl backdrop-saturate-150',
            'border-b border-ink-border-soft'
          )}
        >
          <div className="px-8 pt-3 pb-3">
            {/* Subject block — EN lang pip + tracking-tight headline.
                pt 与 pb 取齐 (pt-3=pb-3): 之前 pt-6 上留白比下大一截, 视觉不平衡。 */}
            <div className="flex items-start gap-3">
              {langIsEn && (
                <span
                  className="lang-pip mt-2 shrink-0"
                  style={{ fontSize: '11px', padding: '3px 6px' }}
                >
                  EN
                </span>
              )}
              <h1 className="text-subj font-semibold text-ink-fg leading-snug tracking-tight flex-1 break-words">
                {email.subject || '(no subject)'}
              </h1>
            </div>

            {/* One-tap inline translate — 沉浸式翻译入口。三态:
                  - 无 cache + 非翻译中: "翻译" 按钮启动 batch
                  - 有 cache + 隐藏中:   "显示翻译" 按钮 toggle
                  - 有 cache + 显示中:   "显示原文" + "重新翻译" 两按钮
                  - 翻译中: spinner + 文本
                langIsEn 才显示 — 中文邮件没有翻译概念。 */}
            {langIsEn && !isTranslating && !hasCache && (
              <button
                type="button"
                onClick={startTranslate}
                title={`⌥T · ${t('translate.label')}`}
                className={cn(
                  'mt-2 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md',
                  'text-aux text-coral border border-coral/30 bg-coral/10',
                  'hover:bg-coral/15 transition-colors duration-fast'
                )}
              >
                <Languages size={13} strokeWidth={2} />
                {t('translate.inlineCta')}
                <kbd className="ml-0.5">⌥T</kbd>
              </button>
            )}
            {langIsEn && !isTranslating && hasCache && !showTranslation && (
              <button
                type="button"
                onClick={toggleTranslation}
                title={`⌥T · ${t('translate.showTranslation')}`}
                className={cn(
                  'mt-2 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md',
                  'text-aux text-coral border border-coral/30 bg-coral/10',
                  'hover:bg-coral/15 transition-colors duration-fast'
                )}
              >
                <Languages size={13} strokeWidth={2} />
                {t('translate.showTranslation')}
                <kbd className="ml-0.5">⌥T</kbd>
              </button>
            )}
            {langIsEn && !isTranslating && hasCache && showTranslation && (
              <div className="mt-2 inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleTranslation}
                  title={`⌥T · ${t('translate.showOriginal')}`}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md',
                    'text-aux text-ink-fg-1 border border-ink-border bg-ink-4/40',
                    'hover:bg-ink-4 transition-colors duration-fast'
                  )}
                >
                  <Languages size={13} strokeWidth={2} />
                  {t('translate.showOriginal')}
                </button>
                <button
                  type="button"
                  onClick={retranslate}
                  title={t('translate.retranslate')}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md',
                    'text-aux text-ink-fg-2 border border-ink-border bg-transparent',
                    'hover:bg-ink-4/40 hover:text-ink-fg-1 transition-colors duration-fast'
                  )}
                >
                  <RotateCcw size={11} strokeWidth={2} />
                  {t('translate.retranslate')}
                </button>
              </div>
            )}
            {isTranslating && (
              <div className="mt-2 inline-flex items-center gap-2 text-aux text-ink-fg-2">
                <Languages size={13} strokeWidth={2} />
                <ShimmerText text={t('translate.loading')} neutral />
              </div>
            )}
            {translateError && (
              <TranslationErrorBanner
                errorCode={translateError.code}
                onRetry={() => (hasCache ? retranslate() : startTranslate())}
                onDismiss={dismissTranslateError}
              />
            )}
          </div>
        </div>

        <div className="px-8 pt-4 pb-6">
          {/* Meta grid — Sprint 13 round 9 user feedback:
                - "To/CC 仍然没正确显示。(默认显示 100 字符吧, 可以 more
                  展开)" — Cc moves back into the default rows; both To
                  and Cc now use <ExpandableValue> which renders the
                  first 100 chars + an inline "more" link when the full
                  string is longer.
                - "属性折叠字体小一些, 加动态效果平滑一下现在太生硬" —
                  the chevron rotates with a 220ms ease-out transition,
                  the collapsed body lives in a CSS grid-rows 0fr↔1fr
                  wrapper so opening/closing eases the height in/out
                  (no jarring layout snap).
              Default rows: From / To / Cc / Date.
              Collapsed rows (mockup chevron): Mailbox / internal_id /
              message_id.  These rarely-needed bits stay reachable but
              do not crowd the header.  */}
          {(() => {
            const morePropsRows: { label: string; value: React.ReactNode }[] = []
            if (email.mailbox) {
              morePropsRows.push({
                label: 'Mailbox',
                value: (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-coral/100" />
                    {email.mailbox}
                  </span>
                )
              })
            }
            // `-ml-px` 抵 SF Mono 字符 left side bearing — 它比系统 sans 多
            // 1-2px, 不加的话 mono value 起点会比 sans value (Mailbox /
            // Notion URL) 视觉偏右一截.
            morePropsRows.push({
              label: 'internal_id',
              value: <span className="font-mono text-aux -ml-px">{email.internal_id}</span>
            })
            if (email.message_id) {
              morePropsRows.push({
                label: 'message_id',
                value: (
                  <span className="font-mono text-aux break-all -ml-px">{email.message_id}</span>
                )
              })
            }
            if (email.notion_url) {
              morePropsRows.push({
                label: 'Notion URL',
                value: (
                  <a
                    href={email.notion_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      'inline-flex items-center gap-1 text-coral hover:text-coral-hover',
                      'transition-colors duration-fast break-all'
                    )}
                  >
                    {email.notion_url}
                    <ExternalLink size={11} strokeWidth={2} />
                  </a>
                )
              })
            }
            return (
              <>
                <dl className="mt-1 grid grid-cols-[96px_1fr] gap-y-1.5 gap-x-3 text-aux">
                  <MetaRow
                    label="From"
                    value={
                      <>
                        {fromName && <span className="font-medium text-ink-fg">{fromName}</span>}
                        {fromName && fromAddr && <span className="text-ink-fg-2"> · </span>}
                        <span className="text-ink-fg-2">{fromAddr}</span>
                      </>
                    }
                  />
                  <MetaRow
                    label="To"
                    value={
                      email.to_addr && email.to_addr.length > 0 ? (
                        <ExpandableValue text={email.to_addr} />
                      ) : (
                        <span className="text-ink-fg-3">—</span>
                      )
                    }
                  />
                  {email.cc_addr && email.cc_addr.length > 0 && (
                    <MetaRow label="Cc" value={<ExpandableValue text={email.cc_addr} />} />
                  )}
                  {email.date_received && (
                    <MetaRow
                      label="Date"
                      value={
                        <span className="font-mono text-aux">
                          {formatDate(email.date_received)}
                          <span className="text-ink-fg-2">
                            {' '}
                            · {formatRelativeTime(email.date_received)}
                          </span>
                        </span>
                      }
                    />
                  )}
                </dl>

                {/* Collapsible section — Mailbox / internal_id /
                    message_id. CSS grid-rows trick: collapsed = 0fr,
                    expanded = 1fr, with the inner row at min-height: 0
                    so it can shrink past content. ease-out 220ms matches
                    `duration-base` token. */}
                {morePropsRows.length > 0 && (
                  <>
                    <div
                      aria-hidden={!propsExpanded}
                      className={cn(
                        'grid transition-[grid-template-rows] duration-base ease-out',
                        propsExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                      )}
                    >
                      <div className="overflow-hidden min-h-0">
                        <dl
                          className={cn(
                            'mt-1.5 grid grid-cols-[96px_1fr] gap-y-1.5 gap-x-3 text-aux',
                            'transition-opacity duration-base ease-out',
                            propsExpanded ? 'opacity-100' : 'opacity-0'
                          )}
                        >
                          {morePropsRows.map((row) => (
                            <MetaRow key={row.label} label={row.label} value={row.value} />
                          ))}
                        </dl>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setPropsExpanded((v) => !v)}
                      className={cn(
                        'mt-1.5 inline-flex items-center gap-1 text-meta text-ink-fg-2',
                        'hover:text-ink-fg-1 transition-colors duration-fast',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 rounded'
                      )}
                      aria-expanded={propsExpanded}
                    >
                      <ChevronDown
                        size={12}
                        strokeWidth={2}
                        className={cn(
                          'transition-transform duration-base ease-out',
                          propsExpanded && 'rotate-180'
                        )}
                      />
                      {propsExpanded
                        ? t('emailDetail.fewerProps')
                        : t('emailDetail.moreProps', { n: morePropsRows.length })}
                    </button>
                  </>
                )}
              </>
            )
          })()}

          {/* AI Fields — 草稿不渲染: 未发出的邮件不会被 AI 处理 (gate 在
              watcher 草稿分支), `ai` 对存在的行恒非 null (LEFT JOIN 投影),
              不 gate 会渲染一张全空卡 (用户验收)。 */}
          {ai && !['草稿箱', '草稿', 'Drafts'].includes(email.mailbox ?? '') && (
            <div className="mt-6">
              <AIFieldsBlock fields={ai} internalId={email.internal_id} />
            </div>
          )}

          {/* Sprint 13 round 6 user feedback: thread sidebar removed.
              Outlook-style "older messages collapsed under the latest"
              treatment is Sprint 14 — see NOTES.md 2026-05-20. */}

          {/* Body — sandboxed iframe.  沉浸式翻译: showTranslation + hasCache
              时把 segments 透传给 EmailBodyFrame, 由其在 iframe.contentDocument
              上用 textContent.includes(src) fuzzy 配对 DOM 节点, 在每段原文
              之后注入译文 div (CSS .mailagent-translation: italic + 灰色 +
              左侧细线). showTranslation=false 时传 null 触发 clear。 */}
          <div className="mt-7">
            <EmailBodyFrame
              internalId={email.internal_id}
              attachments={email.attachments ?? []}
              translations={showTranslation && hasCache ? cache!.segments : null}
            />
          </div>

          {/* Attachments — AttachmentList renders null when no visible
              originals exist, so the wrapper div would leave a blank
              `mt-8` if we kept it unconditional. Gate on the unfiltered
              count first (cheap) then let the component pick what to show. */}
          {allAttachments.length > 0 && (
            <div className="mt-8">
              <AttachmentList attachments={allAttachments} />
            </div>
          )}

          {/* Sprint 14 round 9 — ThreadBundle 撤出 EmailDetail. 真正
              的 Outlook thread 折叠在邮件列表里 (head row + indented
              children), 不在邮件正文底部. EmailList 重做承担此行为;
              ThreadBundle.tsx 保留供 Sprint 15+ 可能的 "完整 thread
              视图" 复用, 但当前不挂在 DOM 上. */}

          {/* Sprint 14 round 11 — footer 删除. "查看原文 .eml" 是空 CTA
              (没 CLI wiring) 现在不出现; "在 Notion 打开" 跟 toolbar 顶部
              的 ExternalLink 按钮 (`toolbar.openNotion`) 重复, 也删. Notion
              URL 改为 morePropsRows 默认折叠的属性, 用户需要时点 "更多
              属性" 展开能看到. */}
        </div>
      </div>
    </main>
  )
}
