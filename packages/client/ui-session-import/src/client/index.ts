/** Browser Settings consumer for local-session import. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  SessionImportCaptureValue,
  SessionImportCommitValue,
  SessionImportDiscoverValue,
  SessionImportDiscardValue,
  SessionImportOptionsValue,
  SessionImportResult,
} from '@deepseek-ai/dsh-session-import-local/types'
import { SessionImportSection, type SessionImportSectionInjected } from './SessionImportSection.tsx'
import { en, zh } from './locales.ts'

export type { SessionImportSectionInjected, SessionImportSectionProps } from './SessionImportSection.tsx'
export type { SessionImportLocaleKey } from './locales.ts'

const NS = 'settings.sessionImport'
export const inject = ['slots', 'locale', 'remote', 'remote.sessionImportLocal', 'sessions']

/** Collapse the transport envelope into the business result the component owns. */
function remoteValue<T>(result: RemoteResult<SessionImportResult<T>>): SessionImportResult<T> {
  return result.ok
    ? result.value
    : { ok: false, error: { code: 'internal', message: 'Remote request failed.' } }
}

/** Register the Settings page over the generated Host Remote namespace. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-import: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): SessionImportSectionInjected => ({
    options: async signal => remoteValue<SessionImportOptionsValue>(
      await ctx.remote.sessionImportLocal.options(signal),
    ),
    discover: async (request, signal) => remoteValue<SessionImportDiscoverValue>(
      await ctx.remote.sessionImportLocal.discover(request, signal),
    ),
    capture: async (request, signal) => remoteValue<SessionImportCaptureValue>(
      await ctx.remote.sessionImportLocal.capture(request, signal),
    ),
    commit: async (request, signal) => remoteValue<SessionImportCommitValue>(
      await ctx.remote.sessionImportLocal.commit(request, signal),
    ),
    discard: async reservationId => remoteValue<SessionImportDiscardValue>(
      await ctx.remote.sessionImportLocal.discard({ reservationId }),
    ),
    openImported: async (sessionId) => {
      await ctx.sessions.refresh()
      ctx.sessions.open(sessionId as SessionId)
    },
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'session-import',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, SessionImportSection))
}
