# AI 应用问答接入

Vidence 连接 AI 后，可以围绕视频解答问题、整理笔记和查阅学习记忆。普通用户先按[AI 服务设置](setup-models.md)连接已有服务；本页供开发者了解提问和读取学习资料的具体接入方式。

本项目把“发问通道”和“知识访问通道”分开：

- **AIAppConnector**：向 AI 应用发送问题（打开标签页、定位输入框、填入、用户确认后提交、读取可见回答）。
- **MemoryConnector**：让 AI 应用查库（检索、读证据、邻域、关键帧、回传答案）。API 路线使用插件内只读工具；DSH / OpenCode Go 通过原生 MCP 调用同一组文字工具；网页辅助路线发送有限证据包。

## 1. 能力注册表

`src/aiapps/registry.ts` 为每个应用声明：

| 能力 | 含义 |
| --- | --- |
| `createConversation` | 能打开/新建会话 |
| `autoSend` | 能通过可见界面的发送按钮提交 |
| `attachText` | 能把问题与证据填入输入框 |
| `attachImages` | 能附加图片（当前均为 `false`） |
| `connectTools` | 能调用记忆库工具（网页路线均为 `false`） |
| `receiveAnswer` | 能读取可见回答 |
| `streamAnswer` | 能流式接收（当前均为 `false`，采用轮询读取） |
| `cancel` | 能取消生成（当前均为 `false`） |
| `requiresConfirmation` | 默认要求用户确认后再发送 |
| `needsLocalBridge` / `needsRemoteService` | 是否需要额外组件 |

界面状态：

- `full`：完整问答（发送 + 回答回流）
- `send-only`：可发送，答案在原应用查看
- `tools-only`：支持自主查库但不能主动发问
- `snippets-only`：仅提供检索片段
- `manual-handoff`：手动交接
- `unverified`：未在真实账号下验证
- `unavailable`：当前环境不可用

**内置的五个网页连接器目前均为 `verified: false`**，界面显示“未验证”，不冒充已支持。

## 2. 网页辅助流程

1. 用户在侧边栏选择应用并提问；发送时冻结当前媒体时间与选中节点。
2. 后台本地检索 ≤6 条证据，生成带证据编号的提示词（`src/aiapps/prompt.ts`）。
3. 打开/复用该应用标签页；内容脚本（`src/entrypoints/ai-bridge.ts`）在正常可见界面中：
   - 按选择器定位输入框；
   - 使用原生 setter / `execCommand('insertText')` 填入文本并派发输入事件；
   - 默认只填入，等待用户在侧边栏点击“发送到应用”后再点击发送按钮或按 Enter；
   - 轮询读取最后一条助手消息的可见文本。
4. 后台状态机：`preparing → awaiting-login / awaiting-confirm → sent → generating → completed | canceled | failed | unknown-delivery`。
5. 回答中的 `[E:id]` 只保留本次证据包内的 ID，其余移除并计数。

### 已知风险

- 站点改版会使选择器失效；界面会显示“未验证”与原因。
- 读取的是可见文本，不是隐藏推理或协议数据。
- 后台重启后，已发送但未确认的请求标记为 `unknown-delivery`，**不自动重发**，用户可点击“读取当前回答”。

## 3. API 路线与工具协议

只读工具（`src/agent/tools.ts`）：

- `search_library`：查询、节点/时间范围、条数上限 1–20。
- `read_evidence`：最多 12 条证据，总长度上限 12k 字符。
- `get_timeline`：节点目录，最多 50 条。
- `get_neighbors`：前后各 ≤2 个节点。
- `get_frame`：仅在 `privacy.allowVisionUpload`、本次允许图片、未超图像预算、关键帧 `uploadAllowed` 时返回图像。

范围检查：多选节点提问时 `scopes` 非空，检索与读取都限制在所选节点及其证据内；不被模型“扩大范围”的请求带动。

引用核验：`finalizeCitations()` 只接受本次实际读取过的证据 ID，未知引用移除并计入警告。

## 4. 本地智能体与 MCP 桥接

已实现 `scripts/local-agent-bridge.mjs`（Node 标准库，127.0.0.1:8131）：

- 回环 + 配对令牌 + 扩展 Origin，固定工作目录，后端白名单、超时、取消和单任务上限。
- OpenCode Go 的模型列表从 DSH 桌面配置读取；不是官方 DeepSeek 两项列表，也不冒充远端实时发现。
- 调用已安装 DSH 的 headless CLI，使用其原生凭据解析；OpenCode Go 设置 provider、所选 model 和 high。
- MCP 子进程仅暴露 `get_question`、`search_library`、`read_evidence`、`get_timeline`、`get_neighbors`。
- 每次提问创建临时通道；扩展轮询领取调用并用现有 ToolExecutor 执行，数据库不复制到磁盘。结束、取消、超时撤销通道；默认最多 4 次工具读取，可按问答预算调低或关闭。
- 当前请求的 videoId、selectedNodeIds 和 scopes 在扩展执行侧校验；邻域读取不能越过已选范围。
- 最终答案从 CLI 回流；引用只能来自随附证据或本次工具实际读取过的原文，不提供 `submit_answer`。
- Codex CLI 已实测有限证据问答；Claude Code 适配器未在本机实测，因为未安装。两者目前不接此 MCP 通道。
- 云端应用只能使用其可访问的远程连接器或已同步的 Notion 数据，不能声称能读本机 IndexedDB 或 localhost。

网页路线仍明确显示“基于已附证据回答”，不声称能自主检索整个库。本地智能体当前只传文字，图片授权控件禁用。

## 5. 为什么不用 iframe / Cookie / 私有接口

- iframe 嵌入受站点 `X-Frame-Options`/CSP 限制，且无法保证会话与焦点行为；改用独立标签页 + 扩展消息。
- 读取登录 Cookie、会话令牌或逆向私有接口会把用户账号置于风险中，且违反多数平台条款；已明确禁止。
- 未登录或验证码页面：暂停并让用户接管，不绕过。

## 6. 网页辅助连接器实测状态

本节仅指五个网页辅助连接器；OpenCode Go 原生路线已实测，见第 4 节。网页路线目前：

- 选择器、填写、读取与状态机的代码已完成；
- 未在任何真实登录账号下验证，因此全部标记为“未验证”；
- 未使用复制按钮或 API 回答冒充“AI 应用问答验收通过”。

若要验证某个应用，可按以下步骤：在桌面 Chrome/Edge 登录该应用 → 侧边栏选择它 → 提问 → 确认填入内容 → 点击“发送到应用” → 观察是否出现新回答并被“读取当前回答”捕获。成功后可把 `registry.ts` 中对应项的 `verified` 改为 `true`，并在提交说明中记录日期、浏览器版本与失败点。

感谢您的支持，如果有帮助的话，请点一个 [STAR](https://github.com/lby749/Vidence)，谢谢！
