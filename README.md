# Ghost Personal Agent

基于 DeepSeek Harness + Fastify 的个人 AI 助手，支持流式聊天、技能加载和会话持久化。

## 架构

```
┌─────────────────────────────────────────────┐
│  Application Layer (Fastify)                │
│  - HTTP API (POST /api/message)             │
│  - SSE streaming (/api/message/stream)      │
│  - Conversation routing                    │
│  - SessionManager: queue & idle cleanup     │
│  - Conversation history presentation       │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Agent Core (Cordis + DSH)                  │
│  - Create / resume Agent handles           │
│  - Run turns & stream events               │
│  - Read durable session events             │
└─────────────────────────────────────────────┘
```

## 快速开始

需要 Node.js 24+

```bash
npm install
cp .env.example .env
```

编辑 `.env` 配置模型接口和密钥。

会话数据库默认是 `data/ghost.sqlite`，启动时自动创建表。可以通过 `SESSION_DB_PATH` 指定其他路径，不需要单独运行数据库服务。

如果已有旧版本的 JSONL 会话，先停止旧后端，再导入：

```bash
npm run migrate:sessions
```

默认读取 `$DSH_HOME/sessions`（未配置 `DSH_HOME` 时是 `data/sessions/sessions`）。也可以用 `npm run migrate:sessions -- /path/to/jsonl-root` 指定来源。导入保留原 session ID、时间、完整事件和分支元数据，不删除 JSONL 文件；重复执行会核对已导入的历史前缀，有冲突时拒绝覆盖。

### 启动后端

```bash
npm run dev
```

服务器默认监听 `http://0.0.0.0:3000`

`npm run dev` 会监听源码和配置变化并自动重启；直接运行后端使用 `npm start`。

### 启动前端（开发模式）

新开一个终端：

```bash
npm run dev:web
```

前端默认运行在 `http://localhost:5173`，API 请求会自动代理到后端。

### 生产构建

```bash
npm run build:web
```

前端打包到 `dist/web/`，可以用 Nginx 或其他静态服务器托管。

## 配置接口和模型

所有模型连接写在 `.env`，添加模型或接口只需编辑这里：

```dotenv
MODEL_PROVIDER=gateway
MODEL_NAME=model-a

MODEL_PROVIDERS='{
  "gateway": {
    "api": "openai-completions",
    "baseURL": "https://gateway.example.com/v1",
    "apiKeyEnv": "GATEWAY_API_KEY",
    "models": [
      { "id": "model-a", "maxTokens": 4096 },
      { "id": "model-b", "maxTokens": 8192 }
    ]
  }
}'

GATEWAY_API_KEY=你的密钥
```

`MODEL_PROVIDERS` 是用单引号包裹的 JSON 对象，可以换行。对象的键是你自定义的 provider 名称。`MODEL_PROVIDER` 选择初始接口，`MODEL_NAME` 选择该接口 `models` 中的模型 ID。示例中的地址和 ID 需要替换为服务实际提供的值。

同一个地址、协议和密钥提供的模型放在同一个 `models` 列表中。不同接口在 `MODEL_PROVIDERS` 中新增一个键，各自定义 `api`、`baseURL`、`apiKeyEnv` 和 `models`；所有配置的接口会同时注册。`.env.example` 包含两个接口的完整示例。

| api | 协议 | baseURL 示例 |
| --- | --- | --- |
| `openai-completions` | Chat Completions | `https://api.openai.com/v1` |
| `openai-responses` | Responses | `https://api.openai.com/v1` |
| `anthropic-messages` | Anthropic Messages | `https://api.anthropic.com` |

地址填写 API 根路径，不包含 `/chat/completions`、`/responses` 或 `/messages`。网关需要兼容所选协议的流式响应和工具调用。

`apiKeyEnv` 填写保存密钥的环境变量名称，密钥本身写在该变量中。启动时检查选中接口的密钥；调用其他接口时由适配器解析其密钥。

每个模型可以配置 `maxTokens`（默认输出上限）、`contextWindow`（上下文容量）、`input`（如 `["text", "image"]`），以及适配器支持的 `reasoningEfforts`、`compat` 等字段。每个接口也可配置 `headers`、`compat`、`timeoutMs` 等原生 pi-ai 适配器字段。配置在启动时读取，编辑后重新启动。

## 同一 Agent 中切换模型

宿主可在 Agent 创建后安装模型选择器，保留同一会话历史：

```ts
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'

const selection: ModelSelectionRef = {
  current: { provider, model },
  assembled: undefined,
}
installModelSelection(agent.ctx, selection)

await agent.whenIdle()
selection.current = { provider: 'gateway', model: 'model-b' }
// 然后通过 agent.followup(...) 继续对话。
```

切换目标必须出现在 `MODEL_PROVIDERS` 中。更换接口时同时替换 provider 和 model；选择器在后续步骤生效，正在进行的请求保持原选择。

## API 使用

### 发送消息（同步）

```bash
curl -X POST http://localhost:3000/api/message \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "owner",
    "channel": "main",
    "content": "Hello!"
  }'
```

响应：

```json
{
  "conversationId": "main",
  "sessionId": "ghost-..."
}
```

### 发送消息（SSE 流式）

```bash
curl -X POST http://localhost:3000/api/message/stream \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "owner",
    "channel": "main",
    "content": "用 greeting 技能跟我打个招呼，我叫 Richard"
  }'
```

返回 Server-Sent Events：

```
data: {"type":"metadata","conversationId":"..."}

data: {"type":"text","text":"你"}

data: {"type":"text","text":"你好"}

data: {"type":"event","event":{...}}

data: {"type":"done"}
```

`text` 来自 DSH 的实时 `agent/assistant-stream` 事件，每次携带当前生成尝试的完整可见文本。客户端替换已有文本，避免重复拼接；新步骤或重试会先发送空文本。推理内容和工具参数不会进入 `text` 消息。最终 `assistant/message` 用于校准文本，成功时发送 `done`，生成失败时发送 `error`。

前端通过 `/api/message/stream` 请求；开发模式使用 Vite 代理，生产环境需要将 `/api` 转发到后端。

### 读取主会话历史

```bash
curl 'http://localhost:3000/api/conversation?userId=owner&channel=main'
```

返回 `id`、`title`、`messages`、`createdAt` 和 `updatedAt`，前端打开时自动加载。请求中的 `userId` 和 `channel` 由客户端提供，暂未接入身份认证。

### 健康检查

```bash
curl http://localhost:3000/api/health
```

## 目录结构

```
ghost/
├── main.ts                  # 应用入口（Fastify）
├── src/
│   ├── app/                 # 应用层（Fastify）
│   │   ├── server.ts
│   │   ├── conversation-routing.ts  # 用户/channel → 逻辑会话
│   │   ├── session-manager.ts       # 实例管理、排队、空闲释放
│   │   ├── conversation-history.ts  # 事件 → 前端聊天记录
│   │   └── routes/
│   │       └── message.ts
│   ├── agent-core/          # Agent 核心（Cordis + DSH）
│   │   ├── index.ts         # AgentCore 类
│   │   └── cordis-core.yml  # DSH 插件配置
│   ├── storage/             # 持久化实现
│   │   ├── sqlite-session-persistence.ts  # DSH 持久化插件与句柄
│   │   ├── sqlite-session-database.ts     # SQLite 读写与事务
│   │   └── migrations/                   # 数据库结构升级
│   └── shared/
│       └── types.ts
├── web/                     # 前端（React + Vite）
│   ├── src/
│   │   ├── components/
│   │   │   ├── Chat.tsx
│   │   │   └── Sidebar.tsx
│   │   ├── App.tsx
│   │   └── main.tsx
│   └── index.html
├── skills/                  # Agent 技能（markdown）
├── scripts/
│   └── migrate-sessions.ts  # 旧 JSONL → SQLite
└── data/                    # 运行时数据（gitignore）
    ├── ghost.sqlite         # 当前会话数据库
    └── sessions/            # 保留的旧 DSH JSONL 日志
```

## 会话管理

- **默认身份**：`web/src/client-context.ts` 定义 `userId: owner` 和 `channel: main`，浏览器不再生成随机用户和会话 ID。
- **长期会话**：每个用户当前共用一个 `main` 会话，所有 channel 的消息都路由到该会话。路由策略集中在 `src/app/conversation-routing.ts`，后续可按 channel 分开。
- **持久化与恢复**：用户与会话决定稳定的 DSH session ID。完整事件日志保存在 SQLite，刷新页面直接读取数据库历史，重启服务或释放 Agent 后从数据库恢复同一会话。
- **自动清理**：空闲 30 分钟后释放 Agent 实例，持久化历史保留。同一会话的发送、读取和清理按顺序执行。
- **分层边界**：`SessionManager` 在应用层决定稳定 session ID、缓存 Agent handle、排队和回收，并调用 `conversation-history.ts` 整理展示消息。`AgentCore` 只封装 DSH 创建、恢复、执行和原始事件读取，不依赖用户、channel 或聊天展示类型。入口按 HTTP 请求、会话实例、DSH 运行时的顺序关闭资源。
- **历史版本**：此前随机用户/会话的 JSONL 日志保留，不自动合并到新的 `owner/main`。

## SQLite 会话存储

`src/storage/sqlite-session-persistence.ts` 实现 DSH 的 `SessionPersistence` 接口，替换原 JSONL 插件。应用层和 Agent 使用相同的创建、恢复与执行接口。

- `sessions` 保存不可变的 DSH header、继承事件数和当前事件数。
- `session_events` 保存每个完整事件，以 `(session_id, seq)` 为主键，按序追加。模型上下文、工具调用、工具结果和 turn 边界均保留，聊天展示记录由这些事件生成。
- `session_writers` 保存写句柄的租约。认领与每批追加使用事务，同一个 session 只允许一个活跃写句柄；只读句柄无需认领。租约每 20 秒续期、60 秒过期，关闭时释放，本机已退出进程的租约可以立即接管。失去租约的句柄不能继续写入；应用释放对应的缓存 Agent，后续请求重新恢复会话。

实时事件最多等待 200 毫秒组成一批写入。每批事件及事件数在同一事务中提交，使用 WAL 和 `synchronous=FULL`；输入接收后、回复完成后及资源关闭时都会 flush。数据库保存格式版本，恢复时通过 DSH 校验事件，不静默跳过未知的必需事件。

SQLite 适合当前单机使用；数据库及 WAL 文件应放在本机磁盘。后续更换持久化后端可以继续实现同一个 DSH 接口。当前 Agent 缓存和进程内排队逻辑仍保留。

## 后续计划

- [ ] 长期记忆（memory 插件）
- [ ] 云端沙箱工具（bash/python 执行）
- [x] Web 前端与主会话历史恢复
- [ ] 用户认证
- [x] SQLite 会话事件持久化与 JSONL 导入
- [ ] 用户及会话归属信息入库
- [ ] 定时任务调度器

---

🤖 基于 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
