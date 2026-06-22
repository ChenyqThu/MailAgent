// Sprint 4 §6.6 — composer textarea + send button.
// ⌘↩ shortcut wired here via useShortcut (Sprint 4 Day 1 keydown bus).
// allowInEditable: true so the binding fires when focus is in our own
// textarea.
//
// V1 redesign (Sprint 10 polish): mirrors mockup-inbox.html lines 1334-1358.
// Footer is a dedicated row beneath the textarea (no `absolute` overlap),
// the send button is a squared-off `rounded-md` 28×28 chip that turns
// coral on hover, and the affordance strip is English mono so the
// 12px text-meta floor is on-spec.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AtSign, ArrowUp, Brain, Cpu, Paperclip, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useShortcut } from '@shared/hooks/useShortcut'
import {
  type ChatAttachment,
  formatAttachmentSize,
  readAttachment
} from '@shared/lib/chat-attachments'
import { toastError } from '@shared/state/toast'
import type { SearchHit } from '@shared/api/types'

import { MentionPopover } from './MentionPopover'
import { ActiveSkillChips } from './ActiveSkillChips'

/** Which chat surface a Composer instance lives in. */
type PanelScope = 'chat' | 'general'

/** Scope of the panel currently holding keyboard focus, or `null` if focus is
 *  outside any chat surface. Drives the per-instance shortcut gating below: the
 *  Composer is shared between the email-mode AIChatPanel (`ai-chat-panel`) and
 *  the Cmd+O General Agent dialog (`data-general-agent-panel`), and both can be
 *  mounted at once. The shared shortcut bus is LIFO and re-registers handlers on
 *  every render, so without checking "is the focused panel MY panel" a
 *  background composer could handle the foreground panel's ⌘↩ and submit into
 *  the wrong surface. */
function activePanelScope(): PanelScope | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return null
  if (active.closest('[aria-label="ai-chat-panel"]')) return 'chat'
  if (active.closest('[data-general-agent-panel]')) return 'general'
  return null
}

interface Props {
  /** Renderer-controlled draft text. Lifted so QuickActions can prefill it. */
  value: string
  onChange(next: string): void
  /** Called when user hits ⌘↩ or clicks the send button. */
  onSend(text: string): void
  /** Called when user clicks the cancel button during a streaming reply. */
  onCancel(): void
  /** True while a streaming reply is in flight — swap send button for cancel. */
  isStreaming: boolean
  /** Disable send when there's no active email or backend is missing. */
  canSend: boolean
  /** Short, ASCII-safe label for the active backend (e.g. "Jarvis", "sonnet-4-6").
   *  Rendered in the footer next to ⌘↩ so the user always sees what they'll
   *  be sending to. */
  backendName: string
  /** Sprint 13 — model dropdown lives in the Composer footer's Cpu button.
   *  Only meaningful for Custom API backend (Notion Agent has no model
   *  picker — the agent decides). Pass null + empty options to disable. */
  currentModel?: string | null
  availableModels?: ReadonlyArray<string>
  onModelChange?(model: string): void
  /** Hides the model picker entirely (used by Notion Agent backend kind). */
  modelPickerDisabled?: boolean
  /** task 06-08-chat 需求 5 — extended-thinking toggle state. When the button
   *  is on, the next send streams the model's reasoning into a collapsible
   *  block. Only meaningful for custom-api Anthropic — pass thinkingDisabled
   *  for notion-agent / OpenAI. */
  thinkingEnabled?: boolean
  onToggleThinking?(): void
  /** Disables the thinking toggle (backend doesn't support extended thinking). */
  thinkingDisabled?: boolean
  /** Sprint 14 PR D — currently selected @-mention emails. Rendered as a
   *  chip stack above the textarea. AIChatPanel owns the state so the
   *  list survives send (we prepend each chip's subject + snippet to
   *  the message body before clearing it on the next render). */
  mentions?: ReadonlyArray<SearchHit>
  onAddMention?(hit: SearchHit): void
  onRemoveMention?(internalId: number): void
  /** Sprint 14 PR C — file attachments (in-memory MVP). Same chip-stack
   *  treatment as mentions; AIChatPanel owns the state + reads the text
   *  content into the user message at send time. */
  attachments?: ReadonlyArray<ChatAttachment>
  onAddAttachment?(attachment: ChatAttachment): void
  onRemoveAttachment?(id: string): void
  /** Which chat surface this Composer lives in. Gates the ⌘↩ / ⌘O / ⌘⇧M
   *  shortcuts so they only fire when focus is inside THIS panel. Defaults to
   *  the email-mode chat panel; the Cmd+O General Agent dialog passes
   *  `'general'`. */
  panelScope?: PanelScope
  /** R3 — the per-conversation @mention activation scope key (from the chat hook's
   *  `skillScopeKey`). Drives ActiveSkillChips so each surface/session shows only its own
   *  pinned skills. Omitted → no chips rendered. */
  skillScopeKey?: string
}

export function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  isStreaming,
  canSend,
  backendName,
  currentModel,
  availableModels,
  onModelChange,
  modelPickerDisabled,
  mentions = [],
  onAddMention,
  onRemoveMention,
  attachments = [],
  onAddAttachment,
  onRemoveAttachment,
  thinkingEnabled = false,
  onToggleThinking,
  thinkingDisabled = false,
  panelScope = 'chat',
  skillScopeKey
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  // Sprint 14 PR D — @-mention popover open state. Local to Composer
  // because AIChatPanel only needs the resolved mentions list, not the
  // popover lifecycle. Outside-click + Escape close inside the popover.
  const [mentionOpen, setMentionOpen] = useState(false)
  const mentionEnabled = onAddMention !== undefined && onRemoveMention !== undefined
  const attachEnabled = onAddAttachment !== undefined && onRemoveAttachment !== undefined

  // Sprint 14 PR C — file picker handler. Reads selected files via the
  // FileReader API (renderer-side, no IPC) and pushes each one through
  // onAddAttachment. Reset the input value after consumption so the
  // same file can be re-selected after a remove + re-add cycle.
  const handleFilePick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = e.target.files
      if (!files || files.length === 0 || !onAddAttachment) return
      const failed: string[] = []
      for (const file of Array.from(files)) {
        try {
          const a = await readAttachment(file)
          onAddAttachment(a)
        } catch {
          // Sprint 14 review LOW fix — surface read failures via toast
          // so the user knows why nothing showed up (sandbox refused
          // FileReader access, file got renamed between pick + read,
          // etc.). Batch the filenames so a multi-pick with one bad
          // file produces one toast, not N.
          failed.push(file.name)
        }
      }
      if (failed.length > 0) {
        toastError(t('chat.composer.attachReadFail'), failed.join(', '))
      }
      e.target.value = ''
    },
    [onAddAttachment, t]
  )
  // Sprint 13 — model picker popover state. Open via the Cpu button in
  // the footer; closed by Escape, outside click, or model select.
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!modelPickerOpen) return
    const handler = (e: MouseEvent): void => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false)
      }
    }
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setModelPickerOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', escHandler)
    return (): void => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', escHandler)
    }
  }, [modelPickerOpen])

  // model-picker 出入场：菜单锚在 Cpu 按钮上方 (bottom-full 向上展开)，故
  // transformOrigin bottom left。无 backdrop，退场反向。scopeRef 是 popover
  // 本身；outside-click 仍判定外层 modelPickerRef (含按钮+popover)。
  const modelPickerVisible =
    modelPickerOpen && !modelPickerDisabled && !!availableModels && availableModels.length > 0
  const { shouldRender: modelPickerShouldRender, scopeRef: modelPickerScopeRef } =
    useExitAnimation<HTMLDivElement>(modelPickerVisible, {
      backdrop: false,
      from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom left' },
      enterDuration: DUR.fast
    })

  const submit = useCallback(() => {
    const trimmed = value.trim()
    if (!canSend || isStreaming || trimmed.length === 0) return
    onSend(trimmed)
  }, [canSend, isStreaming, onSend, value])

  // ⌘↩ to send. Sprint 4 review (opus M carry-forward): `enabled: focused`
  // killed the shortcut whenever the user clicked a tool row or the
  // BackendSelector. Scope to "anywhere inside MY panel" — composer textarea,
  // quick-action chips, and BackendSelector all sit under the panel root
  // (`aria-label="ai-chat-panel"` for chat, `data-general-agent-panel` for the
  // Cmd+O General Agent dialog). `panelScope` tells THIS instance which panel
  // it owns, so only the composer whose panel holds focus submits.
  useShortcut(
    'cmd+enter',
    () => {
      if (activePanelScope() !== panelScope) return
      submit()
      return true
    },
    { allowInEditable: true }
  )

  // Sprint 14 PR H — ⌘O picks an attachment file (chat panel only; the
  // General Agent dialog has no attachments). Browser default for ⌘O is
  // "Open File" which Electron doesn't honour in renderer, so overriding is
  // free of side effects. Returning `true` stops the shortcut bus from
  // cascading the keystroke to the GLOBAL ⌘O (GlobalShortcuts toggles the
  // General Agent dialog) — without consuming it inside the dialog, ⌘O there
  // would fall through and toggle the dialog shut.
  useShortcut(
    'cmd+o',
    () => {
      if (activePanelScope() !== panelScope) return
      // General Agent dialog: no attachments — consume so the global ⌘O
      // (toggle dialog) doesn't fire and close us mid-typing.
      if (panelScope === 'general') return true
      if (!attachEnabled) return
      fileInputRef.current?.click()
      return true
    },
    { allowInEditable: true }
  )

  // Sprint 14 PR H — ⌘⇧M toggles the mention popover. Picked the same
  // shift-modifier family the panel uses elsewhere (⇧⌥B backend,
  // ⇧⌥H history) so the "shift-modifier = AI panel action" mental
  // model stays consistent. ⌘ instead of ⌥ because the @-mention is
  // composer-scoped — same mod group as ⌘↩ send / ⌘O attach.
  useShortcut(
    'cmd+shift+m',
    () => {
      if (activePanelScope() !== panelScope || !mentionEnabled) return
      setMentionOpen((cur) => !cur)
      return true
    },
    { allowInEditable: true }
  )

  // Sprint 14 PR H — auto-focus textarea once a streaming reply ends so
  // the user can immediately type the next prompt without reaching for
  // the mouse. Track the previous isStreaming via ref so a mount-time
  // false→false transition does NOT steal focus from the BackendSelector
  // / Composer / wherever the user clicked first.
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      taRef.current?.focus()
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming])

  const sendDisabled = !canSend || value.trim().length === 0
  const sendTitle = `${t('chat.composer.send')} (⌘↩)`

  return (
    // mockup L2514 — `border-t border-ink-border bg-ink-2 p-2.5`. p-2.5 (10px)
    // not p-3 (12px); border above is `border-ink-border` not `-soft`.
    <div className="p-2.5 border-t border-ink-border bg-ink-2">
      {/* Sprint 14 PR C — attachment chip stack. Text-content attachments
          are rendered with the same chip chrome as mentions (coral
          accent) so the user has a single visual idiom for "I added
          extra context to this turn". Binary attachments still render
          a chip but the send-time block surfaces metadata only. */}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1 px-1 pb-1.5">
          {attachments.map((a) => (
            <li
              key={a.id}
              className={cn(
                'inline-flex items-center gap-1 max-w-[220px]',
                'px-1.5 py-0.5 rounded',
                'bg-ink-3 border border-ink-border',
                'text-micro text-ink-fg'
              )}
              title={`${a.filename} (${formatAttachmentSize(a.sizeBytes)})`}
            >
              <Paperclip size={9} strokeWidth={2} className="text-ink-fg-2 shrink-0" />
              <span className="truncate">{a.filename}</span>
              <span className="text-ink-fg-3 font-mono shrink-0">
                {formatAttachmentSize(a.sizeBytes)}
              </span>
              <button
                type="button"
                onClick={() => onRemoveAttachment?.(a.id)}
                aria-label={t('chat.attachment.remove')}
                className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
              >
                <X size={9} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Sprint 14 PR D — mention chip stack lives ABOVE the textarea
          container (separate row so the chips never collide with the
          text caret). Each chip shows the subject + a remove X; the
          send handler in AIChatPanel reads `mentions` at submit time
          to prepend a "Referenced email" block to the LLM prompt. */}
      {mentions.length > 0 && (
        <ul className="flex flex-wrap gap-1 px-1 pb-1.5">
          {mentions.map((m) => (
            <li
              key={m.internal_id}
              className={cn(
                'inline-flex items-center gap-1 max-w-[200px]',
                'px-1.5 py-0.5 rounded',
                'bg-coral/10 border border-coral/30',
                'text-micro text-ink-fg'
              )}
            >
              <AtSign size={9} strokeWidth={2} className="text-coral shrink-0" />
              <span className="truncate" title={m.subject}>
                {m.subject || `#${m.internal_id}`}
              </span>
              <button
                type="button"
                onClick={() => onRemoveMention?.(m.internal_id)}
                aria-label={t('chat.mention.remove')}
                className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
              >
                <X size={9} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* PR7 — @mention skill activation chips (self-hides when none are active). */}
      {skillScopeKey ? <ActiveSkillChips scopeKey={skillScopeKey} /> : null}
      <div
        className={cn(
          'rounded-md bg-ink-3 border transition-colors duration-fast',
          focused ? 'border-coral/50' : 'border-ink-border'
        )}
      >
        <div className="px-3 pt-2.5 pb-1">
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            // Sprint 14 PR G polish — `@` keystroke surfaces the mention
            // popover so users don't have to mouse to the AtSign icon.
            // The `@` character itself still types into the textarea
            // (no preventDefault) so a typo "@bob" stays editable. The
            // popover's input gets focus inside its own useEffect, so
            // the user's next keystrokes land on the search field.
            onKeyDown={(e) => {
              if (
                e.key === '@' &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                mentionEnabled &&
                !mentionOpen
              ) {
                setMentionOpen(true)
              }
            }}
            rows={2}
            placeholder={t('chat.composer.placeholder')}
            aria-label={t('chat.composer.placeholder')}
            className={cn(
              // text-[14px] 跟 message bubble 视觉对齐 — Tailwind v4 没
              // text-body 默认 utility, 之前 textarea fall back 到 browser
              // form default (~11-13px) 比 <div> bubble (16px) 小一号.
              'w-full resize-none bg-transparent text-[14px] text-ink-fg leading-snug',
              'placeholder:text-ink-fg-3',
              'focus:outline-none',
              'max-h-40 overflow-y-auto scrollbar-thin'
            )}
            // grow up to ~8 lines then scroll. Implementation idiom from
            // mockup-inbox.html — height auto + max-h.
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 160) + 'px'
            }}
          />
        </div>

        {/* Footer affordance strip — mockup L2523-2540. Three 7×7 icon
            buttons (attach / @mention / model switch), backend name +
            ⌘↩ kbd hint pinned right, then the send button (rounded-md
            7×7, hover → coral). attach + @mention disabled with
            HoverTip TODO; model click points at the BackendSelector
            Alt row above (the canonical model picker). */}
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-t border-ink-border-soft">
          {/* Sprint 14 PR C — attach button. Hidden file input does the
              picking; the visible button just triggers it via ref.
              multiple lets users add a batch in one open. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => void handleFilePick(e)}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
          <HoverTip
            text={attachEnabled ? t('chat.composer.attach') : t('chat.composer.attachBlocked')}
            side="top"
          >
            <button
              type="button"
              disabled={!attachEnabled}
              aria-label={t('chat.composer.attach')}
              onClick={() => attachEnabled && fileInputRef.current?.click()}
              tabIndex={attachEnabled ? 0 : -1}
              data-disabled={attachEnabled ? undefined : ''}
              className={cn(
                'w-7 h-7 rounded-md grid place-items-center',
                attachEnabled
                  ? 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4'
                  : 'text-ink-fg-3 opacity-50 cursor-not-allowed'
              )}
            >
              <Paperclip size={13} strokeWidth={2} />
            </button>
          </HoverTip>
          {/* Sprint 14 PR D — @-mention button. Wired only when both
              onAddMention + onRemoveMention props are provided (the
              AIChatPanel passes them; read-only viewers can skip them
              entirely → the button renders disabled like before). */}
          <div className="relative">
            <HoverTip
              text={mentionEnabled ? t('chat.composer.mention') : t('chat.composer.mentionBlocked')}
              side="top"
            >
              <button
                type="button"
                disabled={!mentionEnabled}
                aria-label={t('chat.composer.mention')}
                onClick={() => mentionEnabled && setMentionOpen((cur) => !cur)}
                tabIndex={mentionEnabled ? 0 : -1}
                data-disabled={mentionEnabled ? undefined : ''}
                className={cn(
                  'w-7 h-7 rounded-md grid place-items-center',
                  mentionEnabled
                    ? mentionOpen
                      ? 'text-coral bg-coral/10'
                      : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4'
                    : 'text-ink-fg-3 opacity-50 cursor-not-allowed'
                )}
              >
                <AtSign size={13} strokeWidth={2} />
              </button>
            </HoverTip>
            {mentionEnabled && (
              <MentionPopover
                open={mentionOpen}
                onClose={() => setMentionOpen(false)}
                onSelect={(hit) => {
                  onAddMention?.(hit)
                  setMentionOpen(false)
                }}
              />
            )}
          </div>
          {/* Sprint 13 — mockup L2530 真模型切换 button. Notion Agent 时
              modelPickerDisabled=true 因为 agent 自己决定模型 (没有
              picker 概念)。Custom API 时点击弹 popover 列出可选 models.
              Popover anchored to button via relative wrapper. */}
          <div className="relative" ref={modelPickerRef}>
            <HoverTip
              text={
                modelPickerDisabled
                  ? t('chat.composer.modelHint')
                  : `${t('chat.composer.model')} · ${currentModel ?? '—'}`
              }
              side="top"
            >
              <button
                type="button"
                disabled={modelPickerDisabled}
                onClick={() => {
                  if (!modelPickerDisabled) setModelPickerOpen((v) => !v)
                }}
                aria-label={t('chat.composer.model')}
                aria-expanded={modelPickerOpen}
                aria-haspopup="menu"
                data-disabled={modelPickerDisabled ? '' : undefined}
                tabIndex={modelPickerDisabled ? -1 : 0}
                className={cn(
                  'w-7 h-7 rounded-md grid place-items-center',
                  'transition-colors duration-fast',
                  modelPickerDisabled
                    ? 'text-ink-fg-3 opacity-50 cursor-not-allowed'
                    : modelPickerOpen
                      ? 'text-coral bg-coral/10'
                      : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4'
                )}
              >
                <Cpu size={13} strokeWidth={2} />
              </button>
            </HoverTip>

            {modelPickerShouldRender && availableModels && (
              // mockup-faithful glass popover anchored above the Cpu button.
              // Width auto-fits the widest model id (claude-opus-4-7 ≈ 110px);
              // padding matches Sprint 11 .glass-pop recipe.
              <div
                ref={modelPickerScopeRef}
                role="menu"
                aria-label={t('chat.composer.model')}
                className={cn(
                  'absolute z-50 bottom-full mb-1.5 left-0',
                  'min-w-[160px] rounded-md py-1',
                  'glass-pop shadow-[0_4px_12px_rgba(0,0,0,0.35)]'
                )}
              >
                {availableModels.map((m) => {
                  const active = m === currentModel
                  return (
                    <button
                      key={m}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        onModelChange?.(m)
                        setModelPickerOpen(false)
                      }}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-meta font-mono',
                        'flex items-center gap-2 whitespace-nowrap',
                        active
                          ? 'text-coral bg-coral/10'
                          : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg',
                        'transition-colors duration-fast'
                      )}
                    >
                      <span
                        className={cn(
                          'w-1.5 h-1.5 rounded-full shrink-0',
                          active ? 'bg-coral/100' : 'bg-ink-fg-3'
                        )}
                      />
                      {m}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* task 06-08-chat 需求 5 — extended-thinking toggle (Brain icon).
              On → coral fill (same active idiom as the @-mention button); the
              next send streams the model's reasoning into a collapsible block.
              Disabled for notion-agent / OpenAI (no extended-thinking support). */}
          {onToggleThinking && (
            <HoverTip
              text={
                thinkingDisabled
                  ? t('chat.thinking.unsupported')
                  : thinkingEnabled
                    ? t('chat.thinking.toggleOff')
                    : t('chat.thinking.toggleOn')
              }
              side="top"
            >
              <button
                type="button"
                disabled={thinkingDisabled}
                aria-label={t('chat.thinking.label')}
                aria-pressed={thinkingEnabled}
                onClick={() => !thinkingDisabled && onToggleThinking()}
                tabIndex={thinkingDisabled ? -1 : 0}
                data-disabled={thinkingDisabled ? '' : undefined}
                className={cn(
                  'w-7 h-7 rounded-md grid place-items-center transition-colors duration-fast',
                  thinkingDisabled
                    ? 'text-ink-fg-3 opacity-50 cursor-not-allowed'
                    : thinkingEnabled
                      ? 'text-coral bg-coral/10'
                      : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4'
                )}
              >
                <Brain size={13} strokeWidth={2} />
              </button>
            </HoverTip>
          )}

          {/* Backend label + ⌘↩ kbd — `ml-auto` shoves the affordance
              icons left and the send button stays at the right edge. */}
          <span className="ml-auto inline-flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
            <span className="truncate max-w-[120px]">{backendName}</span>
            <kbd>⌘↩</kbd>
          </span>

          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label={t('chat.composer.cancel')}
              title={t('chat.composer.cancel')}
              className={cn(
                'ml-1 w-7 h-7 rounded-md grid place-items-center',
                'bg-ink-4 hover:bg-coral/100 text-ink-fg-1 hover:text-accent-fg',
                'transition-colors duration-fast'
              )}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={sendDisabled}
              aria-label={t('chat.composer.send')}
              title={sendTitle}
              className={cn(
                'ml-1 w-7 h-7 rounded-md grid place-items-center',
                'transition-colors duration-fast',
                sendDisabled
                  ? 'bg-ink-4 text-ink-fg-3 cursor-not-allowed'
                  : 'bg-ink-4 hover:bg-coral/100 text-ink-fg-1 hover:text-accent-fg'
              )}
            >
              <ArrowUp size={12} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
