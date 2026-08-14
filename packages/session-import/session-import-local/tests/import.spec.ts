import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionImportRegistry, {
  ForeignSessionImportError,
  type ForeignSessionCaptureRequest,
  type ForeignSessionProvider,
  type ForeignSessionSnapshot,
} from '@deepseek-ai/dsh-session-import'
import { apply as applyRegistryInvariant } from '@deepseek-ai/dsh-session-import/invariant'
import LlmRuntime, { LlmAdapter, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSessionImportService, {
  convertForeignSnapshot,
  importedSessionId,
  type Config,
  type SessionImportCommitValue,
} from '../src/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const CONFIG: Config = {
  maxSourceBytes: 4 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxVisibleContextBytes: 2 * 1024 * 1024,
  maxVisibleMessages: 1_000,
  maxToolActivities: 100,
  maxDiscoveryItems: 500,
  maxReservations: 8,
  maxToolSummaryBytes: 64 * 1024,
}

const tempRoots: string[] = []
const COMMIT_TARGET = {
  workspaceId: 'workspace',
  agentPreset: 'preset',
  provider: 'provider',
  model: 'model',
} as const

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function waitForReservationReset(service: LocalSessionImportService, id: string): Promise<void> {
  const internal = service as unknown as {
    reservations: Map<string, { commit?: Promise<unknown> }>
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (internal.reservations.get(id)?.commit === undefined) return
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  throw new Error('reservation did not become retryable')
}

async function waitUntilFilesExist(paths: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    const ready = await Promise.all(paths.map(path => access(path).then(() => true, () => false)))
    if (ready.every(Boolean)) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error('independent import contenders did not reach the barrier')
}

function launchContender(args: {
  readonly backend: Backend
  readonly location: string
  readonly ready: string
  readonly go: string
  readonly index: number
}): Promise<{ ok: boolean; value?: SessionImportCommitValue; error?: { code: string } }> {
  const fixture = fileURLToPath(new URL('./fixtures/process-contender.ts', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', fixture, JSON.stringify(args)], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`independent contender failed with code ${String(code)}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as { ok: boolean; value?: SessionImportCommitValue; error?: { code: string } })
      } catch {
        reject(new Error('independent contender returned invalid metadata'))
      }
    })
  })
}

async function tempRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function snapshot(label: string): ForeignSessionSnapshot {
  return Object.freeze({
    provenance: Object.freeze({
      sourceKind: 'codex',
      sourceSessionId: `source-${label}`,
      sourceVersion: '1.0.0',
      capturedAt: 1_786_665_600_000,
      prefixDigest: createHash('sha256').update(label).digest('hex'),
      converterVersion: 'test-v1',
    }),
    sourceIdentity: `codex:1:2:source-${label}`,
    cwdHint: '/tmp/import-workspace',
    messages: Object.freeze([
      Object.freeze({ role: 'user' as const, text: 'token=sk-import-secret-1234567890' }),
      Object.freeze({ role: 'assistant' as const, text: 'Historical answer' }),
    ]),
    tools: Object.freeze([
      Object.freeze({ name: 'Read File', status: 'completed' as const }),
    ]),
    capturedBytes: 1024,
    contextBytes: 57,
    trailingPartialRecordIgnored: false,
  })
}

class StaticProvider implements ForeignSessionProvider {
  readonly sourceKind = 'codex' as const

  constructor(private readonly value: ForeignSessionSnapshot) {}

  discover(): Promise<[]> { return Promise.resolve([]) }

  capture(request: ForeignSessionCaptureRequest): Promise<ForeignSessionSnapshot> {
    request.signal?.throwIfAborted()
    return Promise.resolve(this.value)
  }
}

interface StubConfig {
  readonly workspacePath: string
  readonly attachFails?: boolean
}

class WorkspaceRegistryStub extends Service {
  private readonly row

  constructor(ctx: Context, config: StubConfig) {
    super(ctx, 'workspaceRegistry')
    this.row = {
      id: 'workspace',
      title: 'Import workspace',
      path: config.workspacePath,
      attachSession: (_id: string): Promise<void> => config.attachFails === true
        ? Promise.reject(new Error('accounting unavailable'))
        : Promise.resolve(),
    }
  }

  list(): readonly [typeof this.row] { return [this.row] }
}

class AgentPresetsStub extends Service {
  constructor(ctx: Context) { super(ctx, 'agentPresets') }

  list(): Promise<Array<{ id: string; name: string }>> {
    return Promise.resolve([{ id: 'preset', name: 'Test preset' }])
  }

  standingKeyFor(): Promise<{ agentPreset: string }> {
    return Promise.resolve({ agentPreset: 'preset' })
  }
}

class ImportModelAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'model', name: 'Import model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Import model',
      context: { contextWindow: 128_000 },
      defaultMaxTokens: 8_192,
    })
  }

  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type Backend = 'jsonl' | 'sqlite'

interface ImportHarness {
  readonly ctx: Context
  readonly reservationId: string
  readonly disposeImport: () => Promise<void>
  readonly disposePersistence: () => Promise<void>
  readonly dispose: () => Promise<void>
}

async function harness(
  backend: Backend,
  location: string,
  value: ForeignSessionSnapshot,
  options: {
    readonly attachFails?: boolean
    readonly workspacePath?: string
    readonly config?: Config
  } = {},
): Promise<ImportHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['provider'], new ImportModelAdapter())
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SessionImportRegistry)
  await ctx.plugin(WorkspaceRegistryStub, {
    workspacePath: options.workspacePath ?? '/tmp/import-workspace',
    ...options.attachFails === undefined ? {} : { attachFails: options.attachFails },
  })
  await ctx.plugin(AgentPresetsStub)
  const persistence = backend === 'jsonl'
    ? await ctx.plugin(JsonlSessionPersistence, { root: location, compression: 'none' })
    : await ctx.plugin(SqliteSessionPersistence, { path: location })
  ctx.sessionImports.registerProvider(new StaticProvider(value))
  const importer = await ctx.plugin(LocalSessionImportService, options.config ?? CONFIG)
  const captured = await ctx.sessionImportLocal.capture({
    sourceKind: 'codex',
    sourceSessionId: value.provenance.sourceSessionId,
  }, new AbortController().signal)
  if (!captured.ok) throw new Error(`capture failed: ${captured.error.code}`)
  const disposeImport = async (): Promise<void> => { await importer.dispose() }
  const disposePersistence = async (): Promise<void> => { await persistence.dispose() }
  return {
    ctx,
    reservationId: captured.value.reservationId,
    disposeImport,
    disposePersistence,
    dispose: async () => {
      await disposeImport()
      await disposePersistence()
    },
  }
}

async function race(backend: Backend, count: number, label: string): Promise<void> {
  const root = await tempRoot(`dsh-import-${backend}-`)
  const location = backend === 'jsonl' ? root : join(root, 'sessions.db')
  const value = snapshot(label)
  const harnesses: ImportHarness[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      harnesses.push(await harness(backend, location, value))
    }
    const results = await Promise.all(harnesses.map(item => item.ctx.sessionImportLocal.commit({
      reservationId: item.reservationId,
      workspaceId: 'workspace',
      agentPreset: 'preset',
      provider: 'provider',
      model: 'model',
    }, new AbortController().signal)))
    const successes = results.filter((result): result is { ok: true; value: SessionImportCommitValue } => result.ok)
    expect(successes).toHaveLength(count)
    expect(new Set(successes.map(result => result.value.sessionId))).toEqual(new Set([String(importedSessionId(value))]))
    expect(successes.filter(result => !result.value.existing)).toHaveLength(1)

    const inspection = await harnesses[0]!.ctx.sessionPersistence.inspect(importedSessionId(value))
    expect(inspection.events[0]?.type).toBe('session/imported')
    expect(inspection.events.at(-1)?.type).toBe('session/end-seed')
    expect(inspection.events.map(event => event.seq)).toEqual(
      inspection.events.map((_event, index) => index),
    )
    const serialized = JSON.stringify(inspection)
    expect(serialized).toContain('[REDACTED CREDENTIAL]')
    expect(serialized).not.toContain('import-secret-1234567890')
    expect(serialized).not.toContain(value.sourceIdentity)
  } finally {
    await Promise.all(harnesses.map(item => item.dispose()))
  }
}

describe('local session import', () => {
  it('registers providers with duplicate protection, deterministic listing, and disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionImportRegistry)
    const provider = new StaticProvider(snapshot('registry'))
    const dispose = ctx.sessionImports.registerProvider(provider)
    expect(ctx.sessionImports.getProvider('codex')).toBe(provider)
    expect(ctx.sessionImports.getProvider('claude-code')).toBeUndefined()
    expect(ctx.sessionImports.listProviders()).toEqual(['codex'])
    expect(() => ctx.sessionImports.registerProvider(provider)).toThrow(/already registered/)
    dispose()
    await Promise.resolve()
    expect(ctx.sessionImports.listProviders()).toEqual([])

    const invariantDispose = () => {}
    const register = (name: string, install: (() => void) & { inject?: string[] }): (() => void) => {
      expect(name).toBe('@deepseek-ai/dsh-session-import')
      expect(install.inject).toEqual(['sessionImports'])
      install()
      return invariantDispose
    }
    await expect(applyRegistryInvariant({ invariants: { register } } as never)).resolves.toBe(invariantDispose)
    await ctx.fiber.dispose()
  })

  it('converts a neutral snapshot into a detached balanced seed without source identity or secrets', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const value = snapshot('converter')
    const id = importedSessionId(value)
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: value.provenance.capturedAt,
      cwd: '/tmp/import-workspace',
      agentPreset: 'preset',
    }
    const raw = convertForeignSnapshot(value, header, CONFIG.maxToolSummaryBytes, {
      provider: 'provider', model: 'model', contextWindow: 128_000, maxTokens: 8_192,
    })
    const prepared = ctx.sessions.prepare(id, { seed: raw, meta: header })

    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(prepared.events[0]?.type).toBe('session/imported')
    expect(prepared.events.at(-1)?.type).toBe('session/end-seed')
    expect(prepared.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(prepared.events.filter(event => event.type === 'tool/call')).toHaveLength(0)
    const serialized = JSON.stringify(prepared.events)
    expect(serialized).toContain('Imported historical tool activity; inert metadata only')
    expect(serialized).toContain('[REDACTED CREDENTIAL]')
    expect(serialized).not.toContain('import-secret-1234567890')
    expect(serialized).not.toContain(value.sourceIdentity)
  })

  it('converts tool-free interrupted history and rejects an oversized inert tool summary', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const base = snapshot('converter-edges')
    const value: ForeignSessionSnapshot = {
      ...base,
      messages: [{ role: 'assistant', text: 'Interrupted answer', interrupted: true }],
      tools: [],
    }
    const id = importedSessionId(value)
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: value.provenance.capturedAt,
      cwd: '/tmp/import-workspace',
      agentPreset: 'preset',
    }
    const raw = convertForeignSnapshot(value, header, CONFIG.maxToolSummaryBytes, {
      provider: 'provider', model: 'model', contextWindow: 128_000,
      tools: [{ name: 'safe_tool', description: 'Safe tool', parameters: { type: 'object' } }],
    })
    const prepared = ctx.sessions.prepare(id, { seed: raw, meta: header })
    const turnEnd = prepared.events.find(event => event.type === 'turn/end')
    expect(turnEnd).toMatchObject({ data: { reason: { kind: 'aborted' } } })

    const unnamed: ForeignSessionSnapshot = {
      ...base,
      tools: [{ name: '', status: 'unknown' }],
    }
    const withUnknown = convertForeignSnapshot(unnamed, header, CONFIG.maxToolSummaryBytes, {
      provider: 'provider', model: 'model', contextWindow: 128_000,
    })
    expect(JSON.stringify(withUnknown)).toContain('- unknown: unknown')
    expect(() => convertForeignSnapshot(base, header, 1, {
      provider: 'provider', model: 'model', contextWindow: 128_000,
    })).toThrow(/tool summary exceeds/)
  })

  for (const backend of ['jsonl', 'sqlite'] as const) {
    for (const count of [2, 10, 100]) {
      it(`${backend} publishes one complete deterministic session under ${count}-way contention`, {
        timeout: 60_000,
      }, async () => {
        await race(backend, count, `${backend}-${count}`)
      })
    }
  }

  for (const backend of ['jsonl', 'sqlite'] as const) {
    it(`${backend} publishes one complete session across independent Node processes`, {
      timeout: 60_000,
    }, async () => {
      const root = await tempRoot(`dsh-import-process-${backend}-`)
      const location = backend === 'jsonl' ? join(root, 'store') : join(root, 'sessions.db')
      const go = join(root, 'go')
      const ready = Array.from({ length: 6 }, (_, index) => join(root, `ready-${index}`))
      const contenders: Array<ReturnType<typeof launchContender>> = []
      for (const [index, readyPath] of ready.entries()) {
        const contender = launchContender({ backend, location, ready: readyPath, go, index })
        contenders.push(contender)
        // Let every process finish persistence setup before starting the next
        // one. The shared barrier below still makes all six commits contend.
        await Promise.race([waitUntilFilesExist([readyPath]), contender])
      }
      await writeFile(go, 'go')
      const results = await Promise.all(contenders)
      expect(results.every(result => result.ok), JSON.stringify(results)).toBe(true)
      expect(results.filter(result => result.value?.existing === false)).toHaveLength(1)
      expect(new Set(results.map(result => result.value?.sessionId))).toHaveLength(1)
    })
  }

  it('keeps a failed workspace attachment non-destructive and reports the limitation', async () => {
    const root = await tempRoot('dsh-import-attach-')
    const value = snapshot('attach-failure')
    const item = await harness('jsonl', root, value, { attachFails: true })
    try {
      const result = await item.ctx.sessionImportLocal.commit({
        reservationId: item.reservationId,
        workspaceId: 'workspace',
        agentPreset: 'preset',
        provider: 'provider',
        model: 'model',
      }, new AbortController().signal)
      expect(result).toEqual({
        ok: true,
        value: { sessionId: String(importedSessionId(value)), existing: false, workspaceAttached: false },
      })
      const persisted = await item.ctx.sessionPersistence.inspect(importedSessionId(value))
      expect(persisted.events.at(-1)?.type).toBe('session/end-seed')
    } finally {
      await item.dispose()
    }
  })

  it('does not reserve or publish an already-cancelled capture', async () => {
    const root = await tempRoot('dsh-import-cancel-')
    const value = snapshot('cancelled')
    const item = await harness('jsonl', root, value)
    try {
      const controller = new AbortController()
      controller.abort()
      const result = await item.ctx.sessionImportLocal.capture({
        sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
      }, controller.signal)
      expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      await expect(item.ctx.sessionPersistence.inspect(importedSessionId(value))).rejects.toThrow()
    } finally {
      await item.dispose()
    }
  })

  it('keeps a shared commit alive for a second caller when the first caller cancels', async () => {
    const root = await tempRoot('dsh-import-shared-cancel-')
    const value = snapshot('shared-cancel')
    const item = await harness('jsonl', root, value)
    try {
      const request = {
        reservationId: item.reservationId,
        workspaceId: 'workspace',
        agentPreset: 'preset',
        provider: 'provider',
        model: 'model',
      }
      const cancelled = new AbortController()
      const survivor = new AbortController()
      const first = item.ctx.sessionImportLocal.commit(request, cancelled.signal)
      const second = item.ctx.sessionImportLocal.commit(request, survivor.signal)
      cancelled.abort()

      await expect(first).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
      await expect(second).resolves.toMatchObject({
        ok: true,
        value: { sessionId: String(importedSessionId(value)) },
      })
      const persisted = await item.ctx.sessionPersistence.inspect(importedSessionId(value))
      expect(persisted.events.at(-1)?.type).toBe('session/end-seed')
    } finally {
      await item.dispose()
    }
  })

  it('waits for a sole cancelled commit to become quiescent before returning', async () => {
    const root = await tempRoot('dsh-import-sole-cancel-')
    const value = snapshot('sole-cancel')
    const item = await harness('jsonl', root, value, {
      config: Object.assign({}, CONFIG, { maxReservations: 1 }),
    })
    try {
      const appendStarted = deferred<true>()
      const releaseAppend = deferred<true>()
      const append = item.ctx.sessionPersistence.append.bind(item.ctx.sessionPersistence)
      const publication = vi.spyOn(item.ctx.sessionPersistence, 'append')
        .mockImplementationOnce(async (id, events) => {
          appendStarted.resolve(true)
          await releaseAppend.promise
          await append(id, events)
        })
      const workspace = item.ctx.workspaceRegistry.list()[0]!
      const attach = vi.spyOn(workspace, 'attachSession')
      const controller = new AbortController()
      const committing = item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, controller.signal)
      await appendStarted.promise

      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET,
        workspaceId: 'other',
        reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'target-conflict' },
      })
      expect(item.ctx.sessionImportLocal.discard({ reservationId: item.reservationId }))
        .toEqual({ ok: true, value: { discarded: false } })
      await expect(item.ctx.sessionImportLocal.capture({
        sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'internal' },
      })

      controller.abort()
      let returned = false
      void committing.then(() => { returned = true })
      await Promise.resolve()
      expect(returned).toBe(false)
      releaseAppend.resolve(true)
      await expect(committing).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
      const persisted = await item.ctx.sessionPersistence.inspect(importedSessionId(value))
      expect(persisted.events.at(-1)?.type).toBe('session/end-seed')
      expect(publication).toHaveBeenCalledOnce()
      expect(attach).not.toHaveBeenCalled()
      await waitForReservationReset(item.ctx.sessionImportLocal, item.reservationId)

      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: true, value: { existing: true, workspaceAttached: true },
      })
      expect(attach).toHaveBeenCalledOnce()
    } finally {
      await item.dispose()
    }
  })

  it('contains an unexpected commit promise rejection and permits an exact retry', async () => {
    const root = await tempRoot('dsh-import-commit-reject-')
    const value = snapshot('commit-reject')
    const item = await harness('jsonl', root, value)
    try {
      const service = item.ctx.sessionImportLocal as unknown as {
        commitReservation: (...args: unknown[]) => Promise<never>
      }
      const failure = vi.spyOn(service, 'commitReservation').mockRejectedValueOnce(new Error('private failure'))
      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'internal' },
      })
      await waitForReservationReset(item.ctx.sessionImportLocal, item.reservationId)
      failure.mockRestore()
      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({ ok: true })
    } finally {
      await item.dispose()
    }
  })

  it('returns current targets and model-specific budgets, with cancellable option loading', async () => {
    const root = await tempRoot('dsh-import-options-')
    const item = await harness('jsonl', root, snapshot('options'))
    try {
      const result = await item.ctx.sessionImportLocal.options(new AbortController().signal)
      expect(result).toMatchObject({
        ok: true,
        value: {
          sourceKinds: ['codex'],
          workspaces: [{ id: 'workspace' }],
          presets: [{ id: 'preset' }],
          models: [{ provider: 'provider', model: 'model', contextWindow: 128_000 }],
        },
      })
      const cancelled = new AbortController()
      cancelled.abort()
      await expect(item.ctx.sessionImportLocal.options(cancelled.signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    } finally {
      await item.dispose()
    }
  })

  it('filters broken presets and model routes whose metadata cannot establish a safe budget', async () => {
    const root = await tempRoot('dsh-import-options-filter-')
    const item = await harness('jsonl', root, snapshot('options-filter'))
    try {
      vi.spyOn(item.ctx.agentPresets, 'list').mockResolvedValueOnce([
        { id: 'bare' },
        { id: 'broken', name: 'Broken', broken: 'invalid' },
      ] as never)
      vi.spyOn(item.ctx.llm, 'listProviders').mockReturnValue([
        { id: 'list-fails', name: 'List fails' },
        { id: 'resolve-fails', name: 'Resolve fails' },
        { id: 'unknown', name: 'Unknown' },
        { id: 'tiny', name: 'Tiny' },
        { id: 'provider', name: 'Working' },
      ] as never)
      vi.spyOn(item.ctx.llm, 'listModels').mockImplementation(async (provider) => {
        if (provider === 'list-fails') throw new Error('unavailable')
        return [{ provider, id: 'model', name: 'Model' }]
      })
      vi.spyOn(item.ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, model) => {
        if (provider === 'resolve-fails') throw new Error('unavailable')
        if (provider === 'unknown') return { provider, id: model, name: 'Unknown' }
        if (provider === 'tiny') {
          return { provider, id: model, name: 'Tiny', context: { contextWindow: 4_096 }, defaultMaxTokens: 1 }
        }
        return {
          provider, id: model, name: 'Working', context: { contextWindow: 128_000 }, defaultMaxTokens: 8_192,
        }
      })

      const result = await item.ctx.sessionImportLocal.options(new AbortController().signal)
      expect(result).toMatchObject({
        ok: true,
        value: {
          presets: [{ id: 'bare', name: 'bare' }],
          models: [{ provider: 'provider', model: 'model' }],
        },
      })
    } finally {
      await item.dispose()
    }
  })

  it('bounds and validates discovery without returning provider paths or bodies', async () => {
    const root = await tempRoot('dsh-import-discover-')
    const value = snapshot('discover')
    const item = await harness('jsonl', root, value)
    try {
      await expect(item.ctx.sessionImportLocal.discover({ sourceKind: 'claude-code' }, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'provider-unavailable' } })
      const provider = item.ctx.sessionImports.getProvider('codex')!
      const discover = vi.spyOn(provider, 'discover')
      discover.mockResolvedValueOnce([{
        sourceKind: 'codex', sourceSessionId: 'safe-id', sizeBytes: 1, modifiedAt: 1,
      }])
      await expect(item.ctx.sessionImportLocal.discover({ sourceKind: 'codex' }, new AbortController().signal))
        .resolves.toMatchObject({ ok: true, value: { items: [{ sourceSessionId: 'safe-id' }] } })
      discover.mockResolvedValueOnce(Array.from({ length: CONFIG.maxDiscoveryItems + 1 }, (_, index) => ({
        sourceKind: 'codex' as const, sourceSessionId: `id-${index}`, sizeBytes: 1, modifiedAt: 1,
      })))
      await expect(item.ctx.sessionImportLocal.discover({ sourceKind: 'codex' }, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'source-too-large' } })
      discover.mockResolvedValueOnce([{
        sourceKind: 'codex', sourceSessionId: 'bad value', sizeBytes: 1, modifiedAt: 1,
      }])
      await expect(item.ctx.sessionImportLocal.discover({ sourceKind: 'codex' }, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'source-corrupt' } })
      discover.mockRejectedValueOnce(new Error('/private/path sk-secret-body'))
      const failed = await item.ctx.sessionImportLocal.discover({ sourceKind: 'codex' }, new AbortController().signal)
      expect(failed).toMatchObject({ ok: false, error: { code: 'internal' } })
      expect(JSON.stringify(failed)).not.toContain('/private/path')
      expect(JSON.stringify(failed)).not.toContain('secret-body')
    } finally {
      await item.dispose()
    }
  })

  it('rejects empty, malformed, unavailable, and provider-failed captures without reservations', async () => {
    const root = await tempRoot('dsh-import-capture-failures-')
    const value = snapshot('capture-failures')
    const item = await harness('jsonl', root, value)
    try {
      await expect(item.ctx.sessionImportLocal.capture({
        sourceKind: 'claude-code', sourceSessionId: value.provenance.sourceSessionId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'provider-unavailable' },
      })
      const provider = item.ctx.sessionImports.getProvider('codex')!
      const capture = vi.spyOn(provider, 'capture')
      const { cwdHint: _cwdHint, ...withoutCwdHint } = value
      capture.mockResolvedValueOnce(withoutCwdHint)
      await expect(item.ctx.sessionImportLocal.capture({
        sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: true, value: { sourceSessionId: value.provenance.sourceSessionId },
      })
      capture.mockResolvedValueOnce({ ...value, messages: [], tools: [] })
      await expect(item.ctx.sessionImportLocal.capture({
        sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
      }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'source-corrupt' } })

      const invalids: ForeignSessionSnapshot[] = [
        { ...value, provenance: { ...value.provenance, sourceKind: 'claude-code' } },
        { ...value, provenance: { ...value.provenance, sourceSessionId: '../bad' } },
        { ...value, provenance: { ...value.provenance, sourceVersion: 'bad value' } },
        { ...value, provenance: { ...value.provenance, converterVersion: 'bad value' } },
        { ...value, provenance: { ...value.provenance, prefixDigest: 'bad' } },
        { ...value, sourceIdentity: '' },
        { ...value, cwdHint: 'relative' },
        { ...value, capturedBytes: CONFIG.maxSourceBytes + 1 },
        { ...value, contextBytes: CONFIG.maxVisibleContextBytes + 1 },
        { ...value, messages: [{ role: 'system' as never, text: 'x' }] },
        { ...value, tools: [{ name: 'x', status: 'bad' as never }] },
      ]
      for (const invalid of invalids) {
        capture.mockResolvedValueOnce(invalid)
        await expect(item.ctx.sessionImportLocal.capture({
          sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
        }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'source-corrupt' } })
      }
      capture.mockRejectedValueOnce(new ForeignSessionImportError(
        'source-not-found', 'codex', 2, 'codex record 2 is unavailable',
      ))
      await expect(item.ctx.sessionImportLocal.capture({
        sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
      }, new AbortController().signal)).resolves.toEqual({
        ok: false,
        error: { code: 'source-not-found', sourceKind: 'codex', record: 2, message: 'codex record 2 is unavailable' },
      })
      capture.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      await expect(item.ctx.sessionImportLocal.capture({
        sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
      }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    } finally {
      await item.dispose()
    }
  })

  it('waits for an in-flight commit during disposal and starts no post-unload attachment', async () => {
    const root = await tempRoot('dsh-import-disposed-')
    const value = snapshot('disposed')
    const item = await harness('jsonl', root, value)
    const service = item.ctx.sessionImportLocal
    try {
      const appendStarted = deferred<true>()
      const releaseAppend = deferred<true>()
      const append = item.ctx.sessionPersistence.append.bind(item.ctx.sessionPersistence)
      vi.spyOn(item.ctx.sessionPersistence, 'append').mockImplementationOnce(async (id, events) => {
        appendStarted.resolve(true)
        await releaseAppend.promise
        await append(id, events)
      })
      const attach = vi.spyOn(item.ctx.workspaceRegistry.list()[0]!, 'attachSession')
      const committing = service.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)
      await appendStarted.promise

      const disposing = item.disposeImport()
      let disposed = false
      void disposing.then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      releaseAppend.resolve(true)
      await disposing

      await expect(committing).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
      const persisted = await item.ctx.sessionPersistence.inspect(importedSessionId(value))
      expect(persisted.events.at(-1)?.type).toBe('session/end-seed')
      expect(attach).not.toHaveBeenCalled()
      await expect(service.capture({
        sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'internal' },
      })
      await expect(service.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'internal' },
      })
    } finally {
      await item.disposePersistence()
    }
  })

  it('keeps failed target resolution retryable and never publishes a half session', async () => {
    const root = await tempRoot('dsh-import-target-failures-')
    const value = snapshot('target-failures')
    const item = await harness('jsonl', root, value)
    try {
      await expect(item.ctx.sessionImportLocal.commit({ ...COMMIT_TARGET, reservationId: 'missing' }, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'reservation-not-found' } })

      const workspaceList = vi.spyOn(item.ctx.workspaceRegistry, 'list')
      workspaceList.mockReturnValueOnce([])
      await expect(item.ctx.sessionImportLocal.commit(
        { ...COMMIT_TARGET, reservationId: item.reservationId }, new AbortController().signal,
      ))
        .resolves.toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })

      const presetList = vi.spyOn(item.ctx.agentPresets, 'list')
      presetList.mockResolvedValueOnce([])
      await expect(item.ctx.sessionImportLocal.commit(
        { ...COMMIT_TARGET, reservationId: item.reservationId }, new AbortController().signal,
      ))
        .resolves.toMatchObject({ ok: false, error: { code: 'preset-not-found' } })
      presetList.mockResolvedValueOnce([{ id: 'preset', name: 'Preset', broken: 'bad' }] as never)
      await expect(item.ctx.sessionImportLocal.commit(
        { ...COMMIT_TARGET, reservationId: item.reservationId }, new AbortController().signal,
      ))
        .resolves.toMatchObject({ ok: false, error: { code: 'preset-unavailable' } })

      const resolveModel = vi.spyOn(item.ctx.llm, 'resolveModelInfo')
      resolveModel.mockRejectedValueOnce(new Error('gone'))
      await expect(item.ctx.sessionImportLocal.commit(
        { ...COMMIT_TARGET, reservationId: item.reservationId }, new AbortController().signal,
      ))
        .resolves.toMatchObject({ ok: false, error: { code: 'target-conflict' } })
      resolveModel.mockResolvedValueOnce({ provider: 'provider', id: 'model', name: 'Unknown' })
      await expect(item.ctx.sessionImportLocal.commit(
        { ...COMMIT_TARGET, reservationId: item.reservationId }, new AbortController().signal,
      ))
        .resolves.toMatchObject({ ok: false, error: { code: 'context-too-large' } })
      resolveModel.mockResolvedValueOnce({
        provider: 'provider', id: 'model', name: 'Tiny', context: { contextWindow: 4_096 }, defaultMaxTokens: 1,
      })
      await expect(item.ctx.sessionImportLocal.commit(
        { ...COMMIT_TARGET, reservationId: item.reservationId }, new AbortController().signal,
      ))
        .resolves.toMatchObject({ ok: false, error: { code: 'context-too-large' } })

      const cancelled = new AbortController()
      cancelled.abort()
      await expect(item.ctx.sessionImportLocal.commit({ ...COMMIT_TARGET, reservationId: item.reservationId }, cancelled.signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
      await expect(item.ctx.sessionPersistence.inspect(importedSessionId(value))).rejects.toThrow()
    } finally {
      await item.dispose()
    }
  })

  it('fails closed at composition, sizing, and publication faults and retries the same reservation', async () => {
    const stages = ['composition', 'sizing', 'publication'] as const
    for (const stage of stages) {
      const root = await tempRoot(`dsh-import-${stage}-fault-`)
      const value = snapshot(`${stage}-fault`)
      const item = await harness('jsonl', root, value)
      try {
        if (stage === 'composition') {
          vi.spyOn(item.ctx.systemPrompt, 'assemble').mockRejectedValueOnce(new Error('composition failed'))
        } else if (stage === 'sizing') {
          vi.spyOn(item.ctx.tokenMeter, 'measure').mockReturnValueOnce({ totalTokens: 1_000_000 } as never)
        } else {
          vi.spyOn(item.ctx.sessionPersistence, 'append').mockRejectedValueOnce(new Error('publication failed'))
        }
        const expectedCode = stage === 'sizing' ? 'context-too-large' : 'internal'
        await expect(item.ctx.sessionImportLocal.commit({
          ...COMMIT_TARGET, reservationId: item.reservationId,
        }, new AbortController().signal)).resolves.toMatchObject({
          ok: false, error: { code: expectedCode },
        })
        await expect(item.ctx.sessionPersistence.inspect(importedSessionId(value))).rejects.toThrow()
        await expect(item.ctx.sessionImportLocal.commit({
          ...COMMIT_TARGET, reservationId: item.reservationId,
        }, new AbortController().signal)).resolves.toMatchObject({ ok: true })
      } finally {
        await item.dispose()
      }
    }
  })

  it('accepts the matching winner after append reports failure and contains materialization failure', async () => {
    const root = await tempRoot('dsh-import-publish-winner-')
    const value = snapshot('publish-winner')
    const item = await harness('jsonl', root, value, { attachFails: true })
    try {
      const create = item.ctx.sessionPersistence.create.bind(item.ctx.sessionPersistence)
      vi.spyOn(item.ctx.sessionPersistence, 'create').mockImplementationOnce(async (header) => {
        await create(header)
        throw new Error('create acknowledgement lost')
      })
      const append = item.ctx.sessionPersistence.append.bind(item.ctx.sessionPersistence)
      let publication: Promise<void> = Promise.resolve()
      vi.spyOn(item.ctx.sessionPersistence, 'append').mockImplementationOnce((id, events) => {
        publication = new Promise((resolve) => {
          setTimeout(() => { resolve(append(id, events)) }, 20)
        })
        return Promise.reject(new Error('ack lost'))
      })
      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toEqual({
        ok: true,
        value: { sessionId: String(importedSessionId(value)), existing: true, workspaceAttached: false },
      })
      await publication
      const persisted = await item.ctx.sessionPersistence.inspect(importedSessionId(value))
      expect(persisted.events.at(-1)?.type).toBe('session/end-seed')
    } finally {
      await item.dispose()
    }
  })

  it('reports a durable mismatching winner as a conflict after append failure', async () => {
    const root = await tempRoot('dsh-import-publish-mismatch-')
    const value = snapshot('publish-mismatch')
    const item = await harness('jsonl', root, value)
    try {
      vi.spyOn(item.ctx.sessionPersistence, 'append').mockRejectedValueOnce(new Error('claim lost'))
      const service = item.ctx.sessionImportLocal as unknown as {
        inspectDurableWinner: () => Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
      }
      vi.spyOn(service, 'inspectDurableWinner').mockResolvedValueOnce({
        meta: {
          version: SESSION_FORMAT_VERSION,
          id: importedSessionId(value),
          createdAt: value.provenance.capturedAt,
          cwd: '/tmp/different-workspace',
          agentPreset: 'different-preset',
        },
        events: [],
      })
      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'target-conflict' },
      })
    } finally {
      await item.dispose()
    }
  })

  it('rejects deterministic targets that already hold different workspace or model choices', async () => {
    const root = await tempRoot('dsh-import-existing-mismatch-')
    const value = snapshot('existing-mismatch')
    const owner = await harness('jsonl', root, value)
    const differentWorkspace = await harness('jsonl', root, value, { workspacePath: '/tmp/other-workspace' })
    const differentModel = await harness('jsonl', root, value)
    const attachmentFailure = await harness('jsonl', root, value, { attachFails: true })
    try {
      await expect(owner.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: owner.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({ ok: true, value: { existing: false } })
      await expect(differentWorkspace.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: differentWorkspace.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'target-conflict' },
      })
      await expect(differentModel.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, model: 'other', reservationId: differentModel.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'target-conflict' },
      })
      await expect(attachmentFailure.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: attachmentFailure.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: true, value: { existing: true, workspaceAttached: false },
      })
    } finally {
      await Promise.all([owner.dispose(), differentWorkspace.dispose(), differentModel.dispose(), attachmentFailure.dispose()])
    }
  })

  it('rejects same-process live-session races at every publication check', async () => {
    for (const liveAt of [1, 2, 3] as const) {
      const root = await tempRoot(`dsh-import-live-${liveAt}-`)
      const value = snapshot(`live-${liveAt}`)
      const item = await harness('jsonl', root, value)
      try {
        let calls = 0
        const service = item.ctx.sessionImportLocal as unknown as {
          targetIsLive: (sessionId: string) => boolean
        }
        vi.spyOn(service, 'targetIsLive').mockImplementation(() => {
          calls += 1
          return calls >= liveAt
        })
        await expect(item.ctx.sessionImportLocal.commit({
          ...COMMIT_TARGET, reservationId: item.reservationId,
        }, new AbortController().signal)).resolves.toMatchObject({
          ok: false, error: { code: 'target-conflict' },
        })
      } finally {
        await item.dispose()
      }
    }
  })

  it('uses a conservative fallback output reserve when a model has no default output limit', async () => {
    const root = await tempRoot('dsh-import-output-fallback-')
    const item = await harness('jsonl', root, snapshot('output-fallback'))
    try {
      const service = item.ctx.sessionImportLocal as unknown as {
        usableImportTokens: (info: LlmResolvedModelInfo) => number
      }
      expect(service.usableImportTokens({
        provider: 'provider', id: 'model', name: 'No default', context: { contextWindow: 100_000 },
      })).toBe(80_000)
      expect(service.usableImportTokens({ provider: 'provider', id: 'model', name: 'No context' }))
        .toBe(-4_097)
      const missingCommit = await (service as unknown as {
        watchCommit: (reservation: { commit?: Promise<unknown> }, signal: AbortSignal) => Promise<unknown>
      }).watchCommit({}, new AbortController().signal)
      expect(missingCommit).toMatchObject({ ok: false, error: { code: 'internal' } })

      vi.spyOn(item.ctx.llm, 'resolveModelInfo').mockResolvedValueOnce({
        provider: 'provider', id: 'model', name: 'No default', context: { contextWindow: 100_000 },
      })
      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({ ok: true })
    } finally {
      await item.dispose()
    }
  })

  it('rejects a materialized deterministic target with no import provenance', async () => {
    const root = await tempRoot('dsh-import-missing-provenance-')
    const location = join(root, 'sessions.db')
    const value = snapshot('missing-provenance')
    const item = await harness('sqlite', location, value)
    try {
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION,
        id: importedSessionId(value),
        createdAt: value.provenance.capturedAt,
        cwd: '/tmp/import-workspace',
        agentPreset: 'preset',
      }
      const seed = convertForeignSnapshot(value, header, CONFIG.maxToolSummaryBytes, {
        provider: 'provider', model: 'model', contextWindow: 128_000,
      })
      const prepared = item.ctx.sessions.prepare(header.id, { seed, meta: header })
      const withoutProvenance = prepared.events
        .filter(event => event.type !== 'session/imported')
        .map((event, seq) => ({ ...event, seq })) as SessionEvent[]
      await item.ctx.sessionPersistence.create(header)
      await item.ctx.sessionPersistence.append(header.id, withoutProvenance)
      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: item.reservationId,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'target-conflict' },
      })
    } finally {
      await item.dispose()
    }
  })

  it('discards reservations idempotently and enforces the configured reservation bound', async () => {
    const root = await tempRoot('dsh-import-discard-')
    const value = snapshot('discard')
    const item = await harness('jsonl', root, value)
    try {
      expect(item.ctx.sessionImportLocal.discard({ reservationId: item.reservationId }))
        .toEqual({ ok: true, value: { discarded: true } })
      expect(item.ctx.sessionImportLocal.discard({ reservationId: item.reservationId }))
        .toEqual({ ok: true, value: { discarded: false } })

      const reservations: string[] = []
      for (let index = 0; index <= CONFIG.maxReservations; index += 1) {
        const captured = await item.ctx.sessionImportLocal.capture({
          sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
        }, new AbortController().signal)
        if (!captured.ok) throw new Error(captured.error.message)
        reservations.push(captured.value.reservationId)
      }
      await expect(item.ctx.sessionImportLocal.commit({
        ...COMMIT_TARGET, reservationId: reservations[0]!,
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false, error: { code: 'reservation-not-found' },
      })
    } finally {
      await item.dispose()
    }
  })
})

// Compile-time pin: imported events remain ordinary SessionEvent values, not
// untrusted foreign JSON masquerading as the native event union.
const _nativeEventOnly: readonly SessionEvent[] = []
void _nativeEventOnly
