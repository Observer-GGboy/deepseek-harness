# Agent Note: Safe local Session import

Status: implemented

English | [中文](2026-08-14-safe-local-session-import.zh.md)

## Problem

Codex and Claude Code users can have useful local conversation history that predates DeepSeek Harness, but their files are not Harness event logs. Treating foreign JSON as `SessionEvent`, copying entire files to a browser, or replaying tool state would cross trust boundaries: vendor formats contain hidden instructions, reasoning, credentials, paths, attachments, commands, and partially written stream records. A retry or concurrent import could also create duplicate Sessions or expose a half-published event log.

The user still needs a deliberate continuation point: choose one source, inspect safe facts, select the Workspace, Agent preset, and exact model route that govern future work, and start a normal new turn without resuming the foreign process.

## Decision

Local import is a five-package capability seam. `dsh-session-import` defines the provider registry and neutral snapshot; Codex and Claude Code Service Providers reduce supported vendor records; `dsh-session-import-local` owns opaque reservations, native conversion, deterministic persistence, and Remote methods; `dsh-client-ui-session-import` owns the Settings confirmation flow.

Discovery is metadata-only. Capture fixes an initial JSONL byte prefix and streams complete records under configured source, line, visible-byte, visible-message, and tool-count budgets. It hashes the same prefix twice and compares file identity and size. Appends are allowed outside the captured prefix; replacement, truncation, middle mutation, malformed complete records, format drift, conflicting duplicates, and out-of-order timestamps fail closed. An incomplete final record is ignored and reported.

External records never implement or deserialize into `SessionEvent`. Providers emit an immutable `ForeignSessionSnapshot` containing only visible redacted user/assistant text, marked generated summaries, inert tool names/statuses, safe provenance, counts, and an optional cwd hint. System/developer instructions, reasoning, tool arguments/results, attachments, environment values, credentials, and source paths have no neutral field. The Host Consumer validates and redacts the snapshot again before conversion.

Converter v1 uses explicit external-version policies instead of accepting arbitrary future rows. Codex accepts `0.144.0` through `0.148.999` (including bounded in-range prereleases), permits repeated consistent `session_meta`, and records all observed supported versions. Claude Code accepts `2.1.128` through `2.1.222`, records supported updater transitions as a minimum/maximum range, and explicitly treats the body-free `frame-link` record observed in 2.1.128 as ignored metadata. Missing, malformed, older, newer, identity-conflicting, or unknown required structures fail closed. Only a short canonical numeric version may enter a failure message; invalid, prerelease, path-shaped, credential-shaped, and oversized external values are omitted.

## Identity and publication

The target Session id hashes a domain separator, Host-local source file identity plus source Session identity, and the captured-prefix SHA-256 digest. Capture time does not affect identity, so equivalent captures converge. The Host-local file identity is never persisted, logged, or returned to a Client.

The operator explicitly confirms an existing Workspace, usable Agent preset, and exact provider/model route. The Workspace and preset become immutable `SessionHeader` values, while the route and its assembled preset composition become native request state. Reusing the same deterministic target with different choices is a visible conflict, not a metadata rewrite.

The Consumer constructs a complete balanced native seed and passes it through `SessionStore.prepare()`. Its first persistence append contains `session/imported`, all imported closed turns, `session/end-seed`, and the confirmed continuation request state. JSONL uses no-replace first materialization; SQLite writes the header and batch in one transaction. That first complete batch is both claim and publication, so there is no durable reserved-only or partially published Session. After a failed claim, a bounded, cancellable inspection window lets an independent winner's atomic publication become visible. Equivalent losers, including independent processes, then return the same id. A durable mismatching winner is a target conflict; an exhausted inspection with no winner preserves the standalone append rejection as a redacted internal persistence failure.

Workspace attachment is intentionally post-publication and best-effort. An attachment failure returns `workspaceAttached: false`; the complete Session remains selectable and usable. A retry inspects the existing import and does not append the seed again.

## Continuation and trust

Imported tool history becomes one explicitly labeled inert user-context summary. No native tool call or result event is synthesized, so no historical command can execute. Imported visible messages become closed native turns. Before publication, the Consumer assembles the selected preset's system prompt and tools on a detached Session, stores the confirmed provider/model in `request/header`, and measures the final seed. Safe capacity is the selected context window minus the model's default output allowance (or 10%) and the larger of 4096 tokens or 10% for composition and the next prompt. New code, tools, approvals, and model work begin only after the user's next message under the confirmed Workspace, preset, and route.

The Web Client receives only source metadata, capture counts, cwd hint, safe per-model allowances, and opaque reservation id. It never receives transcript excerpts or file paths. Leaving the section discards an uncommitted reservation; capture and commit accept cancellation. Multiple callers waiting on one identical commit cancel independently. The final cancellation aborts the shared work and waits for it to settle before returning. Plugin disposal closes commit admission, aborts and awaits every shared commit, preserves any complete Session that crossed atomic publication, and prevents later Workspace attachment from starting. Reservations are bounded and process-local, while committed idempotency is durable across tabs, processes, restarts, JSONL, and SQLite. The v1 progress contract reports only discover/capture/commit phases; it does not expose byte counters without a real Remote progress seam.

## Verification

Provider fixtures pin metadata-only discovery, symlink exclusion, stable append behavior, deterministic read/rehash/final-stat mutation faults, partial-tail handling, the external version ranges, Codex repeated metadata, Claude Code 2.1.128 `frame-link`, structural exclusion, credential redaction, and path/body/version-safe failures. Host tests pass provider-neutral snapshots through native seed validation, model-specific composition sizing, standalone and contended persistence failures, attachment faults, quiescent cancellation and disposal, retry, and 2-, 10-, and 100-way contention against real JSONL and SQLite backends; six separate Node processes also contend against each backend. Client tests pin explicit three-way confirmation, stage status, cancellation, metadata-only rendering, safe diagnostics, and the post-publication accounting warning. The four focused provider/Host/Client suites are held at 100% statements, branches, functions, and lines. A keyless real Loader + Web + Chromium scenario imports a Codex snapshot containing a historical shell-call tripwire, continues it through a replay model, verifies no `tool/call` was synthesized or executed, and commits the resulting accessibility golden.

## Alternatives considered

**Import foreign JSON directly as native events.** Rejected because vendor records do not satisfy Harness ordering, balancing, provenance, or trust contracts, and future format drift would silently widen the native event union.

**Copy the complete transcript and filter it when rendering or prompting.** Rejected because secrets and hidden records would already have crossed persistence and Client boundaries. Structural exclusion and redaction happen before reservation instead.

**Persist a reservation, then fill the Session incrementally.** Rejected because crashes and concurrent readers could observe an empty or partial Session. One complete backend-atomic first append provides a single publication point.

**Include Workspace and preset in the deterministic id.** Rejected because one captured historical prefix should have one durable identity. Different continuation metadata is an explicit conflict that forces the operator to acknowledge the immutable choice.

**Resume vendor process and tool state.** Rejected because process, branch, sandbox, permission, hook, and tool state cannot be safely reconstructed from a transcript. Import is intentionally historical context only.

## Consequences

Users can continue useful visible history without copying or replaying the foreign execution environment. Equivalent retries converge on one complete Session across both shipped persistence backends, and the UI can remain metadata-only.

The trade-off is deliberate loss: hidden reasoning, attachments, tool bodies, sidechains, vendor runtime state, and arbitrary post-capture appends are unavailable. Common credential patterns are redacted, but unconstrained prose cannot be proven secret-free; structural exclusion and narrow contracts remain the primary boundary. New vendor required record shapes must be reviewed and added explicitly rather than accepted optimistically.
