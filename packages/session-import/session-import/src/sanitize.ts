/** Provider-neutral redaction and bounded snapshot accumulation. */

import { Buffer } from 'node:buffer'
import type {
  ForeignSessionCaptureLimits,
  ForeignSessionSourceKind,
  ForeignToolActivity,
  ForeignVisibleMessage,
} from './types.ts'
import { ForeignSessionImportError } from './types.ts'

/** Stable replacement used for every credential-shaped substring. */
export const FOREIGN_SECRET_REDACTION = '[REDACTED CREDENTIAL]'

/**
 * Remove common credential material before foreign text can enter a Harness
 * event. This is a fail-safe filter, not a claim that arbitrary prose can be
 * classified perfectly; providers exclude hidden/system records entirely.
 * @param input Untrusted visible text from a foreign transcript.
 * @returns Text with credential-shaped substrings replaced.
 */
export function redactForeignText(input: string): string {
  return input
    .replace(/\b((?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token)\s*[:=]\s*)\S+/giu, `$1${FOREIGN_SECRET_REDACTION}`)
    .replace(/\bBearer\s+[A-Z0-9._~+/=-]{8,}/giu, `Bearer ${FOREIGN_SECRET_REDACTION}`)
    .replace(/\b(?:sk|api)[-_][A-Z0-9._-]{12,}\b/giu, FOREIGN_SECRET_REDACTION)
}

/**
 * Validate and normalize an external timestamp.
 * @param value Untrusted timestamp value.
 * @returns A nonnegative epoch millisecond value when valid.
 */
export function foreignTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** Bounded neutral accumulator shared by vendor parsers. */
export class ForeignSnapshotAccumulator {
  /** Sanitized visible conversation messages accepted so far. */
  readonly messages: ForeignVisibleMessage[] = []
  /** Inert historical tool facts accepted so far. */
  readonly tools: ForeignToolActivity[] = []
  /** UTF-8 bytes consumed by visible messages. */
  contextBytes = 0
  private lastTimestamp: number | undefined

  constructor(
    private readonly sourceKind: ForeignSessionSourceKind,
    private readonly limits: ForeignSessionCaptureLimits,
  ) {}

  /**
   * Enforce nondecreasing source record timestamps when present.
   * @param timestamp Normalized timestamp, when the record supplies one.
   * @param record One-based source record index for safe diagnostics.
   */
  observeTimestamp(timestamp: number | undefined, record: number): void {
    if (timestamp === undefined) return
    if (this.lastTimestamp !== undefined && timestamp < this.lastTimestamp) {
      throw new ForeignSessionImportError(
        'out-of-order', this.sourceKind, record,
        `${this.sourceKind} record ${record} has an out-of-order timestamp`,
      )
    }
    this.lastTimestamp = timestamp
  }

  /**
   * Append one visible message after redaction and exact byte accounting.
   * @param message Provider-neutral visible message.
   * @param record One-based source record index for safe diagnostics.
   */
  message(message: ForeignVisibleMessage, record: number): void {
    const text = redactForeignText(message.text).trim()
    if (text.length === 0) return
    const previous = this.messages.at(-1)
    // Both products can emit the same visible update through a summary/event
    // and a final response-item record. Exact adjacent copies collapse only;
    // non-adjacent repeated prompts remain distinct conversation history.
    if (previous?.role === message.role && previous.text === text) return
    if (this.messages.length >= this.limits.maxVisibleMessages) {
      throw new ForeignSessionImportError(
        'context-too-large', this.sourceKind, record,
        `${this.sourceKind} visible message count exceeds the configured import budget`,
      )
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (this.contextBytes + bytes > this.limits.maxVisibleContextBytes) {
      throw new ForeignSessionImportError(
        'context-too-large', this.sourceKind, record,
        `${this.sourceKind} visible context exceeds the configured import budget`,
      )
    }
    this.contextBytes += bytes
    this.messages.push(Object.freeze({
      role: message.role,
      text,
      ...message.timestamp === undefined ? {} : { timestamp: message.timestamp },
      ...message.interrupted === true ? { interrupted: true as const } : {},
    }))
  }

  /**
   * Append one inert tool fact; arguments/results never enter this method.
   * @param activity Provider-neutral body-free tool activity.
   * @param record One-based source record index for safe diagnostics.
   */
  tool(activity: ForeignToolActivity, record: number): void {
    if (this.tools.length >= this.limits.maxToolActivities) {
      throw new ForeignSessionImportError(
        'context-too-large', this.sourceKind, record,
        `${this.sourceKind} tool history exceeds the configured import budget`,
      )
    }
    // Tool names are display/model metadata, not executable routing. Keep a
    // narrow inert alphabet and replace everything else.
    const name = activity.name.replace(/[^A-Za-z0-9_.:/-]/gu, '?').slice(0, 128) || 'unknown'
    this.tools.push(Object.freeze({
      name,
      status: activity.status,
      ...activity.timestamp === undefined ? {} : { timestamp: activity.timestamp },
    }))
  }
}
