/** Metadata-only recursive discovery for supported local JSONL roots. */

import { opendir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ForeignSessionCandidate, ForeignSessionSourceKind } from './types.ts'
import { ForeignSessionImportError } from './types.ts'

/** Internal candidate carrying the path providers retain on the Host only. */
export interface LocalJsonlCandidate {
  readonly file: string
  readonly row: ForeignSessionCandidate
}

/** Metadata-only scan options. */
export interface DiscoverLocalJsonlOptions {
  readonly root: string
  readonly sourceKind: ForeignSessionSourceKind
  readonly maxFiles: number
  readonly signal?: AbortSignal
  readonly sessionIdFromName: (name: string) => string | undefined
}

/**
 * Metadata-only scan; transcript files are statted but never opened.
 * @param options Supported root, source identity parser, and scan bounds.
 * @returns Deterministically ordered candidates retained on the Host.
 */
export async function discoverLocalJsonl(options: DiscoverLocalJsonlOptions): Promise<LocalJsonlCandidate[]> {
  const root = resolve(options.root)
  const pending = [root]
  const found: LocalJsonlCandidate[] = []
  let visited = 0
  while (pending.length > 0) {
    options.signal?.throwIfAborted()
    const directory = pending.pop()
    /* v8 ignore next -- the loop condition proves the LIFO stack has an entry. */
    if (directory === undefined) break
    let handle
    try {
      handle = await opendir(directory)
    } catch (error) {
      if (directory === root && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ForeignSessionImportError(
        'source-unsafe', options.sourceKind, undefined,
        `${options.sourceKind} discovery root cannot be enumerated safely`,
      )
    }
    try {
      for await (const entry of handle) {
        options.signal?.throwIfAborted()
        visited += 1
        if (visited > options.maxFiles * 20) {
          throw new ForeignSessionImportError(
            'source-too-large', options.sourceKind, undefined,
            `${options.sourceKind} discovery exceeds the configured entry budget`,
          )
        }
        // Never follow links. A linked source is neither discovered nor later
        // selectable, so it cannot traverse outside the supported root.
        if (entry.isSymbolicLink()) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          pending.push(path)
          continue
        }
        /* v8 ignore next -- supported roots contain directories, regular files,
           and skipped links; native special files are not portable fixtures. */
        if (!entry.isFile()) continue
        const sourceSessionId = options.sessionIdFromName(entry.name)
        if (sourceSessionId === undefined) continue
        const metadata = await stat(path)
        /* v8 ignore next -- this revalidation catches an external replacement race after the Dirent check. */
        if (!metadata.isFile()) continue
        found.push({
          file: path,
          row: {
            sourceKind: options.sourceKind,
            sourceSessionId,
            sizeBytes: metadata.size,
            modifiedAt: metadata.mtimeMs,
          },
        })
      }
    } finally {
      await handle.close().catch(() => {})
    }
  }
  found.sort((left, right) =>
    right.row.modifiedAt - left.row.modifiedAt
    || left.row.sourceSessionId.localeCompare(right.row.sourceSessionId))
  return found.slice(0, options.maxFiles)
}
