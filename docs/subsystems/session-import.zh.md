# Session 导入

[English](session-import.md) | 中文

本地 Session 导入会把用户选中的 Codex 或 Claude Code JSONL 前缀变成一个可继续使用的新 DeepSeek Harness Session。它是一次性历史快照，不是进程迁移：Git 状态、进程、权限、hooks、工具、隐藏指令、推理、环境值和附件都不会恢复。

## 包拓扑

| 角色 | 包 | 职责 |
|---|---|---|
| Service Definition | `dsh-session-import` | 提供方注册表、中立类型、仅元数据发现、有界稳定 JSONL 捕获、脱敏 |
| Service Provider | `dsh-session-import-codex` | 归约受支持的 Codex rollout |
| Service Provider | `dsh-session-import-claude-code` | 归约受支持的 Claude Code transcript |
| Host 消费方 | `dsh-session-import-local` | 预留、校验、原生转换、确定性身份、持久化、Remote 方法 |
| Client 消费方 | `dsh-client-ui-session-import` | Settings 发现、元数据预览、显式目标确认、取消、打开流程 |

外部 JSON 永远不会进入原生事件联合。每个 Service Provider 把受支持的完整记录归约为 `ForeignSessionSnapshot`；只有 Host 消费方构造 `SessionEvent` 值。Web Client 只接收来源 id、大小、修改时间、计数、可选 cwd 提示和不透明预留 id——绝不接收 transcript 文本或来源文件路径。

## 捕获边界

发现过程递归枚举普通文件，并对匹配 UUID 文件名的条目执行 stat，不打开正文，也不跟随符号链接。捕获会规范化所选文件并证明其位于配置根目录内，把前缀固定为开始时的字节大小，在显式限制内流式处理完整换行记录，并对完全相同的前缀执行两次哈希。之后的追加可以继续，且位于快照之外。替换、截断、中段变更、格式错误的完整记录、重复身份、时间戳乱序和未知必要结构都会拒绝捕获，不创建预留。

解析器只保留可见的用户／助手文本、带标记的生成摘要，以及不含正文的工具名称／状态。常见凭据形状会在进入快照前脱敏，并在转换为原生事件前再次脱敏。工具输入／输出、系统／开发者指令、推理、附件引用、环境数据和来源路径都没有持久化表示。转换器 v1 接受 Codex `0.144.0` 至 `0.148.999` 与 Claude Code `2.1.128` 至 `2.1.222`；缺失、格式错误或超出范围的版本会故障关闭。文件内受支持的版本过渡会保留在来源信息中。Claude Code 不含正文的 `frame-link` 元数据会被显式忽略。

## 预留与提交

捕获创建不透明、有界、进程本地的预留。提交只接受该预留、现有 Workspace id、可用 Agent 预设 id 与精确 provider/model 路由。一个预留只提交一次；使用不同选项的并发调用会冲突，离开 Settings 会丢弃未提交的预留。等待相同选择的调用方可独立取消；只有最后一个等待方离开后，共享提交才会中止。

目标 Session id 对 Host 本地来源文件身份、来源 Session id 和稳定前缀摘要执行哈希。`SessionStore.prepare()` 在存储前校验完整原生 seed。JSONL 首次发布使用禁止替换实体化；SQLite 在同一事务中写入 header 和完整事件批。因此 2、10 或 100 个等价竞争方——即使来自独立 Node 进程——也只有一个获胜，其余竞争方检查并返回同一个平衡目标，不会发布重复或部分 Session。

可忽略的 `session/imported` 事件会持久化安全来源类型、来源 Session id、供应商／转换器版本、前缀摘要、捕获时间、计数和部分尾记录状态。它排除 transcript 绝对路径和 Host 本地文件身份。不可变 Session 元数据使得使用不同 Workspace 路径、Agent 预设、provider 或 model 的重试成为显式冲突。

## 继续语义

导入消息会变成已关闭的原生轮次。历史工具会变成带标签、不可执行的用户上下文摘要；系统不会合成 `tool/call` 或 `tool/result` 事件，因此没有内容能够重放。`session/end-seed` 关闭经过校验的历史前缀。Host 在脱离持久化的 Session 上组装所选预设的系统提示词和工具，在 `request/header` 中记录确认的 provider/model，并在发布前计量最终 seed。安全导入容量为模型上下文窗口减去默认输出额度（缺失时取 10%），再减去 4096 token 与窗口 10% 中较大的组装及下一提示词预留。只有用户在已确认的 Workspace、预设与模型路由下发送下一条消息后，新工作才会开始。

Workspace 关联在原子发布 Session 后尽力执行。失败会返回 `workspaceAttached: false`，并让完整 Session 保持可选择、可使用；重试绝不会重新发布其事件日志。

## 安全与运维限制

- 配置的来源根目录与大小／数量预算属于 Host 策略，不是 Client 输入。
- v1 UI 只报告有界阶段状态（发现、捕获、提交），不跨 Remote 边界暴露字节进度。
- 无法识别任意自然语言中的所有秘密；该功能把常见形状脱敏、结构性排除与仅元数据 Client 约定结合起来。
- 格式漂移会故障关闭。支持新的供应商必要记录时，需要加入解析器 fixture 并显式更改转换器版本。
- 快照不可变。要捕获后来追加的前缀，请再次导入；系统不提供持续同步。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionimportlocal--localsessionimportservice"></a>

### `ctx.sessionImportLocal` — `LocalSessionImportService`

Host Remote consumer. Providers remain separately registered on `ctx.sessionImports`.

```ts cordis-catalog
/**
 * Current source/workspace/preset/model choices for the confirmation screen.
 * @param signal Remote request cancellation signal.
 * @returns Available source kinds and explicit continuation targets.
 */
@Remote('options') async options(signal: AbortSignal): Promise<SessionImportResult<SessionImportOptionsValue>>

/**
 * Metadata-only discovery for one explicitly chosen provider.
 * @param request Chosen source kind.
 * @param signal Remote request cancellation signal.
 * @returns Bounded source metadata rows without transcript content.
 */
@Remote('discover') async discover( request: SessionImportDiscoverRequest, signal: AbortSignal, ): Promise<SessionImportResult<SessionImportDiscoverValue>>

/**
 * Capture a selected stable prefix behind an opaque reservation.
 * @param request Explicitly selected source identity.
 * @param signal Remote request cancellation signal.
 * @returns Sanitized counts and an opaque one-shot reservation identity.
 */
@Remote('capture') async capture( request: SessionImportCaptureRequest, signal: AbortSignal, ): Promise<SessionImportResult<SessionImportCaptureValue>>

/**
 * Atomically publish after explicit workspace, preset, and model confirmation.
 * @param request Reservation and confirmed continuation targets.
 * @param signal Remote request cancellation signal.
 * @returns Published session identity and idempotency/attachment status.
 */
@Remote('commit') commit( request: SessionImportCommitRequest, signal: AbortSignal, ): Promise<SessionImportResult<SessionImportCommitValue>>

/**
 * Release an uncommitted capture.
 * @param request Opaque reservation identity to discard.
 * @returns Whether an uncommitted reservation was removed.
 */
@Remote('discard') discard(request: SessionImportDiscardRequest): SessionImportResult<SessionImportDiscardValue>
```

Source: [`packages/session-import/session-import-local/src/index.ts:317`](../../packages/session-import/session-import-local/src/index.ts)

<a id="ctxsessionimports--sessionimportregistry"></a>

### `ctx.sessionImports` — `SessionImportRegistry`

Registry of source-format providers. It performs no persistence or conversion.

```ts cordis-catalog
/**
 * Register one source kind for the lifetime of the calling effect.
 * @param provider Provider implementation to register.
 * @returns Effect disposer that unregisters the provider.
 */
registerProvider(provider: ForeignSessionProvider): () => void

/**
 * Return one registered provider without choosing a fallback.
 * @param kind Exact source kind to resolve.
 * @returns The registered provider, or `undefined` when unavailable.
 */
getProvider(kind: ForeignSessionSourceKind): ForeignSessionProvider | undefined

/**
 * Return source kinds in deterministic lexical order.
 * @returns Registered source kinds.
 */
listProviders(): ForeignSessionSourceKind[]
```

Source: [`packages/session-import/session-import/src/index.ts:21`](../../packages/session-import/session-import/src/index.ts)
<!-- END GENERATED cordis-surface -->
