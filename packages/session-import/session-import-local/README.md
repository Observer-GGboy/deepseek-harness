# @deepseek-ai/dsh-session-import-local

English | [中文](README.zh.md)

Host Consumer for local transcript import. `ctx.sessionImportLocal` exposes generated Remote methods for options, metadata discovery, selected capture, commit, and discard. Capture retains a bounded neutral snapshot behind an opaque process-local reservation; no transcript body, source path, source file identity, or secret crosses the Client boundary.

Commit requires the operator's explicit Workspace, Agent-preset, and exact provider/model choices. The target Session id is deterministic over source file identity, source Session id, and captured-prefix digest. The Consumer revalidates and redacts provider output, converts it to balanced native events, assembles the selected preset's system prompt and tools on a detached Session, and asks `SessionStore.prepare()` to validate the complete seed before persistence.

JSONL first materialization uses the backend's no-replace publication; SQLite inserts the header and complete event batch in one transaction. Under same-process or independent-process contention, one writer publishes and equivalent writers inspect the same complete target. A different cwd, preset, provider, or model for the same deterministic target is an explicit conflict. The persisted `session/imported` event contains safe provenance and counts, never the Host-local source identity or source path.

| Config key | Default | Boundary |
|---|---:|---|
| `maxSourceBytes` | 67108864 | selected source prefix |
| `maxLineBytes` | 1048576 | one complete JSONL record |
| `maxVisibleContextBytes` | 67108864 | retained visible UTF-8 text before model-specific sizing |
| `maxVisibleMessages` | 10000 | retained visible messages |
| `maxToolActivities` | 1000 | retained inert tool facts |
| `maxDiscoveryItems` | 500 | metadata rows returned per discovery |
| `maxReservations` | 32 | uncommitted process-local captures |
| `maxToolSummaryBytes` | 65536 | generated inert tool summary |

## Model Experience

### Continued imported Session

#### What the model sees

The next request sees the imported visible conversation after `session/end-seed`, an explicitly labeled inert tool-activity summary, and the chosen continuation route. The committed `request/header` contains the selected provider/model plus the selected preset's assembled system prompt and tools, so the first new turn continues with the same route that was sized and confirmed. It receives no foreign system prompt, reasoning, tool arguments/results, attachment path, credential, or executable tool call.

#### Token effect

Before publication, the token meter measures the final native seed, including the assembled preset composition. The safe import allowance is `contextWindow - outputReserve - compositionReserve`, where `outputReserve` is the model's default maximum output or 10% of the window, and `compositionReserve` is the larger of 4096 tokens or 10% of the window. An oversized import fails before any durable Session is published.

#### KV Cache effect

The deterministic Session has a new native prefix. An idempotent retry reuses the same Session rather than creating another prefix.

## Known Limitations and Deferred Work

- Import creates a one-shot historical snapshot; it does not synchronize later foreign transcript changes.
- Workspace accounting occurs after atomic Session publication. If it fails, the complete Session remains usable and the Remote reports `workspaceAttached: false`.
- Importing the same captured prefix with different Workspace, Agent-preset, provider, or model choices conflicts instead of silently rewriting immutable Session metadata.
- The v1 Client progress surface reports only operation phases; it does not claim byte-level progress across Remote boundaries.
