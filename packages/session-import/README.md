# session-import/ — safe local transcript import

English | [中文](README.zh.md)

This capability family discovers local Codex and Claude Code JSONL transcripts, captures one selected stable prefix, reduces it to a provider-neutral snapshot, and publishes a new DeepSeek Harness Session only after the operator confirms the destination Workspace and Agent preset.

| Package | Role | ctx key |
|---|---|---|
| [`session-import/`](session-import/README.md) | Defines the provider registry, neutral snapshot, bounded discovery, capture, and redaction helpers | `ctx.sessionImports` |
| [`session-import-codex/`](session-import-codex/README.md) | Parses supported Codex rollout JSONL into the neutral snapshot | registers on `ctx.sessionImports` |
| [`session-import-claude-code/`](session-import-claude-code/README.md) | Parses supported Claude Code transcript JSONL into the neutral snapshot | registers on `ctx.sessionImports` |
| [`session-import-local/`](session-import-local/README.md) | Owns reservations, native Session conversion, atomic persistence, and the Client Remote | `ctx.sessionImportLocal` |
| [`../client/ui-session-import/`](../client/ui-session-import/README.md) | Provides the explicit Web Settings discovery, preview, confirmation, and open flow | registers `settings.section` |

The subsystem reference and security boundaries are in [docs/subsystems/session-import.md](../../docs/subsystems/session-import.md).
