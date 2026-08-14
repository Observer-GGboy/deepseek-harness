import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ForeignSessionImportError } from '@deepseek-ai/dsh-session-import'
import { ClaudeCodeSessionImportProvider } from '../src/index.ts'

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
  it('converges assistant stream updates and excludes sidechains, reasoning, attachments, and tool bodies', async () => {
    const sourceRoot = await root()
    const nested = join(sourceRoot, '-tmp-project')
    await mkdir(nested, { recursive: true })
    const id = '77777777-7777-4777-8777-777777777777'
    const path = join(nested, `${id}.jsonl`)
    const base = { sessionId: id, version: '2.0', cwd: '/tmp/project' }
    await writeFile(path, [
      { ...base, type: 'system', timestamp: '2026-08-14T00:00:00.000Z', message: { role: 'system', content: 'sk-hidden-system-1234567890' } },
      { ...base, type: 'attachment', timestamp: '2026-08-14T00:00:00.500Z', attachment: { path: '/private/attachment' } },
      { ...base, type: 'user', uuid: 'user-1', timestamp: '2026-08-14T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'authorization=sk-visible-claude-1234567890' }] } },
      { ...base, type: 'assistant', uuid: 'assistant-1', timestamp: '2026-08-14T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }, { type: 'thinking', thinking: 'private chain' }, { type: 'tool_use', id: 'tool-1', name: 'Read File', input: { path: '/secret', token: 'sk-tool-1234567890' } }] } },
      { ...base, type: 'assistant', uuid: 'assistant-1', timestamp: '2026-08-14T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'tool-1', name: 'Read File', input: { path: '/secret' } }, { type: 'fallback', from: { model: 'secret-old' }, to: { model: 'secret-new' } }] } },
      { ...base, type: 'user', uuid: 'tool-result-1', timestamp: '2026-08-14T00:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'sk-result-1234567890' }, { type: 'image', source: { path: '/private/image.png' } }] } },
      { ...base, type: 'assistant', uuid: 'sidechain-1', isSidechain: true, timestamp: '2026-08-14T00:00:05.000Z', message: { role: 'assistant', content: 'sidechain secret' } },
    ].map(line).join(''))

    const snapshot = await new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
    })

    expect(snapshot.provenance).toMatchObject({ sourceKind: 'claude-code', sourceVersion: '2.0' })
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
      { sessionId: id, type: 'assistant', uuid: 'same', message: { role: 'assistant', content: 'first secret body' } },
      { sessionId: id, type: 'assistant', uuid: 'same', message: { role: 'assistant', content: 'different secret body' } },
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
      sessionId: unsupportedId, type: 'future-required-record', payload: 'secret',
    }))
    const unsupported = await importError(new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: unsupportedId,
      limits: LIMITS,
    }))
    expect(unsupported.code).toBe('unsupported-version')

    const unorderedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await writeFile(join(sourceRoot, `${unorderedId}.jsonl`), [
      { sessionId: unorderedId, type: 'user', timestamp: '2026-08-14T00:00:02.000Z', message: { role: 'user', content: 'later' } },
      { sessionId: unorderedId, type: 'assistant', timestamp: '2026-08-14T00:00:01.000Z', message: { role: 'assistant', content: 'earlier' } },
    ].map(line).join(''))
    const unordered = await importError(new ClaudeCodeSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: unorderedId,
      limits: LIMITS,
    }))
    expect(unordered.code).toBe('out-of-order')
  })
})
