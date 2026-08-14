import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SessionImportRegistry, { ForeignSessionImportError } from '@deepseek-ai/dsh-session-import'
import { apply, ClaudeCodeSessionImportProvider } from '../src/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'

const LIMITS = {
  maxSourceBytes: 4 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxVisibleContextBytes: 2 * 1024 * 1024,
  maxVisibleMessages: 1_000,
  maxToolActivities: 100,
} as const

const roots: string[] = []
const line = (value: unknown): string => `${JSON.stringify(value)}\n`

async function importError(promise: Promise<unknown>): Promise<ForeignSessionImportError> {
  try {
    await promise
  } catch (error) {
    return error as ForeignSessionImportError
  }
  throw new Error('expected capture to reject')
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-import-claude-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('ClaudeCodeSessionImportProvider', () => {
  async function captureRows(id: string, rows: readonly unknown[]): Promise<unknown> {
    const sourceRoot = await root()
    await writeFile(join(sourceRoot, `${id}.jsonl`), rows.map(line).join(''))
    return await new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
      signal: new AbortController().signal,
    })
  }

  it('converges assistant stream updates and excludes sidechains, reasoning, attachments, and tool bodies', async () => {
    const sourceRoot = await root()
    const nested = join(sourceRoot, '-tmp-project')
    await mkdir(nested, { recursive: true })
    const id = '77777777-7777-4777-8777-777777777777'
    const path = join(nested, `${id}.jsonl`)
    const base = { sessionId: id, version: '2.1.128', cwd: '/tmp/project' }
    await writeFile(path, [
      { ...base, type: 'system', timestamp: '2026-08-14T00:00:00.000Z', message: { role: 'system', content: 'sk-hidden-system-1234567890' } },
      { ...base, type: 'attachment', timestamp: '2026-08-14T00:00:00.500Z', attachment: { path: '/private/attachment' } },
      { ...base, type: 'frame-link', timestamp: '2026-08-14T00:00:00.600Z', frameUrl: 'https://example.invalid/private', path: '/private/frame' },
      { ...base, type: 'user', uuid: 'user-1', timestamp: '2026-08-14T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'authorization=sk-visible-claude-1234567890' }] } },
      { ...base, type: 'assistant', uuid: 'assistant-1', timestamp: '2026-08-14T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }, { type: 'thinking', thinking: 'private chain' }, { type: 'tool_use', id: 'tool-1', name: 'Read File', input: { path: '/secret', token: 'sk-tool-1234567890' } }] } },
      { ...base, type: 'assistant', uuid: 'assistant-1', timestamp: '2026-08-14T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'tool-1', name: 'Read File', input: { path: '/secret' } }, { type: 'fallback', from: { model: 'secret-old' }, to: { model: 'secret-new' } }] } },
      { ...base, type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', content: 'Hello' } },
      { ...base, type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', content: 'Hel' } },
      { ...base, type: 'user', uuid: 'tool-result-1', timestamp: '2026-08-14T00:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'sk-result-1234567890' }, { type: 'image', source: { path: '/private/image.png' } }] } },
      { ...base, type: 'assistant', uuid: 'sidechain-1', isSidechain: true, timestamp: '2026-08-14T00:00:05.000Z', message: { role: 'assistant', content: 'sidechain secret' } },
    ].map(line).join(''))

    const snapshot = await new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
    })

    expect(snapshot.provenance).toMatchObject({ sourceKind: 'claude-code', sourceVersion: '2.1.128' })
    expect(snapshot.messages.map(message => message.text)).toEqual([
      'authorization=[REDACTED CREDENTIAL]',
      'Hello',
    ])
    expect(snapshot.tools).toEqual([{
      name: 'Read?File', status: 'completed', timestamp: Date.parse('2026-08-14T00:00:02.000Z'),
    }])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('hidden-system')
    expect(serialized).not.toContain('private chain')
    expect(serialized).not.toContain('/secret')
    expect(serialized).not.toContain('result-1234567890')
    expect(serialized).not.toContain('/private/image.png')
    expect(serialized).not.toContain('/private/attachment')
    expect(serialized).not.toContain('secret-old')
    expect(serialized).not.toContain('sidechain secret')
    expect(serialized).not.toContain(path)
  })

  it('rejects conflicting duplicate assistant records without returning source data', async () => {
    const sourceRoot = await root()
    const id = '88888888-8888-4888-8888-888888888888'
    const path = join(sourceRoot, `${id}.jsonl`)
    await writeFile(path, [
      { sessionId: id, version: '2.1.128', type: 'assistant', uuid: 'same', message: { role: 'assistant', content: 'first secret body' } },
      { sessionId: id, version: '2.1.128', type: 'assistant', uuid: 'same', message: { role: 'assistant', content: 'different secret body' } },
    ].map(line).join(''))

    const error = await importError(new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
    }))

    expect(error).toBeInstanceOf(ForeignSessionImportError)
    expect(error.code).toBe('duplicate-record')
    expect(error.record).toBe(2)
    expect(error.message).not.toContain('first secret body')
    expect(error.message).not.toContain(path)
  })

  it('rejects unsupported structural records and out-of-order timestamps', async () => {
    const sourceRoot = await root()
    const unsupportedId = '99999999-9999-4999-8999-999999999999'
    await writeFile(join(sourceRoot, `${unsupportedId}.jsonl`), line({
      sessionId: unsupportedId, version: '2.1.128', type: 'future-required-record', payload: 'secret',
    }))
    const unsupported = await importError(new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: unsupportedId,
      limits: LIMITS,
    }))
    expect(unsupported.code).toBe('unsupported-version')

    const unorderedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await writeFile(join(sourceRoot, `${unorderedId}.jsonl`), [
      { sessionId: unorderedId, version: '2.1.128', type: 'user', timestamp: '2026-08-14T00:00:02.000Z', message: { role: 'user', content: 'later' } },
      { sessionId: unorderedId, version: '2.1.128', type: 'assistant', timestamp: '2026-08-14T00:00:01.000Z', message: { role: 'assistant', content: 'earlier' } },
    ].map(line).join(''))
    const unordered = await importError(new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: unorderedId,
      limits: LIMITS,
    }))
    expect(unordered.code).toBe('out-of-order')
  })

  it('accepts every body-free record and safe content variant across supported upgrades', async () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const hiddenTypes = [
      'system', 'progress', 'file-history-snapshot', 'queue-operation', 'last-prompt',
      'ai-title', 'attachment', 'custom-title', 'mode', 'pr-link', 'frame-link',
    ]
    const rows: unknown[] = hiddenTypes.map((type, index) => ({
      sessionId: id,
      version: index === 0 ? '2.1.128' : '2.1.222',
      type,
      hidden: 'secret',
    }))
    rows.push(
      { sessionId: id, version: '2.1.222', type: 'user', message: { content: 'plain' } },
      { sessionId: id, version: '2.1.222', type: 'user', message: { content: null } },
      { sessionId: id, version: '2.1.222', type: 'assistant', uuid: 'a', message: { content: [
        { type: 'text', text: 1 },
        { type: 'text', text: 'answer' },
        { type: 'tool_use' },
        { type: 'tool_use' },
        { type: 'redacted_thinking', data: 'hidden' },
        { type: 'document', source: { path: '/hidden' } },
      ] } },
      { sessionId: id, version: '2.1.222', type: 'assistant', uuid: 'a', message: { content: 'answer+' } },
      { sessionId: id, version: '2.1.222', type: 'user', message: { content: [
        { type: 'tool_result' },
        { type: 'tool_result', tool_use_id: 'missing', is_error: true, content: 'hidden' },
        { type: 'tool_result', tool_use_id: 'record-15', is_error: true, content: 'hidden' },
      ] } },
      { sessionId: id, version: '2.1.222', type: 'summary', timestamp: '2026-08-14T00:00:01.000Z', summary: 'safe summary' },
      { sessionId: id, version: '2.1.222', type: 'summary', summary: 'safe summary without time' },
      { sessionId: id, version: '2.1.222', type: 'assistant', isSidechain: true, message: { content: 'hidden sidechain' } },
    )
    const captured = await captureRows(id, rows) as {
      provenance: { sourceVersion: string }
      messages: Array<{ text: string }>
    }
    expect(captured.provenance.sourceVersion).toBe('2.1.128..2.1.222')
    expect(captured.messages.some(message => message.text.includes('safe summary'))).toBe(true)
    expect(JSON.stringify(captured)).not.toContain('hidden')
  })

  it('fails closed for unsupported versions, identities, messages, blocks, and summaries', async () => {
    const base = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const cases: Array<{ rows: unknown[]; code: string }> = [
      { rows: [null], code: 'source-corrupt' },
      { rows: [{ type: 'system', version: '2.1.128' }], code: 'source-corrupt' },
      { rows: [{ sessionId: base, type: 'system' }], code: 'unsupported-version' },
      { rows: [{ sessionId: base, version: 'bad', type: 'system' }], code: 'unsupported-version' },
      { rows: [{ sessionId: base, version: '2.1.127', type: 'system' }], code: 'unsupported-version' },
      { rows: [{ sessionId: base, version: '2.1.223', type: 'system' }], code: 'unsupported-version' },
      { rows: [{ sessionId: 'different', version: '2.1.128', type: 'system' }], code: 'source-corrupt' },
      { rows: [{ sessionId: base, version: '2.1.128', type: 'user', message: null }], code: 'source-corrupt' },
      { rows: [{ sessionId: base, version: '2.1.128', type: 'user', message: { role: 'assistant', content: 'x' } }], code: 'source-corrupt' },
      { rows: [
        { sessionId: base, version: '2.1.128', type: 'user', uuid: 'same', message: { content: 'a' } },
        { sessionId: base, version: '2.1.128', type: 'user', uuid: 'same', message: { content: 'a' } },
      ], code: 'duplicate-record' },
      { rows: [{ sessionId: base, version: '2.1.128', type: 'user', message: { content: [null] } }], code: 'source-corrupt' },
      { rows: [{ sessionId: base, version: '2.1.128', type: 'user', message: { content: [{ type: 'tool_use' }] } }], code: 'source-corrupt' },
      { rows: [{ sessionId: base, version: '2.1.128', type: 'user', message: { content: [{ type: 'future' }] } }], code: 'unsupported-version' },
      { rows: [{ sessionId: base, version: '2.1.128', type: 'summary', summary: 1 }], code: 'source-corrupt' },
      { rows: [{ sessionId: base, version: '2.1.128', type: 'future' }], code: 'unsupported-version' },
    ]
    for (const [index, candidate] of cases.entries()) {
      const id = `${String(index + 20).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`
      const rows = candidate.rows.map(row => JSON.parse(JSON.stringify(row).replaceAll(base, id)) as unknown)
      const error = await importError(captureRows(id, rows))
      expect(error.code, `case ${index}`).toBe(candidate.code)
      expect(error.message).not.toContain('secret')
    }
  })

  it('reports missing and ambiguous session ids and returns bounded discovery metadata', async () => {
    const missingRoot = await root()
    const missing = new ClaudeCodeSessionImportProvider({ root: missingRoot, maxCandidates: 1 })
    await expect(missing.capture({
      sourceSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', limits: LIMITS,
    })).rejects.toMatchObject({ code: 'source-not-found' })

    const sourceRoot = await root()
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    await mkdir(join(sourceRoot, 'a'))
    await mkdir(join(sourceRoot, 'b'))
    const data = line({ sessionId: id, version: '2.1.128', type: 'system' })
    await writeFile(join(sourceRoot, 'a', `${id}.jsonl`), data)
    await writeFile(join(sourceRoot, 'b', `${id}.jsonl`), data)
    const provider = new ClaudeCodeSessionImportProvider({ root: sourceRoot, maxCandidates: 1 })
    await expect(provider.discover()).resolves.toHaveLength(1)
    await expect(provider.discover(new AbortController().signal)).resolves.toHaveLength(1)
    await expect(provider.capture({ sourceSessionId: id, limits: LIMITS }))
      .rejects.toMatchObject({ code: 'source-ambiguous' })
  })

  it('registers its invariant companion', async () => {
    const dispose = () => {}
    const register = (name: string, install: (() => void) & { inject?: string[] }): (() => void) => {
      expect(name).toBe('@deepseek-ai/dsh-session-import-claude-code')
      expect(install.inject).toEqual(['sessionImports'])
      install()
      return dispose
    }
    await expect(applyInvariant({ invariants: { register } } as never)).resolves.toBe(dispose)
  })

  it('registers the provider plugin and honors pre-cancelled capture', async () => {
    const sourceRoot = await root()
    const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    await writeFile(join(sourceRoot, `${id}.jsonl`), line({
      sessionId: id, version: '2.1.128', type: 'system',
    }))
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    await expect(new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id, limits: LIMITS, signal: cancelled.signal,
    })).rejects.toThrow('cancelled')
    expect(new ClaudeCodeSessionImportProvider().sourceKind).toBe('claude-code')

    const ctx = new Context()
    await ctx.plugin(SessionImportRegistry)
    apply(ctx, { root: sourceRoot, maxCandidates: 2 })
    expect(ctx.sessionImports.listProviders()).toEqual(['claude-code'])
    await ctx.fiber.dispose()
  })
})
