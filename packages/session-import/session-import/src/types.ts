/**
 * Provider-neutral local-session import vocabulary.
 *
 * External records never implement SessionEvent directly. Providers reduce a
 * captured, stable source prefix to this inert snapshot; the consumer is the
 * only layer allowed to construct native Harness events.
 * @module @deepseek-ai/dsh-session-import/types
 */

/** Known first-party foreign transcript families. */
export type ForeignSessionSourceKind = 'codex' | 'claude-code'

/** Metadata-only discovery row. No transcript body or absolute path crosses this boundary. */
export interface ForeignSessionCandidate {
  /** Provider route used for the later explicit capture. */
  readonly sourceKind: ForeignSessionSourceKind
  /** Vendor session identity parsed from the filename, never from message content. */
  readonly sourceSessionId: string
  /** Source file byte size observed during discovery. */
  readonly sizeBytes: number
  /** Source file modification time observed during discovery. */
  readonly modifiedAt: number
}

/** Visible text retained from one foreign transcript message. */
export interface ForeignVisibleMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly timestamp?: number
  /** True when the source explicitly marks this message/turn interrupted. */
  readonly interrupted?: true
}

/** Inert history fact: arguments and results are intentionally absent. */
export interface ForeignToolActivity {
  readonly name: string
  readonly status: 'completed' | 'failed' | 'interrupted' | 'unknown'
  readonly timestamp?: number
}

/** Safe provenance persisted with an imported Session. */
export interface ForeignSessionProvenance {
  readonly sourceKind: ForeignSessionSourceKind
  readonly sourceSessionId: string
  readonly sourceVersion: string
  readonly capturedAt: number
  readonly prefixDigest: string
  readonly converterVersion: string
}

/**
 * One immutable capture. `sourceIdentity` is host-local idempotency material;
 * consumers must not persist, log, export, or return it to a client.
 */
export interface ForeignSessionSnapshot {
  readonly provenance: ForeignSessionProvenance
  readonly sourceIdentity: string
  readonly cwdHint?: string
  readonly messages: readonly ForeignVisibleMessage[]
  readonly tools: readonly ForeignToolActivity[]
  readonly capturedBytes: number
  readonly contextBytes: number
  readonly trailingPartialRecordIgnored: boolean
}

/** Limits every provider applies while streaming one selected source. */
export interface ForeignSessionCaptureLimits {
  readonly maxSourceBytes: number
  readonly maxLineBytes: number
  readonly maxVisibleContextBytes: number
  readonly maxVisibleMessages: number
  readonly maxToolActivities: number
}

/** Provider request after an operator explicitly selected a discovery row. */
export interface ForeignSessionCaptureRequest {
  readonly sourceSessionId: string
  readonly limits: ForeignSessionCaptureLimits
  readonly signal?: AbortSignal
}

/** Vendor-owned discovery and capture implementation. */
export interface ForeignSessionProvider {
  readonly sourceKind: ForeignSessionSourceKind
  /** Discover metadata only; implementations must not open transcript bodies. */
  discover(signal?: AbortSignal): Promise<readonly ForeignSessionCandidate[]>
  /** Capture one explicitly selected source into the neutral snapshot. */
  capture(request: ForeignSessionCaptureRequest): Promise<ForeignSessionSnapshot>
}

/** Closed provider/consumer-safe diagnosis that never carries source content or paths. */
export type ForeignSessionImportErrorCode =
  | 'provider-unavailable'
  | 'source-not-found'
  | 'source-ambiguous'
  | 'source-unsafe'
  | 'source-too-large'
  | 'record-too-large'
  | 'source-changed'
  | 'source-corrupt'
  | 'unsupported-version'
  | 'context-too-large'
  | 'duplicate-record'
  | 'out-of-order'

/** Typed, redacted source failure. */
export class ForeignSessionImportError extends Error {
  /**
   * @param code - stable diagnosis.
   * @param sourceKind - selected provider route.
   * @param record - one-based record position, when a record caused failure.
   * @param message - path- and body-free operator-facing summary.
   */
  constructor(
    readonly code: ForeignSessionImportErrorCode,
    readonly sourceKind: ForeignSessionSourceKind,
    readonly record: number | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ForeignSessionImportError'
  }
}
