/** Package-owned invariant companion. @module @deepseek-ai/dsh-session-import-local/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-session-import-local'
export const name = 'session-import-local-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['sessionImportLocal'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
