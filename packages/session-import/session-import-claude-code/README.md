# @deepseek-ai/dsh-session-import-claude-code

English | [中文](README.zh.md)

Claude Code Service Provider for `ctx.sessionImports`. It scans the configured root (default `~/.claude/projects`) for UUID-named transcript JSONL files and returns metadata only until the operator selects one source.

The parser retains visible user/assistant text and generated summaries. Repeated assistant UUID records converge only when one text is a prefix of the other. Sidechains, system/progress/file-history records, thinking blocks, attachments, tool input, and tool-result bodies are excluded; tool ids contribute only inert names and terminal statuses. The body-free `frame-link` record observed in Claude Code 2.1.128 is explicitly ignored as non-conversation metadata. Conflicting duplicates, out-of-order timestamps, and unknown required shapes fail closed.

The v1 converter explicitly accepts versions from `2.1.128` through `2.1.222`, including bounded prerelease suffixes. Missing, malformed, older, or newer versions fail closed. An unsupported-version diagnosis echoes only a short canonical numeric version; malformed, prerelease, path-shaped, credential-shaped, and oversized values never enter the error message. A transcript may contain multiple versions within that range; safe provenance records the observed minimum and maximum as `min..max` instead of rejecting a supported updater transition.

## Model Experience

### Claude Code history

#### What the model sees

After confirmation and native conversion, the model sees redacted visible Claude Code messages under the `imported-claude-code` source, marked generated summaries, and inert tool names and statuses.

#### Token effect

The retained messages and generated tool summary consume context tokens; excluded Claude Code records do not.

#### KV Cache effect

None from this provider itself; the new native Session owns a distinct prompt prefix.

## Known Limitations and Deferred Work

- Only UUID-named transcript JSONL files and the explicitly supported record shapes are accepted.
- Widening the supported Claude Code range requires real-format fixtures and a reviewed converter policy change.
- Sidechain work and attachment content are intentionally unavailable after import.
- A capture does not resume the Claude Code process, Git branch, permissions, hooks, or tool state.
