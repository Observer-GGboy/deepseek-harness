# @deepseek-ai/dsh-session-import-local

English | [中文](README.zh.md)

Host Consumer for local transcript import. `ctx.sessionImportLocal` exposes generated Remote methods for options, metadata discovery, selected capture, commit, and discard. Capture retains a bounded neutral snapshot behind an opaque process-local reservation; no transcript body, source path, source file identity, or secret crosses the Client boundary.

Commit requires the operator's explicit Workspace and Agent-preset choices. The target Session id is deterministic over source file identity, source Session id, and captured-prefix digest. The Consumer revalidates and redacts provider output, converts it to balanced native events, and asks `SessionStore.prepare()` to validate the complete seed before persistence.

JSONL first materialization uses the backend's no-replace publication; SQLite inserts the header and complete event batch in one transaction. Under concurrent captures, one writer publishes and equivalent writers inspect the same complete target. A different cwd or preset for the same deterministic target is an explicit conflict. The persisted `session/imported` event contains safe provenance and counts, never the Host-local source identity or source path.

| Config key | Default | Boundary |
|---|---:|---|
| `maxSourceBytes` | 67108864 | selected source prefix |
| `maxLineBytes` | 1048576 | one complete JSONL record |
| `maxVisibleContextBytes` | 4194304 | retained visible UTF-8 text |
| `maxVisibleMessages` | 10000 | retained visible messages |
| `maxToolActivities` | 1000 | retained inert tool facts |
| `maxDiscoveryItems` | 500 | metadata rows returned per discovery |
| `maxReservations` | 32 | uncommitted process-local captures |
| `maxToolSummaryBytes` | 65536 | generated inert tool summary |

## Model Experience

### Continued imported Session

#### What the model sees

The next request sees the imported visible conversation after `session/end-seed` and an explicitly labeled inert tool-activity summary. It receives no foreign system prompt, reasoning, tool arguments/results, attachment path, credential, or executable tool call.

#### Token effect

The imported visible messages and tool summary count toward the next request's context budget.

#### KV Cache effect

The deterministic Session has a new native prefix. An idempotent retry reuses the same Session rather than creating another prefix.

## Known Limitations and Deferred Work

- Import creates a one-shot historical snapshot; it does not synchronize later foreign transcript changes.
- Workspace accounting occurs after atomic Session publication. If it fails, the complete Session remains usable and the Remote reports `workspaceAttached: false`.
- Importing the same captured prefix with different Workspace or Agent-preset choices conflicts instead of silently rewriting immutable Session metadata.
