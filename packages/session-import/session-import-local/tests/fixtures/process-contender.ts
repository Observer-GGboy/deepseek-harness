/** Independent process participant for local-session import contention tests. */

import { createHash } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionImportRegistry from '@deepseek-ai/dsh-session-import'
import type {
  ForeignSessionCaptureRequest,
  ForeignSessionProvider,
  ForeignSessionSnapshot,
} from '@deepseek-ai/dsh-session-import'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSessionImportService, { type Config } from '../../src/index.ts'

interface Arguments {
  readonly backend: 'jsonl' | 'sqlite'
  readonly location: string
  readonly ready: string
  readonly go: string
  readonly index: number
}

const args = JSON.parse(process.argv[2] ?? '') as Arguments
const config: Config = {
  maxSourceBytes: 4 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxVisibleContextBytes: 2 * 1024 * 1024,
  maxVisibleMessages: 1_000,
  maxToolActivities: 100,
  maxDiscoveryItems: 500,
  maxReservations: 8,
  maxToolSummaryBytes: 64 * 1024,
}

const value: ForeignSessionSnapshot = Object.freeze({
  provenance: Object.freeze({
    sourceKind: 'codex',
    sourceSessionId: 'independent-process-source',
    sourceVersion: '1.0.0',
    capturedAt: 1_786_665_600_000,
    prefixDigest: createHash('sha256').update('independent-process').digest('hex'),
    converterVersion: 'test-v1',
  }),
  sourceIdentity: 'codex:independent-process-source',
  messages: Object.freeze([Object.freeze({ role: 'user' as const, text: 'safe imported context' })]),
  tools: Object.freeze([]),
  capturedBytes: 64,
  contextBytes: 21,
  trailingPartialRecordIgnored: false,
})

class StaticProvider implements ForeignSessionProvider {
  readonly sourceKind = 'codex' as const
  discover(): Promise<[]> { return Promise.resolve([]) }
  capture(request: ForeignSessionCaptureRequest): Promise<ForeignSessionSnapshot> {
    request.signal?.throwIfAborted()
    return Promise.resolve(value)
  }
}

class WorkspaceRegistryStub extends Service {
  constructor(ctx: Context) { super(ctx, 'workspaceRegistry') }
  list(): readonly [object] {
    return [{
      id: 'workspace', title: 'Workspace', path: '/tmp/import-workspace',
      attachSession: (): Promise<void> => Promise.resolve(),
    }]
  }
}

class AgentPresetsStub extends Service {
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
  list(): Promise<Array<{ id: string; name: string }>> {
    return Promise.resolve([{ id: 'preset', name: 'Preset' }])
  }
  standingKeyFor(): Promise<{ agentPreset: string }> {
    return Promise.resolve({ agentPreset: 'preset' })
  }
}

class ImportModelAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'model', name: 'Model' }])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: 'Model', context: { contextWindow: 128_000 }, defaultMaxTokens: 8_192,
    })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['provider'], new ImportModelAdapter())
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SessionImportRegistry)
  await ctx.plugin(WorkspaceRegistryStub)
  await ctx.plugin(AgentPresetsStub)
  await ctx.plugin(args.backend === 'jsonl' ? JsonlSessionPersistence : SqliteSessionPersistence,
    args.backend === 'jsonl'
      ? { root: args.location, compression: 'none' }
      : { path: args.location })
  ctx.sessionImports.registerProvider(new StaticProvider())
  await ctx.plugin(LocalSessionImportService, config)
  const captured = await ctx.sessionImportLocal.capture({
    sourceKind: 'codex', sourceSessionId: value.provenance.sourceSessionId,
  }, new AbortController().signal)
  if (!captured.ok) throw new Error('capture failed')
  await writeFile(args.ready, String(args.index))
  while (true) {
    try {
      await access(args.go)
      break
    } catch {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    }
  }
  const result = await ctx.sessionImportLocal.commit({
    reservationId: captured.value.reservationId,
    workspaceId: 'workspace',
    agentPreset: 'preset',
    provider: 'provider',
    model: 'model',
  }, new AbortController().signal)
  process.stdout.write(JSON.stringify(result))
  await ctx.fiber.dispose()
}

await main().catch(() => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'process-failed' } }))
  process.exitCode = 1
})
