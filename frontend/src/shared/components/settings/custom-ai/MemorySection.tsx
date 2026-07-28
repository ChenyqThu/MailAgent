// MemorySection — AI 记忆双开关（MAILAGENT_MEM0_CAPTURE / _RETRIEVAL，Lane 2 #8）
//
// 「AI 要不要记住我说的话」是隐私级用户意图。此前倒置：能选记忆抽取**模型**
// （MemoryCaptureModelSection）、却没有任何 UI 能把记忆本身关掉——只有会改 .env 的人
// 才关得了。这里补上两个开关，且**不**挂 standingDocsEditorEnabled 门（那是高级配置面
// 的显隐 flag；隐私开关必须无条件可见）。
//
// 两个键都默认 ON（2026-07-02 cutover，env 显式 false = 应急回退）→ EnvField defaultOn
// 让未设时如实显示为开。生效方式不同（CLAUDE.md 开关表）：
//   - CAPTURE：Electron main 进程 gateway 启动时 envBool 读一次 → restart-required
//     （默认 markRestartRequired，同 MAILAGENT_OPENNESS_WEB_TOOLS 先例）。
//   - RETRIEVAL：serve-api chat.py 每请求 dotenv_values 热读 .env → hotReload
//     （保存即生效，拉重启横幅反而是误导）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'

export function MemorySection(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Section
      title={t('settings.aiMemory.title', { defaultValue: 'AI 记忆' })}
      helper={t('settings.aiMemory.desc', {
        defaultValue:
          'AI 会把对话中你的持久偏好与事实（如「回复邮件永远用中文」）整理进一份本机记忆文件，让之后的对话不用重复交代。记忆只存在这台电脑上。'
      })}
    >
      <EnvField
        envKey="MAILAGENT_MEM0_CAPTURE"
        control="toggle"
        defaultOn
        label={t('settings.aiMemory.capture.label', { defaultValue: '自动记住对话中的偏好' })}
        helper={t('settings.aiMemory.capture.helper', {
          defaultValue:
            '每轮对话结束后在后台提取值得长期记住的信息并合并进记忆。关闭后 AI 不再从对话中学到任何新东西（已有记忆保留，可在下方身份文档中查看或编辑）。默认开启。'
        })}
      />
      <EnvField
        envKey="MAILAGENT_MEM0_RETRIEVAL"
        control="toggle"
        defaultOn
        hotReload
        label={t('settings.aiMemory.retrieval.label', { defaultValue: '对话中使用已有记忆' })}
        helper={t('settings.aiMemory.retrieval.helper', {
          defaultValue:
            '每轮对话把记忆内容提供给 AI 作背景。关闭后 AI 立即「失忆」——不再参考任何已记住的偏好（记忆文件本身不删除）。保存即生效。默认开启。'
        })}
      />
    </Section>
  )
}
