/** Client-safe Host consumer contract for local-session import. */

/** Source routes projected over the generated Remote contract. */
export type SessionImportSourceKind = 'codex' | 'claude-code'

/** Provider failure codes projected without importing Host-only declarations. */
export type SessionImportSourceErrorCode =
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

/** Generic Remote success branch. */
export interface SessionImportSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Redacted import failure. */
export interface SessionImportFailure {
  readonly code: SessionImportSourceErrorCode | 'reservation-not-found' | 'workspace-not-found'
    | 'preset-not-found' | 'preset-unavailable' | 'target-conflict' | 'cancelled' | 'internal'
  readonly message: string
  readonly sourceKind?: SessionImportSourceKind
  readonly record?: number
}

/** Generic Remote rejection branch. */
export interface SessionImportRejected {
  readonly ok: false
  readonly error: SessionImportFailure
}

/** Generic business result. */
export type SessionImportResult<T> = SessionImportSuccess<T> | SessionImportRejected

/** Metadata-only discovery request. */
export interface SessionImportDiscoverRequest {
  readonly sourceKind: SessionImportSourceKind
}

/** Metadata-only discovery row. */
export interface SessionImportSourceRow {
  readonly sourceKind: SessionImportSourceKind
  readonly sourceSessionId: string
  readonly sizeBytes: number
  readonly modifiedAt: number
}

/** Metadata-only discovery response. */
export interface SessionImportDiscoverValue {
  readonly items: readonly SessionImportSourceRow[]
}

/** Explicit selected-source capture request. */
export interface SessionImportCaptureRequest {
  readonly sourceKind: SessionImportSourceKind
  readonly sourceSessionId: string
}

/** Captured snapshot facts; no transcript body or source path is returned. */
export interface SessionImportCaptureValue {
  readonly reservationId: string
  readonly sourceKind: SessionImportSourceKind
  readonly sourceSessionId: string
  readonly capturedAt: number
  readonly capturedBytes: number
  readonly contextBytes: number
  readonly messageCount: number
  readonly toolCount: number
  readonly cwdHint?: string
  readonly trailingPartialRecordIgnored: boolean
}

/** One existing Harness workspace the operator may explicitly select. */
export interface SessionImportWorkspaceOption {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** One currently usable Agent preset. */
export interface SessionImportPresetOption {
  readonly id: string
  readonly name: string
}

/** Current confirmation choices. */
export interface SessionImportOptionsValue {
  readonly sourceKinds: readonly SessionImportSourceKind[]
  readonly workspaces: readonly SessionImportWorkspaceOption[]
  readonly presets: readonly SessionImportPresetOption[]
}

/** Final explicit commit request. */
export interface SessionImportCommitRequest {
  readonly reservationId: string
  readonly workspaceId: string
  readonly agentPreset: string
}

/** Published target. */
export interface SessionImportCommitValue {
  readonly sessionId: string
  readonly existing: boolean
  /** False only when post-publication workspace accounting failed; the complete Session remains usable. */
  readonly workspaceAttached: boolean
}

/** Release one uncommitted capture. */
export interface SessionImportDiscardRequest {
  readonly reservationId: string
}

/** Idempotent release acknowledgement. */
export interface SessionImportDiscardValue {
  readonly discarded: boolean
}
