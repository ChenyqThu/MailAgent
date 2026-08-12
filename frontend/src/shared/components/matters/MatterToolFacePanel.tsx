import { useTranslation } from 'react-i18next'
import { useIsFetching } from '@tanstack/react-query'
import { Globe, Loader2, Lock, Plug, Shield } from 'lucide-react'

import { useConnectorQuickRows } from '@shared/hooks/useConnectorQuickRows'
import {
  isMatterToolGroupAvailable,
  MATTER_TOOL_FACE_GROUPS,
  type MatterToolGroup
} from '@shared/lib/matterToolFace'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'

import { useMatterRunWebFace, WEB_FACE_ORDER, type MatterRunWebFace } from './useMatterRunWebFace'
import { useMatterToolFaceFlags } from './useMatterToolFaceFlags'

/**
 * 跟进 Agent 的**工具面清单**（0812 dogfood Lane C）。
 *
 * owner 原话：「工具那块也是，默认授权的工具，就算不可改也应该列出来」。此前这里只有一段
 * 散文（`matters.globalAgent.fixedBody`）说「只有只读工具和一个提案通道」—— 是真话，但
 * 读不出它到底能看邮件正文、能不能查日历、连没连 Notion。现在按分组**默认展开**列出来。
 *
 * 🔴 清单本身在零依赖叶子 `@shared/lib/matterToolFace`，不在本文件里硬编码；它与 gateway
 * 真实装配出来的 ToolSet 由 `tests/ai-gateway/matter_tool_face_leaf.test.ts` 双向钉死
 * （幽灵条目 / 藏起来的能力都会红）。
 *
 * 「外部服务」一组结构上进不了静态叶子（名字来自远端 manifest，随连了哪几家变），所以按
 * **实际已连接的行**渲染；总闸关着 / 一家没连 → 如实说「未连接任何外部服务」，不画假清单。
 *
 * 🔴 0812 Lane D —— 三处「界面在说谎」收口，判据全部来自**真实信号**，不猜不硬编码：
 *   1. 带 skill 归属的分组（email / search / report）会被 设置 → Custom AI → Skills 整族拿掉
 *      （gateway 两道 applySkillGating）。按 `/chat/config.advertisedSkills` 把关掉的组**降级
 *      标注**（不隐藏 —— owner 明说「就算不可改也应该列出来」），并说清去哪儿开。
 *   2. `MAILAGENT_OPENNESS_WEB_TOOLS=false` 时 web 工具压根不注册，三档是个死开关：整组标
 *      「不可用」+ 禁用 radio。
 *   3. connector 行还在路上时不许先断言「未连接」—— 加载中显示中性态。
 */

/** 三档的档位标签与后果说明 —— key 完整性由 `Record<MatterRunWebFace, …>` 保证：
 *  词表（policy.ts 的 MATTER_RUN_WEB_FACES）多一档就缺键，typecheck 当场红。 */
const WEB_FACE_I18N: Record<MatterRunWebFace, { label: string; body: string }> = {
  keep: { label: 'matters.globalAgent.webFace.keep', body: 'matters.globalAgent.webFace.keepBody' },
  search_only: {
    label: 'matters.globalAgent.webFace.searchOnly',
    body: 'matters.globalAgent.webFace.searchOnlyBody'
  },
  off: { label: 'matters.globalAgent.webFace.off', body: 'matters.globalAgent.webFace.offBody' }
}

function ToolChips({
  tools,
  muted = false
}: {
  tools: readonly string[]
  muted?: boolean
}): React.ReactElement {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tools.map((name) => (
        <code
          key={name}
          className={cn(
            'rounded-[5px] px-1.5 py-px font-mono text-micro',
            muted ? 'bg-ink-fg/[0.03] text-ink-fg-3 line-through' : 'bg-ink-fg/[0.06] text-ink-fg-2'
          )}
        >
          {name}
        </code>
      ))}
    </div>
  )
}

/** 「这一族当前不生效」的标注 —— 徽标 + 一句「为什么 + 去哪儿开」。两处复用（skill 关掉 /
 *  web 工具未启用），语义不同故文案分开传。 */
function UnavailableNote({ hint }: { hint: string }): React.ReactElement {
  return <p className="mt-1 text-micro leading-4 text-ink-fg-3">{hint}</p>
}

function OffBadge({ label }: { label: string }): React.ReactElement {
  return (
    <span className="rounded-full bg-warn/[0.14] px-1.5 py-px text-micro font-normal text-warn">
      {label}
    </span>
  )
}

function GroupRow({
  group,
  available
}: {
  group: MatterToolGroup
  available: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div>
      <p className="flex flex-wrap items-center gap-1.5 text-meta font-medium text-ink-fg-1">
        <Lock size={11} className="text-ink-fg-3" />
        <span className={available ? undefined : 'text-ink-fg-2'}>
          {t(`matters.globalAgent.toolFace.groups.${group.id}.label`)}
        </span>
        <span className="font-normal text-ink-fg-2">
          {t(`matters.globalAgent.toolFace.groups.${group.id}.desc`)}
        </span>
        {available ? null : <OffBadge label={t('matters.globalAgent.toolFace.skillOff.badge')} />}
      </p>
      <ToolChips tools={group.tools} muted={!available} />
      {available ? null : (
        <UnavailableNote hint={t('matters.globalAgent.toolFace.skillOff.hint')} />
      )}
    </div>
  )
}

export function MatterToolFacePanel(): React.ReactElement {
  const { t } = useTranslation()
  const connectors = useConnectorQuickRows()
  const flags = useMatterToolFaceFlags()
  const webFace = useMatterRunWebFace({
    onSaveError: (error) =>
      toastError(t('matters.globalAgent.webFace.saveFailed'), errorMessage(error))
  })

  // 🔴 connector 行「还没回来」≠「一家都没连」。`useConnectorQuickRows` 只给
  // {rows, available, anyActive}，没有 loading 态 —— 但它被 composer 共用，**不改它的签名**
  // （改一处签名会把 diff 撑到 composer 那边去）。这里改用 react-query 的在途计数区分二者：
  // 它先查 flag（`qk.chat.config('connectorToolsEnabled')`）、flag 为 true 才查 list
  // （`qk.connectors()`），所以两条都不在途才算「回来了」。两个 key 与那个 hook 用的是同一
  // 份 `qk` 构造，不是手抄字面量。
  const connectorsPending =
    useIsFetching({ queryKey: qk.chat.config('connectorToolsEnabled') }) +
      useIsFetching({ queryKey: qk.connectors() }) >
    0

  // 与 Python `resource_proposal.connected_connector_ids` 同一判据（status='connected' 且
  // enabled）—— 跟进 run 真正拿得到只读工具的就是这些家。
  const connected = connectors.rows.filter((row) => row.enabled && row.status === 'connected')
  const fixedGroups = MATTER_TOOL_FACE_GROUPS.filter((group) => group.tier === 'fixed')
  const webGroup = MATTER_TOOL_FACE_GROUPS.find((group) => group.id === 'web')
  // `MAILAGENT_OPENNESS_WEB_TOOLS=false` ⇒ web 工具根本不注册，三档存了也没有消费者。
  // undefined（未知 / 旧后端）**不**禁用 —— 判据取 `=== false`（CapabilityCards 先例）。
  const webAvailable = flags.webToolsEnabled !== false

  return (
    <div className="mt-4 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2/50 p-3">
      <p className="flex items-center gap-1.5 text-meta font-medium text-ink-fg-1">
        <Shield size={13} className="text-ok" />
        {t('matters.globalAgent.toolFace.title')}
      </p>
      <p className="mt-1.5 text-meta leading-relaxed text-ink-fg-2">
        {t('matters.globalAgent.toolFace.intro')}
      </p>

      <div className="mt-3 space-y-2.5">
        {fixedGroups.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            available={isMatterToolGroupAvailable(group, flags.advertisedSkills)}
          />
        ))}

        {/* 外部服务：动态一组。没连 / 总闸关 → 如实说没有，不画假清单。 */}
        <div>
          <p className="flex items-center gap-1.5 text-meta font-medium text-ink-fg-1">
            <Plug size={11} className="text-ink-fg-3" />
            {t('matters.globalAgent.toolFace.groups.connector.label')}
            <span className="font-normal text-ink-fg-2">
              {t('matters.globalAgent.toolFace.groups.connector.desc')}
            </span>
          </p>
          {connected.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {connected.map((row) => (
                <span
                  key={row.connector_id}
                  className="rounded-[5px] bg-ink-fg/[0.06] px-1.5 py-px text-micro text-ink-fg-2"
                >
                  {row.display_name}
                </span>
              ))}
            </div>
          ) : (
            /* 🔴 还在读 → 中性态。在数据回来之前说「未连接任何外部服务」是一个**确定的否定**，
               而它有一半时间是错的。 */
            <p className="mt-1 text-micro text-ink-fg-3">
              {t(
                connectorsPending
                  ? 'matters.globalAgent.toolFace.groups.connector.loading'
                  : 'matters.globalAgent.toolFace.groups.connector.none'
              )}
            </p>
          )}
        </div>
      </div>

      {/* 唯一可改的一组 —— 三档 */}
      {webGroup ? (
        <div className="mt-3 border-t border-ink-border pt-3">
          <p className="flex flex-wrap items-center gap-1.5 text-meta font-medium text-ink-fg-1">
            <Globe size={11} className={webAvailable ? 'text-ai' : 'text-ink-fg-3'} />
            {t('matters.globalAgent.toolFace.groups.web.label')}
            {webFace.isSaving ? <Loader2 size={11} className="animate-spin text-ink-fg-3" /> : null}
            {webAvailable ? null : (
              <OffBadge label={t('matters.globalAgent.toolFace.webOff.badge')} />
            )}
          </p>
          <ToolChips tools={webGroup.tools} muted={!webAvailable} />
          {webAvailable ? null : (
            <UnavailableNote hint={t('matters.globalAgent.toolFace.webOff.hint')} />
          )}
          {webFace.isError ? (
            <p className="mt-1.5 text-meta text-warn">
              {t('matters.globalAgent.webFace.loadFailed')}
            </p>
          ) : null}
          <div role="radiogroup" className="mt-1.5 space-y-0.5">
            {WEB_FACE_ORDER.map((face) => {
              const active = webFace.face === face
              return (
                <button
                  key={face}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  /* web 工具未注册时这三档谁也管不着 —— 禁用比让人"配一个不生效的东西"诚实。 */
                  disabled={webFace.face === undefined || webFace.isSaving || !webAvailable}
                  onClick={() => {
                    if (!active) webFace.save(face)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-[var(--r-ctl)] px-1.5 py-1.5 text-left',
                    'hover:bg-ink-fg/[0.04] disabled:opacity-60',
                    active && 'bg-ink-fg/[0.06]'
                  )}
                >
                  <span
                    className={cn(
                      'mt-1 size-[9px] shrink-0 rounded-full border',
                      active ? 'border-coral bg-coral/100' : 'border-ink-fg-3'
                    )}
                  />
                  <span className="min-w-0">
                    <span className="text-meta font-medium text-ink-fg-1">
                      {t(WEB_FACE_I18N[face].label)}
                    </span>
                    <span className="ml-1 text-meta text-ink-fg-2">
                      {t(WEB_FACE_I18N[face].body)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          {/* 🔴 如实提示：档位在 run 开始时就冻进 run context（agentRun.ts 的
              resolveMatterRunWebFace），改动不会影响正在跑的那一轮。 */}
          <p className="mt-1 text-micro leading-4 text-ink-fg-3">
            {t('matters.globalAgent.webFace.runningHint')}
          </p>
        </div>
      ) : null}
    </div>
  )
}
