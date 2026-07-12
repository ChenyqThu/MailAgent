// MailAgent agent-view trigger popover (@ mention / slash commands) — ported from the assistant-ui
// base demo's ComposerTriggerPopover, restyled with MailAgent tokens. Renders the popover UI for a
// LexicalComposerInput trigger char: an optional category list → an items list (with an async loading
// state surfaced via the popover scope's isLoading). The @ trigger uses `directive` (inserts an inline
// chip); the / trigger uses `action` (fires a slash-command handler). Pass exactly one of the two.

import { memo, type ComponentPropsWithoutRef, type FC } from 'react'
import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContext,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem
} from '@assistant-ui/react'
import { AtSign, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'

import { cn } from '@shared/lib/cn'

type IconComponent = FC<{ className?: string }>

type DirectiveBehaviorProps = {
  formatter?: Unstable_DirectiveFormatter
  onInserted?: (item: Unstable_TriggerItem) => void
}
type ActionBehaviorProps = {
  formatter?: Unstable_DirectiveFormatter
  onExecute: (item: Unstable_TriggerItem) => void
  removeOnExecute?: boolean
}

type BaseProps = Omit<
  ComponentPropsWithoutRef<typeof ComposerPrimitive.Unstable_TriggerPopover>,
  'children'
> & {
  iconMap?: Record<string, IconComponent>
  fallbackIcon?: IconComponent
  backLabel?: string
  emptyCategoriesLabel?: string
  emptyItemsLabel?: string
  loadingLabel?: string
}

type AgentTriggerPopoverProps = BaseProps &
  (
    | { directive: DirectiveBehaviorProps; action?: never }
    | { action: ActionBehaviorProps; directive?: never }
  )

function resolveIcon(
  key: string | undefined,
  map: Record<string, IconComponent> | undefined,
  fallback: IconComponent
): IconComponent {
  if (key && map?.[key]) return map[key]!
  return fallback
}

const Categories: FC<{
  iconMap?: Record<string, IconComponent>
  fallbackIcon: IconComponent
  emptyLabel: string
}> = ({ iconMap, fallbackIcon, emptyLabel }) => (
  <ComposerPrimitive.Unstable_TriggerPopoverCategories>
    {(categories) => (
      <div className="flex flex-col py-1">
        {categories.map((cat) => {
          const Icon = resolveIcon(cat.id, iconMap, fallbackIcon)
          return (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
              key={cat.id}
              categoryId={cat.id}
              className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-aux text-ink-fg-1 outline-none transition-colors duration-fast hover:bg-ink-4 data-[highlighted]:bg-ink-4"
            >
              <span className="flex items-center gap-2">
                <Icon className="size-4 text-ink-fg-3" />
                {cat.label}
              </span>
              <ChevronRight className="size-4 text-ink-fg-3" />
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          )
        })}
        {categories.length === 0 && (
          <div className="px-3 py-2 text-aux text-ink-fg-3">{emptyLabel}</div>
        )}
      </div>
    )}
  </ComposerPrimitive.Unstable_TriggerPopoverCategories>
)

const Items: FC<{
  iconMap?: Record<string, IconComponent>
  fallbackIcon: IconComponent
  backLabel: string
  emptyLabel: string
  loadingLabel: string
}> = ({ iconMap, fallbackIcon, backLabel, emptyLabel, loadingLabel }) => {
  const { isLoading } = unstable_useTriggerPopoverScopeContext()
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItems>
      {(items) => (
        <div className="flex flex-col">
          <ComposerPrimitive.Unstable_TriggerPopoverBack className="flex cursor-pointer items-center gap-1.5 border-b border-ink-border-soft px-3 py-2 text-micro uppercase tracking-wide text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4">
            <ChevronLeft className="size-3.5" />
            {backLabel}
          </ComposerPrimitive.Unstable_TriggerPopoverBack>
          <div className="scrollbar-thin max-h-[260px] overflow-y-auto py-1">
            {items.map((item, index) => {
              const iconKey =
                typeof item.metadata?.icon === 'string' ? item.metadata.icon : undefined
              const Icon = resolveIcon(iconKey, iconMap, fallbackIcon)
              return (
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  className="flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-1.5 text-start outline-none transition-colors duration-fast hover:bg-ink-4 data-[highlighted]:bg-ink-4"
                >
                  <span className="flex w-full min-w-0 items-center gap-2 text-aux font-medium text-ink-fg">
                    <Icon className="size-3.5 shrink-0 text-coral" />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.description && (
                    <span className="ms-5 truncate text-micro text-ink-fg-3">
                      {item.description}
                    </span>
                  )}
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              )
            })}
            {items.length === 0 && (
              <div className="px-3 py-2 text-aux text-ink-fg-3">
                {isLoading ? loadingLabel : emptyLabel}
              </div>
            )}
          </div>
        </div>
      )}
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  )
}

const AgentTriggerPopoverImpl: FC<AgentTriggerPopoverProps> = ({
  iconMap,
  fallbackIcon = Sparkles,
  backLabel = 'Back',
  emptyCategoriesLabel = 'No items',
  emptyItemsLabel = 'No matching items',
  loadingLabel = 'Loading…',
  className,
  directive,
  action,
  ...props
}) => {
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      className={cn(
        // 主题 v3 C8/批 4: directive/mention 触发菜单 = 紧凑菜单档 rounded-lg(8) → token 化 --r-ctl
        'glass-pop absolute bottom-full start-0 z-50 mb-2 w-72 overflow-hidden rounded-[var(--r-ctl)] border border-ink-border shadow-md',
        className
      )}
      {...props}
    >
      {directive ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Directive
          formatter={directive.formatter ?? unstable_defaultDirectiveFormatter}
          onInserted={directive.onInserted}
        />
      ) : action ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Action
          formatter={action.formatter ?? unstable_defaultDirectiveFormatter}
          onExecute={action.onExecute}
          removeOnExecute={action.removeOnExecute}
        />
      ) : null}
      <Categories iconMap={iconMap} fallbackIcon={fallbackIcon} emptyLabel={emptyCategoriesLabel} />
      <Items
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        backLabel={backLabel}
        emptyLabel={emptyItemsLabel}
        loadingLabel={loadingLabel}
      />
    </ComposerPrimitive.Unstable_TriggerPopover>
  )
}
AgentTriggerPopoverImpl.displayName = 'AgentTriggerPopover'

export const AgentTriggerPopover = memo(AgentTriggerPopoverImpl) as FC<AgentTriggerPopoverProps>

/** Inline @ email-mention chip (coral pill, our tokens). Rendered by LexicalComposerInput for each
 *  inserted directive node; `label` is the email subject. */
export function AgentDirectiveChip({
  label
}: {
  directiveId: string
  directiveType: string
  label: string
}): React.JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md bg-coral/15 px-1.5 py-0.5 text-meta font-medium text-coral">
      <AtSign className="size-3 self-center" />
      <span>{label}</span>
    </span>
  )
}
