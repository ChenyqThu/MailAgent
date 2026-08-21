// task 08-20 Notion OAuth — 库选择器（Lane 3）。
//
// 什么时候出现：main 的库发现没能唯一确定「邮件库 + 日历库」（用户选了已有页面 /
// 授权范围里有多个候选 / 一个 database 挂多个 data source）→ phase=need_selection。
//
// 诚实性要求（design.md v2「UI 状态」）：
//   * 只列已授权到的候选，不让用户手填 ID；
//   * required 档缺字段的置灰**并列出缺哪些**（不是笼统一句「不可用」）；
//   * recommended 档缺失只黄字提示，**不挡选择**（那些字段只有可选功能才写）；
//   * 角色识别按 schema 签名，签名两边都不命中 → 「无法识别用途」，同样说清楚。
// 提交后 main 会重新校验一次（不信任 renderer 传值），这里的置灰只是提前告知。

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@shared/components/ui/radio-group'
import type { NotionDbCandidate } from '@shared/lib/notionOauthContract'

type Role = 'email' | 'calendar'

interface NotionDbSelectDialogProps {
  open: boolean
  candidates: NotionDbCandidate[]
  /** selectDatabases 在途（提交按钮转 busy）。 */
  busy: boolean
  /** main 重校验失败等的已本地化错误文案。 */
  errorText?: string | null
  onCancel: () => void
  onSubmit: (emailDbId: string, calendarDbId: string) => void
}

function CandidateRow({
  candidate,
  role,
  groupName
}: {
  candidate: NotionDbCandidate
  role: Role
  groupName: string
}): React.ReactElement {
  const { t } = useTranslation()
  const selectable = candidate.role === role && candidate.valid
  const id = `${groupName}-${candidate.id}`
  let reason: React.ReactNode = null
  if (!selectable) {
    if (candidate.role !== role) {
      reason = t('settings.accounts.notion.oauth.select.reason.otherRole', {
        defaultValue: '不是这一类的库（字段签名不匹配）'
      })
    } else if (candidate.missing.length > 0) {
      reason = t('settings.accounts.notion.oauth.select.reason.missing', {
        fields: candidate.missing.join('、'),
        defaultValue: '缺少必需字段：{fields}'
      })
    } else {
      reason = t('settings.accounts.notion.oauth.select.reason.unknown', {
        defaultValue: '无法识别用途：字段签名既不匹配邮件库也不匹配日历库'
      })
    }
  }

  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', !selectable && 'opacity-60')}>
      <RadioGroupItem value={candidate.id} id={id} disabled={!selectable} className="mt-1" />
      <div className="min-w-0 flex-1">
        <label
          htmlFor={id}
          className={cn(
            'block text-aux text-ink-fg',
            selectable ? 'cursor-pointer' : 'cursor-not-allowed'
          )}
        >
          {candidate.title ||
            t('settings.accounts.notion.oauth.select.untitled', { defaultValue: '（未命名）' })}
        </label>
        {reason ? <div className="text-meta text-fail mt-0.5 leading-relaxed">{reason}</div> : null}
        {selectable && candidate.warnings.length > 0 ? (
          <div className="text-meta text-warn mt-0.5 leading-relaxed">
            {t('settings.accounts.notion.oauth.select.warnings', {
              fields: candidate.warnings.join('、'),
              defaultValue: '缺少可选字段：{fields}（只影响 AI 分类等可选功能，可以先用）'
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function NotionDbSelectDialog({
  open,
  candidates,
  busy,
  errorText,
  onCancel,
  onSubmit
}: NotionDbSelectDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [emailId, setEmailId] = React.useState('')
  const [calendarId, setCalendarId] = React.useState('')

  // 候选换了（新一次授权）→ 清掉上一次的选择，避免提交一个不在本次列表里的 id。
  React.useEffect(() => {
    setEmailId('')
    setCalendarId('')
  }, [candidates])

  const canSubmit = emailId !== '' && calendarId !== '' && emailId !== calendarId && !busy

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('settings.accounts.notion.oauth.select.title', {
              defaultValue: '选择要使用的数据库'
            })}
          </DialogTitle>
          <DialogDescription>
            {t('settings.accounts.notion.oauth.select.description', {
              defaultValue:
                '下面是本次授权能访问到的数据库。各选一个：邮件同步写入邮件库，会议邀请写入日历库。'
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[52vh] overflow-y-auto scrollbar-thin flex flex-col gap-4">
          <div>
            <div className="text-aux font-medium text-ink-fg mb-1">
              {t('settings.accounts.notion.oauth.select.emailGroup', { defaultValue: '邮件库' })}
            </div>
            {candidates.length === 0 ? (
              <div className="text-meta text-ink-fg-2">
                {t('settings.accounts.notion.oauth.select.empty', {
                  defaultValue: '没有可用的候选。'
                })}
              </div>
            ) : (
              <RadioGroup value={emailId} onValueChange={setEmailId} className="gap-0">
                {candidates.map((c) => (
                  <CandidateRow key={c.id} candidate={c} role="email" groupName="notion-db-email" />
                ))}
              </RadioGroup>
            )}
          </div>

          <div>
            <div className="text-aux font-medium text-ink-fg mb-1">
              {t('settings.accounts.notion.oauth.select.calendarGroup', { defaultValue: '日历库' })}
            </div>
            {candidates.length === 0 ? (
              <div className="text-meta text-ink-fg-2">
                {t('settings.accounts.notion.oauth.select.empty', {
                  defaultValue: '没有可用的候选。'
                })}
              </div>
            ) : (
              <RadioGroup value={calendarId} onValueChange={setCalendarId} className="gap-0">
                {candidates.map((c) => (
                  <CandidateRow
                    key={c.id}
                    candidate={c}
                    role="calendar"
                    groupName="notion-db-calendar"
                  />
                ))}
              </RadioGroup>
            )}
          </div>
        </div>

        {errorText ? (
          <div
            role="alert"
            className="rounded-lg border border-fail/30 bg-fail/10 px-3 py-2 text-aux text-ink-fg-1"
          >
            {errorText}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('settings.accounts.notion.oauth.select.cancel', { defaultValue: '取消授权' })}
          </Button>
          <Button onClick={() => onSubmit(emailId, calendarId)} disabled={!canSubmit}>
            {t('settings.accounts.notion.oauth.select.confirm', { defaultValue: '使用所选数据库' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
