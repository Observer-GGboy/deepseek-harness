/**
 * Host consumer for local-session providers: selected capture reservations,
 * neutral-to-native conversion, idempotent persistence, and Remote methods.
 * @module @deepseek-ai/dsh-session-import-local
 */

import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { freezeMessage, MessageId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-token-meter'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import {
  ForeignSessionImportError,
  redactForeignText,
} from '@deepseek-ai/dsh-session-import'
import type {
  ForeignSessionCaptureLimits,
  ForeignSessionProvider,
  ForeignSessionProvenance,
  ForeignSessionSnapshot,
} from '@deepseek-ai/dsh-session-import'
import type {
  SessionImportCaptureRequest,
  SessionImportCaptureValue,
  SessionImportCommitRequest,
  SessionImportCommitValue,
  SessionImportDiscoverRequest,
  SessionImportDiscoverValue,
  SessionImportDiscardRequest,
  SessionImportDiscardValue,
  SessionImportFailure,
  SessionImportOptionsValue,
  SessionImportResult,
} from './types.ts'

export type * from './types.ts'

/** Persisted, purely informational import provenance. */
export interface SessionImportedEventData extends ForeignSessionProvenance {
  readonly capturedBytes: number
  readonly contextBytes: number
  readonly messageCount: number
  readonly toolCount: number
  readonly trailingPartialRecordIgnored: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Safe origin facts for one immutable foreign snapshot; never model-visible. */
    'session/imported': SessionImportedEventData
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionImportLocal: LocalSessionImportService
  }
}

/** Required import budgets and reservation ownership. */
export interface Config extends ForeignSessionCaptureLimits {
  /** Maximum metadata rows returned to one discovery request. */
  readonly maxDiscoveryItems: number
  /** Maximum retained selected snapshots across tabs. */
  readonly maxReservations: number
  /** Maximum UTF-8 bytes of the inert historical-tool summary. */
  readonly maxToolSummaryBytes: number
}

export const Config: s<Config> = s.object({
  maxSourceBytes: s.natural().min(1).default(64 * 1024 * 1024),
  maxLineBytes: s.natural().min(1).default(1024 * 1024),
  maxVisibleContextBytes: s.natural().min(1).default(64 * 1024 * 1024),
  maxVisibleMessages: s.natural().min(1).default(10_000),
  maxToolActivities: s.natural().default(1_000),
  maxDiscoveryItems: s.natural().min(1).default(500),
  maxReservations: s.natural().min(1).default(32),
  maxToolSummaryBytes: s.natural().min(1).default(64 * 1024),
})

interface ReservationTarget {
  readonly workspaceId: string
  readonly agentPreset: string
  readonly provider: string
  readonly model: string
}

interface Reservation {
  readonly id: string
  readonly snapshot: ForeignSessionSnapshot
  readonly insertedAt: number
  chosen: ReservationTarget | undefined
  commit: Promise<SessionImportResult<SessionImportCommitValue>> | undefined
  controller: AbortController | undefined
  waiters: number
  settled: boolean
}

const success = <T>(value: T): SessionImportResult<T> => Object.freeze({ ok: true, value: Object.freeze(value) })
const WINNER_INSPECTION_ATTEMPTS = 50
const WINNER_INSPECTION_DELAY_MS = 5
const rejected = <T>(error: SessionImportFailure): SessionImportResult<T> =>
  Object.freeze({ ok: false, error: Object.freeze(error) })

function failure(error: unknown): SessionImportFailure {
  if (error instanceof ForeignSessionImportError) {
    return {
      code: error.code,
      message: error.message,
      sourceKind: error.sourceKind,
      ...error.record === undefined ? {} : { record: error.record },
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'cancelled', message: 'Local session import was cancelled.' }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'cancelled', message: 'Local session import was cancelled.' }
  }
  // Unknown filesystem/provider errors can carry paths or source content in
  // their message. Never forward or log them at this boundary.
  return { code: 'internal', message: 'Local session import failed without publishing a partial session.' }
}

/**
 * Derive the stable target identity for one selected captured prefix.
 * @param snapshot Validated provider-neutral snapshot.
 * @returns Deterministic Harness session identity.
 */
export function importedSessionId(snapshot: ForeignSessionSnapshot): SessionId {
  const hash = createHash('sha256')
    .update('dsh-local-session-import-v1\0')
    .update(snapshot.sourceIdentity)
    .update('\0')
    .update(snapshot.provenance.prefixDigest)
    .digest('hex')
  return brandSessionId(`import-${hash.slice(0, 48)}`)
}

/** Deterministic message identity so concurrent writers propose equivalent graphs. */
function importedMessageId(sessionId: SessionId, index: number): MessageId {
  return MessageId(createHash('sha256').update(`${sessionId}\0message\0${index}`).digest('hex'))
}

/** Format inert tool history. Arguments, output, and paths never enter this text. */
function toolSummary(snapshot: ForeignSessionSnapshot, maxBytes: number): string | undefined {
  if (snapshot.tools.length === 0) return undefined
  const lines = [
    '[Imported historical tool activity; inert metadata only. Nothing below was executed by DeepSeek Harness.]',
    ...snapshot.tools.map((tool) => {
      const name = tool.name.replace(/[^A-Za-z0-9_.:/-]/gu, '?').slice(0, 128) || 'unknown'
      return `- ${name}: ${tool.status}`
    }),
  ]
  const text = lines.join('\n')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ForeignSessionImportError(
      'context-too-large', snapshot.provenance.sourceKind, undefined,
      `${snapshot.provenance.sourceKind} tool summary exceeds the configured import budget`,
    )
  }
  return text
}

/**
 * Convert once from neutral values to a balanced, continuous native log.
 * @param snapshot Validated provider-neutral snapshot.
 * @param header Confirmed native session header.
 * @param maxToolSummaryBytes Maximum UTF-8 bytes allowed for inert tool facts.
 * @param continuation Confirmed model route and assembled request composition.
 * @returns Complete native seed events ready for atomic publication.
 */
export function convertForeignSnapshot(
  snapshot: ForeignSessionSnapshot,
  header: SessionHeader,
  maxToolSummaryBytes: number,
  continuation: {
    readonly provider: string
    readonly model: string
    readonly contextWindow: number
    readonly maxTokens?: number
    readonly system?: string
    readonly tools?: readonly ToolSchema[]
  },
): SessionEvent[] {
  const events: SessionEvent[] = []
  const push = <Type extends keyof SessionEventMap>(
    type: Type,
    data: SessionEventMap[Type],
    options: Type extends 'user/message' | 'assistant/message' | 'tool/result'
      ? { surfaceOp: 'append' }
      : { ignorable?: true } = {} as never,
  ): void => {
    const event = {
      type,
      seq: events.length,
      time: header.createdAt + events.length,
      data,
      ...options,
    } as SessionEvent
    events.push(event)
  }

  push('session/imported', {
    ...snapshot.provenance,
    capturedBytes: snapshot.capturedBytes,
    contextBytes: snapshot.contextBytes,
    messageCount: snapshot.messages.length,
    toolCount: snapshot.tools.length,
    trailingPartialRecordIgnored: snapshot.trailingPartialRecordIgnored,
  }, { ignorable: true })

  const visible: Array<{ role: 'user' | 'assistant'; text: string; interrupted?: true }> = []
  const tools = toolSummary(snapshot, maxToolSummaryBytes)
  if (tools !== undefined) visible.push({ role: 'user', text: tools })
  visible.push(...snapshot.messages.map(message => ({
    role: message.role,
    text: redactForeignText(message.text),
    ...message.interrupted === true ? { interrupted: true as const } : {},
  })))

  visible.forEach((message, index) => {
    const turn = index + 1
    push('turn/start', { turn })
    if (message.role === 'user') {
      push('user/message', freezeMessage({
        id: importedMessageId(header.id, index),
        role: 'user',
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'plugin', plugin: 'session-import' },
      }), { surfaceOp: 'append' })
    } else {
      push('step/start', { turn, step: 1 })
      push('assistant/message', {
        turn,
        step: 1,
        message: freezeMessage({
          id: importedMessageId(header.id, index),
          role: 'assistant',
          content: [{ type: 'text', text: message.text }],
          source: {
            kind: 'model',
            provider: `imported-${snapshot.provenance.sourceKind}`,
            model: 'historical',
          },
        }),
      }, { surfaceOp: 'append' })
      push('step/end', { turn, step: 1 })
    }
    push('turn/end', {
      turn,
      reason: message.interrupted === true
        ? { kind: 'aborted', reason: { kind: 'user' } }
        : { kind: 'completed' },
    })
  })
  push('request/header', {
    header: {
      config: {
        provider: continuation.provider,
        model: continuation.model,
        ...continuation.maxTokens === undefined ? {} : { maxTokens: continuation.maxTokens },
      },
      ...continuation.system === undefined || continuation.system.length === 0
        ? {}
        : { system: continuation.system },
      ...continuation.tools === undefined || continuation.tools.length === 0
        ? {}
        : { tools: [...continuation.tools] },
    },
    reason: 'change',
  })
  push('request/context', {
    provider: continuation.provider,
    model: continuation.model,
    contextWindow: continuation.contextWindow,
  }, { ignorable: true })
  return events
}

/** Find and verify the persisted import provenance. */
function matchingImport(
  snapshot: ForeignSessionSnapshot,
  header: SessionHeader,
  events: readonly SessionEvent[],
  cwd: string,
  preset: string,
  provider: string,
  model: string,
): boolean {
  if (header.cwd !== cwd || header.agentPreset !== preset) return false
  const imported = events.find(event => event.type === 'session/imported')
  const continuation = [...events].reverse().find(event => event.type === 'request/header')
  if (imported?.type !== 'session/imported') return false
  if (continuation?.type !== 'request/header'
    || continuation.data.header.config.provider !== provider
    || continuation.data.header.config.model !== model) return false
  return imported.data.sourceKind === snapshot.provenance.sourceKind
    && imported.data.sourceSessionId === snapshot.provenance.sourceSessionId
    && imported.data.prefixDigest === snapshot.provenance.prefixDigest
    && imported.data.converterVersion === snapshot.provenance.converterVersion
}

/** Host Remote consumer. Providers remain separately registered on `ctx.sessionImports`. */
export class LocalSessionImportService extends TypertRemoteService {
  static inject = [
    'sessionImports', 'sessionPersistence', 'sessions', 'workspaceRegistry',
    'agentPresets', 'llm', 'tokenMeter', 'systemPrompt',
  ]
  static Config = Config
  private readonly reservations = new Map<string, Reservation>()
  private accepting = true

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'sessionImportLocal')
    ctx.effect(() => () => {
      this.accepting = false
      for (const reservation of this.reservations.values()) {
        reservation.controller?.abort(new DOMException('Service disposed', 'AbortError'))
      }
      this.reservations.clear()
    }, 'session-import-local.dispose')
  }

  /**
   * Current source/workspace/preset/model choices for the confirmation screen.
   * @param signal Remote request cancellation signal.
   * @returns Available source kinds and explicit continuation targets.
   */
  @Remote('options')
  async options(signal: AbortSignal): Promise<SessionImportResult<SessionImportOptionsValue>> {
    try {
      signal.throwIfAborted()
      const presets = (await this.ctx.agentPresets.list())
        .filter(preset => preset.broken === undefined)
        .map(preset => ({ id: preset.id, name: preset.name ?? preset.id }))
      signal.throwIfAborted()
      const models = []
      for (const provider of this.ctx.llm.listProviders()) {
        const listed = await this.ctx.llm.listModels(provider.id).catch(() => [])
        for (const listedModel of listed) {
          const info = await this.ctx.llm.resolveModelInfo(provider.id, listedModel.id, signal)
            .catch(() => undefined)
          if (info?.context === undefined) continue
          const usableImportTokens = this.usableImportTokens(info)
          if (usableImportTokens <= 0) continue
          models.push({
            provider: provider.id,
            model: listedModel.id,
            name: `${provider.name} — ${listedModel.name}`,
            contextWindow: info.context.contextWindow,
            usableImportTokens,
          })
        }
      }
      signal.throwIfAborted()
      return success({
        sourceKinds: this.ctx.sessionImports.listProviders(),
        workspaces: this.ctx.workspaceRegistry.list().map(workspace => ({
          id: String(workspace.id), title: workspace.title, path: workspace.path,
        })),
        presets,
        models,
      })
    } catch (error) {
      return rejected(failure(error))
    }
  }

  /**
   * Metadata-only discovery for one explicitly chosen provider.
   * @param request Chosen source kind.
   * @param signal Remote request cancellation signal.
   * @returns Bounded source metadata rows without transcript content.
   */
  @Remote('discover')
  async discover(
    request: SessionImportDiscoverRequest,
    signal: AbortSignal,
  ): Promise<SessionImportResult<SessionImportDiscoverValue>> {
    const provider = this.ctx.sessionImports.getProvider(request.sourceKind)
    if (provider === undefined) {
      return rejected({
        code: 'provider-unavailable', sourceKind: request.sourceKind,
        message: `${request.sourceKind} import provider is unavailable.`,
      })
    }
    try {
      const items = await provider.discover(signal)
      signal.throwIfAborted()
      if (items.length > this.config.maxDiscoveryItems) {
        throw new ForeignSessionImportError(
          'source-too-large', request.sourceKind, undefined,
          `${request.sourceKind} discovery exceeds the configured result budget`,
        )
      }
      for (const item of items) this.validateCandidate(item, request.sourceKind)
      return success({ items: items.map(item => ({ ...item })) })
    } catch (error) {
      return rejected(failure(error))
    }
  }

  /**
   * Capture a selected stable prefix behind an opaque reservation.
   * @param request Explicitly selected source identity.
   * @param signal Remote request cancellation signal.
   * @returns Sanitized counts and an opaque one-shot reservation identity.
   */
  @Remote('capture')
  async capture(
    request: SessionImportCaptureRequest,
    signal: AbortSignal,
  ): Promise<SessionImportResult<SessionImportCaptureValue>> {
    if (!this.accepting) return rejected({ code: 'internal', message: 'Local session import is shutting down.' })
    const provider = this.ctx.sessionImports.getProvider(request.sourceKind)
    if (provider === undefined) {
      return rejected({
        code: 'provider-unavailable', sourceKind: request.sourceKind,
        message: `${request.sourceKind} import provider is unavailable.`,
      })
    }
    try {
      const snapshot = await provider.capture({
        sourceSessionId: request.sourceSessionId,
        limits: this.config,
        signal,
      })
      signal.throwIfAborted()
      this.validateSnapshot(snapshot, request)
      if (snapshot.messages.length === 0 && snapshot.tools.length === 0) {
        throw new ForeignSessionImportError(
          'source-corrupt', request.sourceKind, undefined,
          `${request.sourceKind} source contains no safe visible context`,
        )
      }
      while (this.reservations.size >= this.config.maxReservations) {
        const oldest = [...this.reservations.values()]
          .filter(candidate => candidate.commit === undefined)
          .sort((left, right) => left.insertedAt - right.insertedAt)[0]
        if (oldest === undefined) {
          return rejected({ code: 'internal', message: 'Too many local session imports are currently committing.' })
        }
        this.reservations.delete(oldest.id)
      }
      const id = randomUUID()
      this.reservations.set(id, {
        id,
        snapshot,
        insertedAt: Date.now(),
        chosen: undefined,
        commit: undefined,
        controller: undefined,
        waiters: 0,
        settled: false,
      })
      return success({
        reservationId: id,
        sourceKind: snapshot.provenance.sourceKind,
        sourceSessionId: snapshot.provenance.sourceSessionId,
        capturedAt: snapshot.provenance.capturedAt,
        capturedBytes: snapshot.capturedBytes,
        contextBytes: snapshot.contextBytes,
        messageCount: snapshot.messages.length,
        toolCount: snapshot.tools.length,
        ...snapshot.cwdHint === undefined ? {} : { cwdHint: snapshot.cwdHint },
        trailingPartialRecordIgnored: snapshot.trailingPartialRecordIgnored,
      })
    } catch (error) {
      return rejected(failure(error))
    }
  }

  /**
   * Atomically publish after explicit workspace, preset, and model confirmation.
   * @param request Reservation and confirmed continuation targets.
   * @param signal Remote request cancellation signal.
   * @returns Published session identity and idempotency/attachment status.
   */
  @Remote('commit')
  commit(
    request: SessionImportCommitRequest,
    signal: AbortSignal,
  ): Promise<SessionImportResult<SessionImportCommitValue>> {
    const reservation = this.reservations.get(request.reservationId)
    if (reservation === undefined) {
      return Promise.resolve(rejected({ code: 'reservation-not-found', message: 'The captured import is no longer available.' }))
    }
    if (signal.aborted) {
      return Promise.resolve(rejected({ code: 'cancelled', message: 'Local session import was cancelled.' }))
    }
    const chosen = reservation.chosen
    if (chosen !== undefined
      && (chosen.workspaceId !== request.workspaceId
        || chosen.agentPreset !== request.agentPreset
        || chosen.provider !== request.provider
        || chosen.model !== request.model)) {
      return Promise.resolve(rejected({
        code: 'target-conflict',
        message: 'This captured import is already committing with different workspace or preset choices.',
      }))
    }
    if (reservation.commit === undefined) {
      reservation.chosen = {
        workspaceId: request.workspaceId,
        agentPreset: request.agentPreset,
        provider: request.provider,
        model: request.model,
      }
      reservation.controller = new AbortController()
      reservation.settled = false
      reservation.commit = this.commitReservation(reservation, request, reservation.controller.signal)
      reservation.commit.then((result) => {
        reservation.settled = true
        if (result.ok) this.reservations.delete(reservation.id)
        else {
          reservation.commit = undefined
          reservation.controller = undefined
          reservation.chosen = undefined
        }
      }).catch(() => {
        reservation.settled = true
        reservation.commit = undefined
        reservation.controller = undefined
        reservation.chosen = undefined
      })
    }
    return this.watchCommit(reservation, signal)
  }

  /** Give each caller independent cancellation while one target commit stays single-flight. */
  private watchCommit(
    reservation: Reservation,
    signal: AbortSignal,
  ): Promise<SessionImportResult<SessionImportCommitValue>> {
    const commit = reservation.commit
    if (commit === undefined) {
      return Promise.resolve(rejected({ code: 'internal', message: 'Local session import commit was not started.' }))
    }
    reservation.waiters += 1
    return new Promise<SessionImportResult<SessionImportCommitValue>>((resolve) => {
      let done = false
      const finish = (value: SessionImportResult<SessionImportCommitValue>): void => {
        if (done) return
        done = true
        signal.removeEventListener('abort', cancelled)
        resolve(value)
      }
      const cancelled = (): void => {
        finish(rejected({ code: 'cancelled', message: 'Local session import was cancelled.' }))
      }
      signal.addEventListener('abort', cancelled, { once: true })
      void commit.then(finish, () => {
        finish(rejected({
          code: 'internal', message: 'Local session import failed without publishing a partial session.',
        }))
      })
    }).finally(() => {
      reservation.waiters -= 1
      if (reservation.waiters === 0 && !reservation.settled) {
        reservation.controller?.abort(new DOMException('All commit callers cancelled', 'AbortError'))
      }
    })
  }

  /**
   * Release an uncommitted capture.
   * @param request Opaque reservation identity to discard.
   * @returns Whether an uncommitted reservation was removed.
   */
  @Remote('discard')
  discard(request: SessionImportDiscardRequest): SessionImportResult<SessionImportDiscardValue> {
    const reservation = this.reservations.get(request.reservationId)
    if (reservation?.commit !== undefined) return success({ discarded: false })
    return success({ discarded: this.reservations.delete(request.reservationId) })
  }

  private async commitReservation(
    reservation: Reservation,
    request: SessionImportCommitRequest,
    signal: AbortSignal,
  ): Promise<SessionImportResult<SessionImportCommitValue>> {
    try {
      signal.throwIfAborted()
      const workspace = this.ctx.workspaceRegistry.list()
        .find(candidate => String(candidate.id) === request.workspaceId)
      if (workspace === undefined) {
        return rejected({ code: 'workspace-not-found', message: 'Select an existing workspace again.' })
      }
      const preset = (await this.ctx.agentPresets.list())
        .find(candidate => candidate.id === request.agentPreset)
      if (preset === undefined) {
        return rejected({ code: 'preset-not-found', message: 'Select an existing Agent preset again.' })
      }
      if (preset.broken !== undefined) {
        return rejected({ code: 'preset-unavailable', message: 'The selected Agent preset is currently unavailable.' })
      }
      signal.throwIfAborted()
      let model: LlmResolvedModelInfo
      try {
        model = await this.ctx.llm.resolveModelInfo(request.provider, request.model, signal)
      } catch {
        return rejected({ code: 'target-conflict', message: 'Select an available continuation model again.' })
      }
      if (model.context === undefined) {
        return rejected({
          code: 'context-too-large',
          message: 'The selected model does not publish a context window, so this import cannot be sized safely.',
        })
      }
      const usableImportTokens = this.usableImportTokens(model)
      if (usableImportTokens <= 0) {
        return rejected({
          code: 'context-too-large',
          message: 'The selected model leaves no safe budget for imported context.',
        })
      }
      const snapshot = reservation.snapshot
      const sessionId = importedSessionId(snapshot)
      const existing = await this.inspectExisting(sessionId)
      if (existing !== undefined) {
        if (!matchingImport(
          snapshot, existing.meta, existing.events, workspace.path, preset.id, model.provider, model.id,
        )) {
          return rejected({ code: 'target-conflict', message: 'The deterministic import target already contains different data.' })
        }
        const workspaceAttached = await workspace.attachSession(sessionId).then(() => true, () => false)
        return success({ sessionId, existing: true, workspaceAttached })
      }
      if (this.targetIsLive(sessionId)) {
        return rejected({ code: 'target-conflict', message: 'The import target became live before publication.' })
      }
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION,
        id: sessionId,
        createdAt: snapshot.provenance.capturedAt,
        cwd: workspace.path,
        agentPreset: preset.id,
      }
      const continuation = {
        provider: model.provider,
        model: model.id,
        contextWindow: model.context.contextWindow,
        ...model.defaultMaxTokens === undefined ? {} : { maxTokens: model.defaultMaxTokens },
      }
      const draft = this.ctx.sessions.prepare(sessionId, {
        seed: convertForeignSnapshot(snapshot, header, this.config.maxToolSummaryBytes, continuation),
        meta: header,
      })
      const scope = await this.ctx.agentPresets.standingKeyFor(preset.id)
      const assembly = await this.ctx.systemPrompt.assemble({
        scope,
        signal,
        agent: {
          id: sessionId,
          options: { provider: model.provider, model: model.id },
          session: draft,
          ctx: this.ctx,
          status: 'idle',
        } as unknown as Agent,
      })
      signal.throwIfAborted()
      const raw = convertForeignSnapshot(snapshot, header, this.config.maxToolSummaryBytes, {
        ...continuation,
        system: renderPrompt(assembly),
        tools: assembly.tools,
      })
      // SessionStore owns exact seed-envelope and surface validation. The
      // detached value is never entered or announced.
      const prepared = this.ctx.sessions.prepare(sessionId, { seed: raw, meta: header })
      const measured = this.ctx.tokenMeter.measure(prepared)
      if (measured.totalTokens > usableImportTokens) {
        return rejected({
          code: 'context-too-large',
          message: `Imported context requires ${measured.totalTokens} estimated tokens; the selected model allows ${usableImportTokens}. Choose another model or cancel.`,
        })
      }
      const events = [...prepared.events]
      signal.throwIfAborted()
      if (this.targetIsLive(sessionId)) {
        return rejected({ code: 'target-conflict', message: 'The import target became live before publication.' })
      }
      try {
        await this.ctx.sessionPersistence.create(header)
      } catch {
        // Same-process retry can already own a lazy create; cross-process
        // contenders can already have materialized. The first append below is
        // the atomic claim, and inspection after a rejection proves the winner.
      }
      if (this.targetIsLive(sessionId)) {
        return rejected({ code: 'target-conflict', message: 'The import target became live before publication.' })
      }
      try {
        await this.ctx.sessionPersistence.append(sessionId, events)
      } catch {
        const won = await this.inspectDurableWinner(sessionId, signal)
        if (won === undefined
          || !matchingImport(
            snapshot, won.meta, won.events, workspace.path, preset.id, model.provider, model.id,
          )) {
          return rejected({ code: 'target-conflict', message: 'Another writer claimed the import target with different data.' })
        }
        const workspaceAttached = await workspace.attachSession(sessionId).then(() => true, () => false)
        return success({ sessionId, existing: true, workspaceAttached })
      }
      // The complete first batch is the commit and publication boundary. No
      // reserved/snapshot-only state is visible through SessionPersistence.
      const workspaceAttached = await workspace.attachSession(sessionId).then(() => true, () => false)
      return success({ sessionId, existing: false, workspaceAttached })
    } catch (error) {
      return rejected(failure(error))
    }
  }

  /** Reserve output plus preset/tool/new-prompt headroom from one exact model. */
  private usableImportTokens(info: LlmResolvedModelInfo): number {
    const contextWindow = info.context?.contextWindow ?? 0
    const outputReserve = info.defaultMaxTokens ?? Math.max(1, Math.floor(contextWindow * 0.1))
    const compositionReserve = Math.max(4_096, Math.ceil(contextWindow * 0.1))
    return contextWindow - outputReserve - compositionReserve
  }

  private async inspectExisting(sessionId: SessionId): Promise<{
    meta: SessionHeader
    events: readonly SessionEvent[]
  } | undefined> {
    try {
      return await this.ctx.sessionPersistence.inspect(sessionId)
    } catch {
      return undefined
    }
  }

  /** Allow a concurrent process's atomic publication to become observable. */
  private async inspectDurableWinner(sessionId: SessionId, signal: AbortSignal): Promise<{
    meta: SessionHeader
    events: readonly SessionEvent[]
  } | undefined> {
    for (let attempt = 0; attempt < WINNER_INSPECTION_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted()
      const existing = await this.inspectExisting(sessionId)
      if (existing !== undefined) return existing
      if (attempt + 1 < WINNER_INSPECTION_ATTEMPTS) {
        await delay(WINNER_INSPECTION_DELAY_MS, undefined, { signal })
      }
    }
    return undefined
  }

  /** Same-process publication race check, kept separate from durable inspection. */
  private targetIsLive(sessionId: SessionId): boolean {
    return this.ctx.sessions.get(sessionId) !== undefined
  }

  /** Re-check provider output before it can enter reservations or persistence. */
  private validateSnapshot(
    snapshot: ForeignSessionSnapshot,
    request: SessionImportCaptureRequest,
  ): void {
    const provenance = snapshot.provenance
    const safeMetadata = /^[A-Za-z0-9._+:/-]+$/u
    const messages: readonly { readonly role: unknown; readonly text: unknown }[] = snapshot.messages
    const tools: readonly { readonly name: unknown; readonly status: unknown }[] = snapshot.tools
    const invalid = provenance.sourceKind !== request.sourceKind
      || typeof provenance.sourceSessionId !== 'string'
      || provenance.sourceSessionId !== request.sourceSessionId
      || provenance.sourceSessionId.length > 200
      || !safeMetadata.test(provenance.sourceSessionId)
      || typeof provenance.sourceVersion !== 'string'
      || provenance.sourceVersion.length > 128
      || !safeMetadata.test(provenance.sourceVersion)
      || typeof provenance.converterVersion !== 'string'
      || provenance.converterVersion.length > 128
      || !safeMetadata.test(provenance.converterVersion)
      || !/^[a-f0-9]{64}$/u.test(provenance.prefixDigest)
      || !Number.isSafeInteger(provenance.capturedAt)
      || provenance.capturedAt < 0
      || typeof snapshot.sourceIdentity !== 'string'
      || snapshot.sourceIdentity.length === 0
      || snapshot.sourceIdentity.length > 512
      || (snapshot.cwdHint !== undefined
        && (!isAbsolute(snapshot.cwdHint) || snapshot.cwdHint.length > 4096))
      || messages.length > this.config.maxVisibleMessages
      || tools.length > this.config.maxToolActivities
      || !Number.isSafeInteger(snapshot.capturedBytes)
      || snapshot.capturedBytes < 0
      || snapshot.capturedBytes > this.config.maxSourceBytes
      || !Number.isSafeInteger(snapshot.contextBytes)
      || snapshot.contextBytes < 0
      || snapshot.contextBytes > this.config.maxVisibleContextBytes
      || messages.some(message =>
        (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string')
      || tools.some(tool =>
        typeof tool.name !== 'string'
        || (tool.status !== 'completed' && tool.status !== 'failed'
          && tool.status !== 'interrupted' && tool.status !== 'unknown'))
    if (invalid) {
      throw new ForeignSessionImportError(
        'source-corrupt', request.sourceKind, undefined,
        `${request.sourceKind} provider returned an invalid safe snapshot`,
      )
    }
  }

  /** Prevent a provider bug from projecting arbitrary data through metadata discovery. */
  private validateCandidate(
    candidate: Awaited<ReturnType<ForeignSessionProvider['discover']>>[number],
    sourceKind: ForeignSessionProvenance['sourceKind'],
  ): void {
    const invalid = candidate.sourceKind !== sourceKind
      || typeof candidate.sourceSessionId !== 'string'
      || candidate.sourceSessionId.length === 0
      || candidate.sourceSessionId.length > 200
      || !/^[A-Za-z0-9._+:/-]+$/u.test(candidate.sourceSessionId)
      || !Number.isSafeInteger(candidate.sizeBytes)
      || candidate.sizeBytes < 0
      || candidate.sizeBytes > this.config.maxSourceBytes
      || !Number.isFinite(candidate.modifiedAt)
      || candidate.modifiedAt < 0
    if (invalid) {
      throw new ForeignSessionImportError(
        'source-corrupt', sourceKind, undefined,
        `${sourceKind} provider returned invalid discovery metadata`,
      )
    }
  }
}

export default LocalSessionImportService
