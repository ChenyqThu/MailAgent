// submit_feedback（task 08-27-l4-tab-workspace P4a）—— 主 Agent 代 owner 向产品反馈库提交一条反馈。
//
// 用户在对话里说「这个有 bug」，模型把上下文整理成一条反馈；提交面与设置里那个反馈弹窗
// 是同一条链路（shared/feedback/contract.ts 的 submitFeedbackToNotion），不是第二套。
//
// 🔴 恒 HITL，**不给「以后都自动」**。对外发送属于安全地板那一档（与 run_command 无白名单
//    命中、skill 安装同级），所以：
//      · tool_class = 'outbound'（policy.ts）→ 只在 manual_chat 注册，headless 结构上拿不到，
//        且 outbound 没有 grants key，永远不可能被 per-agent grant 放宽；
//      · 本工厂**不接** policyEvaluate → 没有白名单 / 免卡通道；
//      · tool_prefs.py 里 configurable=False、default ask → owner 在设置里也调不成 auto。
//    （notion_agent_chat / email_prepare_send 的同款姿态。）
//
// 🔴 卡上三个按钮 = 改一改 / 不发 / 发送。「改一改」靠 editableFields 走 04a 的 resolve
//    侧信道：卡里改完 kind/title/detail/freq，执行的是**改后的** payload —— agent 整理的
//    措辞未必对，只有「发 / 不发」两档不够用。
//
// 🔴 截图恒无：agent 截不了图，schema 里根本没有截图字段（诊断包也由主进程按
//    attach_diagnostics 自己组装，模型不经手文件内容）。
//
// 提交本身由注入的 `submit` 完成（主进程实现：拼 UA + 组诊断包 + 落台账）。工厂只拿一个
// 函数，所以 pure-Node harness 与单测能在零网络下驱动整条审批链。

import type { Tool } from 'ai'

import type { ApprovalGuard } from '../security/approval'
import { auditedWriteTool, type GatewayApprovalMode, type GatewayToolAuditCollector } from './types'
import type { AgentContextMode } from './policy'
// RELATIVE import（不是 @shared）—— 同 web.ts / calendar.ts：pure-Node harness 要能加载。
import { sanitizeProse } from '../../shared/assistant/context/contextSerializer'
import { submitFeedbackSchema, type SubmitFeedbackInput } from './schemas'

/** 名字数组 —— 测试与 eval catalog 完整性闸靠静态抽取每个 GATEWAY_*_TOOL_NAMES。 */
export const GATEWAY_FEEDBACK_TOOL_NAMES = ['submit_feedback'] as const

/** 主进程注入的提交实现。返回回执编号；失败抛（错误直达模型，它会如实告诉用户没发出去）。 */
export type FeedbackSubmitFn = (
  input: SubmitFeedbackInput,
  signal?: AbortSignal
) => Promise<{ submissionBlockId: string }>

const SUBMIT_FEEDBACK_DESCRIPTION =
  'Submit ONE product-feedback entry (bug report / suggestion / question) to the MailAgent ' +
  'feedback database on the user’s behalf. Use it when the user reports a defect or asks for a ' +
  'feature and wants it passed on — never to take notes for yourself. Write `title` and `detail` ' +
  'in the user’s own language, summarising what THEY described (include reproduction steps and ' +
  'the observed vs expected behaviour when known). `freq` only applies to kind=问题. Set ' +
  '`attach_diagnostics` for a reproducible defect: the app builds a redacted log bundle ' +
  '(last 7 days, no email bodies / attachments / contacts) — it takes about a minute. You cannot ' +
  'attach a screenshot (you cannot see the screen); say so if the user asks for one. This sends ' +
  'data OFF this machine, so the user must approve it every time — the approval card lets them ' +
  'edit the wording before it goes. Edit tier — always asks, and it can never be made automatic.'

/**
 * Build the submit_feedback tool. 恒 HITL edit-tier；无 policyEvaluate（无免卡通道），
 * editableFields 开放给审批卡的「改一改」。
 */
export function createFeedbackTools(
  submit: FeedbackSubmitFn,
  collector: GatewayToolAuditCollector = [],
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    /** 🔴 只有字面 'bypass'（owner 全局模式，服务端注入、manual 限定）能免卡 —— 与
     *  notion_agent_chat / skill_install 同待遇。'auto-reversible' 对 edit tier 无效。 */
    approvalMode?: GatewayApprovalMode
    oneShot?: boolean
    contextMode?: AgentContextMode
  } = {}
): Record<string, Tool> {
  const submit_feedback = auditedWriteTool<SubmitFeedbackInput>(
    {
      a2uiEnabled: opts.a2uiEnabled,
      approvalMode: opts.approvalMode,
      // 🔴 有意不传 toolApprovalPrefs：per-tool 档对本工具无效（tool_prefs.py 里
      //    configurable=False），传进来只会给「以后都自动」留一条缝。
      oneShot: opts.oneShot,
      contextMode: opts.contextMode,
      name: 'submit_feedback',
      description: SUBMIT_FEEDBACK_DESCRIPTION,
      inputSchema: submitFeedbackSchema,
      risk: 'edit',
      // 「改一改」的四个字段。kind 可改是因为模型常把「建议」判成「问题」；email 不在
      // 列内 —— 那是 owner 的联系方式，不该由这张卡的侧信道改写。
      editableFields: ['kind', 'title', 'detail', 'freq'],
      run: async (input, { signal }) => {
        const { submissionBlockId } = await submit(input, signal)
        return {
          submitted: true,
          // 回执编号是服务端串 → 单行 prose sanitize（防伪造 token 夹带 fence 关闭符）。
          submission_id: sanitizeProse(submissionBlockId),
          kind: input.kind,
          title: input.title,
          // 说清是谁代发的：owner 在库里看到自己没印象的条目时不至于困惑。
          submitted_by: 'main_agent',
          // 提醒模型在回话里如实说明这两件事。
          screenshot_attached: false,
          diagnostics_attached: input.attach_diagnostics === true
        }
      }
    },
    collector,
    guard
  )

  return { submit_feedback }
}
