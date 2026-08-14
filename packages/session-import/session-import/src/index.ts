/**
 * Service Definition and provider registry for foreign local-session import.
 * @module @deepseek-ai/dsh-session-import
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ForeignSessionProvider, ForeignSessionSourceKind } from './types.ts'

export * from './types.ts'
export * from './jsonl.ts'
export * from './sanitize.ts'
export * from './discovery.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionImports: SessionImportRegistry
  }
}

/** Registry of source-format providers. It performs no persistence or conversion. */
export class SessionImportRegistry extends Service {
  private readonly providers = new Map<ForeignSessionSourceKind, ForeignSessionProvider>()

  constructor(ctx: Context) {
    super(ctx, 'sessionImports')
  }

  /**
   * Register one source kind for the lifetime of the calling effect.
   * @param provider Provider implementation to register.
   * @returns Effect disposer that unregisters the provider.
   */
  registerProvider(provider: ForeignSessionProvider): () => void {
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: SessionImportRegistry) {
      if (this.providers.has(provider.sourceKind)) {
        throw new Error(`session-import: provider "${provider.sourceKind}" is already registered`)
      }
      this.providers.set(provider.sourceKind, provider)
      yield () => { this.providers.delete(provider.sourceKind) }
    }.bind(this), 'sessionImports.registerProvider()')
  }

  /**
   * Return one registered provider without choosing a fallback.
   * @param kind Exact source kind to resolve.
   * @returns The registered provider, or `undefined` when unavailable.
   */
  getProvider(kind: ForeignSessionSourceKind): ForeignSessionProvider | undefined {
    return this.providers.get(kind)
  }

  /**
   * Return source kinds in deterministic lexical order.
   * @returns Registered source kinds.
   */
  listProviders(): ForeignSessionSourceKind[] {
    return [...this.providers.keys()].sort()
  }
}

export default SessionImportRegistry
