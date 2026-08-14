# @deepseek-ai/dsh-session-import-local

[English](README.md) | 中文

本地 transcript 导入的 Host 消费方。`ctx.sessionImportLocal` 通过生成的 Remote 方法提供选项、元数据发现、选定来源捕获、提交和丢弃。捕获会把有界中立快照保存在不透明的进程本地预留之后；transcript 正文、来源路径、来源文件身份和秘密都不会跨越 Client 边界。

提交要求用户显式选择 Workspace、Agent 预设与精确 provider/model。目标 Session id 由来源文件身份、来源 Session id 和捕获前缀摘要确定性派生。消费方重新校验并脱敏提供方输出，将其转换为平衡的原生事件，在脱离持久化的 Session 上组装所选预设的系统提示词和工具，并在持久化前通过 `SessionStore.prepare()` 校验完整 seed。

JSONL 首次实体化使用后端的禁止替换发布；SQLite 在同一事务中插入 header 与完整事件批。同一进程或独立进程发生竞争时，一个写入方完成发布，等价写入方检查并返回同一个完整目标。对同一确定性目标使用不同 cwd、预设、provider 或 model 会产生显式冲突。持久化的 `session/imported` 事件只包含安全来源信息和计数，绝不包含 Host 本地来源身份或来源路径。

只有检查发现不匹配的持久化获胜方时，追加拒绝才会成为 `target-conflict`；没有获胜方时会返回已脱敏的 `internal` 持久化失败。只要仍有其他等待方，同一提交的调用方就可以独立取消。最后一个等待方会中止共享操作并等待其完全结束，然后才收到 `cancelled`。插件卸载会关闭提交准入、中止所有共享提交并等待其结束；如果追加已经越过原子发布点，完整 Session 会保留，但卸载后不会再开始 Workspace 关联。

| 配置键 | 默认值 | 边界 |
|---|---:|---|
| `maxSourceBytes` | 67108864 | 所选来源前缀 |
| `maxLineBytes` | 1048576 | 单条完整 JSONL 记录 |
| `maxVisibleContextBytes` | 67108864 | 按模型计量前保留的可见 UTF-8 文本 |
| `maxVisibleMessages` | 10000 | 保留的可见消息 |
| `maxToolActivities` | 1000 | 保留的不可执行工具事实 |
| `maxDiscoveryItems` | 500 | 每次发现返回的元数据行 |
| `maxReservations` | 32 | 未提交的进程本地捕获 |
| `maxToolSummaryBytes` | 65536 | 生成的不可执行工具摘要 |

## 模型体验

### 继续导入的 Session

#### 模型看到什么

下一次请求会看到 `session/end-seed` 之后的导入可见对话、带显式标签且不可执行的工具活动摘要，以及所选继续路由。已提交的 `request/header` 包含所选 provider/model 与所选预设组装出的系统提示词和工具，因此第一条新消息会沿用已计量、已确认的路由。它不会收到外部系统提示词、推理、工具参数／结果、附件路径、凭据或可执行工具调用。

#### Token 影响

发布前，token meter 会计量最终原生 seed，包括组装后的预设内容。安全导入额度为 `contextWindow - outputReserve - compositionReserve`：`outputReserve` 取模型默认最大输出或窗口的 10%，`compositionReserve` 取 4096 token 与窗口 10% 中的较大者。超出额度的导入会在发布任何持久 Session 前失败。

#### KV Cache 影响

确定性 Session 拥有新的原生前缀。幂等重试会复用同一个 Session，而不是创建另一条前缀。

## 已知限制与暂缓事项

- 导入创建一次性历史快照；它不会同步外部 transcript 的后续变化。
- Workspace 记账发生在原子发布 Session 之后。记账失败时，完整 Session 仍可使用，Remote 会报告 `workspaceAttached: false`。
- 使用不同 Workspace、Agent 预设、provider 或 model 导入同一个捕获前缀会产生冲突，不会静默改写不可变 Session 元数据。
- v1 Client 进度界面只报告操作阶段，不声称跨 Remote 边界提供字节级进度。
