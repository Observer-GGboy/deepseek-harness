# session-import/：安全导入本地 transcript

[English](README.md) | 中文

该能力家族发现本地 Codex 与 Claude Code JSONL transcript（文本记录），捕获一个由用户选择的稳定前缀，将其归约为提供方中立快照，并且只在用户确认目标 Workspace 和 Agent 预设后发布新的 DeepSeek Harness Session。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-import/`](session-import/README.md) | 定义提供方注册表、中立快照、有界发现、捕获与脱敏辅助函数 | `ctx.sessionImports` |
| [`session-import-codex/`](session-import-codex/README.md) | 将受支持的 Codex rollout JSONL 解析为中立快照 | 注册到 `ctx.sessionImports` |
| [`session-import-claude-code/`](session-import-claude-code/README.md) | 将受支持的 Claude Code transcript JSONL 解析为中立快照 | 注册到 `ctx.sessionImports` |
| [`session-import-local/`](session-import-local/README.md) | 负责预留、原生 Session 转换、原子持久化与 Client Remote | `ctx.sessionImportLocal` |
| [`../client/ui-session-import/`](../client/ui-session-import/README.md) | 提供 Web Settings 中显式的发现、预览、确认与打开流程 | 注册 `settings.section` |

子系统参考和安全边界见 [docs/subsystems/session-import.md](../../docs/subsystems/session-import.md)。
