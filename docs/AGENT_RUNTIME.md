# AgentRuntime 抽象层与 DeepSeek 迁移

## 现状

Codex 仍是默认运行时。DeepSeek 作为可选的 API Key 驱动实现已完整接入：设置页可切换、密钥加密存储、运行时热切换、首页就绪提示按 provider 区分。

**唯一未完成的是用真实 DeepSeek API Key 跑端到端验证。**

## 为什么需要这层

Codex 二进制包里同时供应四层能力：

| 层 | 内容 | 换 DeepSeek 后 |
| --- | --- | --- |
| 语言模型 | 读懂需求、写代码 | DeepSeek 提供 |
| Agent 运行时 | 多轮"想→调工具→看结果"循环 | **宿主实现**（已完成） |
| 工具执行器 | read / write / edit / run_command | **宿主实现**（已完成） |
| 会话 / 审批 / 沙箱 | thread 持久化、中断、权限 | **宿主实现**（已完成） |

## 文件map

| 文件 | 作用 |
| --- | --- |
| `src/main/agentRuntime.ts` | 提供方中立接口 + 全部传输无关类型 + `AgentRuntimeFeatureSet` |
| `src/main/agentProvider.ts` | Provider 注册表、就绪检查、运行时热切换代理 |
| `src/main/agentProviderManager.ts` | Provider 生命周期：构建、切换、停用、就绪汇总 |
| `src/main/providerCredentialStore.ts` | API Key 加密存储（safeStorage） |
| `src/main/workspaceTools.ts` | 工具执行器：路径守卫、原子写、命令白名单 |
| `src/main/deepseekRuntime.ts` | DeepSeek 运行时：工具循环、通知翻译、会话持久化 |
| `scripts/deepseek-probe.ts` | 能力探针（独立实现，用于交叉验证） |
| `src/main/codexAppServer.ts` | `implements AgentRuntime`，Codex 实现保持不变 |

消费方全部改为依赖接口：`gameHarness.ts`、`gameEngineAdvisor.ts`、`approvalBroker.ts`、`mediaToolBroker.ts`、`mcpConfigManager.ts`、`imageGenerationSkillPolicy.ts`、`projectIconAgent.ts`。

## 已实现的 DeepSeek 能力

| Codex 能力 | DeepSeek 实现 |
| --- | --- |
| `thread/start` | `startThread`，写入 `userData/threads/<id>.json` |
| `thread/resume` | `resumeThread`，从磁盘读回；**缺失时明确报错，不伪造** |
| `turn/start` | 启动异步循环，通过 `notification` 事件汇报 |
| `turn/interrupt` | `AbortController.abort()` + 发 `turn/completed status=interrupted` |
| 内置工具 | `list_files` / `read_file` / `write_file` / `edit_file` / `run_command` |
| 动态工具 | `buildHostTools` + `executeHostTool` 注入并内联分发 |
| 通知协议 | 发出与 Codex 相同形状的 `item/agentMessage/delta`、`turn/completed` |
| 上下文管理 | 超限时保留系统消息 + 最近轮次，并插入显式省略标记 |
| 账户 | `account.type = 'api-key'`，`startLogin` 明确拒绝 |

## 安全约束（已测试）

`workspaceTools.ts` 是安全关键代码，模型决定其参数：

- 拒绝 `..` 逃逸、绝对路径、NUL 字节
- 拒绝跟随逃出工作区的符号链接（读和写都是）
- 原子写：临时文件 + `rename`，不会留下半截文件
- `edit_file` 遇到多处匹配直接拒绝，绝不猜测
- `run_command` 只接受 `npm | node | npx | godot | godot4`，argv 数组 + `shell:false`
- 子进程环境变量白名单，**不传递任何 Provider 密钥**
- 宿主管理的 `AGENTS.md`、`.noobi`、`.codex`、`GAME_DESIGN.md` 对 Agent 只读

## 硬约束（换 provider 时必须遵守）

### 1. 必须自己发通知

`GameHarness.#executeTurn` 只监听 `notification` 事件，**不读 `startTurn` 的返回值**。只返回 turn id 不发通知的 runtime 会让 harness 卡到 20 分钟超时。已由 `agentRuntime.test.ts` 锁定。

### 2. 图片 API 从可选变成硬要求

`validateImageGenerationRoute` 允许 `codex-imagegen` 兜底，DeepSeek 没有这个能力。`assessProviderReadiness` 已经把"未配置图片 API"作为 DeepSeek 的阻断项。

### 3. 缺能力必须显式声明

`AgentRuntimeFeatureSet` 用于让 UI 如实显示"此功能不可用"，而不是 no-op 假装成功。

## 验证

```bash
npm run typecheck
npx vitest run                    # 52 文件 / 415 测试
npm run smoke:ui                  # 界面截图检查
```

新增测试：

| 文件 | 覆盖 |
| --- | --- |
| `agentRuntime.test.ts` | 接口契约、通知合同、三角色流程、能力标志 |
| `agentProvider.test.ts` | Provider 注册、就绪判定、热切换代理 |
| `workspaceTools.test.ts` | 23 项安全测试 |
| `deepseekRuntime.test.ts` | 完整 turn 流程、工具执行、上下文裁剪、会话持久化、harness 集成、中断 |
| `agentProviderManager.test.ts` | 就绪判定、拒绝不可用切换、切换时停用旧 provider、缓存失效 |
| `providerCredentialStore.test.ts` | 密文存储、清除、加密不可用时拒绝、跨机解密失败、信封校验 |

其中最关键的一条：`deepseekRuntime.test.ts` 里有一个测试用**真实的 `GameHarness` + 假的 chat transport** 跑完整的 Planner→Implementer→Reviewer 流程，证明通知契约足够——不需要改 harness 一行。

## main.ts 接线（已完成）

### 运行时热切换

`runtime`（Codex 实例）保持不变，`runtimeHolder.switching()` 返回一个 Proxy，永远转发到当前活动的 runtime。这样 `GameHarness`、`GameEngineAdvisor`、`ApprovalBroker`、`McpConfigManager` 只需构造一次，切换 provider 后自动跟随。

```ts
const runtimeHolder = createRuntimeHolder(runtime);
const agentRuntime = runtimeHolder.switching();
const harness = new GameHarness(agentRuntime);
```

`AgentProviderManager.activate()` 会先做就绪检查，**不可用的 provider 直接拒绝切换**，不会让用户选中一个首次制作就失败的引擎。切换失败时回退到 Codex 并发出 `provider/fallback` 事件，不静默。

### 设置持久化

`AppSettings` 新增 `agentProvider` 与 `providerModels`。旧配置文件缺省回填为 `codex`，升级不会静默改变写用户工作区的引擎。

### 密钥存储

`ProviderCredentialStore` 复用与 `MediaProviderStore` 相同的 safeStorage 封装：

- 磁盘上只有密文
- 系统加密不可用时**拒绝保存**，不降级为明文
- IPC 只返回 `hasApiKey`，永不回传密钥本身
- 设置新 Key 会 `invalidate()` 缓存的 runtime，确保新凭证生效

### UI

「运行时与账户」页：

- Provider 选择卡片（Codex / DeepSeek）
- 未就绪时列出具体阻断原因
- DeepSeek 注明需要自备图片 API
- Codex 显示登录卡片，DeepSeek 显示 API Key 输入框（`type=password`，保存后立即清空）

首页的启动阻断提示按 provider 区分文案：Codex 说"去登录"，DeepSeek 说"去设置"。

## 尚未完成

1. **真实 API 验证**：需要 `DEEPSEEK_API_KEY`，跑 `npm run probe:deepseek` 和一次真实 harness 轮次。
2. **打包**：`package.json` 的 `build.files` 移除 `@openai/codex`（仅在确定不再内置 Codex 时）。
3. **Godot 变可选**：Web 项目不依赖它。

## 已知风险

| 风险 | 现状 |
| --- | --- |
| DeepSeek 上下文较小 | 已实现裁剪 + 显式省略标记；真实表现待测 |
| 工具调用不收敛 | 步数上限 40，超限判为 failed，不伪装成功 |
| 编造文件内容 | 靠 `read_file` 强制约束 + 宿主门禁兜底 |

模型能力的真实水平只能靠 `npm run probe:deepseek` 测量，单元测试测不出来。
