import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'

/**
 * 「每轮提示词由哪几段拼成」的只读披露（0812 dogfood Lane C）。
 *
 * owner 打开全局配置只看到一个框，读成「预设完全没做」——真相是那个框只是**第一段**，
 * 后面还有服务端运行时拼进去的三段和事项自己那段。不说清楚，用户既不知道自己改的是哪一段，
 * 也不知道模型每轮其实拿到了什么。
 *
 * 🔴 权威 = `src/matters/run_spec.py::assemble_matter_spec` 的 `sections` 列表（按序）：
 *   `_task_contract()` → `_RUN_METHODOLOGY` → `_run_actions_section()` → `_snapshot_section()` →
 *   `_manifest_section()` →（可选）`【补充指引】`。
 * 下面的 `STEPS` 是那份列表的一一对应投影，**改一边必须改另一边**（run_spec.py 顶部 docstring
 * 也钉了这条反向指引）—— 少一段/顺序错，这块披露就在向 owner 说明一个不存在的 prompt。
 */

interface AssemblyStep {
  /** i18n key 后缀 —— `matters.globalAgent.assembly.steps.<id>.{name,body}` */
  id: string
  /** 这一段谁说了算：本框可改 / 运行时注入 / 事项自己填。 */
  origin: 'editable' | 'runtime' | 'perMatter'
}

/** 顺序 = prompt 里的真实拼接顺序。 */
const STEPS: readonly AssemblyStep[] = [
  { id: 'contract', origin: 'editable' },
  { id: 'method', origin: 'runtime' },
  { id: 'actions', origin: 'perMatter' },
  { id: 'snapshot', origin: 'runtime' },
  { id: 'manifest', origin: 'runtime' },
  { id: 'persona', origin: 'perMatter' }
]

const ORIGIN_CLASS: Record<AssemblyStep['origin'], string> = {
  editable: 'bg-coral/[0.14] text-coral',
  runtime: 'bg-ink-fg/[0.08] text-ink-fg-2',
  perMatter: 'bg-ai/[0.12] text-ai'
}

export function MatterPromptAssembly(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2/50 p-3">
      <p className="flex items-center gap-1.5 text-meta font-medium text-ink-fg-1">
        <Layers size={13} className="text-ink-fg-2" />
        {t('matters.globalAgent.assembly.title')}
      </p>
      <ol className="mt-2 space-y-1.5">
        {STEPS.map((step, index) => (
          <li key={step.id} className="flex gap-2 text-meta leading-5">
            <span className="w-4 shrink-0 text-right tabular-nums text-ink-fg-3">{index + 1}</span>
            <span className="min-w-0">
              <span className="font-medium text-ink-fg-1">
                {t(`matters.globalAgent.assembly.steps.${step.id}.name`)}
              </span>
              <span
                className={`ml-1.5 rounded-full px-1.5 py-px text-micro ${ORIGIN_CLASS[step.origin]}`}
              >
                {t(`matters.globalAgent.assembly.origin.${step.origin}`)}
              </span>
              <span className="ml-1 text-ink-fg-2">
                {t(`matters.globalAgent.assembly.steps.${step.id}.body`)}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
