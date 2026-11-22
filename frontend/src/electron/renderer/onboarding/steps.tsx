// Onboarding NEW-user wizard steps — barrel facade re-exporting from ./wizard/*.

/* eslint-disable react-refresh/only-export-components -- compatibility barrel
   re-exporting wizard step components, types, and helpers for OnboardingRoot & tests. */

export {
  buildCompleteConfig,
  collectSystemImapNames,
  type ConfigForm,
  type SubmitError
} from './wizard/types'
export {
  StepFDA,
  StepWelcome,
  type StepFdaProps,
  type StepWelcomeProps
} from './wizard/StepWelcomeAndFda'
export { StepBackend, type StepBackendProps } from './wizard/StepBackend'
export { StepConfig, type StepConfigProps } from './wizard/StepConfig'
export { StepFolders, type StepFoldersProps } from './wizard/StepFolders'
export {
  StepPlugins,
  StepSync,
  type StepPluginsProps,
  type StepSyncProps,
  type SyncState
} from './wizard/StepSyncAndPlugins'
export {
  StepAiModel,
  StepDone,
  type StepAiModelProps,
  type StepDoneProps
} from './wizard/StepAiAndDone'
