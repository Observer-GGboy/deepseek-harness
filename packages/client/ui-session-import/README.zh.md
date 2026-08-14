# @deepseek-ai/dsh-client-ui-session-import

[English](README.md) | 中文

用于导入本地 Codex 与 Claude Code Session 的 Web Settings 消费方。该分节要求用户显式选择来源类型并触发发现，只列出元数据；随后捕获一个被选中的来源，预览计数和可选 cwd 提示，并要求同时确认 Workspace、Agent 预设与精确继续模型后才能提交。每个模型选项都会显示 Host 计算出的安全导入 token 额度。

UI 永远不会接收或渲染消息文本、工具参数／结果、来源 transcript 路径、文件身份、凭据或预留内容。捕获与提交使用 `AbortSignal`；更换来源或离开页面会丢弃未提交的预留。v1 进度约定刻意只报告有界的本地阶段——查找、读取／校验与原子发布——不暴露未经验证的字节计数。发布后，Client 刷新 Session 列表并打开确定性的导入 Session。

## 模型体验

### 用户确认的导入

#### 模型看到什么

UI 自身不添加模型内容。经其确认的 Host 提交会创建 `dsh-session-import-local` 所述的安全历史上下文。

#### Token 影响

提交前不影响 token。发布前，Host 会把完整导入 seed 连同所选预设组装出的系统提示词和工具一起计量，并与所选模型的安全额度比较。下一次模型请求会计入保留的上下文。

#### KV Cache 影响

渲染 Settings 无直接影响；导入的原生 Session 会开始自己的前缀。

## 已知限制与暂缓事项

- 发现操作读取 DeepSeek Harness Host 的文件系统；在远程部署中，它可能与浏览器设备不同。
- 预览刻意只显示计数和元数据，不显示 transcript 摘录。
- 发布后的 Workspace 记账失败时，Settings 会保持打开并显示警告，同时完整 Session 已被选中且可以使用。
