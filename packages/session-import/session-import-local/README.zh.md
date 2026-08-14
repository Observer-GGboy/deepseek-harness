# @deepseek-ai/dsh-session-import-local

[English](README.md) | 中文

本地 transcript 导入的 Host 消费方。`ctx.sessionImportLocal` 通过生成的 Remote 方法提供选项、元数据发现、选定来源捕获、提交和丢弃。捕获会把有界中立快照保存在不透明的进程本地预留之后；transcript 正文、来源路径、来源文件身份和秘密都不会跨越 Client 边界。

提交要求用户显式选择 Workspace 与 Agent 预设。目标 Session id 由来源文件身份、来源 Session id 和捕获前缀摘要确定性派生。消费方重新校验并脱敏提供方输出，将其转换为平衡的原生事件，并在持久化前通过 `SessionStore.prepare()` 校验完整 seed。

JSONL 首次实体化使用后端的禁止替换发布；SQLite 在同一事务中插入 header 与完整事件批。并发捕获时，一个写入方完成发布，等价写入方检查并返回同一个完整目标。对同一确定性目标使用不同 cwd 或预设会产生显式冲突。持久化的 `session/imported` 事件只包含安全来源信息和计数，绝不包含 Host 本地来源身份或来源路径。

| 配置键 | 默认值 | 边界 |
|---|---:|---|
| `maxSourceBytes` | 67108864 | 所选来源前缀 |
| `maxLineBytes` | 1048576 | 单条完整 JSONL 记录 |
| `maxVisibleContextBytes` | 4194304 | 保留的可见 UTF-8 文本 |
| `maxVisibleMessages` | 10000 | 保留的可见消息 |
| `maxToolActivities` | 1000 | 保留的不可执行工具事实 |
| `maxDiscoveryItems` | 500 | 每次发现返回的元数据行 |
| `maxReservations` | 32 | 未提交的进程本地捕获 |
| `maxToolSummaryBytes` | 65536 | 生成的不可执行工具摘要 |

## 模型体验

### 继续导入的 Session

#### 模型看到什么

下一次请求会看到 `session/end-seed` 之后的导入可见对话，以及带显式标签、不可执行的工具活动摘要。它不会收到外部系统提示词、推理、工具参数／结果、附件路径、凭据或可执行工具调用。

#### Token 影响

导入的可见消息和工具摘要会计入下一次请求的上下文预算。

#### KV Cache 影响

确定性 Session 拥有新的原生前缀。幂等重试会复用同一个 Session，而不是创建另一条前缀。

## 已知限制与暂缓事项

- 导入创建一次性历史快照；它不会同步外部 transcript 的后续变化。
- Workspace 记账发生在原子发布 Session 之后。记账失败时，完整 Session 仍可使用，Remote 会报告 `workspaceAttached: false`。
- 使用不同 Workspace 或 Agent 预设导入同一个捕获前缀会产生冲突，不会静默改写不可变 Session 元数据。
