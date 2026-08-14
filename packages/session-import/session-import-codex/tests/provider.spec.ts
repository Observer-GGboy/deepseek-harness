import { appendFile, mkdir, mkdtemp, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionImportRegistry, {
  captureStableJsonl,
  discoverLocalJsonl,
  foreignTimestamp,
  ForeignSessionImportError,
  ForeignSnapshotAccumulator,
  redactForeignText,
} from '@deepseek-ai/dsh-session-import'
import { apply as applyInvariant } from '../src/invariant.ts'
import { apply, CodexSessionImportProvider } from '../src/index.ts'

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
  async function captureRows(id: string, rows: readonly unknown[]): Promise<unknown> {
    const sourceRoot = await root()
    await writeFile(join(sourceRoot, filename(id)), rows.map(line).join(''))
    return await new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
    })
  }

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

    const signal = new AbortController().signal
    await expect(new CodexSessionImportProvider({ root: sourceRoot }).discover(signal)).resolves.toHaveLength(1)
  })

  it('captures only visible redacted text and inert tool facts', async () => {
    const sourceRoot = await root()
    const id = '44444444-4444-4444-8444-444444444444'
    const path = join(sourceRoot, filename(id))
    const rows = [
      { type: 'session_meta', timestamp: '2026-08-14T00:00:00.000Z', payload: { id, cwd: '/tmp/project', cli_version: '0.148.0-alpha.9' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:01.000Z', payload: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'hidden sk-system-secret-1234567890' }] } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use api_key=sk-visible-secret-1234567890' }] } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:03.000Z', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"token":"sk-tool-args-1234567890"}' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:04.000Z', payload: { type: 'function_call_output', call_id: 'call-1', output: 'sk-tool-output-1234567890' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:05.000Z', payload: { type: 'reasoning', summary: 'secret reasoning' } },
      { type: 'world_state', timestamp: '2026-08-14T00:00:05.100Z', payload: { full: 'hidden world state' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:05.200Z', payload: { type: 'ghost_snapshot', ghost_commit: { secret: 'hidden ghost' } } },
      { type: 'event_msg', timestamp: '2026-08-14T00:00:05.300Z', payload: { type: 'patch_apply_end', stdout: 'hidden output' } },
      { type: 'session_meta', timestamp: '2026-08-14T00:00:05.400Z', payload: { id, cwd: '/tmp/project', cli_version: '0.148.0-alpha.9' } },
      { type: 'response_item', timestamp: '2026-08-14T00:00:06.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Bearer topsecret123456789' }] } },
    ]
    await writeFile(path, rows.map(line).join('') + '{"type":"response_item"')

    const snapshot = await new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
    })

    expect(snapshot.provenance).toMatchObject({
      sourceKind: 'codex', sourceSessionId: id, sourceVersion: '0.148.0-alpha.9', converterVersion: 'codex-rollout-v1',
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

  it('fails closed on unsupported source versions without returning source data', async () => {
    const sourceRoot = await root()
    const id = '66666666-6666-4666-8666-666666666666'
    const path = join(sourceRoot, filename(id))
    await writeFile(path, [
      { type: 'session_meta', payload: { id, cli_version: '0.149.0' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'secret body' }] } },
    ].map(line).join(''))
    const error = await importError(new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id,
      limits: LIMITS,
    }))
    expect(error).toBeInstanceOf(ForeignSessionImportError)
    expect(error.code).toBe('unsupported-version')
    expect(error.message).toContain('0.149.0')
    expect(error.message).toContain('record 1')
    expect(error.message).not.toContain('secret body')
    expect(error.message).not.toContain(sourceRoot)
  })

  it('never exposes malformed, credential-shaped, path-shaped, or oversized version values', async () => {
    const unsafeVersions = [
      '/private/project/.env',
      'Bearer sk-codex-version-secret-1234567890',
      'sk-codex-version-secret-1234567890',
      `0.149.0-${'x'.repeat(512)}`,
    ]
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const [index, version] of unsafeVersions.entries()) {
        const id = `${String(index + 80).padStart(8, '0')}-6666-4666-8666-666666666666`
        const error = await importError(captureRows(id, [{
          type: 'session_meta', payload: { id, cli_version: version },
        }]))
        expect(error).toMatchObject({
          code: 'unsupported-version', sourceKind: 'codex', record: 1,
        })
        expect(`${error.message}\n${error.stack ?? ''}`).not.toContain(version)
      }
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('accepts the complete known record vocabulary without retaining hidden bodies', async () => {
    const id = '12121212-1212-4212-8212-121212121212'
    const ignoredEvents = [
      'context_compacted', 'task_started', 'task_complete', 'token_count', 'agent_reasoning',
      'stream_error', 'mcp_tool_call_end', 'patch_apply_end', 'sub_agent_activity',
      'thread_settings_applied', 'web_search_end',
    ].map(type => ({ type: 'event_msg', payload: { type, secret: 'hidden' } }))
    const captured = await captureRows(id, [
      { type: 'session_meta', payload: { id, cwd: 'relative', cli_version: '0.144.0' } },
      { type: 'event_msg', payload: { type: 'turn_aborted' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: null } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 1 }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'plain user' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [
        null, { type: 'other', text: 'hidden' }, { type: 'text', text: 'assistant' },
      ] } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: 'hidden' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'a', name: 'fn' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', id: 'b', name: 'custom' } },
      { type: 'response_item', payload: { type: 'local_shell_call' } },
      { type: 'response_item', payload: { type: 'web_search_call', call_id: 'd' } },
      { type: 'response_item', payload: { type: 'computer_tool_call', call_id: 'e' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'b', output: 'hidden' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'missing' } },
      { type: 'response_item', payload: { type: 'function_call_output' } },
      { type: 'response_item', payload: { type: 'reasoning', secret: 'hidden' } },
      { type: 'response_item', payload: { type: 'agent_message', secret: 'hidden' } },
      { type: 'response_item', payload: { type: 'ghost_snapshot', secret: 'hidden' } },
      { type: 'event_msg', payload: { type: 'turn_aborted' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'event user' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'event assistant' } },
      { type: 'event_msg', timestamp: '2026-08-14T00:00:01.000Z', payload: { type: 'user_message' } },
      { type: 'event_msg', timestamp: '2026-08-14T00:00:01.000Z', payload: { type: 'agent_message' } },
      { type: 'event_msg', payload: { type: 'turn_aborted' } },
      ...ignoredEvents,
      { type: 'compacted', timestamp: '2026-08-14T00:00:01.000Z', payload: { summary: 'summary' } },
      { type: 'compacted', payload: { content: 'content summary' } },
      { type: 'compacted', payload: {} },
      { type: 'turn_context', payload: { secret: 'hidden' } },
      { type: 'world_state', payload: { secret: 'hidden' } },
      { type: 'inter_agent_communication_metadata', payload: { secret: 'hidden' } },
      { type: 'session_meta', payload: { id, cwd: '/tmp/updated', cli_version: '0.148.0-alpha.9' } },
    ]) as { provenance: { sourceVersion: string }; cwdHint?: string; tools: unknown[]; messages: Array<{ interrupted?: true }> }
    expect(captured.provenance.sourceVersion).toBe('0.144.0+0.148.0-alpha.9')
    expect(captured.cwdHint).toBe('/tmp/updated')
    expect(captured.tools).toHaveLength(5)
    expect(captured.messages.some(message => message.interrupted === true)).toBe(true)
    expect(JSON.stringify(captured)).not.toContain('hidden')
  })

  it('rejects an empty rollout and honors caller cancellation before reading', async () => {
    const sourceRoot = await root()
    const id = '23232323-2323-4232-8232-232323232323'
    await writeFile(join(sourceRoot, filename(id)), '')
    await expect(new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id, limits: LIMITS, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'source-corrupt' })

    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    await expect(new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id, limits: LIMITS, signal: cancelled.signal,
    })).rejects.toThrow('cancelled')
    expect(new CodexSessionImportProvider().sourceKind).toBe('codex')
  })

  it('omits an unavailable working-directory hint from a valid snapshot', async () => {
    const id = '24242424-2424-4242-8242-242424242424'
    const captured = await captureRows(id, [
      { type: 'session_meta', payload: { id, cli_version: '0.148.0' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'hello' } },
    ]) as { cwdHint?: string }
    expect(captured.cwdHint).toBeUndefined()
  })

  it('fails closed for corrupt identities and unknown structural variants', async () => {
    const base = '34343434-3434-4434-8434-343434343434'
    const cases: Array<{ rows: unknown[]; code: string }> = [
      { rows: [null], code: 'source-corrupt' },
      { rows: [{ type: 'event_msg', payload: { type: 'task_started' } }], code: 'source-corrupt' },
      { rows: [{ type: 'session_meta', payload: null }], code: 'source-corrupt' },
      { rows: [{ type: 'session_meta', payload: { id: base } }], code: 'unsupported-version' },
      { rows: [{ type: 'session_meta', payload: { id: base, cli_version: 'bad' } }], code: 'unsupported-version' },
      { rows: [{ type: 'session_meta', payload: { id: base, cli_version: '0.148.0-01' } }], code: 'unsupported-version' },
      { rows: [{ type: 'session_meta', payload: { id: base, cli_version: '0.143.9' } }], code: 'unsupported-version' },
      { rows: [{ type: 'session_meta', payload: { id: base, cli_version: '0.149.0' } }], code: 'unsupported-version' },
      { rows: [
        { type: 'session_meta', payload: { id: base, cli_version: '0.148.0' } },
        { type: 'session_meta', payload: { id: 'other', cli_version: '0.148.0' } },
      ], code: 'source-corrupt' },
      { rows: [
        { type: 'session_meta', payload: { id: base, cli_version: '0.148.0' } },
        { type: 'future', payload: {} },
      ], code: 'unsupported-version' },
      { rows: [
        { type: 'session_meta', payload: { id: base, cli_version: '0.148.0' } },
        { type: 'response_item', payload: null },
      ], code: 'source-corrupt' },
      { rows: [
        { type: 'session_meta', payload: { id: base, cli_version: '0.148.0' } },
        { type: 'response_item', payload: { type: 'future' } },
      ], code: 'unsupported-version' },
      { rows: [
        { type: 'session_meta', payload: { id: base, cli_version: '0.148.0' } },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'same' } },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'same' } },
      ], code: 'duplicate-record' },
      { rows: [
        { type: 'session_meta', payload: { id: base, cli_version: '0.148.0' } },
        { type: 'event_msg', payload: null },
      ], code: 'source-corrupt' },
      { rows: [
        { type: 'session_meta', payload: { id: base, cli_version: '0.148.0' } },
        { type: 'event_msg', payload: { type: 'future' } },
      ], code: 'unsupported-version' },
      { rows: [
        { type: 'session_meta', payload: { id: base, cli_version: '0.148.0' } },
        { type: 'compacted', payload: null },
      ], code: 'source-corrupt' },
    ]
    for (const [index, candidate] of cases.entries()) {
      const id = `${String(index).padStart(8, '0')}-3434-4434-8434-343434343434`
      const rows = candidate.rows.map(row => JSON.parse(JSON.stringify(row).replaceAll(base, id)) as unknown)
      const error = await importError(captureRows(id, rows))
      expect(error.code, `case ${index}`).toBe(candidate.code)
      expect(error.message).not.toContain('secret')
    }
  })

  it('reports missing and ambiguous source identities and validates basenames', async () => {
    expect(filename('56565656-5656-4656-8656-565656565656')).toContain('56565656')
    const provider = new CodexSessionImportProvider({ root: await root(), maxCandidates: 1 })
    await expect(provider.capture({
      sourceSessionId: '56565656-5656-4656-8656-565656565656', limits: LIMITS,
    })).rejects.toMatchObject({ code: 'source-not-found' })

    const sourceRoot = await root()
    const id = '78787878-7878-4878-8878-787878787878'
    await mkdir(join(sourceRoot, 'a'))
    await mkdir(join(sourceRoot, 'b'))
    const data = line({ type: 'session_meta', payload: { id, cli_version: '0.148.0' } })
    await writeFile(join(sourceRoot, 'a', filename(id)), data)
    await writeFile(join(sourceRoot, 'b', filename(id)), data)
    await expect(new CodexSessionImportProvider({ root: sourceRoot }).capture({
      sourceSessionId: id, limits: LIMITS,
    })).rejects.toMatchObject({ code: 'source-ambiguous' })
  })
})

describe('shared local JSONL safety machinery', () => {
  it('redacts credentials, normalizes timestamps, and enforces accumulator bounds', () => {
    expect(redactForeignText('api-key: secret Bearer abcdefgh sk_abcdefghijkl api-abcdefghijkl'))
      .not.toContain('secret')
    expect(foreignTimestamp(0)).toBe(0)
    expect(foreignTimestamp(-1)).toBeUndefined()
    expect(foreignTimestamp('2026-08-14T00:00:00.000Z')).toBe(1_786_665_600_000)
    expect(foreignTimestamp('not-a-date')).toBeUndefined()
    expect(foreignTimestamp({})).toBeUndefined()

    const limits = { ...LIMITS, maxVisibleMessages: 1, maxVisibleContextBytes: 4, maxToolActivities: 1 }
    const messages = new ForeignSnapshotAccumulator('codex', limits)
    messages.observeTimestamp(undefined, 1)
    messages.observeTimestamp(2, 2)
    messages.observeTimestamp(2, 3)
    expect(() => { messages.observeTimestamp(1, 4) }).toThrow(/out-of-order/)
    messages.message({ role: 'user', text: '   ' }, 5)
    messages.message({ role: 'user', text: 'abcd' }, 6)
    messages.message({ role: 'user', text: 'abcd' }, 7)
    expect(() => { messages.message({ role: 'assistant', text: 'x' }, 8) }).toThrow(/message count/)

    const bytes = new ForeignSnapshotAccumulator('codex', { ...LIMITS, maxVisibleContextBytes: 1 })
    expect(() => { bytes.message({ role: 'user', text: 'xx' }, 1) }).toThrow(/visible context/)
    const tools = new ForeignSnapshotAccumulator('codex', limits)
    tools.tool({ name: ' Read File ', status: 'unknown' }, 1)
    expect(tools.tools[0]?.name).toBe('?Read?File?')
    expect(() => { tools.tool({ name: '', status: 'completed', timestamp: 1 }, 2) }).toThrow(/tool history/)
    const emptyTool = new ForeignSnapshotAccumulator('codex', LIMITS)
    emptyTool.tool({ name: '', status: 'completed' }, 1)
    expect(emptyTool.tools).toEqual([{ name: 'unknown', status: 'completed' }])
    const interrupted = new ForeignSnapshotAccumulator('codex', LIMITS)
    interrupted.message({ role: 'assistant', text: 'stopped', interrupted: true }, 1)
    expect(interrupted.messages[0]).toMatchObject({ interrupted: true })
  })

  it('covers missing, aborted, bounded, and deterministically sorted discovery', async () => {
    const missing = join(await root(), 'missing')
    await expect(discoverLocalJsonl({
      root: missing, sourceKind: 'codex', maxFiles: 1, sessionIdFromName: () => 'id',
    })).resolves.toEqual([])

    const fileRoot = join(await root(), 'file')
    await writeFile(fileRoot, '')
    await expect(discoverLocalJsonl({
      root: fileRoot, sourceKind: 'codex', maxFiles: 1, sessionIdFromName: () => 'id',
    })).rejects.toMatchObject({ code: 'source-unsafe' })

    const aborted = new AbortController()
    aborted.abort()
    await expect(discoverLocalJsonl({
      root: await root(), sourceKind: 'codex', maxFiles: 1, signal: aborted.signal,
      sessionIdFromName: () => undefined,
    })).rejects.toThrow()

    const bounded = await root()
    await Promise.all(Array.from({ length: 21 }, (_, index) => writeFile(join(bounded, `junk-${index}`), '')))
    await expect(discoverLocalJsonl({
      root: bounded, sourceKind: 'codex', maxFiles: 1, sessionIdFromName: () => undefined,
    })).rejects.toMatchObject({ code: 'source-too-large' })

    const sorted = await root()
    await writeFile(join(sorted, 'b.jsonl'), '')
    await writeFile(join(sorted, 'a.jsonl'), '')
    await utimes(join(sorted, 'a.jsonl'), 1, 1)
    await utimes(join(sorted, 'b.jsonl'), 1, 1)
    const rows = await discoverLocalJsonl({
      root: sorted, sourceKind: 'codex', maxFiles: 1,
      sessionIdFromName: name => name.endsWith('.jsonl') ? name[0] : undefined,
    })
    expect(rows).toHaveLength(1)
  })

  it('captures stable prefixes and injects replacement, truncation, and path faults safely', async () => {
    const sourceRoot = await root()
    const path = join(sourceRoot, 'source.jsonl')
    await writeFile(path, '{}\n\n{"ok":true}\npartial')
    const records: unknown[] = []
    let appended = false
    const stable = await captureStableJsonl({
      root: sourceRoot,
      file: path,
      sourceKind: 'codex',
      maxSourceBytes: 1024,
      maxLineBytes: 128,
      onRecord: record => records.push(record.value),
      faults: {
        afterReadChunk: async () => {
          if (appended) return
          appended = true
          await appendFile(path, '\n{"late":true}\n')
        },
      },
    })
    expect(records).toEqual([{}, { ok: true }])
    expect(stable.trailingPartialRecordIgnored).toBe(true)
    expect(stable.capturedBytes).toBeLessThan((await stat(path)).size)

    const rewrite = join(sourceRoot, 'rewrite.jsonl')
    await writeFile(rewrite, '{"a":1}\n')
    await expect(captureStableJsonl({
      root: sourceRoot, file: rewrite, sourceKind: 'codex', maxSourceBytes: 100, maxLineBytes: 100,
      onRecord: () => {}, faults: { beforeRehash: () => writeFile(rewrite, '{"b":2}\n') },
    })).rejects.toMatchObject({ code: 'source-changed' })

    const split = join(sourceRoot, 'split.jsonl')
    const largeRecord = { text: 'x'.repeat(70_000) }
    await writeFile(split, line(largeRecord))
    const splitRecords: unknown[] = []
    await expect(captureStableJsonl({
      root: sourceRoot, file: split, sourceKind: 'codex', maxSourceBytes: 100_000, maxLineBytes: 100_000,
      onRecord: record => splitRecords.push(record.value),
    })).resolves.toMatchObject({ trailingPartialRecordIgnored: false })
    expect(splitRecords).toEqual([largeRecord])

    const midReadTruncate = join(sourceRoot, 'mid-read-truncate.jsonl')
    await writeFile(midReadTruncate, `${' '.repeat(70_000)}\n`)
    let truncated = false
    await expect(captureStableJsonl({
      root: sourceRoot,
      file: midReadTruncate,
      sourceKind: 'codex',
      maxSourceBytes: 100_000,
      maxLineBytes: 100_000,
      onRecord: () => {},
      faults: {
        afterReadChunk: async () => {
          if (truncated) return
          truncated = true
          await truncate(midReadTruncate, 0)
        },
      },
    })).rejects.toMatchObject({ code: 'source-changed' })

    const shortened = join(sourceRoot, 'short.jsonl')
    await writeFile(shortened, '{"a":1}\n')
    await expect(captureStableJsonl({
      root: sourceRoot, file: shortened, sourceKind: 'codex', maxSourceBytes: 100, maxLineBytes: 100,
      onRecord: () => {}, faults: { beforeRehash: () => truncate(shortened, 1) },
    })).rejects.toMatchObject({ code: 'source-changed' })

    const replaced = join(sourceRoot, 'replace.jsonl')
    const replacement = join(sourceRoot, 'replacement.jsonl')
    await writeFile(replaced, '{}\n')
    await writeFile(replacement, '{}\n')
    await expect(captureStableJsonl({
      root: sourceRoot, file: replaced, sourceKind: 'codex', maxSourceBytes: 100, maxLineBytes: 100,
      onRecord: () => {}, faults: { beforeFinalStat: () => rename(replacement, replaced) },
    })).rejects.toMatchObject({ code: 'source-changed' })
  })

  it('rejects unsafe files, malformed JSON, line and source bounds, and cancellation', async () => {
    const sourceRoot = await root()
    const missing = join(sourceRoot, 'missing.jsonl')
    const options = {
      root: sourceRoot, file: missing, sourceKind: 'codex' as const,
      maxSourceBytes: 10, maxLineBytes: 4, onRecord: () => {},
    }
    await expect(captureStableJsonl(options)).rejects.toMatchObject({ code: 'source-not-found' })
    await expect(captureStableJsonl({ ...options, file: sourceRoot })).rejects.toMatchObject({ code: 'source-unsafe' })

    const outsideRoot = await root()
    const outside = join(outsideRoot, 'outside.jsonl')
    await writeFile(outside, '{}\n')
    const link = join(sourceRoot, 'link.jsonl')
    await symlink(outside, link)
    await expect(captureStableJsonl({ ...options, file: link })).rejects.toMatchObject({ code: 'source-unsafe' })

    const large = join(sourceRoot, 'large.jsonl')
    await writeFile(large, '12345678901')
    await expect(captureStableJsonl({ ...options, file: large })).rejects.toMatchObject({ code: 'source-too-large' })
    const bad = join(sourceRoot, 'bad.jsonl')
    await writeFile(bad, 'bad\n')
    await expect(captureStableJsonl({ ...options, file: bad })).rejects.toMatchObject({ code: 'source-corrupt' })
    const long = join(sourceRoot, 'long.jsonl')
    await writeFile(long, '12345\n')
    await expect(captureStableJsonl({ ...options, file: long })).rejects.toMatchObject({ code: 'record-too-large' })
    const partial = join(sourceRoot, 'partial.jsonl')
    await writeFile(partial, '12345')
    await expect(captureStableJsonl({ ...options, file: partial })).rejects.toMatchObject({ code: 'record-too-large' })

    const cancelled = new AbortController()
    cancelled.abort('stop')
    await expect(captureStableJsonl({ ...options, file: outside, signal: cancelled.signal })).rejects.toThrow('aborted')
    const cancelledWithError = new AbortController()
    cancelledWithError.abort(new Error('caller stopped'))
    await expect(captureStableJsonl({ ...options, file: outside, signal: cancelledWithError.signal }))
      .rejects.toThrow('caller stopped')
  })

  it('registers its invariant companion without exposing source state', async () => {
    const dispose = () => {}
    const register = (name: string, install: (() => void) & { inject?: string[] }): (() => void) => {
      expect(name).toBe('@deepseek-ai/dsh-session-import-codex')
      expect(install.inject).toEqual(['sessionImports'])
      install()
      return dispose
    }
    await expect(applyInvariant({ invariants: { register } } as never)).resolves.toBe(dispose)
  })

  it('registers the provider plugin through the service definition', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionImportRegistry)
    apply(ctx, { root: await root(), maxCandidates: 2 })
    expect(ctx.sessionImports.listProviders()).toEqual(['codex'])
    await ctx.fiber.dispose()
  })
})
