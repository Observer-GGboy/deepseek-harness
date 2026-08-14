/** Bounded, stable-prefix JSONL capture shared by local source providers. */

import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ForeignSessionSourceKind } from './types.ts'
import { ForeignSessionImportError } from './types.ts'

/** One complete decoded JSONL record. */
export interface StableJsonlRecord {
  readonly index: number
  readonly value: unknown
}

/** Stable-prefix capture output. */
export interface StableJsonlCapture {
  readonly prefixDigest: string
  readonly sourceIdentity: string
  readonly capturedBytes: number
  readonly trailingPartialRecordIgnored: boolean
}

/** Inputs to one selected-file capture. */
export interface StableJsonlCaptureOptions {
  readonly root: string
  readonly file: string
  readonly sourceKind: ForeignSessionSourceKind
  readonly maxSourceBytes: number
  readonly maxLineBytes: number
  readonly signal?: AbortSignal
  readonly onRecord: (record: StableJsonlRecord) => void
  /** Deterministic mutation points for fault-injection tests; production providers omit them. */
  readonly faults?: {
    readonly afterReadChunk?: (completedBytes: number, totalBytes: number) => void | Promise<void>
    readonly beforeRehash?: () => void | Promise<void>
    readonly beforeFinalStat?: () => void | Promise<void>
  }
}

const READ_CHUNK_BYTES = 64 * 1024

/** Throw the caller's abort reason without manufacturing path-bearing text. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return
  throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
}

/** Whether `candidate` remains inside `root` after canonical resolution. */
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Canonicalize and prove one selected regular file stays inside its supported root. */
async function resolveSafeFile(options: StableJsonlCaptureOptions): Promise<{
  root: string
  file: string
  before: Awaited<ReturnType<typeof stat>>
}> {
  let canonicalRoot: string
  let canonicalFile: string
  try {
    canonicalRoot = await realpath(resolve(options.root))
    canonicalFile = await realpath(resolve(options.file))
  } catch {
    throw new ForeignSessionImportError(
      'source-not-found', options.sourceKind, undefined, `${options.sourceKind} source is unavailable`,
    )
  }
  if (!isWithin(canonicalRoot, canonicalFile)) {
    throw new ForeignSessionImportError(
      'source-unsafe', options.sourceKind, undefined, `${options.sourceKind} source resolves outside its supported root`,
    )
  }
  const before = await stat(canonicalFile, { bigint: true })
  if (!before.isFile()) {
    throw new ForeignSessionImportError(
      'source-unsafe', options.sourceKind, undefined, `${options.sourceKind} source is not a regular file`,
    )
  }
  return { root: canonicalRoot, file: canonicalFile, before }
}

/** Hash exactly one prefix without buffering it. */
async function hashPrefix(
  file: string,
  bytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, bytes)))
    let position = 0
    while (position < bytes) {
      throwIfAborted(signal)
      const length = Math.min(buffer.byteLength, bytes - position)
      const read = await handle.read(buffer, 0, length, position)
      if (read.bytesRead === 0) break
      hash.update(buffer.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
    if (position !== bytes) throw new Error('prefix shortened')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/**
 * Stream complete lines from the selected file's initial byte prefix, then
 * re-hash that same prefix to reject replacement/truncation/middle mutation.
 * Appended bytes are intentionally outside the capture; a final incomplete
 * line inside the prefix is ignored.
 * @param options Selected path, source kind, bounds, and record observer.
 * @returns Stable prefix identity and capture metadata.
 */
export async function captureStableJsonl(options: StableJsonlCaptureOptions): Promise<StableJsonlCapture> {
  throwIfAborted(options.signal)
  const safe = await resolveSafeFile(options)
  const capturedBytes = Number(safe.before.size)
  if (!Number.isSafeInteger(capturedBytes) || capturedBytes > options.maxSourceBytes) {
    throw new ForeignSessionImportError(
      'source-too-large', options.sourceKind, undefined,
      `${options.sourceKind} source exceeds the configured capture budget`,
    )
  }
  const sourceIdentity = `${String(safe.before.dev)}:${String(safe.before.ino)}`
  const handle = await open(safe.file, 'r')
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, capturedBytes)))
  let position = 0
  let pending = Buffer.alloc(0)
  let recordIndex = 0
  try {
    while (position < capturedBytes) {
      throwIfAborted(options.signal)
      const length = Math.min(buffer.byteLength, capturedBytes - position)
      const read = await handle.read(buffer, 0, length, position)
      if (read.bytesRead === 0) break
      const chunk = Buffer.from(buffer.subarray(0, read.bytesRead))
      digest.update(chunk)
      position += read.bytesRead
      await options.faults?.afterReadChunk?.(position, capturedBytes)
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk])
      let newline = pending.indexOf(0x0a)
      while (newline !== -1) {
        const line = pending.subarray(0, newline)
        pending = pending.subarray(newline + 1)
        recordIndex += 1
        if (line.byteLength > options.maxLineBytes) {
          throw new ForeignSessionImportError(
            'record-too-large', options.sourceKind, recordIndex,
            `${options.sourceKind} record ${recordIndex} exceeds the configured line budget`,
          )
        }
        if (line.byteLength > 0) {
          let value: unknown
          try {
            value = JSON.parse(line.toString('utf8')) as unknown
          } catch {
            throw new ForeignSessionImportError(
              'source-corrupt', options.sourceKind, recordIndex,
              `${options.sourceKind} record ${recordIndex} is not valid JSON`,
            )
          }
          options.onRecord({ index: recordIndex, value })
        }
        newline = pending.indexOf(0x0a)
      }
      if (pending.byteLength > options.maxLineBytes) {
        throw new ForeignSessionImportError(
          'record-too-large', options.sourceKind, recordIndex + 1,
          `${options.sourceKind} record ${recordIndex + 1} exceeds the configured line budget`,
        )
      }
    }
  } finally {
    await handle.close()
  }
  if (position !== capturedBytes) {
    throw new ForeignSessionImportError(
      'source-changed', options.sourceKind, undefined, `${options.sourceKind} source changed during capture`,
    )
  }
  throwIfAborted(options.signal)
  const firstDigest = digest.digest('hex')
  let secondDigest: string
  try {
    await options.faults?.beforeRehash?.()
    secondDigest = await hashPrefix(safe.file, capturedBytes, options.signal)
  } catch {
    throwIfAborted(options.signal)
    throw new ForeignSessionImportError(
      'source-changed', options.sourceKind, undefined, `${options.sourceKind} source changed during capture`,
    )
  }
  await options.faults?.beforeFinalStat?.()
  const after = await stat(safe.file, { bigint: true })
  if (after.dev !== safe.before.dev || after.ino !== safe.before.ino
    || after.size < safe.before.size || firstDigest !== secondDigest) {
    throw new ForeignSessionImportError(
      'source-changed', options.sourceKind, undefined, `${options.sourceKind} source changed during capture`,
    )
  }
  return {
    prefixDigest: firstDigest,
    sourceIdentity,
    capturedBytes,
    trailingPartialRecordIgnored: pending.byteLength > 0,
  }
}
