# @deepseek-ai/dsh-session-import-claude-code

[English](README.md) | 中文

面向 `ctx.sessionImports` 的 Claude Code Service Provider。它在配置的根目录（默认 `~/.claude/projects`）中扫描以 UUID 命名的 transcript JSONL 文件；在用户选择一个来源前，只返回元数据。

解析器保留可见的用户／助手文本和生成摘要。带相同助手 UUID 的重复记录只在其中一份文本是另一份前缀时收敛。Sidechain、系统／进度／文件历史记录、thinking 块、附件、工具输入和工具结果正文都会被排除；工具 id 只贡献不可执行的名称与终态。在 Claude Code 2.1.128 中观察到的不含正文 `frame-link` 记录被显式视为非对话元数据并忽略。冲突重复、时间戳乱序和未知必要结构会故障关闭。

v1 转换器显式接受 `2.1.128` 至 `2.1.222` 的版本。缺失、格式错误、过旧或更新的版本都会故障关闭。transcript 可以包含该范围内的多个版本；安全来源信息会以 `min..max` 记录观察到的最小值和最大值，而不是拒绝受支持的更新器过渡。

## 模型体验

### Claude Code 历史记录

#### 模型看到什么

确认并转换为原生 Session 后，模型会看到 `imported-claude-code` 来源下经过脱敏的 Claude Code 可见消息、带标记的生成摘要，以及不可执行的工具名称和状态。

#### Token 影响

保留的消息和生成的工具摘要会消耗上下文 token；被排除的 Claude Code 记录不会。

#### KV Cache 影响

该提供方自身无影响；新的原生 Session 拥有独立的提示词前缀。

## 已知限制与暂缓事项

- 只接受以 UUID 命名的 transcript JSONL 文件和显式支持的记录结构。
- 扩大支持的 Claude Code 版本范围需要真实格式 fixture 和经审查的转换器策略变更。
- 导入后刻意不提供 Sidechain 工作与附件内容。
- 捕获不会恢复 Claude Code 进程、Git 分支、权限、hooks 或工具状态。
