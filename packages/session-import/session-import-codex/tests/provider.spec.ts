import { appendFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ForeignSessionImportError } from '@deepseek-ai/dsh-session-import'
import { CodexSessionImportProvider } from '../src/index.ts'

const LIMITS = {
  maxSourceBytes: 4 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxVisibleContextBytes: 2 * 1024 * 1024,
  maxVisibleMessages: 1_000,
  maxToolActivities: 100,
} as const

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-import-codex-'))
  roots.push(value)
  return value
}

function filename(id: string): string {
  return `rollout-2026-08-14T00-00-00-${id}.jsonl`
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

async function importError(promise: Promise<unknown>): Promise<ForeignSessionImportError> {
  try {
    await promise
  } catch (error) {
    return error as ForeignSessionImportError
  }
  throw new Error('expected capture to reject')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('CodexSessionImportProvider', () => {
  it('discovers metadata without parsing transcript bodies or following links', async () => {
    const sourceRoot = await root()
    const nested = join(sourceRoot, '2026', '08')
    await mkdir(nested, { recursive: true })
    const id = '11111111-1111-4111-8111-111111111111'
    await writeFile(join(nested, filename(id)), '{not-json')
    const outside = join(await root(), filename('22222222-2222-4222-8222-222222222222'))
    await writeFile(outside, line({ secret: 'sk-discovery-must-not-read-1234567890' }))
    await symlink(outside, join(nested, filename('33333333-3333-4333-8333-333333333333')))

    const rows = await new CodexSessionImportProvider({ root: sourceRoot }).discover()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sourceKind: 'codex', sourceSessionId: id })
    expect(rows[0]?.sizeBytes).toBeGreaterThan(0)
  })

  it('captures only visible redacted text and inert tool facts', async () => {
    const sourceRoot = await root()
    const id = '44444444-4444-4444-8444-444444444444'
    const path = join(sourceRoot, filename(id))
    const rows = [
      { type: 'session_meta', timestamp: '2026-08-14T00:00:00.000Z', payload: { id, cwd: '/tmp/project', cli_version: '1.2.3' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:01.000Z', payload: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'hidden sk-system-secret-1234567890' }] } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use api_key=sk-visible-secret-1234567890' }] } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:03.000Z', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"token":"sk-tool-args-1234567890"}' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:04.000Z', payload: { type: 'function_call_output', call_id: 'call-1', output: 'sk-tool-output-1234567890' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:05.000Z', payload: { type: 'reasoning', summary: 'secret reasoning' } },
      { type: 'world_state', timestamp: '2026-08-14T00:00:05.100Z', payload: { full: 'hidden world state' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:05.200Z', payload: { type: 'ghost_snapshot', ghost_commit: { secret: 'hidden ghost' } } },
      { type: 'event_msg', timestamp: '2026-08-14T00:00:05.300Z', payload: { type: 'patch_apply_end', stdout: 'hidden output' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:06.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Bearer topsecret123456789' }] } },
    ]
    await writeFile(path, rows.map(line).join('') + '{"type":"response_item"')

    const snapshot = await new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
    })

    expect(snapshot.provenance).toMatchObject({
      sourceKind: 'codex', sourceSessionId: id, sourceVersion: '1.2.3', converterVersion: 'codex-rollout-v1',
    })
    expect(snapshot.cwdHint).toBe('/tmp/project')
    expect(snapshot.trailingPartialRecordIgnored).toBe(true)
    expect(snapshot.tools).toEqual([{ name: 'shell', status: 'completed', timestamp: Date.parse('2026-08-14T00:00:03.000Z') }])
    expect(snapshot.messages).toHaveLength(2)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).toContain('[REDACTED CREDENTIAL]')
    expect(serialized).not.toContain('system-secret')
    expect(serialized).not.toContain('tool-args')
    expect(serialized).not.toContain('tool-output')
    expect(serialized).not.toContain('secret reasoning')
    expect(serialized).not.toContain('hidden world state')
    expect(serialized).not.toContain('hidden ghost')
    expect(serialized).not.toContain('hidden output')
    expect(serialized).not.toContain('topsecret123456789')
    expect(serialized).not.toContain(path)
  })

  it('captures an immutable initial prefix while allowing a concurrent append', async () => {
    const sourceRoot = await root()
    const id = '55555555-5555-4555-8555-555555555555'
    const path = join(sourceRoot, filename(id))
    const large = 'x'.repeat(96 * 1024)
    await writeFile(path, [
      { type: 'session_meta', payload: { id, cli_version: '1' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: large }] } },
    ].map(line).join(''))
    let appended = false

    const snapshot = await new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
      onProgress: (progress) => {
        if (appended || progress.phase !== 'reading') return
        appended = true
        appendFileSync(path, line({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'late append' }] },
        }))
      },
    })

    expect(appended).toBe(true)
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0]?.text).not.toContain('late append')
  })

  it('fails closed on a changed prefix and redacts the diagnostic', async () => {
    const sourceRoot = await root()
    const id = '66666666-6666-4666-8666-666666666666'
    const path = join(sourceRoot, filename(id))
    const original = [
      { type: 'session_meta', payload: { id, cli_version: '1' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(96 * 1024) }] } },
    ].map(line).join('')
    await writeFile(path, original)
    let changed = false

    const capture = new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
      onProgress: (progress) => {
        if (changed || progress.phase !== 'reading') return
        changed = true
        const replacement = original.replace('"cli_version":"1"', '"cli_version":"2"')
        writeFileSync(path, replacement)
      },
    })

    const error = await importError(capture)
    expect(error).toBeInstanceOf(ForeignSessionImportError)
    expect(error.code).toBe('source-changed')
    expect(error.message).not.toContain(sourceRoot)
  })
})
