// S2 W1 (task 07-02-s2-exec-skill-install) — ExecApprovalCard (run_command / file_read / file_write).
//
// The edit-tier approval card for the local exec tools. It shows the EXACT command / file the model
// proposes (so the user reviews precisely what will run — there is NO sandbox once approved) plus a
// "总是允许" affordance: ticking it and approving asks the gateway to derive a full-PIN structured
// whitelist rule from THIS approved action (POST /api/ai/policy/remember → the owner policy API), so a
// matching future run skips the card. Rule creation is an OWNER action only — no tool can reach it.
//
// 🔴 "总是允许" is best-effort: if the rule creation fails, the approval STILL proceeds (the user
//    already decided to run this once) — the whitelist just isn't created, so next time it asks again.
//    A failed run gets no rule (only a successful approve path fires it); reject never creates a rule.

import { useState } from 'react'
import { Terminal, FileText, FilePenLine } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type ExecApprovalCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner, deriveCardPhase } from '../_cardShell'
import { resolveAiGatewayBaseUrl } from '../../runtime/flags'

/** POST the "always allow" to the gateway (POST /api/ai/policy/remember). The gateway peeks the
 *  pending exec approval (the SAME approved argv/cwd/path, so the model can't forge a broader rule),
 *  derives a full-PIN structured whitelist rule, and persists it (owner action — no tool can reach
 *  this). Throws the typed error code on failure; the caller treats a failure as best-effort. Local
 *  (not exported) — one consumer, keeps this component file free of shared non-component exports. */
async function postRememberExecPolicy(toolCallId: string): Promise<void> {
  const base = resolveAiGatewayBaseUrl()
  // '' (same-origin web proxy) is a VALID base but falsy — null-check explicitly, never `!base`.
  if (base == null) throw new Error('E_NO_GATEWAY')
  const res = await fetch(`${base}/api/ai/policy/remember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId })
  })
  if (!res.ok) {
    let code = `E_HTTP_${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) code = body.error
    } catch {
      /* non-JSON error body — keep the status code */
    }
    throw new Error(code)
  }
}

const TITLES: Record<string, string> = {
  run_command: '运行本机命令',
  file_read: '读取本机文件',
  file_write: '写入本机文件'
}

function iconFor(kind: string): React.ReactNode {
  if (kind === 'file_read') return <FileText size={13} strokeWidth={2} />
  if (kind === 'file_write') return <FilePenLine size={13} strokeWidth={2} />
  return <Terminal size={13} strokeWidth={2} />
}

function propsOf(toolName: string, args: unknown, result: unknown): ExecApprovalCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    kind: 'run_command',
    summary: '执行本机操作'
  }) as unknown as ExecApprovalCardProps
}

/** The "always allow" hint by kind — run pins the exact command, file pins the parent directory. */
const ALLOW_HINT: Record<string, string> = {
  run_command: '总是允许运行这条完全一致的命令（免审批）',
  file_read: '总是允许读取该文件所在目录下的文件（免审批）',
  file_write: '总是允许写入该文件所在目录下的文件（免审批）'
}

/** The Chinese lead-in label by kind (rendered at text-aux — CN never at mono/meta size). */
const PROMPT_LABEL: Record<string, string> = {
  run_command: '将在本机运行以下命令（批准后无沙箱，以你的权限执行）：',
  file_read: '将读取以下本机文件：',
  file_write: '将写入以下本机文件：'
}

/** The mono line (command / path — never CJK) shown under the label. */
function monoLine(data: ExecApprovalCardProps): string {
  if (data.kind === 'run_command') return data.argv?.join(' ') || '(空)'
  return data.path ?? '?'
}

export function ExecApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, toolCallId, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const title = TITLES[toolName] ?? '本机操作确认'
  const [alwaysAllow, setAlwaysAllow] = useState(false)

  const onApprove = async (): Promise<void> => {
    if (alwaysAllow) {
      // Best-effort: a whitelist-creation failure must NOT block the run the user approved.
      try {
        await postRememberExecPolicy(toolCallId)
      } catch {
        /* rule not created (e.g. gateway hiccup) → next time it asks again; proceed with the run */
      }
    }
    respondToApproval({ approved: true })
  }
  const onReject = (): void => respondToApproval({ approved: false })

  return (
    <CardFrame icon={iconFor(data.kind)} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">
            {PROMPT_LABEL[data.kind] ?? '将执行本机操作：'}
          </div>
          <div className="mt-1 break-all font-mono text-meta text-ink-fg">{monoLine(data)}</div>
          {data.kind === 'run_command' && data.cwd ? (
            <div className="mt-0.5 break-all font-mono text-meta text-ink-fg-3">{data.cwd}</div>
          ) : null}
          {data.kind === 'file_write' && data.mode ? (
            <div className="mt-0.5 text-aux text-ink-fg-3">{`写入模式：${data.mode}`}</div>
          ) : null}
          <div className="mt-2 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-2">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={alwaysAllow}
                onChange={(e) => setAlwaysAllow(e.target.checked)}
                className="mt-0.5 size-3.5 shrink-0 accent-[rgb(var(--c-accent))]"
              />
              <span className="text-aux text-ink-fg-2">
                {ALLOW_HINT[data.kind] ?? '总是允许该操作（免审批）'}
                <span className="mt-0.5 block text-ink-fg-3">
                  仅对你信任的操作勾选：本机执行没有沙箱。
                </span>
              </span>
            </label>
          </div>
          <ApprovalActions onApprove={onApprove} onReject={onReject} approveLabel="允许并运行" />
        </>
      ) : phase === 'done' ? (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{monoLine(data)}</div>
          {typeof data.exitCode === 'number' || typeof data.bytesWritten === 'number' ? (
            <div className="mt-0.5 text-aux text-ink-fg-2">
              {typeof data.exitCode === 'number' ? `退出码 ${data.exitCode}` : ''}
              {typeof data.bytesWritten === 'number' ? `已写入 ${data.bytesWritten} 字节` : ''}
            </div>
          ) : null}
        </>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">操作失败，请重试或让助手重新发起。</div>
      ) : (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{monoLine(data)}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
