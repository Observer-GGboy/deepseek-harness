/** Codex rollout JSONL provider for the neutral session-import seam. */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import {
  captureStableJsonl,
  discoverLocalJsonl,
  foreignTimestamp,
  ForeignSessionImportError,
  ForeignSnapshotAccumulator,
} from '@deepseek-ai/dsh-session-import'
import type {
  ForeignSessionCandidate,
  ForeignSessionCaptureRequest,
  ForeignSessionProvider,
  ForeignSessionSnapshot,
  StableJsonlRecord,
} from '@deepseek-ai/dsh-session-import'

export const name = 'session-import-codex'
export const inject = ['sessionImports']
const SOURCE_KIND = 'codex' as const
const CONVERTER_VERSION = 'codex-rollout-v1'
const DEFAULT_MAX_CANDIDATES = 500
const MIN_SUPPORTED_VERSION = [0, 144, 0] as const
const MAX_SUPPORTED_VERSION = [0, 148, 999] as const

/** Local Codex source configuration. */
export interface Config {
  /** Explicit supported root; defaults to the official local sessions root. */
  root?: string
  /** Maximum metadata rows returned by one discovery. */
  maxCandidates?: number
}

export const Config: s<Config> = s.object({
  root: s.string().default(join(homedir(), '.codex', 'sessions')),
  maxCandidates: s.natural().min(1).default(DEFAULT_MAX_CANDIDATES),
})

type RecordMap = Record<string, unknown>
const isRecord = (value: unknown): value is RecordMap =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function versionParts(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(version)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}

function assertSupportedVersion(version: unknown, record: number): string {
  if (typeof version !== 'string') {
    throw new ForeignSessionImportError(
      'unsupported-version', SOURCE_KIND, record,
      `codex version unknown at record ${record} is unsupported`,
    )
  }
  const parsed = versionParts(version)
  if (parsed === undefined
    || compareVersion(parsed, MIN_SUPPORTED_VERSION) < 0
    || compareVersion(parsed, MAX_SUPPORTED_VERSION) > 0) {
    throw new ForeignSessionImportError(
      'unsupported-version', SOURCE_KIND, record,
      `codex version ${version} at record ${record} is unsupported`,
    )
  }
  return version
}

/**
 * Extract the thread identity from a supported Codex rollout basename.
 * @param name One basename discovered beneath the supported Codex root.
 * @returns The thread UUID, or `undefined` for unsupported basenames.
 */
export function codexSessionIdFromName(name: string): string | undefined {
  const matched = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(name)
  return matched?.[1]
}

function textParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part): string[] => {
    if (!isRecord(part)) return []
    if (part['type'] !== 'input_text' && part['type'] !== 'output_text' && part['type'] !== 'text') return []
    return typeof part['text'] === 'string' ? [part['text']] : []
  }).join('')
}

/** Selected-file parser. Unknown structural records fail closed. */
class CodexCaptureParser {
  readonly accumulator: ForeignSnapshotAccumulator
  sourceVersion = ''
  cwdHint: string | undefined
  private metaSeen = false
  private metaId: string | undefined
  private readonly versions = new Set<string>()
  private readonly calls = new Map<string, number>()

  constructor(
    private readonly wantedId: string,
    request: ForeignSessionCaptureRequest,
  ) {
    this.accumulator = new ForeignSnapshotAccumulator(SOURCE_KIND, request.limits)
  }

  parse(record: StableJsonlRecord): void {
    if (!isRecord(record.value)) this.corrupt(record.index)
    const row = record.value
    const timestamp = foreignTimestamp(row['timestamp'])
    this.accumulator.observeTimestamp(timestamp, record.index)
    const type = row['type']
    const payload = row['payload']
    if (type === 'session_meta') {
      this.sessionMeta(payload, record.index)
      return
    }
    if (!this.metaSeen) this.corrupt(record.index)
    switch (type) {
      case 'response_item':
        this.responseItem(payload, timestamp, record.index)
        return
      case 'event_msg':
        this.eventMessage(payload, timestamp, record.index)
        return
      case 'compacted':
        this.compacted(payload, timestamp, record.index)
        return
      case 'turn_context':
      case 'world_state':
      case 'inter_agent_communication_metadata':
        // Host/world/subagent metadata is not visible conversation context.
        return
      default:
        throw new ForeignSessionImportError(
          'unsupported-version', SOURCE_KIND, record.index,
          `codex record ${record.index} uses an unsupported required record type`,
        )
    }
  }

  finish(): void {
    if (!this.metaSeen || this.metaId !== this.wantedId) {
      throw new ForeignSessionImportError(
        'source-corrupt', SOURCE_KIND, undefined, 'codex source has no matching session metadata',
      )
    }
  }

  private sessionMeta(value: unknown, record: number): void {
    if (!isRecord(value) || typeof value['id'] !== 'string') this.corrupt(record)
    const id = value['id']
    if (id !== this.wantedId || (this.metaId !== undefined && this.metaId !== id)) this.corrupt(record)
    this.metaSeen = true
    this.metaId = id
    this.versions.add(assertSupportedVersion(value['cli_version'], record))
    this.sourceVersion = [...this.versions].sort((left, right) => {
      return left.localeCompare(right, 'en', { numeric: true })
    }).join('+')
    const cwd = value['cwd']
    if (typeof cwd === 'string' && isAbsolute(cwd)) this.cwdHint = resolve(cwd)
  }

  private responseItem(value: unknown, timestamp: number | undefined, record: number): void {
    if (!isRecord(value) || typeof value['type'] !== 'string') this.corrupt(record)
    const type = value['type']
    if (type === 'message') {
      const role = value['role']
      if (role === 'user' || role === 'assistant') {
        this.accumulator.message({
          role,
          text: textParts(value['content']),
          ...timestamp === undefined ? {} : { timestamp },
        }, record)
      }
      // system/developer/tool roles are intentionally non-importable.
      return
    }
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call'
      || type === 'web_search_call' || type === 'computer_tool_call') {
      const callId = typeof value['call_id'] === 'string'
        ? value['call_id']
        : typeof value['id'] === 'string' ? value['id'] : `record-${record}`
      if (this.calls.has(callId)) {
        throw new ForeignSessionImportError(
          'duplicate-record', SOURCE_KIND, record, `codex record ${record} duplicates a tool call id`,
        )
      }
      const name = typeof value['name'] === 'string' ? value['name'] : type
      this.calls.set(callId, this.accumulator.tools.length)
      this.accumulator.tool({
        name,
        status: 'unknown',
        ...timestamp === undefined ? {} : { timestamp },
      }, record)
      return
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const callId = typeof value['call_id'] === 'string' ? value['call_id'] : undefined
      const index = callId === undefined ? undefined : this.calls.get(callId)
      if (index !== undefined) {
        const previous = this.accumulator.tools[index]
        /* v8 ignore next -- the index comes from the append-only tool array at registration. */
        if (previous !== undefined) {
          this.accumulator.tools[index] = Object.freeze({ ...previous, status: 'completed' })
        }
      }
      // Output bodies are never retained.
      return
    }
    if (type === 'reasoning' || type === 'agent_message' || type === 'ghost_snapshot') return
    throw new ForeignSessionImportError(
      'unsupported-version', SOURCE_KIND, record,
      `codex record ${record} uses an unsupported response item`,
    )
  }

  private eventMessage(value: unknown, timestamp: number | undefined, record: number): void {
    if (!isRecord(value) || typeof value['type'] !== 'string') this.corrupt(record)
    switch (value['type']) {
      case 'user_message':
        this.accumulator.message({
          role: 'user',
          text: typeof value['message'] === 'string' ? value['message'] : '',
          ...timestamp === undefined ? {} : { timestamp },
        }, record)
        return
      case 'agent_message':
        this.accumulator.message({
          role: 'assistant',
          text: typeof value['message'] === 'string' ? value['message'] : '',
          ...timestamp === undefined ? {} : { timestamp },
        }, record)
        return
      case 'turn_aborted': {
        const last = this.accumulator.messages.at(-1)
        if (last !== undefined) this.accumulator.messages[this.accumulator.messages.length - 1] = { ...last, interrupted: true }
        return
      }
      case 'context_compacted':
      case 'task_started':
      case 'task_complete':
      case 'token_count':
      case 'agent_reasoning':
      case 'stream_error':
      case 'mcp_tool_call_end':
      case 'patch_apply_end':
      case 'sub_agent_activity':
      case 'thread_settings_applied':
      case 'web_search_end':
        return
      default:
        throw new ForeignSessionImportError(
          'unsupported-version', SOURCE_KIND, record,
          `codex record ${record} uses an unsupported event message`,
        )
    }
  }

  private compacted(value: unknown, timestamp: number | undefined, record: number): void {
    if (!isRecord(value)) this.corrupt(record)
    const summary = typeof value['summary'] === 'string'
      ? value['summary']
      : typeof value['content'] === 'string' ? value['content'] : ''
    if (summary !== '') {
      this.accumulator.message({
        role: 'user',
        text: `[Imported generated summary; untrusted historical context]\n${summary}`,
        ...timestamp === undefined ? {} : { timestamp },
      }, record)
    }
  }

  private corrupt(record: number): never {
    throw new ForeignSessionImportError(
      'source-corrupt', SOURCE_KIND, record, `codex record ${record} has an invalid required shape`,
    )
  }
}

/** Provider over one configured Codex sessions root. */
export class CodexSessionImportProvider implements ForeignSessionProvider {
  readonly sourceKind = SOURCE_KIND
  private readonly root: string
  private readonly maxCandidates: number

  constructor(config: Config = {}) {
    this.root = resolve(config.root ?? join(homedir(), '.codex', 'sessions'))
    this.maxCandidates = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  }

  async discover(signal?: AbortSignal): Promise<readonly ForeignSessionCandidate[]> {
    const candidates = await discoverLocalJsonl({
      root: this.root,
      sourceKind: SOURCE_KIND,
      maxFiles: this.maxCandidates,
      ...signal === undefined ? {} : { signal },
      sessionIdFromName: codexSessionIdFromName,
    })
    return candidates.map(candidate => Object.freeze(candidate.row))
  }

  async capture(request: ForeignSessionCaptureRequest): Promise<ForeignSessionSnapshot> {
    request.signal?.throwIfAborted()
    const matches = (await discoverLocalJsonl({
      root: this.root,
      sourceKind: SOURCE_KIND,
      maxFiles: Math.max(this.maxCandidates, 10_000),
      ...request.signal === undefined ? {} : { signal: request.signal },
      sessionIdFromName: codexSessionIdFromName,
    })).filter(candidate => candidate.row.sourceSessionId === request.sourceSessionId)
    const selected = matches[0]
    if (selected === undefined) {
      throw new ForeignSessionImportError('source-not-found', SOURCE_KIND, undefined, 'codex source is unavailable')
    }
    if (matches.length > 1) {
      throw new ForeignSessionImportError('source-ambiguous', SOURCE_KIND, undefined, 'codex session id is not unique')
    }
    const parser = new CodexCaptureParser(request.sourceSessionId, request)
    const capturedAt = Date.now()
    const capture = await captureStableJsonl({
      root: this.root,
      file: selected.file,
      sourceKind: SOURCE_KIND,
      maxSourceBytes: request.limits.maxSourceBytes,
      maxLineBytes: request.limits.maxLineBytes,
      ...request.signal === undefined ? {} : { signal: request.signal },
      onRecord: (record) => { parser.parse(record) },
    })
    parser.finish()
    return Object.freeze({
      provenance: Object.freeze({
        sourceKind: SOURCE_KIND,
        sourceSessionId: request.sourceSessionId,
        sourceVersion: parser.sourceVersion,
        capturedAt,
        prefixDigest: capture.prefixDigest,
        converterVersion: CONVERTER_VERSION,
      }),
      sourceIdentity: `${SOURCE_KIND}:${capture.sourceIdentity}:${request.sourceSessionId}`,
      ...parser.cwdHint === undefined ? {} : { cwdHint: parser.cwdHint },
      messages: Object.freeze([...parser.accumulator.messages]),
      tools: Object.freeze([...parser.accumulator.tools]),
      capturedBytes: capture.capturedBytes,
      contextBytes: parser.accumulator.contextBytes,
      trailingPartialRecordIgnored: capture.trailingPartialRecordIgnored,
    })
  }
}

/** Register the Codex provider. */
export function apply(ctx: Context, config: Config): void {
  ctx.sessionImports.registerProvider(new CodexSessionImportProvider(config))
}
