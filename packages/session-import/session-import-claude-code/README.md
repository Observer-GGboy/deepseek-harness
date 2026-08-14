# @deepseek-ai/dsh-session-import-claude-code

English | [中文](README.zh.md)

Claude Code Service Provider for `ctx.sessionImports`. It scans the configured root (default `~/.claude/projects`) for UUID-named transcript JSONL files and returns metadata only until the operator selects one source.

The parser retains visible user/assistant text and generated summaries. Repeated assistant UUID records converge only when one text is a prefix of the other. Sidechains, system/progress/file-history records, thinking blocks, attachments, tool input, and tool-result bodies are excluded; tool ids contribute only inert names and terminal statuses. Conflicting duplicates, version changes, out-of-order timestamps, and unknown required shapes fail closed.

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
- Sidechain work and attachment content are intentionally unavailable after import.
- A capture does not resume the Claude Code process, Git branch, permissions, hooks, or tool state.
