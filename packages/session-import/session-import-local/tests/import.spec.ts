import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionImportRegistry, {
  type ForeignSessionCaptureRequest,
  type ForeignSessionProvider,
  type ForeignSessionSnapshot,
} from '@deepseek-ai/dsh-session-import'
import LocalSessionImportService, {
  convertForeignSnapshot,
  importedSessionId,
  type Config,
  type SessionImportCommitValue,
} from '../src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'

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
}

type Backend = 'jsonl' | 'sqlite'

interface ImportHarness {
  readonly ctx: Context
  readonly reservationId: string
  readonly dispose: () => Promise<void>
}

async function harness(
  backend: Backend,
  location: string,
  value: ForeignSessionSnapshot,
  options: { readonly attachFails?: boolean } = {},
): Promise<ImportHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionImportRegistry)
  await ctx.plugin(WorkspaceRegistryStub, {
    workspacePath: '/tmp/import-workspace',
    ...options.attachFails === undefined ? {} : { attachFails: options.attachFails },
  })
  await ctx.plugin(AgentPresetsStub)
  const persistence = backend === 'jsonl'
    ? await ctx.plugin(JsonlSessionPersistence, { root: location, compression: 'none' })
    : await ctx.plugin(SqliteSessionPersistence, { path: location })
  ctx.sessionImports.registerProvider(new StaticProvider(value))
  await ctx.plugin(LocalSessionImportService, CONFIG)
  const captured = await ctx.sessionImportLocal.capture({
    sourceKind: 'codex',
    sourceSessionId: value.provenance.sourceSessionId,
  }, new AbortController().signal)
  if (!captured.ok) throw new Error(`capture failed: ${captured.error.code}`)
  return {
    ctx,
    reservationId: captured.value.reservationId,
    dispose: async () => { await persistence.dispose() },
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
    const raw = convertForeignSnapshot(value, header, CONFIG.maxToolSummaryBytes)
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

  for (const backend of ['jsonl', 'sqlite'] as const) {
    for (const count of [2, 10, 100]) {
      it(`${backend} publishes one complete deterministic session under ${count}-way contention`, {
        timeout: 60_000,
      }, async () => {
        await race(backend, count, `${backend}-${count}`)
      })
    }
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
})

// Compile-time pin: imported events remain ordinary SessionEvent values, not
// untrusted foreign JSON masquerading as the native event union.
const _nativeEventOnly: readonly SessionEvent[] = []
void _nativeEventOnly
