// Sprint 9 §2.1 — Island module barrel. Public surface for handlers + tests.
//
// Keep this module re-export-only. Logic lives in `envelope.ts` (pure
// builders), `sender.ts` (one-shot unix socket write+read) and `probe.ts`
// (connection liveness loop + IslandStatus).

export {
  buildAIDraftReady,
  buildAIDraftStart,
  buildAIDraftStream,
  buildAppearanceChange,
  buildPing,
  serializeEnvelope,
  swiftSentAt,
  type AIDraftReadyPayload,
  type AIDraftStartPayload,
  type AIDraftStreamPayload,
  type AppearanceChangePayload,
  type BridgeEnvelope,
  type IslandEventType,
  type IslandProvider,
  type IslandStatusKind
} from './envelope'

export {
  ProtocolError,
  resolveSocketPath,
  resolveTimeoutMs,
  sendEnvelope,
  __wire,
  type SendOpts,
  type SendOutcome,
  type SocketFactory,
  type SocketLike
} from './sender'

export {
  getIslandStatus,
  probeOnce,
  reportSendOutcome,
  setIslandEnabled,
  startProbeLoop,
  stopProbeLoop,
  subscribeIslandStatus,
  __resetForTesting,
  __testing,
  type IslandConnectionState,
  type IslandStatus,
  type IslandStatusListener,
  type StartProbeOpts
} from './probe'
