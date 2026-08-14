# Agent Note: Models 设置中的防碰撞凭据引用

Status: implemented

[English](2026-08-14-credential-reference-collision.md) | 中文

## 问题

当 pi-ai profile 尚未指名 `apiKeyEnv` 时，Models 页面会派生 `<ROUTE>_API_KEY`。提供方 route id 只在其适配器／settings namespace 内有效，凭据引用却是全局的。因此，名为 `deepseek` 的 pi-ai 路由会派生 `DEEPSEEK_API_KEY`，与 DeepSeek 官方 profile 使用的固定引用相同。保存新的网关密钥会静默替换两条路由共同观察的凭据。反向编辑与删除也存在同样的所有权歧义：一行可以覆盖或移除仍被另一提供方使用的凭据。浏览器从未收到 secret 值，但原有的不含值联接没有保留足够的引用所有权信息来阻止破坏性写入。此决策部分取代了[提供方凭据生命周期 note](2026-08-06-provider-credential-lifecycle.md)中的单行清理证明；该 note 对分阶段写入、重试、空密钥行为和提供方身份仍具有权威性。

## 决策

联接后的提供方行现在会投影出一个不含 secret 的凭据引用台账，其中只有提供方身份、settings namespace／路径与引用名。编辑器或自定义提供方写入凭据前，页面会排除目标自己的 profile，再检查是否已有另一 profile 指名拟写入的引用。

发生碰撞时会渲染原生单选组。安全默认项写入由 namespace 与 route 派生的路由私有引用（`DSH_<NAMESPACE>_<ROUTE>_API_KEY`，必要时追加数字后缀），并通过 profile 的 `apiKeyEnv` 路径记录该引用。另一选项会明确共享现有引用，并说明新密钥会替换所有列出的提供方所用凭据。共享选择只属于精确的「引用＋使用方」碰撞；推送而来的 settings 变化不能把这项意图带到另一目标。若 profile 写入成功而凭据存储失败，重试会保留已提交的引用，只重试 `credentials.set`。

凭据清理采用同一份台账。一行只有在引用符合页面的某项确定性命名规则、已配置且可写，并且没有其他 profile 使用方时，才能移除凭据。共享引用、环境引用、任意自定义引用及其他无法识别的引用都会保留。整个流程中，settings op、UI 文案、日志、测试与快照最多只包含引用名；凭据值始终只写入 `credentials.set` 调用。

## 考虑过的替代方案

**拒绝所有碰撞。** 否决：有意共享凭据对别名和网关路由有实际价值；页面可以让这项操作变得明确，无需完全禁止。

**始终创建新引用且不提供选择。** 否决：这样能防止意外替换，却让用户无法从 UI 保持既有的有意共享。

**只按提供方 route id 确定引用。** 否决：route id 是适配器局部值，这正是产生碰撞的边界错配。namespace 加 route 能提供稳定且用户可读的独立名字。

**读取或比较凭据值来推断共享。** 否决：凭据平面刻意保持只写。只依靠脱敏后的 settings 元数据就能确定引用所有权，因此 secret 内容不得进入浏览器或诊断界面。

## 后果

保存 pi-ai 的 `deepseek` 路由默认不再改变 DeepSeek 官方凭据，任一方也都能从既有共享引用中分离。用户仍可在本地化警告下明确选择共享。DeepSeek 官方需要独立引用时，引导流程现在可能会在 secret 写入前写一条 `apiKeyEnv` settings op；没有碰撞时行为保持不变。引用台账会从每次推送／重新获取的快照中重新计算，因此跨标签页 settings 变化无需缓存 secret 状态即可收敛。确定性引用名比旧的纯 route 形式更长；有意共享凭据的 profile 在替换它时需要多做一次选择。
