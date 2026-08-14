# @deepseek-ai/dsh-session-import-codex

[English](README.md) | 中文

面向 `ctx.sessionImports` 的 Codex Service Provider。它在配置的根目录（默认 `~/.codex/sessions`）中扫描以 UUID 结尾的 rollout 文件名；发现阶段只公开 Session id、大小和修改时间，只解析用户选中的稳定前缀。

受支持的记录包括 `session_meta`、可见的用户／助手 `response_item` 消息、选定的可见 `event_msg` 消息、`compacted` 摘要和不可执行的工具调用状态。系统／开发者消息、推理、token 计数、工具参数和工具输出正文都会被排除。未知的必要记录和冲突身份会故障关闭。

v1 转换器显式接受 `0.144.0` 至 `0.148.999` 的语义版本；只要数字核心位于该范围，也接受预发布后缀。缺失、格式错误、过旧或更新的版本都会故障关闭。rollout 仅可在 Session 身份保持一致时重复 `session_meta`；所有受支持版本会以排序后的 `+` 形式保留在安全来源信息中，使文件内的更新器过渡可见，而不会被静默丢弃。

## 模型体验

### Codex 历史记录

#### 模型看到什么

确认并转换为原生 Session 后，模型会看到 `imported-codex` 来源下经过脱敏的 Codex 可见消息，以及不可执行的工具名称和状态。

#### Token 影响

保留的消息和生成的工具摘要会消耗上下文 token；被排除的 Codex 记录不会。

#### KV Cache 影响

该提供方自身无影响；新的原生 Session 拥有独立的提示词前缀。

## 已知限制与暂缓事项

- 只接受以 UUID 结尾的 rollout JSONL 文件和显式支持的记录结构。
- 扩大支持的 CLI 版本范围需要真实格式 fixture 和经审查的转换器策略变更。
- 捕获不会恢复 Codex 进程、Git 分支、审批、sandbox 或工具状态。
- 并发追加位于不可变捕获前缀之外，需要再次捕获才能导入。
