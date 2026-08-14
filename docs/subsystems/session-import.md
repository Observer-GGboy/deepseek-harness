# Session import

English | [中文](session-import.zh.md)

Local Session import turns a selected Codex or Claude Code JSONL prefix into a new, continuable DeepSeek Harness Session. It is a one-shot historical snapshot, not process migration: Git state, processes, permissions, hooks, tools, hidden instructions, reasoning, environment values, and attachments are not restored.

## Package topology

| Role | Package | Responsibility |
|---|---|---|
| Service Definition | `dsh-session-import` | provider registry, neutral types, metadata-only discovery, bounded stable JSONL capture, redaction |
| Service Provider | `dsh-session-import-codex` | supported Codex rollout reduction |
| Service Provider | `dsh-session-import-claude-code` | supported Claude Code transcript reduction |
| Host Consumer | `dsh-session-import-local` | reservations, validation, native conversion, deterministic identity, persistence, Remote methods |
| Client Consumer | `dsh-client-ui-session-import` | Settings discovery, metadata preview, explicit target confirmation, cancellation, open flow |

External JSON never enters the native event union. Each Service Provider reduces complete supported records to `ForeignSessionSnapshot`; only the Host Consumer constructs `SessionEvent` values. The Web Client receives source id, size, modification time, counts, an optional cwd hint, and opaque reservation id—never transcript text or source file paths.

## Capture boundary

Discovery recursively enumerates regular files and stats matching UUID filenames without opening bodies or following symbolic links. Capture canonicalizes the selected file under its configured root, fixes the prefix at the initial byte size, streams complete newline-delimited records under explicit limits, and hashes that exact prefix twice. A later append is allowed and remains outside the snapshot. Replacement, truncation, middle mutation, malformed complete records, duplicate identities, out-of-order timestamps, and unknown required structures reject the capture without a reservation.

The parsers retain only visible user/assistant text, marked generated summaries, and body-free tool names/statuses. Common credential shapes are redacted before the snapshot and again before native conversion. Tool input/output, system/developer instructions, reasoning, attachment references, environment data, and source paths have no persisted representation. Converter v1 accepts Codex `0.144.0` through `0.148.999` and Claude Code `2.1.128` through `2.1.222`; missing, malformed, or outside-range versions fail closed. Supported in-file version transitions remain visible in provenance. Claude Code's body-free `frame-link` metadata is explicitly ignored.

## Reservation and commit

Capture creates an opaque, bounded, process-local reservation. Commit accepts only that reservation plus an existing Workspace id, usable Agent-preset id, and exact provider/model route. A reservation commits once; concurrent calls with different choices conflict, and leaving Settings discards an uncommitted reservation. Callers waiting on the same choice cancel independently; the shared commit is aborted only after its last waiter leaves.

The target Session id hashes the Host-local source file identity, source Session id, and stable-prefix digest. `SessionStore.prepare()` validates the complete native seed before storage. The first JSONL publication uses no-replace materialization; SQLite writes the header and complete event batch in one transaction. Therefore one of 2, 10, or 100 equivalent contenders—even from independent Node processes—wins, and the rest inspect the same balanced target instead of publishing duplicates or partial Sessions.

The ignorable `session/imported` event persists safe source kind, source Session id, vendor/converter versions, prefix digest, capture time, counts, and partial-tail status. It excludes the absolute transcript path and Host-local file identity. Immutable Session metadata makes a retry with a different Workspace path, Agent preset, provider, or model an explicit conflict.

## Continuation semantics

Imported messages become closed native turns. Historical tools become a labeled inert user-context summary; no `tool/call` or `tool/result` event is synthesized, so nothing can replay. `session/end-seed` closes the validated historical prefix. The Host assembles the chosen preset's system prompt and tools on a detached Session, records the confirmed provider/model in `request/header`, and measures the final seed before publication. Safe import capacity is the model context window minus its default output allowance (or 10%) and the larger of 4096 tokens or 10% for composition and the next prompt. New work begins only when the user sends the next message under that confirmed Workspace, preset, and model route.

Workspace attachment is best-effort after the atomic Session publication. Failure returns `workspaceAttached: false` and leaves the complete Session selectable and usable; retry never republishes its event log.

## Security and operational limits

- The configured source roots and size/count budgets are Host policy, not Client input.
- The v1 UI reports only bounded stage status (discover, capture, commit); it does not expose byte progress across the Remote boundary.
- Detection of arbitrary prose secrets is impossible; the feature combines common-pattern redaction with structural exclusion and a metadata-only Client contract.
- Format drift fails closed. Supporting a new required vendor record needs parser fixtures and an explicit converter-version change.
- The snapshot is immutable. Import again to capture a later appended prefix; there is no ongoing synchronization.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionimportlocal--localsessionimportservice"></a>

### `ctx.sessionImportLocal` — `LocalSessionImportService`

Host Remote consumer. Providers remain separately registered on `ctx.sessionImports`.

```ts cordis-catalog
/**
 * Current source/workspace/preset/model choices for the confirmation screen.
 * @param signal Remote request cancellation signal.
 * @returns Available source kinds and explicit continuation targets.
 */
@Remote('options') async options(signal: AbortSignal): Promise<SessionImportResult<SessionImportOptionsValue>>

/**
 * Metadata-only discovery for one explicitly chosen provider.
 * @param request Chosen source kind.
 * @param signal Remote request cancellation signal.
 * @returns Bounded source metadata rows without transcript content.
 */
@Remote('discover') async discover( request: SessionImportDiscoverRequest, signal: AbortSignal, ): Promise<SessionImportResult<SessionImportDiscoverValue>>

/**
 * Capture a selected stable prefix behind an opaque reservation.
 * @param request Explicitly selected source identity.
 * @param signal Remote request cancellation signal.
 * @returns Sanitized counts and an opaque one-shot reservation identity.
 */
@Remote('capture') async capture( request: SessionImportCaptureRequest, signal: AbortSignal, ): Promise<SessionImportResult<SessionImportCaptureValue>>

/**
 * Atomically publish after explicit workspace, preset, and model confirmation.
 * @param request Reservation and confirmed continuation targets.
 * @param signal Remote request cancellation signal.
 * @returns Published session identity and idempotency/attachment status.
 */
@Remote('commit') commit( request: SessionImportCommitRequest, signal: AbortSignal, ): Promise<SessionImportResult<SessionImportCommitValue>>

/**
 * Release an uncommitted capture.
 * @param request Opaque reservation identity to discard.
 * @returns Whether an uncommitted reservation was removed.
 */
@Remote('discard') discard(request: SessionImportDiscardRequest): SessionImportResult<SessionImportDiscardValue>
```

Source: [`packages/session-import/session-import-local/src/index.ts:317`](../../packages/session-import/session-import-local/src/index.ts)

<a id="ctxsessionimports--sessionimportregistry"></a>

### `ctx.sessionImports` — `SessionImportRegistry`

Registry of source-format providers. It performs no persistence or conversion.

```ts cordis-catalog
/**
 * Register one source kind for the lifetime of the calling effect.
 * @param provider Provider implementation to register.
 * @returns Effect disposer that unregisters the provider.
 */
registerProvider(provider: ForeignSessionProvider): () => void

/**
 * Return one registered provider without choosing a fallback.
 * @param kind Exact source kind to resolve.
 * @returns The registered provider, or `undefined` when unavailable.
 */
getProvider(kind: ForeignSessionSourceKind): ForeignSessionProvider | undefined

/**
 * Return source kinds in deterministic lexical order.
 * @returns Registered source kinds.
 */
listProviders(): ForeignSessionSourceKind[]
```

Source: [`packages/session-import/session-import/src/index.ts:21`](../../packages/session-import/session-import/src/index.ts)
<!-- END GENERATED cordis-surface -->
