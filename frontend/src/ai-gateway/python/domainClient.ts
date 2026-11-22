// chat-panel P4 Phase 03a — MailAgentDomainClient (AI SDK Gateway → Python serve-api).
//
// Preserves the public facade for MailAgentDomainClient, DomainError, DomainClientConfig, and
// all Domain* DTO types across domain-sliced implementation layers.

import { CalendarLibraryDomainClient } from './clientCalendarLibrary'

export { DomainError, type DomainClientConfig } from './clientCore'
export * from './domainTypes'

export class MailAgentDomainClient extends CalendarLibraryDomainClient {}
