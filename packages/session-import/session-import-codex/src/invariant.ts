/** Package-owned invariant companion. @module @deepseek-ai/dsh-session-import-codex/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-session-import-codex'
export const name = 'session-import-codex-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['sessionImports'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
