# @deepseek-ai/dsh-session-import-codex

English | [中文](README.zh.md)

Codex Service Provider for `ctx.sessionImports`. It scans the configured root (default `~/.codex/sessions`) for rollout filenames ending in a UUID, exposes only session id, size, and modification time during discovery, and parses only the selected stable prefix.

Supported records include `session_meta`, visible user/assistant `response_item` messages, selected visible `event_msg` messages, `compacted` summaries, and inert tool-call status. System/developer messages, reasoning, token counts, tool arguments, and tool output bodies are excluded. Unknown required records and conflicting identities fail closed.

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
- A capture does not resume the Codex process, Git branch, approvals, sandbox, or tool state.
- Concurrent appends are outside the immutable captured prefix and require another capture to import.
