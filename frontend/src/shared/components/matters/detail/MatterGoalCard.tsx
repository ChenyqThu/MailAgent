import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CircleCheckBig, Pencil, Target, Trash2, X } from 'lucide-react'

import type { Matter, MatterGoalCheck } from '@shared/api/types/matter'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { Input } from '@shared/components/ui/input'
import { cn } from '@shared/lib/cn'

import { MatterCheckRow } from '../MatterCheckRow'
import { MatterSectionLabel } from './MatterDetailControls'

/**
 * 「背景与目标」卡（设计 matter-agent.jsx:266-332 `GoalCard`）：上半是用户自己写的
 * 背景与目标两段，下半是同一张卡里的「完成标志」分区（底色略深 + 上分隔线）。
 *
 * 🔴 **不做**「让 Agent 改写」按钮：设计稿底部那条 ghost 按钮与 HANDOFF §3 硬约束①
 * 「这两段是用户写的，Agent 永远不能直写」直接冲突。
 *
 * 存储：2026-08-19（v61）owner 推翻「合存单字段 + `## 背景` / `## 目标` 小标题分段」的
 * 方案，改成 `matter.background` / `matter.goal` 两个独立字段 —— 目的就是**没有解析这回事**。
 * 🔴 不要再往这里加分段正则：一处正则就是五处（读态 / 编辑态 / 保存 / 导出 / Agent 写）
 * 都得同意，任何一处不同意就是静默串段。
 */
export function GoalCard({
  matter,
  saving,
  onProseSave,
  onGoalChecksSave
}: {
  matter: Matter
  saving: boolean
  onProseSave(prose: { background: string; goal: string }, onSaved: () => void): void
  onGoalChecksSave(goalChecks: MatterGoalCheck[], onSaved?: () => void): void
}): React.ReactElement {
  const { t } = useTranslation()
  const fieldId = useId()
  const [proseEditing, setProseEditing] = useState(false)
  const [proseDraft, setProseDraft] = useState(() => ({
    background: matter.background,
    goal: matter.goal
  }))
  const [addingGoalCheck, setAddingGoalCheck] = useState(false)
  const [goalCheckDraft, setGoalCheckDraft] = useState('')
  const goalChecks = matter.goal_checks ?? []
  const doneGoalChecks = goalChecks.filter((check) => check.done).length
  const proseDirty = proseDraft.background !== matter.background || proseDraft.goal !== matter.goal

  const [prevProseSync, setPrevProseSync] = useState(() => ({
    editing: proseEditing,
    background: matter.background,
    goal: matter.goal
  }))
  if (
    prevProseSync.editing !== proseEditing ||
    prevProseSync.background !== matter.background ||
    prevProseSync.goal !== matter.goal
  ) {
    setPrevProseSync({
      editing: proseEditing,
      background: matter.background,
      goal: matter.goal
    })
    if (!proseEditing) setProseDraft({ background: matter.background, goal: matter.goal })
  }

  const saveGoalCheck = (): void => {
    const text = goalCheckDraft.trim()
    if (!text) {
      setGoalCheckDraft('')
      setAddingGoalCheck(false)
      return
    }
    onGoalChecksSave([...goalChecks, { t: text, done: false }], () => {
      setGoalCheckDraft('')
      setAddingGoalCheck(false)
    })
  }

  const setGoalCheckDone = (index: number, done: boolean): void => {
    onGoalChecksSave(
      goalChecks.map((check, candidateIndex) =>
        candidateIndex === index ? { ...check, done } : check
      )
    )
  }

  const removeGoalCheck = (index: number): void => {
    onGoalChecksSave(goalChecks.filter((_, candidateIndex) => candidateIndex !== index))
  }

  return (
    <section>
      {/* D8 —— 设计 matter-agent.jsx:277 `<RailLabel icon="target">背景与目标</RailLabel>`。 */}
      <MatterSectionLabel
        icon={<Target size={12} className="shrink-0 text-ink-fg-2" />}
        right={
          !proseEditing ? (
            <button
              type="button"
              onClick={() => setProseEditing(true)}
              className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
            >
              <Pencil size={12} />
              {t('matters.actions.edit')}
            </button>
          ) : null
        }
      >
        {t('matters.state.descriptionLabel')}
      </MatterSectionLabel>
      <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1/75">
        {proseEditing ? (
          <div className="space-y-4 p-4">
            <div>
              <label
                htmlFor={`${fieldId}-background`}
                className="mb-1 block text-meta font-medium text-ink-fg-3"
              >
                {t('matters.state.backgroundLabel')}
              </label>
              <textarea
                autoFocus
                id={`${fieldId}-background`}
                rows={4}
                value={proseDraft.background}
                onChange={(event) =>
                  setProseDraft((draft) => ({ ...draft, background: event.target.value }))
                }
                placeholder={t('matters.state.backgroundPlaceholder')}
                className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-goal`}
                className="mb-1 block text-meta font-medium text-ink-fg-3"
              >
                {t('matters.state.goalLabel')}
              </label>
              <textarea
                id={`${fieldId}-goal`}
                rows={3}
                value={proseDraft.goal}
                onChange={(event) =>
                  setProseDraft((draft) => ({ ...draft, goal: event.target.value }))
                }
                placeholder={t('matters.state.goalPlaceholder')}
                className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
              />
            </div>
            <p className="text-meta text-ink-fg-2">{t('matters.state.markdownHint')}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setProseDraft({ background: matter.background, goal: matter.goal })
                  setProseEditing(false)
                }}
                className="rounded-[var(--r-ctl)] px-2.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                {t('matters.actions.cancel')}
              </button>
              <button
                type="button"
                disabled={saving || !proseDirty}
                onClick={() => onProseSave(proseDraft, () => setProseEditing(false))}
                className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-aux font-medium text-accent-fg transition-[background-color,transform] duration-fast ease-standard hover:bg-coral-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 active:scale-[0.96] disabled:opacity-50"
              >
                {t('matters.actions.save')}
              </button>
            </div>
          </div>
        ) : matter.background || matter.goal ? (
          <>
            {matter.background ? (
              <div className="p-4">
                <h3 className="mb-1 text-meta font-medium text-ink-fg-3">
                  {t('matters.state.backgroundLabel')}
                </h3>
                <div className="[&_.mail-body_p:last-child]:mb-0">
                  <TranslatedBody text={matter.background} />
                </div>
              </div>
            ) : null}
            {matter.goal ? (
              <div
                className={cn('p-4', matter.background ? 'border-t border-ink-border-soft' : null)}
              >
                <h3 className="mb-1 text-meta font-medium text-ink-fg-3">
                  {t('matters.state.goalLabel')}
                </h3>
                <div className="[&_.mail-body_p:last-child]:mb-0">
                  <TranslatedBody text={matter.goal} />
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="p-4 text-body text-ink-fg-2">{t('matters.state.noDescription')}</p>
        )}
        {/* 设计 matter-agent.jsx:290 —— 完成标志是同一张卡的下半分区（`fg/0.022` 底 +
          上分隔线），不是卡里再套一个虚线框。 */}
        <div className="border-t border-ink-border-soft bg-ink-fg/[0.02] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-meta font-medium text-ink-fg-2">{t('matters.state.goalChecks')}</h3>
            {/* 0818 mockup 的 `Progress`：细条 + 「已完成 x / y」。原先是一颗 `x/y` 药丸
              —— 同一个事实，条形更快读出「还差多少」。数字用 tabular-nums 免得跳字宽。 */}
            <div className="flex items-center gap-2.5">
              <span className="h-1 w-24 overflow-hidden rounded-full bg-ink-3">
                <span
                  className="block h-full rounded-full bg-ok transition-[width] duration-base ease-standard"
                  style={{
                    width: `${goalChecks.length === 0 ? 0 : Math.round((doneGoalChecks / goalChecks.length) * 100)}%`
                  }}
                />
              </span>
              <span className="shrink-0 text-meta tabular-nums text-ink-fg-2">
                {t('matters.state.goalChecksCount', {
                  done: doneGoalChecks,
                  total: goalChecks.length
                })}
              </span>
            </div>
          </div>
          {goalChecks.length > 0 ? (
            <ul className="mt-2 space-y-0.5">
              {goalChecks.map((check, index) => (
                <MatterCheckRow
                  key={`${index}-${check.t}`}
                  done={check.done}
                  text={check.t}
                  disabled={saving}
                  onToggle={() => setGoalCheckDone(index, !check.done)}
                  action={
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => removeGoalCheck(index)}
                      aria-label={t('matters.actions.trash')}
                      className="shrink-0 rounded-[var(--r-ctl)] p-1.5 text-ink-fg-3 opacity-0 transition-[color,background-color,opacity] duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40 group-hover/check:opacity-100 group-focus-within/check:opacity-100"
                    >
                      <Trash2 size={12} />
                    </button>
                  }
                />
              ))}
            </ul>
          ) : null}
          {addingGoalCheck ? (
            <div className="mt-3 flex items-center gap-2">
              <Input
                autoFocus
                value={goalCheckDraft}
                disabled={saving}
                onChange={(event) => setGoalCheckDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveGoalCheck()
                  if (event.key === 'Escape') {
                    setGoalCheckDraft('')
                    setAddingGoalCheck(false)
                  }
                }}
                placeholder={t('matters.state.goalCheckPlaceholder')}
                aria-label={t('matters.state.goalChecks')}
                className="h-8 flex-1 px-2 text-body"
              />
              <button
                type="button"
                disabled={saving || !goalCheckDraft.trim()}
                onClick={saveGoalCheck}
                aria-label={t('matters.actions.save')}
                className="rounded-[var(--r-ctl)] p-1.5 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setGoalCheckDraft('')
                  setAddingGoalCheck(false)
                }}
                aria-label={t('matters.actions.cancel')}
                className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={saving}
              onClick={() => setAddingGoalCheck(true)}
              className={cn(
                'mt-3 rounded-[var(--r-ctl)] border border-dashed border-ink-border px-3 py-2 text-left text-aux text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-2 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50',
                goalChecks.length === 0 ? 'w-full' : 'inline-flex'
              )}
            >
              {t('matters.state.goalCheckAdd')}
            </button>
          )}
          {goalChecks.length > 0 && doneGoalChecks === goalChecks.length ? (
            <div className="mt-3 flex items-start gap-2 rounded-[var(--r-ctl)] border border-ok/25 bg-ok/10 px-3 py-2 text-aux text-ok">
              <CircleCheckBig size={13} className="mt-0.5 shrink-0" />
              <span>{t('matters.state.goalChecksAllDone')}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
