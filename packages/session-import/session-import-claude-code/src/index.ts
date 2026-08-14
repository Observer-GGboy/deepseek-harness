/** Claude Code transcript JSONL provider for the neutral session-import seam. */

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
  ForeignVisibleMessage,
  StableJsonlRecord,
} from '@deepseek-ai/dsh-session-import'

export const name = 'session-import-claude-code'
export const inject = ['sessionImports']
const SOURCE_KIND = 'claude-code' as const
const CONVERTER_VERSION = 'claude-transcript-v1'
const DEFAULT_MAX_CANDIDATES = 500
const MIN_SUPPORTED_VERSION = [2, 1, 128] as const
const MAX_SUPPORTED_VERSION = [2, 1, 222] as const

/** Local Claude Code source configuration. */
export interface Config {
  /** Explicit supported root; defaults to the official projects root. */
  root?: string
  /** Maximum metadata rows returned by one discovery. */
  maxCandidates?: number
}

export const Config: s<Config> = s.object({
  root: s.string().default(join(homedir(), '.claude', 'projects')),
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

function assertSupportedVersion(version: string, record: number): void {
  const parsed = versionParts(version)
  if (parsed === undefined
    || compareVersion(parsed, MIN_SUPPORTED_VERSION) < 0
    || compareVersion(parsed, MAX_SUPPORTED_VERSION) > 0) {
    throw new ForeignSessionImportError(
      'unsupported-version', SOURCE_KIND, record,
      `claude-code version ${version} at record ${record} is unsupported`,
    )
  }
}

/**
 * Extract the session identity from a supported Claude transcript basename.
 * @param name One basename discovered beneath the supported Claude root.
 * @returns The session UUID, or `undefined` for unsupported basenames.
 */
export function claudeSessionIdFromName(name: string): string | undefined {
  const matched = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(name)
  return matched?.[1]
}

interface PendingMessage extends ForeignVisibleMessage {
  readonly id?: string
  readonly record: number
}

/** Selected-file parser. System/developer content is always excluded. */
class ClaudeCaptureParser {
  readonly accumulator: ForeignSnapshotAccumulator
  sourceVersion = ''
  cwdHint: string | undefined
  private sessionIdSeen = false
  private readonly versions = new Set<string>()
  private readonly recordIds = new Map<string, { kind: string; messageIndex?: number }>()
  private readonly messages: PendingMessage[] = []
  private readonly toolIndexes = new Map<string, number>()

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
    this.observeIdentity(row, record.index)
    if (row['isSidechain'] === true) return
    const type = row['type']
    switch (type) {
      case 'user':
      case 'assistant':
        this.messageRecord(type, row, timestamp, record.index)
        return
      case 'summary':
        this.summaryRecord(row, timestamp, record.index)
        return
      case 'system':
      case 'progress':
      case 'file-history-snapshot':
      case 'queue-operation':
      case 'last-prompt':
      case 'ai-title':
      case 'attachment':
      case 'custom-title':
      case 'mode':
      case 'pr-link':
      case 'frame-link':
        // Hidden instructions, usage/progress, and file snapshots are not
        // visible transcript context and cannot be imported.
        return
      default:
        throw new ForeignSessionImportError(
          'unsupported-version', SOURCE_KIND, record.index,
          `claude-code record ${record.index} uses an unsupported required record type`,
        )
    }
  }

  finish(): void {
    if (!this.sessionIdSeen) {
      throw new ForeignSessionImportError(
        'source-corrupt', SOURCE_KIND, undefined, 'claude-code source has no matching session identity',
      )
    }
    if (this.versions.size === 0) {
      throw new ForeignSessionImportError(
        'unsupported-version', SOURCE_KIND, undefined,
        'claude-code version unknown is unsupported',
      )
    }
    for (const message of this.messages) {
      this.accumulator.message(message, message.record)
    }
  }

  private observeIdentity(row: RecordMap, record: number): void {
    const sessionId = row['sessionId']
    if (sessionId !== undefined) {
      if (typeof sessionId !== 'string' || sessionId !== this.wantedId) this.corrupt(record)
      this.sessionIdSeen = true
    }
    const version = row['version']
    if (typeof version === 'string') {
      assertSupportedVersion(version, record)
      this.versions.add(version)
      const ordered = [...this.versions].sort((left, right) =>
        left.localeCompare(right, 'en', { numeric: true }))
      this.sourceVersion = ordered.length === 1 ? version : `${ordered[0]}..${ordered.at(-1)}`
    }
    const cwd = row['cwd']
    if (typeof cwd === 'string' && isAbsolute(cwd)) this.cwdHint = resolve(cwd)
  }

  private messageRecord(
    type: 'user' | 'assistant',
    row: RecordMap,
    timestamp: number | undefined,
    record: number,
  ): void {
    const message = row['message']
    if (!isRecord(message) || (message['role'] !== type && message['role'] !== undefined)) this.corrupt(record)
    const uuid = typeof row['uuid'] === 'string' ? row['uuid'] : undefined
    const blocks = this.contentBlocks(message['content'], type, timestamp, record)
    const text = blocks.join('')
    if (uuid !== undefined) {
      const previous = this.recordIds.get(uuid)
      if (previous !== undefined) {
        if (type !== 'assistant' || previous.kind !== 'assistant' || previous.messageIndex === undefined) {
          throw new ForeignSessionImportError(
            'duplicate-record', SOURCE_KIND, record,
            `claude-code record ${record} duplicates a record id`,
          )
        }
        const old = this.messages[previous.messageIndex]
        if (old === undefined || (!text.startsWith(old.text) && !old.text.startsWith(text))) {
          throw new ForeignSessionImportError(
            'duplicate-record', SOURCE_KIND, record,
            `claude-code record ${record} conflicts with an assistant update`,
          )
        }
        if (text.length > old.text.length) {
          this.messages[previous.messageIndex] = {
            ...old,
            text,
            record,
            ...timestamp === undefined ? {} : { timestamp },
          }
        }
        return
      }
    }
    const messageIndex = this.messages.length
    // Keep even an empty assistant draft so a later record with the same UUID
    // can grow it into the final visible update without looking like a duplicate.
    this.messages.push({
      role: type,
      text,
      record,
      ...uuid === undefined ? {} : { id: uuid },
      ...timestamp === undefined ? {} : { timestamp },
    })
    if (uuid !== undefined) {
      this.recordIds.set(uuid, {
        kind: type,
        messageIndex,
      })
    }
  }

  private contentBlocks(
    content: unknown,
    role: 'user' | 'assistant',
    timestamp: number | undefined,
    record: number,
  ): string[] {
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return []
    const text: string[] = []
    for (const block of content) {
      if (!isRecord(block) || typeof block['type'] !== 'string') this.corrupt(record)
      switch (block['type']) {
        case 'text':
          if (typeof block['text'] === 'string') text.push(block['text'])
          break
        case 'tool_use': {
          if (role !== 'assistant') this.corrupt(record)
          const id = typeof block['id'] === 'string' ? block['id'] : `record-${record}`
          // Repeated assistant streaming snapshots repeat already-seen tool
          // blocks. The stable id makes that update an exact no-op.
          if (this.toolIndexes.has(id)) break
          const name = typeof block['name'] === 'string' ? block['name'] : 'tool'
          this.toolIndexes.set(id, this.accumulator.tools.length)
          this.accumulator.tool({
            name,
            status: 'unknown',
            ...timestamp === undefined ? {} : { timestamp },
          }, record)
          break
        }
        case 'tool_result': {
          const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined
          const index = id === undefined ? undefined : this.toolIndexes.get(id)
          if (index !== undefined) {
            const previous = this.accumulator.tools[index]
            /* v8 ignore next -- the index comes from the append-only tool array at registration. */
            if (previous !== undefined) {
              this.accumulator.tools[index] = Object.freeze({
                ...previous,
                status: block['is_error'] === true ? 'failed' : 'completed',
              })
            }
          }
          // Result content and attachment references are intentionally absent.
          break
        }
        case 'thinking':
        case 'redacted_thinking':
        case 'image':
        case 'document':
        case 'fallback':
          // Internal reasoning and binary/path-bearing attachments are excluded.
          break
        default:
          throw new ForeignSessionImportError(
            'unsupported-version', SOURCE_KIND, record,
            `claude-code record ${record} uses an unsupported content block`,
          )
      }
    }
    return text
  }

  private summaryRecord(row: RecordMap, timestamp: number | undefined, record: number): void {
    const summary = row['summary']
    if (typeof summary !== 'string') this.corrupt(record)
    this.messages.push({
      role: 'user',
      text: `[Imported generated summary; untrusted historical context]\n${summary}`,
      record,
      ...timestamp === undefined ? {} : { timestamp },
    })
  }

  private corrupt(record: number): never {
    throw new ForeignSessionImportError(
      'source-corrupt', SOURCE_KIND, record,
      `claude-code record ${record} has an invalid required shape`,
    )
  }
}

/** Provider over one configured Claude Code projects root. */
export class ClaudeCodeSessionImportProvider implements ForeignSessionProvider {
  readonly sourceKind = SOURCE_KIND
  private readonly root: string
  private readonly maxCandidates: number

  constructor(config: Config = {}) {
    this.root = resolve(config.root ?? join(homedir(), '.claude', 'projects'))
    this.maxCandidates = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  }

  async discover(signal?: AbortSignal): Promise<readonly ForeignSessionCandidate[]> {
    const candidates = await discoverLocalJsonl({
      root: this.root,
      sourceKind: SOURCE_KIND,
      maxFiles: this.maxCandidates,
      ...signal === undefined ? {} : { signal },
      sessionIdFromName: claudeSessionIdFromName,
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
      sessionIdFromName: claudeSessionIdFromName,
    })).filter(candidate => candidate.row.sourceSessionId === request.sourceSessionId)
    const selected = matches[0]
    if (selected === undefined) {
      throw new ForeignSessionImportError('source-not-found', SOURCE_KIND, undefined, 'claude-code source is unavailable')
    }
    if (matches.length > 1) {
      throw new ForeignSessionImportError('source-ambiguous', SOURCE_KIND, undefined, 'claude-code session id is not unique')
    }
    const parser = new ClaudeCaptureParser(request.sourceSessionId, request)
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

/** Register the Claude Code provider. */
export function apply(ctx: Context, config: Config): void {
  ctx.sessionImports.registerProvider(new ClaudeCodeSessionImportProvider(config))
}
