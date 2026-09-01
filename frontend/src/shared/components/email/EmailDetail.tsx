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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ChevronDown, ExternalLink, Languages, Mail, RotateCcw } from 'lucide-react'

import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { cn } from '@shared/lib/cn'
import { CollapsibleRegion } from '@shared/components/ui/collapsible'
import { ShimmerText } from '@shared/components/ShimmerText'
import { useMailApi } from '@shared/hooks/useMailApi'
import { formatDate, formatRelativeTime } from '@shared/format'
import { parseAddressList, parseSender } from '@shared/lib/mail_parse'
import { isDraftsMailbox } from '@shared/lib/mailboxSemantics'
import { calendarUiEnabled, detectUiPlatform } from '@shared/lib/mailBackend'
import { asWriteError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { mapLanguage } from '@shared/lib/ai_mapping'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useIsBelowLg } from '@shared/hooks/useMediaQuery'
import { toastError, toastInfo, toastSuccess } from '@shared/state/toast'
import { useActiveEmail, pickNext, pickPrev } from '@shared/state/active-email'
import { canOpenDetachedWindow, useDetachedMode } from '@shared/state/detached-mode'
import { selectActiveTab, tabId, useTabWorkspace } from '@shared/state/tab-workspace'
import {
  clearObjectTabDraft,
  clearTabCloseRequest,
  closeObjectTab,
  getObjectTabScroll,
  saveObjectTabDraft,
  saveObjectTabScroll,
  setObjectTabTitle,
  tabsInert,
  useTabCloseGuard,
  type PendingTabClose
} from '@shared/state/tab-workspace-bridge'
import { useTogglePin } from '@shared/hooks/usePinnedSync'
import { usePinned } from '@shared/state/pinned'
import { startChatWithPrompt } from '@shared/state/ai-chat-panel'

import { EmailBodyFrame } from './EmailBodyFrame'
import { EmailToolbar, type TranslateStatus } from './EmailToolbar'
import { AttachmentList } from './AttachmentList'
import { ThreadAttachmentBar } from './ThreadAttachmentBar'
import { AIFieldsBlock } from '../ai/AIFieldsBlock'
import { MeetingInviteCard } from '../calendar/MeetingInviteCard'
import {
  buildMatterResourceLookupKeys,
  deriveMatterLinkButtonState,
  mergeMatterResourceLinkHits
} from '../matters/matterResource'
import { useMattersApi, useMattersEnabled } from '../matters/hooks'
import { PersonChip } from '../contacts/PersonChip'
import { useContactsApi, useContactsEnabled } from '../contacts/hooks'
import { useContactNavigation } from '../contacts/navigation'
import type { ContactChipDto } from '@shared/api/types/contact'
import { MatterBelongsCard } from '../matters/MatterBelongsCard'
import { MatterLinkPopover } from '../matters/MatterLinkPopover'
import { CustomAgentDrawer } from '../agents/CustomAgentDrawer'
import { useTriggerV2Enabled } from '../agents/hooks'
import { ComposePanel, ComposePanelInner, type ComposeCloseReason } from './compose/ComposePanel'
import type { ComposeGuardHandle } from './compose/useComposeGuard'
import {
  readComposeTabDraft,
  toDraftSnapshot,
  type ComposeTabDraft
} from './compose/composeTabDraft'
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

// ---- 通讯录 WP4：To/Cc chip 流 ----------------------------------------------

/** 收件人折叠上限（>12 折叠为前 12 + 「+n」展开钮，复用 emailDetail.more/less 词）。 */
const RECIPIENT_FOLD_LIMIT = 12

/** chip 查表：resolve 响应键 = 归一（trim+lower）地址。undefined（未请求/键外）
 *  与 null（服务端明说不在库）都渲染虚线不可点态。 */
function chipContactOf(
  resolved: Record<string, ContactChipDto | null> | undefined,
  addr: string
): {
  id: number
  displayName: string | null
  formalName: string | null
  primaryEmail: string | null
  kind: ContactChipDto['kind']
} | null {
  const hit = resolved?.[addr.trim().toLowerCase()]
  if (!hit) return null
  return {
    id: hit.id,
    displayName: hit.display_name,
    formalName: hit.formal_name,
    primaryEmail: hit.primary_email,
    kind: hit.kind
  }
}

/** PersonChip + 默认跳转接线（人物页 store intent + navigate('/contacts')）。
 *  🔴 useNavigate 依赖 router context，故收在这个**仅 chips 激活时才挂载**的
 *  包装组件里，不进 EmailDetail 顶层 hooks（既有单测在无 RouterProvider 下
 *  渲染 EmailDetail，顶层 useNavigate 会炸）。 */
function NavPersonChip({
  contact,
  addr,
  big
}: {
  contact: ReturnType<typeof chipContactOf>
  addr: string
  big?: boolean
}): React.ReactElement {
  const navigate = useNavigate()
  const openContact = useContactNavigation((state) => state.open)
  return (
    <PersonChip
      contact={contact}
      addr={addr}
      big={big}
      onOpen={(id) => {
        openContact(id)
        void navigate({ to: '/contacts' })
      }}
    />
  )
}

function RecipientChipsValue({
  entries,
  resolved
}: {
  entries: ReadonlyArray<{ name: string; email: string }>
  resolved: Record<string, ContactChipDto | null> | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? entries : entries.slice(0, RECIPIENT_FOLD_LIMIT)
  const hiddenCount = entries.length - RECIPIENT_FOLD_LIMIT
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {shown.map((entry) => (
        <NavPersonChip
          key={entry.email.toLowerCase()}
          contact={chipContactOf(resolved, entry.email)}
          addr={entry.email}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            'text-meta text-coral hover:text-coral-hover',
            'transition-colors duration-fast align-baseline',
            'focus:outline-none focus-visible:underline'
          )}
        >
          {expanded ? t('emailDetail.less') : `+${hiddenCount} ${t('emailDetail.more')}`}
        </button>
      )}
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
  delete: boolean
}

const NO_PENDING: PendingMap = {
  resync: false,
  llmRun: false,
  read: false,
  flag: false,
  archive: false,
  delete: false
}

const llmAgentUpgradeFired = new Set<number>()

export function EmailDetail({ internalId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const mattersApi = useMattersApi()
  const mattersEnabled = useMattersEnabled()
  const queryClient = useQueryClient()
  const triggerV2Enabled = useTriggerV2Enabled()
  // task 08-27 P5 —— 本组件既是主窗详情列，也是轻窗的整窗内容（DetachedShell）。
  const isDetachedWindow = useDetachedMode((s) => s.isDetached)
  const [showTranslation, setShowTranslation] = useState(false)
  // G-25 —— 「事项」按钮的捕获浮层与「为此线程建立跟进 Agent」抽屉。
  const [matterMenuOpen, setMatterMenuOpen] = useState(false)
  const [followupOpen, setFollowupOpen] = useState(false)
  const matterAnchorRef = useRef<HTMLDivElement | null>(null)
  const [pending, setPending] = useState<PendingMap>(NO_PENDING)
  const [propsExpanded, setPropsExpanded] = useState(false)
  const morePropsId = useId()
  // #3 置顶: 复用 usePinned 系统 (pin 状态不在 email 对象上, 由 zustand 镜像维护)。
  const togglePin = useTogglePin()
  const isPinned = usePinned((s) => (internalId !== null ? s.isPinned(internalId) : false))
  const [lastInternalId, setLastInternalId] = useState<number | null>(internalId)
  // 08-27 标签工作区（Lane W）—— overlay composer 的「切走不丢正文」从 T6 的钉住+弹确认
  // 改为**现场快照进标签**：切走时把可序列化现场写进 TabDescriptor.draft（下方 effect 经
  // snapshotRef 取），切回该标签自动重开并回填。getter 只读 ref（面板卸载后仍可安全调用，
  // 域切换时 EmailDetail 整树卸载靠 ComposePanelInner 自己的卸载快照兜底）。
  const composeSnapshotRef = useRef<(() => ComposeTabDraft | null) | null>(null)
  // 波3 起 draft-edit 与 overlay 同走「现场快照进标签」：dirty 草稿切走不再钉住弹确认
  // （T9 拦截退役），卸载兜底把现场写进 TabDescriptor.draft，切回自动恢复。两套拦截的
  // 终态分工 —— **切换 = 快照静默携带；关标签 = 关闭守卫弹确认**（下方 close-request
  // effect 经 draftEditGuardRef / overlayGuardRef 承接）。
  const draftEditGuardRef = useRef<ComposeGuardHandle | null>(null)
  const overlayGuardRef = useRef<ComposeGuardHandle | null>(null)
  // React 19 "Adjusting state on prop change" pattern (react.dev/learn/you-might-not-need-an-effect):
  // resetting derived state on a prop transition is a render-time concern,
  // not an effect concern.
  if (lastInternalId !== internalId) {
    setLastInternalId(internalId)
    setShowTranslation(false)
    setPending(NO_PENDING)
    setPropsExpanded(false)
    // overlay composer 不在渲染期关：切邮件的快照+关闭在下方 effect 做（getter 要在
    // useExitAnimation 延迟卸载窗口内读到活面板）。
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
    queryKey: qk.email.detail(internalId),
    queryFn: () => mailApi.email.get(internalId as number),
    enabled: internalId !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData
  })

  const aiQ = useQuery({
    queryKey: qk.email.ai(internalId),
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
    queryKey: qk.email.translation(internalId, 'zh'),
    queryFn: () => mailApi.ai.getCached(internalId as number, 'zh'),
    enabled: internalId !== null,
    staleTime: Infinity,
    retry: false
  })

  // 翻译失败的 banner state (mutation 不写 cacheQ.error, 单独承接)
  const [translateError, setTranslateError] = useState<{ code: string; message: string } | null>(
    null
  )
  const matterLookupKeys = useMemo(
    () => buildMatterResourceLookupKeys(internalId, detailQ.data?.thread_id),
    [detailQ.data?.thread_id, internalId]
  )
  const matterLookupQ = useQuery({
    queryKey: qk.matters.resourceLookup('mailagent', matterLookupKeys),
    queryFn: () => mattersApi.lookupResourceLinks('mailagent', matterLookupKeys),
    enabled:
      mattersEnabled &&
      detailQ.data !== null &&
      detailQ.data !== undefined &&
      matterLookupKeys.length > 0,
    staleTime: 10_000
  })
  const linkedMatters = useMemo(
    () => mergeMatterResourceLinkHits(matterLookupQ.data, matterLookupKeys),
    [matterLookupKeys, matterLookupQ.data]
  )
  const matterLinkState = deriveMatterLinkButtonState(linkedMatters.length)
  // G-25 —— 捕获浮层的线程封数。key 与 ThreadAttachmentBar 完全相同（react-query 去重），
  // 不产生新请求；无 thread_id 时不发。
  const matterThreadQ = useQuery({
    queryKey: qk.email.thread(detailQ.data?.thread_id ?? null),
    queryFn: () => mailApi.email.listByThread(detailQ.data?.thread_id ?? null),
    enabled: mattersEnabled && Boolean(detailQ.data?.thread_id),
    staleTime: 30_000
  })
  // ---- 通讯录 WP4：邮件详情头 PersonChip 的批量精确解析 --------------------
  // 解析集 = parseSender(sender) + parseAddressList(to/cc)，归一（trim+lower）
  // 去重 + 排序（queryKey 稳定）后**一封邮件一次** POST /contacts/resolve。
  // flag off / loading / 失败 → 下方 meta grid 维持现渲染字节级不变（仅在
  // resolve 数据就绪后切 chips，不闪烁）。跳转接线在 NavPersonChip（useNavigate
  // 依赖 router context，不上提进本组件顶层 —— 无 router 的既有单测会炸）。
  const { enabled: contactsEnabled } = useContactsEnabled()
  const contactsApi = useContactsApi()
  const resolveAddresses = useMemo(() => {
    const data = detailQ.data
    if (!data) return [] as string[]
    const out = new Set<string>()
    const senderEmail = parseSender(data.sender).email
    if (senderEmail.includes('@')) out.add(senderEmail.trim().toLowerCase())
    for (const entry of [
      ...parseAddressList(data.to_addr),
      ...parseAddressList(data.cc_addr ?? null)
    ]) {
      // 无 @ 的碎 token 不值一次网络传输 —— 服务端 normalize 也会拒掉它们。
      if (entry.email.includes('@')) out.add(entry.email.trim().toLowerCase())
    }
    return [...out].sort()
  }, [detailQ.data])
  const contactResolveQ = useQuery({
    queryKey: qk.contacts.resolve(resolveAddresses),
    queryFn: () => contactsApi.resolve(resolveAddresses),
    enabled: contactsEnabled && resolveAddresses.length > 0,
    staleTime: 30_000
  })
  const resolvedContacts = contactResolveQ.data?.items

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
          queryKey: qk.email.translation(internalId, 'zh')
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
          queryKey: qk.email.translation(internalId, 'zh')
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
          queryKey: qk.email.translation(internalId, 'zh')
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
  // 08-27 标签工作区：工具栏 ∧/∨ 与 J/K 同语义 —— 在当前标签里原位换目标（replace），
  // 不是每按一次开一个标签。
  const onPrev =
    prevId !== null && prevId !== internalId
      ? () => setActive(prevId, { mode: 'replace' })
      : undefined
  const onNext =
    nextId !== null && nextId !== internalId
      ? () => setActive(nextId, { mode: 'replace' })
      : undefined

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
  // 在邮件 A 开过 compose 后切视图/切邮件, overlay 的 bg-ink-3 实心层会盖在任何后续
  // 详情上。overlay 只在 store.internalId === 当前详情时渲染 (scope 校验)。
  const composeOpenHere = composeOpen && composeFor === internalId
  // 08-27 标签工作区 —— 每标签 draft 快照（切走存 / 切回自动重开）。
  // 描述符 draft 的 selector：draft 对象引用稳定（updateTab 只在写它时换引用），
  // 无关的标签提交不会让本组件重渲。
  const activeTabDraft = useTabWorkspace((s) =>
    internalId === null
      ? null
      : (s.tabs.find((tab) => tab.id === tabId('email', internalId))?.draft ?? null)
  )
  const composeTabDraft = useMemo(() => readComposeTabDraft(activeTabDraft), [activeTabDraft])
  // 切邮件：遗留的上一封 overlay composer → 经 snapshotRef 取现场快照写进它的标签，再关。
  // useExitAnimation 让面板在本次提交后仍活着一小段，getter 此刻可用；域切换（EmailDetail
  // 整树卸载）走 ComposePanelInner 自己的卸载快照，两条路径写的是同一份形状。
  // 随后：本标签挂着 compose 快照且 store 空闲 → 自动重开（「切回来 compose 仍开」）。
  const autoReopenIdRef = useRef<number | null>(null)
  useEffect(() => {
    const cs = useComposeStore.getState()
    if (cs.open && cs.internalId !== null && cs.internalId !== internalId) {
      const snap = composeSnapshotRef.current?.()
      if (snap !== null && snap !== undefined) {
        saveObjectTabDraft('email', cs.internalId, toDraftSnapshot(snap))
      }
      closeCompose()
    }
    // draft-edit 快照不经 compose store：草稿箱分支直渲面板并回填（波3），这里只管
    // overlay 三模式的自动重开。🔴 只在「刚到达这封邮件」时重开（arrived 判据）——
    // composeTabDraft 引用变化也会重跑本 effect（面板的 live dirty 写、清快照都换引用），
    // 不带这个判据时「显式关闭 + 面板 live 写落在同一 flush」会把用户刚关掉的 composer
    // 当场再打开（真实关闭 effect 的清快照晚一步，波3 实测抓到的竞态）。
    const arrived = autoReopenIdRef.current !== internalId
    autoReopenIdRef.current = internalId
    if (
      arrived &&
      internalId !== null &&
      composeTabDraft !== null &&
      composeTabDraft.mode !== 'draft-edit' &&
      !useComposeStore.getState().open
    ) {
      useComposeStore.getState().openCompose(internalId, composeTabDraft.mode)
    }
  }, [internalId, composeTabDraft])
  // 真实关闭（发送成功 / 显式丢弃 —— open 在**本邮件**上翻 false）→ 清掉标签上的快照。
  // 上面 effect 的程序化关闭发生在 composeFor ≠ internalId 时，天然不进这条分支。
  const prevComposeRef = useRef<{ open: boolean; internalId: number | null }>({
    open: composeOpen,
    internalId: composeFor
  })
  useEffect(() => {
    const prev = prevComposeRef.current
    prevComposeRef.current = { open: composeOpen, internalId: composeFor }
    if (prev.open && !composeOpen && prev.internalId !== null && prev.internalId === internalId) {
      clearObjectTabDraft('email', prev.internalId)
    }
  }, [composeOpen, composeFor, internalId])
  // draft-edit 面板关闭。dismiss（取消编辑 / 守卫放行）只取消选中，标签保留 —— 只有
  // 对象消亡（删除草稿 / 发送成功即替换删除）才收标签（波3）。次序参照 MattersWorkspace
  // 的 onRemoved：先清本地选中，再关标签（closeTab 的后继同步会重设选中，反过来会被
  // null 冲掉）。🔴 关「当前激活的邮件标签」而不是挂载时的 internalId —— 保存过的草稿
  // 可能已 retarget（replace 换锚），标签的 targetId 是镜像新行。
  const handleDraftEditClose = useCallback(
    (reason?: ComposeCloseReason): void => {
      const activeTab = selectActiveTab(useTabWorkspace.getState())
      setActive(null)
      if (reason === 'sent' || reason === 'deleted') {
        const target =
          activeTab !== null && activeTab.kind === 'email' ? activeTab.targetId : internalId
        if (target !== null) closeObjectTab('email', target)
      }
    },
    [setActive, internalId]
  )

  // ── 关闭守卫承接端（dogfood 波3）────────────────────────────────────────────
  // requestCloseTab 对 dirty 草稿标签只做「激活 + 挂起请求」；弹窗与保存链都在当页
  // compose 面板里（draft-edit 直渲 / overlay 自动重开），这里把请求接到面板的守卫
  // 句柄上：保存 / 丢弃 → 关标签（closedStack 照常入栈），取消 / 保存失败 → 请求作废。
  // 时序依赖：面板恢复快照把 dirty 翻 true 时会重写标签快照（live 写）→ activeTabDraft
  // 换引用 → 本组件重渲 → effect 重跑 —— 「守卫句柄还没就位 / 还没吃完恢复」的等待
  // 靠这条链收敛，不轮询。
  const closeRequest = useTabCloseGuard((s) => s.pending)
  const consumedCloseRef = useRef<PendingTabClose | null>(null)
  useEffect(() => {
    if (closeRequest === null || internalId === null) return
    if (closeRequest.kind !== 'email' || closeRequest.targetId !== internalId) return
    if (consumedCloseRef.current === closeRequest) return
    const finish = (): void => {
      // 🔴 关的目标按**此刻的**pending 解析：guard 保存路径可能已 retarget（bridge 会把
      // 请求迁到镜像新行）；pending 已被别的路径清掉（404 核销抢先关了标签）则无事可做。
      const pend = useTabCloseGuard.getState().pending
      clearTabCloseRequest()
      if (pend !== null) useTabWorkspace.getState().closeTab(pend.tabId)
    }
    const guard = draftEditGuardRef.current ?? overlayGuardRef.current
    if (guard !== null) {
      // store 说 dirty、面板还 clean = 快照恢复尚未落地 → 等下一轮（见头注释的重跑链）。
      // 快照坏到恢复不出来（composeTabDraft 收窄失败）时不等 —— 面板 clean 即直接放行。
      const rawDirty = (activeTabDraft as { dirty?: unknown } | null)?.dirty === true
      if (rawDirty && composeTabDraft !== null && !guard.isDirty()) return
      consumedCloseRef.current = closeRequest
      guard.attemptClose(finish, clearTabCloseRequest)
      return
    }
    // 没有守卫句柄可承接：overlay 正在自动重开的路上 / 详情还在加载 → 等；drafts 行
    // 数据已就位 = draft-edit 面板马上挂载 → 也等。其余（快照恢复不出来 / 行已不存在）
    // 用户明确要关 —— 直接放行，别让 ⌘W 哑掉。
    const cs = useComposeStore.getState()
    if (cs.open && cs.internalId === internalId) return
    if (!detailQ.isSuccess || detailQ.isPlaceholderData) return
    if (detailQ.data !== null && isDraftsMailbox(detailQ.data.mailbox)) return
    consumedCloseRef.current = closeRequest
    finish()
  }, [
    closeRequest,
    internalId,
    activeTabDraft,
    composeTabDraft,
    composeOpenHere,
    detailQ.isSuccess,
    detailQ.isPlaceholderData,
    detailQ.data
  ])

  // ── 404 轻量核销（dogfood 波3）──────────────────────────────────────────────
  // 「明确不存在」的判据：两条 API 腿对缺行统一返回 null（ElectronApi 的 getEmail
  // miss → null；HttpApi 把 E_NOT_FOUND 收敛成 null，见 HttpApi.isNotFound 注释），
  // 5xx / 网络错则 reject → isError 走错误壳不动。⇒ isSuccess 且 data === null =
  // 行确实不在 SQLite 里（⌘⇧T 重开死 id 也走到这）。dirty 草稿快照在场时**不核销**
  // （宁缺勿误杀：行没了但未保存现场还挂在标签上，收标签 = 丢字节）。先查标签在场
  // 再 toast —— StrictMode 双跑第二遍标签已没了，天然只报一次。
  useEffect(() => {
    if (internalId === null) return
    if (!detailQ.isSuccess || detailQ.isPlaceholderData || detailQ.data !== null) return
    // 没有标签条的窗口（popout / P5 轻窗）没有「核销标签」这回事，连 toast 也不该出。
    if (tabsInert()) return
    const tab = useTabWorkspace.getState().tabs.find((t) => t.id === tabId('email', internalId))
    if (tab === undefined) return
    if ((tab.draft as { dirty?: unknown } | undefined)?.dirty === true) return
    toastInfo(t('tabs.toast.targetGone'))
    closeObjectTab('email', internalId)
  }, [internalId, detailQ.isSuccess, detailQ.isPlaceholderData, detailQ.data, t])

  // B1 — compose overlay 进/退场. backdrop:false (root 即铺满整个详情区的覆盖层,
  // 非居中卡片). 整列覆盖面板用「淡入 + 上滑」(y:20, 无 scale) —— scale 适合居中小卡片,
  // 套到整列覆盖层会变成"整列缩放"观感不对。closeCompose() 触发退场后延迟卸载。
  const { shouldRender: composeShouldRender, scopeRef: composeScopeRef } =
    useExitAnimation<HTMLDivElement>(composeOpenHere, {
      backdrop: false,
      from: { autoAlpha: 0, y: 20 }
    })

  // B2 — 切邮件时正文内容区交叉淡入. internalId 变化时 0→1 淡入 (120ms),
  // overwrite:'auto' 让快速 J/K 连切打断上一个 tween. 仅淡入正文滚动容器 (不含
  // toolbar, 避免 toolbar 闪). keepPreviousData 防内容闪。reduced-motion 短路.
  //
  // 🔴 必须用 fromTo (终点显式 =1), 不能用 gsap.from(autoAlpha:0): from 会把
  // **调用时元素的当前 opacity** 快照成动画终点。快速切邮箱时若上一次淡入 (0→1)
  // 还在中途 (如 0.64) 就被新一次打断, from 会把 0.64 当终点 → 再切又取更低的中途
  // 值 → opacity 单调下降锁死 (真机 bug: style="opacity:0.6432")。fromTo 终点恒 1,
  // 无论何时重入打断都收敛到不透明, 杜绝累积。
  const bodyScopeRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      if (reduceMotion) return
      const el = bodyScopeRef.current
      if (!el) return
      gsap.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.fast, overwrite: 'auto' })
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
          queryKey: qk.compose.planMode(id, mode),
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
      // 归档后自动续选 = 原位换目标（replace），不开新标签。
      if (nextId !== null && nextId !== archivingId) setActive(nextId, { mode: 'replace' })
      else if (prevId !== null && prevId !== archivingId) setActive(prevId, { mode: 'replace' })
      await queryClient.invalidateQueries({ queryKey: qk.emails.all() })
      await queryClient.invalidateQueries({ queryKey: qk.email.detail(archivingId) })
    } catch (err) {
      const e = asWriteError(err)
      toastError(t('toolbarToast.archiveFail'), e.code ? `${e.code} · ${e.message}` : e.message)
    } finally {
      setPending((p) => ({ ...p, archive: false }))
    }
  }, [internalId, mailApi, queryClient, t, nextId, prevId, setActive])

  // 删除（收件箱语义 = flag→done 归档完成, 非物理删除; 草稿在上方已走 compose 编辑态不到这里）。
  // 复刻 EmailRow ricon-delete 非草稿分支 + 跳下一封（同 archive）。types.ts deleteDraft 注释明确：
  // 「收件箱删除按钮 = 归档语义 (flag→done)」，与草稿 deleteDraft 真删区分。接口复用 email.flag。
  const handleDelete = useCallback(async (): Promise<void> => {
    if (internalId === null) return
    const deletingId = internalId
    setPending((p) => ({ ...p, delete: true }))
    try {
      await mailApi.email.flag(deletingId, { isFlagged: false, processingStatus: '已完成' })
      toastSuccess(t('toolbarToast.deleteOk', { defaultValue: '已删除（归档完成）' }))
      if (nextId !== null && nextId !== deletingId) setActive(nextId, { mode: 'replace' })
      else if (prevId !== null && prevId !== deletingId) setActive(prevId, { mode: 'replace' })
      await queryClient.invalidateQueries({ queryKey: qk.emails.all() })
      await queryClient.invalidateQueries({ queryKey: qk.email.detail(deletingId) })
    } catch (err) {
      const e = asWriteError(err)
      toastError(
        t('toolbarToast.deleteFail', { defaultValue: '删除失败' }),
        e.code ? `${e.code} · ${e.message}` : e.message
      )
    } finally {
      setPending((p) => ({ ...p, delete: false }))
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
          await queryClient.invalidateQueries({ queryKey: qk.email.detail(internalId) })
          await queryClient.invalidateQueries({ queryKey: qk.email.ai(internalId) })
        }
      } catch (err) {
        const e = asWriteError(err)
        const key =
          // E_AUTH_FAILED is what both legs actually send (Python envelope over HTTP,
          // and cli_runner's exit-4 fallback over IPC). The old 'E_AUTH' spelling only
          // ever existed in cli_runner's exit map, so this branch never fired.
          e.code === 'E_AUTH_FAILED'
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
      await queryClient.invalidateQueries({ queryKey: qk.email.ai(internalId) })
    } catch (err) {
      const e = asWriteError(err)
      toastError(t('toolbarToast.llmFailGeneric'), e.code ? `${e.code} · ${e.message}` : e.message)
    } finally {
      setPending((p) => ({ ...p, llmRun: false }))
    }
  }, [internalId, mailApi, queryClient, t])

  // G-25 浮层的「AI 调研创建」行：唤起右下角 AI chat，带上这封邮件的引用 + 一条指令，
  // 由主 agent 处理（0812 起的既有通路，本批只是从工具栏一级位挪进浮层）。
  // 🔴 走既有注入面：邮件引用是 AgentConversation 的 email context chip（→ injectedContext），
  //    指令是一条普通用户消息 —— 不新造第五条注入路径，也因此扛得住审批 resume 剥 injectedContext。
  // 🔴 指令文案（locale）明确要求 agent 先查重、再决定新建还是加入既有事项。
  const handleAiResearchMatter = useCallback((): void => {
    if (internalId === null) return
    setMatterMenuOpen(false)
    startChatWithPrompt(t('toolbar.createMatterPrompt'), internalId)
  }, [internalId, t])

  // 切邮件时收起捕获浮层与跟进 Agent 抽屉（它们锚定/预填的都是上一封）。
  useEffect(() => {
    setMatterMenuOpen(false)
    setFollowupOpen(false)
  }, [internalId])

  // Sprint 15 D 块 — Optimistic UI for read/flag toggle. 直接 setQueryData
  // 让 detail panel 瞬时翻, 避免 CLI fork 500ms + invalidate 双重 await 卡顿;
  // 同步更新 ['emails'] 列表 cache, 这样 EmailRow 不需要等 5s poll 也能反映新
  // 状态. CLI 失败再 invalidate 回真值 + toast.
  const optimisticDetail = useCallback(
    (patch: Record<string, unknown>) => {
      if (internalId === null) return
      queryClient.setQueryData(qk.email.detail(internalId), (old: unknown) =>
        old && typeof old === 'object' ? { ...(old as object), ...patch } : old
      )
      queryClient.setQueriesData({ queryKey: qk.emails.all() }, (old: unknown) => {
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
        await queryClient.invalidateQueries({ queryKey: qk.email.detail(internalId) })
        await queryClient.invalidateQueries({ queryKey: qk.email.ai(internalId) })
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
        await queryClient.invalidateQueries({ queryKey: qk.email.detail(internalId) })
        await queryClient.invalidateQueries({ queryKey: qk.email.ai(internalId) })
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

  // 08-27 标签工作区 —— 标签标题回填：deeplink / J-K 开出来的标签没有标题快照，
  // 详情数据落地后补上（bridge 同值不写，不会造成 localStorage 提交风暴）。
  useEffect(() => {
    if (internalId === null) return
    const data = detailQ.data
    if (data?.internal_id !== internalId) return
    if (data.subject) setObjectTabTitle('email', internalId, data.subject)
  }, [internalId, detailQ.data])

  // 08-27 标签工作区 —— 每标签滚动位置：onScroll 只写 ref（不碰 store），切走时
  // （effect cleanup）落一次快照；切回在详情数据就绪后恢复一次。iframe 高度异步
  // 到位，长邮件的恢复是尽力而为（内容未撑开时会被 clamp）。
  const lastScrollTopRef = useRef(0)
  useEffect(() => {
    if (internalId === null) return
    const id = internalId
    return () => {
      saveObjectTabScroll('email', id, lastScrollTopRef.current)
    }
  }, [internalId])
  const scrollRestoredForRef = useRef<number | null>(null)
  useEffect(() => {
    if (internalId === null) return
    if (detailQ.data?.internal_id !== internalId) return
    if (scrollRestoredForRef.current === internalId) return
    scrollRestoredForRef.current = internalId
    const stored = getObjectTabScroll('email', internalId)
    lastScrollTopRef.current = 0
    const el = bodyScopeRef.current
    if (el && stored > 0) {
      // 命令式恢复滚动位置（同 useEmailListRows 的锚定回滚）；规则误判容器不可变。
      // eslint-disable-next-line react-hooks/immutability
      el.scrollTop = stored
      lastScrollTopRef.current = el.scrollTop
    }
  }, [internalId, detailQ.data])

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

  // task 08-20 draft-save C-1: replace 保存会删掉正在编辑的旧草稿行 (锚换镜像新行),
  // 随后 email.synced 失效 → detail 重取 404 → isError, 但缓存里仍有旧数据。此时
  // 若那是草稿箱行 = 正在编辑的 compose 会话, 不能换成错误壳 (会把编辑器连同未保
  // 存增量一起 unmount) — 凭 stale data 落进下方 draft-edit 分支 (面板有自己的
  // 一次性回填, 不再读 detail)。其余场景错误壳行为不变。
  if (!detailQ.data || (detailQ.isError && !isDraftsMailbox(detailQ.data.mailbox))) {
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
  // 波3: initialTabDraft = 标签上的现场快照（切走再切回 / replace 换锚 remount 后恢复
  // 正文·收件人·dirty·「已保存 HH:MM」）；guardRef 给关闭守卫承接端。
  if (isDraftsMailbox(email.mailbox)) {
    return (
      <ComposePanelInner
        key={`draft-${email.internal_id}`}
        internalId={email.internal_id}
        mode="draft-edit"
        onClose={handleDraftEditClose}
        guardRef={draftEditGuardRef}
        initialTabDraft={composeTabDraft}
      />
    )
  }

  const fromParsed = parseSender(email.sender)
  const fromName = email.sender_name || fromParsed.name
  const fromAddr = fromParsed.email || email.sender
  // WP4 —— chips 激活判据：flag on 且 resolve 数据就绪。loading / 失败 / off →
  // 下方 From/To/Cc 维持既有渲染字节级不变（不闪烁）。
  const chipsActive = contactsEnabled && resolvedContacts !== undefined
  const toEntries = chipsActive ? parseAddressList(email.to_addr) : []
  const ccEntries = chipsActive ? parseAddressList(email.cc_addr ?? null) : []
  const fromChip = chipsActive ? chipContactOf(resolvedContacts, fromAddr) : null
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
          <ComposePanel
            snapshotRef={composeSnapshotRef}
            initialTabDraft={composeTabDraft}
            guardRef={overlayGuardRef}
          />
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
        matter={
          mattersEnabled
            ? {
                count: linkedMatters.length,
                state: matterLinkState,
                open: matterMenuOpen,
                onToggle: () => setMatterMenuOpen((value) => !value),
                anchorRef: matterAnchorRef,
                popover: (
                  <MatterLinkPopover
                    open={matterMenuOpen}
                    anchorRef={matterAnchorRef}
                    source={{
                      internalId: email.internal_id,
                      threadId: email.thread_id ?? null,
                      subject: email.subject,
                      sender: email.sender_name || email.sender,
                      receivedAt: email.date_received ?? null,
                      threadCount: Math.max(1, matterThreadQ.data?.length ?? 1)
                    }}
                    onAiResearch={handleAiResearchMatter}
                    // ④ 次级入口：仅 trigger v2 开且线程键可派生（email_filter.thread_ids
                    // 用 thread_id ?? 去尖括号的 message_id，线程首封也能建）。
                    onCreateFollowupAgent={
                      triggerV2Enabled &&
                      (email.thread_id || email.message_id?.replace(/^<|>$/g, ''))
                        ? () => {
                            setMatterMenuOpen(false)
                            setFollowupOpen(true)
                          }
                        : undefined
                    }
                    onClose={() => setMatterMenuOpen(false)}
                  />
                )
              }
            : undefined
        }
        llmRunState={{ pending: pending.llmRun }}
        onToggleRead={() => void handleToggleRead(email.is_read)}
        isRead={email.is_read}
        readState={{ pending: pending.read }}
        onToggleFlag={() => void handleToggleFlag(email.is_flagged)}
        isFlagged={email.is_flagged}
        flagState={{ pending: pending.flag }}
        onTogglePin={() => {
          if (internalId !== null) void togglePin(internalId)
        }}
        isPinned={isPinned}
        isImportant={email.is_important === true}
        notionUrl={email.notion_url}
        // task 08-27 P5 —— 在新窗口打开。轻窗自己也渲染 EmailDetail，所以在轻窗里
        // 再挂一次入口就是「开一个一样的窗」，收掉。
        onOpenDetached={
          canOpenDetachedWindow() && !isDetachedWindow
            ? () => mailApi.email.openDetached(email.internal_id)
            : undefined
        }
        onArchive={handleArchive}
        archiveState={{ pending: pending.archive }}
        onDelete={() => void handleDelete()}
        deleteState={{ pending: pending.delete }}
        onPrev={onPrev}
        onNext={onNext}
      />
      {/* G-25 ④ —— 「为此线程建立跟进 Agent」：复用 CustomAgentDrawer 既有创建流
          （trigger=email_filter + thread_ids 预填，默认 enabled=false 先手动测试）。 */}
      <CustomAgentDrawer
        cfg={null}
        open={followupOpen}
        create
        initial={{
          title: `${t('toolbar.followupAgent')}: ${(email.subject || '').slice(0, 48)}`,
          trigger: {
            enabled: false,
            kind: 'email_filter',
            thread_ids: [email.thread_id || email.message_id?.replace(/^<|>$/g, '') || '']
          }
        }}
        onClose={() => setFollowupOpen(false)}
      />

      <div
        ref={bodyScopeRef}
        className="flex-1 overflow-y-auto scrollbar-thin"
        // 每标签滚动位置的采样面（只写 ref，切走时才落标签快照）。
        onScroll={(e) => {
          lastScrollTopRef.current = e.currentTarget.scrollTop
        }}
      >
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
          <div className="px-4 pt-3 pb-3">
            {/* Subject block — EN lang pip + tracking-tight headline.
                pt 与 pb 取齐 (pt-3=pb-3): 之前 pt-6 上留白比下大一截, 视觉不平衡。
                px-4 (16px): 与正文 px-4 + 工具栏 pl-4 同一左起点 (原 px-8 太宽)。 */}
            <div className="flex items-start gap-3">
              {langIsEn && (
                <span
                  className="lang-pip mt-2 shrink-0"
                  style={{ fontSize: '11px', padding: '3px 6px' }}
                >
                  EN
                </span>
              )}
              <h1 className="text-subj font-semibold text-ink-fg leading-snug tracking-tight flex-1 break-words text-balance">
                {email.subject || t('emailRow.noSubject')}
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

        <div className="px-4 pt-4 pb-6">
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
                  {/* WP4 —— chips 就绪后 From = PersonChip(big) + mono 地址并列
                      （cdemo MailScreen 形态）；发件人不在库时保留既有姓名派生 +
                      虚线不可点 chip（名字信息不丢）。resolve 未就绪/off = 原渲染。 */}
                  <MetaRow
                    label="From"
                    value={
                      chipsActive && fromChip !== null ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          <NavPersonChip big contact={fromChip} addr={fromAddr} />
                          <span className="font-mono text-ink-fg-2">{fromAddr}</span>
                        </span>
                      ) : chipsActive && fromAddr.includes('@') ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          {fromName && <span className="font-medium text-ink-fg">{fromName}</span>}
                          <PersonChip contact={null} addr={fromAddr} />
                        </span>
                      ) : (
                        <>
                          {fromName && <span className="font-medium text-ink-fg">{fromName}</span>}
                          {fromName && fromAddr && <span className="text-ink-fg-2"> · </span>}
                          <span className="text-ink-fg-2">{fromAddr}</span>
                        </>
                      )
                    }
                  />
                  <MetaRow
                    label="To"
                    value={
                      chipsActive && toEntries.length > 0 ? (
                        <RecipientChipsValue
                          key={`to-${email.internal_id}`}
                          entries={toEntries}
                          resolved={resolvedContacts}
                        />
                      ) : email.to_addr && email.to_addr.length > 0 ? (
                        <ExpandableValue text={email.to_addr} />
                      ) : (
                        <span className="text-ink-fg-3">—</span>
                      )
                    }
                  />
                  {email.cc_addr && email.cc_addr.length > 0 && (
                    <MetaRow
                      label="Cc"
                      value={
                        chipsActive && ccEntries.length > 0 ? (
                          <RecipientChipsValue
                            key={`cc-${email.internal_id}`}
                            entries={ccEntries}
                            resolved={resolvedContacts}
                          />
                        ) : (
                          <ExpandableValue text={email.cc_addr} />
                        )
                      }
                    />
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

                {/* Collapsible section — Mailbox / internal_id / message_id.
                    折叠机制走统一原语 (@shared/components/ui/collapsible);
                    此处原是手抄的一份 grid-rows + opacity。触发按钮在正文
                    **下方** (「更多属性 / 收起」), 所以 chevron 保持 rotate-180
                    的上下翻语义 —— 它指向的是内容所在方向, 与区块折叠头
                    (左置 + -rotate-90) 是两种不同的控件, 有意不归一。 */}
                {morePropsRows.length > 0 && (
                  <>
                    <CollapsibleRegion expanded={propsExpanded} id={morePropsId}>
                      <dl className="mt-1.5 grid grid-cols-[96px_1fr] gap-y-1.5 gap-x-3 text-aux">
                        {morePropsRows.map((row) => (
                          <MetaRow key={row.label} label={row.label} value={row.value} />
                        ))}
                      </dl>
                    </CollapsibleRegion>

                    <button
                      type="button"
                      onClick={() => setPropsExpanded((v) => !v)}
                      className={cn(
                        'mt-1.5 inline-flex items-center gap-1 text-meta text-ink-fg-2',
                        'hover:text-ink-fg-1 transition-colors duration-fast',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 rounded'
                      )}
                      aria-expanded={propsExpanded}
                      aria-controls={morePropsId}
                    >
                      <ChevronDown
                        size={12}
                        strokeWidth={2}
                        className={cn(
                          'transition-transform duration-base ease-standard',
                          'motion-reduce:transition-none',
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

          {/* 阶段 2.2 (UX-P0①) — 会议邀请卡片: emailCalendarLink (2.1 数据桥)
              命中才渲染; 非会议/加载中/错误在卡内自查全静默, 不占位 (margin
              在 .cal-invite 自身, 无空 wrapper 残留)。 */}
          {/* G-25 —— 已归属邮件的归属 info 卡（设计 create.jsx:321-333）：数据复用上面的
              matterLookupQ 归属反查（性能铁律：不为它多发一条请求），点击跳事项。 */}
          {mattersEnabled && linkedMatters.length > 0 ? (
            <MatterBelongsCard entries={linkedMatters} />
          ) : null}

          {/* Windows 日历整体出范围（2026-08-13 拍板）→ 邀请卡（含「在日历中查看」
              导航）平台门挂在挂载点, 组件内部 hooks 顺序不受影响。 */}
          {calendarUiEnabled(detectUiPlatform()) && (
            <MeetingInviteCard internalId={email.internal_id} />
          )}

          {/* AI Fields — 草稿不渲染: 未发出的邮件不会被 AI 处理 (gate 在
              watcher 草稿分支), `ai` 对存在的行恒非 null (LEFT JOIN 投影),
              不 gate 会渲染一张全空卡 (用户验收)。 */}
          {ai && !isDraftsMailbox(email.mailbox) && (
            <div className="mt-6">
              <AIFieldsBlock fields={ai} internalId={email.internal_id} />
            </div>
          )}

          {/* Thread-wide attachment strip — aggregates non-inline attachments
              across every message in the thread (the detail pane only renders
              one message, so replies' attachments are otherwise hidden). Owns
              its own top margin because it renders null when the thread has no
              attachments (an unconditional wrapper would leave a blank gap). */}
          <ThreadAttachmentBar
            threadId={email.thread_id ?? null}
            activeInternalId={email.internal_id}
            activeSenderName={email.sender_name ?? null}
            activeSender={email.sender}
            activeDate={email.date_received ?? null}
            activeAttachments={allAttachments}
          />

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
