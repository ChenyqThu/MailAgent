// chat-panel P4 Phase 03a — MailAgentDomainClient (AI SDK Gateway → Python serve-api).
//
// Composes domain-sliced method groups over a shared DomainHttpCore transport while
// preserving the public MailAgentDomainClient constructor/type, _req escape hatch,
// DomainError, DomainClientConfig, and all Domain* DTO types.

import { createAgentsMethods, type AgentsMethods } from './clientAgents'
import { createCalendarLibraryMethods, type CalendarLibraryMethods } from './clientCalendarLibrary'
import { DomainHttpCore, type DomainClientConfig } from './clientCore'
import { createEmailMethods, type EmailMethods } from './clientEmail'
import { createMattersMethods, type MattersMethods } from './clientMatters'
import { createOpsMethods, type OpsMethods } from './clientOps'

export { DomainError, DomainHttpCore, type DomainClientConfig } from './clientCore'
export * from './domainTypes'

type DomainClientMethods = MattersMethods &
  EmailMethods &
  OpsMethods &
  AgentsMethods &
  CalendarLibraryMethods

class MailAgentDomainClientImpl {
  private readonly http: DomainHttpCore
  protected readonly _req: DomainHttpCore['req']

  constructor(config: DomainClientConfig) {
    this.http = new DomainHttpCore(config)
    this._req = (...args) => this.http.req(...args)
    Object.assign(
      this,
      createMattersMethods(this.http),
      createEmailMethods(this.http),
      createOpsMethods(this.http),
      createAgentsMethods(this.http),
      createCalendarLibraryMethods(this.http)
    )
  }
}

export type MailAgentDomainClient = MailAgentDomainClientImpl & DomainClientMethods

export const MailAgentDomainClient = MailAgentDomainClientImpl as unknown as new (
  config: DomainClientConfig
) => MailAgentDomainClient
