# @deepseek-ai/dsh-session-import-codex

English | [中文](README.zh.md)

Codex Service Provider for `ctx.sessionImports`. It scans the configured root (default `~/.codex/sessions`) for rollout filenames ending in a UUID, exposes only session id, size, and modification time during discovery, and parses only the selected stable prefix.

Supported records include `session_meta`, visible user/assistant `response_item` messages, selected visible `event_msg` messages, `compacted` summaries, and inert tool-call status. System/developer messages, reasoning, token counts, tool arguments, and tool output bodies are excluded. Unknown required records and conflicting identities fail closed.

The v1 converter explicitly accepts semantic versions from `0.144.0` through `0.148.999`, including bounded prerelease suffixes whose numeric core is in that range. Missing, malformed, older, or newer versions fail closed. An unsupported-version diagnosis echoes only a short canonical numeric version; malformed, prerelease, path-shaped, credential-shaped, and oversized values never enter the error message. A rollout may repeat `session_meta` only when the Session identity remains identical; each supported version is retained in safe provenance in sorted `+` form so an in-file updater transition is visible rather than silently discarded.

## Model Experience

### Codex history

#### What the model sees

After confirmation and native conversion, the model sees redacted visible Codex messages under the `imported-codex` source plus inert tool names and statuses.

#### Token effect

The retained messages and generated tool summary consume context tokens; excluded Codex records do not.

#### KV Cache effect

None from this provider itself; the new native Session owns a distinct prompt prefix.

## Known Limitations and Deferred Work

- Only UUID-suffixed rollout JSONL files and the explicitly supported record shapes are accepted.
- Widening the supported CLI range requires real-format fixtures and a reviewed converter policy change.
- A capture does not resume the Codex process, Git branch, approvals, sandbox, or tool state.
- Concurrent appends are outside the immutable captured prefix and require another capture to import.
