# Ghost

个人 Agent 应用，采用 npm monorepo。业务 API 与 Agent Worker 独立运行，使用 Redis/BullMQ 传递任务，SQLite 保存业务记录与 DSH 上下文。

## 架构

```text
Web → API / ChatService → 会话、消息、run、outbox（同一 SQLite 事务）
                              ↓
                       OutboxDispatcher → Redis / BullMQ
                                               ↓
                                         Agent Worker
                                               ↓
                                         DSH / 模型 / 工具
                                               ↓
                         SQLite：业务回复、run 快照、DSH 上下文
                              ↓
                         API / SSE → Web
```

- **API** 处理会话和消息用例，查询历史与任务快照。`ChatService` 协调仓储与事务，`OutboxDispatcher` 将待投递记录发送至 Redis。
- **Worker** 接收 Redis 任务，`AgentRunHandler` 校验执行顺序、更新业务状态，`AgentCore` 负责 DSH、模型、工具及上下文恢复。
- **Web** 提交消息获得 runId，再观察快照。刷新恢复未结束的任务，断线自动重新连接。
- **database** 只负责连接、事务和各实体仓储；**queue** 只负责 Redis/BullMQ 传输，不依赖数据库和 Agent SDK。

队列使用 `RedisQueue<T>` 和 `QueueWorker<T>`，payload、job 名称、处理器及重试 / 并发配置由应用传入。队列包仅依赖 BullMQ 和 ioredis；会话顺序、outbox 和执行结果提交由 API / Worker 的应用代码负责。

同一会话按提交顺序执行，不同会话可以由多个 Worker 并行处理。API 与 Worker 目前仍须访问同一台机器上的本地 SQLite 文件。

## 启动

要求 Node.js 24+ 和 Redis 7+。仓库提供本地 Redis 的 Docker Compose 配置。

```bash
npm install
cp .env.example .env
# 配置 Worker 的模型接口和密钥
docker compose up -d redis
```

一个命令同时启动 API、Web 和 Agent Worker，日志按服务标记，按 Ctrl+C 一起停止：

```bash
npm run dev
```

也可以分别启动：

```bash
npm run dev:api      # API，默认 http://localhost:3000
npm run dev:web      # Web，默认 http://localhost:5173
npm run dev:worker   # Agent Worker
```

打开 http://localhost:5173 使用。Redis 需要提前启动。

直接运行使用 `npm run start:api`、`npm run start:worker`。`npm start` 仅启动 API。前端通过 `npm run build:web` 输出到 `dist/web/`，静态服务需将 `/api` 转发至 API。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `DATABASE_PATH` | `data/ghost.sqlite` | API / Worker 共用的本地数据库 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis 连接 |
| `REDIS_QUEUE_NAME` | `ghost-agent-runs` | 两个进程使用相同队列名 |
| `WORKER_LOCK_MS` | `30000` | BullMQ 执行锁时长，自动续期 |
| `AGENT_SKILLS_DIR` | `apps/agent-worker/skills` | Worker 技能目录 |

API 不需要模型配置。进程默认读取根目录 `.env`，外部环境变量优先；`GHOST_ENV_FILE` 可选择其他文件，空字符串跳过加载。

数据库通过当前 `schema.sql` 初始化，项目暂不提供历史格式导入和跨版本 schema 升级。已有开发数据库若结构不一致，使用新的 `DATABASE_PATH`。

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

## API

客户端暂时提供 `userId` 和 `channel`，Web 默认 `owner/main`，尚未接入认证。所有 channel 当前路由到该用户的 `main` 会话。

### 提交消息

```bash
curl -X POST http://localhost:3000/api/message \
  -H 'Content-Type: application/json' \
  -d '{"userId":"owner","channel":"main","content":"你好","requestId":"client-generated-unique-id"}'
```

返回 HTTP 202：

```json
{"conversationId":"main","runId":"uuid","accepted":true}
```

同一会话、相同 requestId 和内容重复提交返回原 runId；复用 requestId 提交不同内容返回 409。202 表示业务命令与待投递记录已经保存，Redis 暂时不可用时任务会等待补投。

### 历史与执行进度

```bash
curl 'http://localhost:3000/api/conversation?userId=owner&channel=main'
curl 'http://localhost:3000/api/runs/RUN_ID?userId=owner&channel=main'
curl -N 'http://localhost:3000/api/runs/RUN_ID/events?userId=owner&channel=main'
```

SSE 每条消息都是完整快照：

```text
id: 4
data: {"type":"snapshot","run":{"id":"uuid","conversationId":"main","assistantMessageId":"assistant-uuid","status":"running","text":"你好","error":null,"revision":4,"createdAt":1,"updatedAt":2}}
```

状态为 `queued / running / completed / failed`。Worker 合并写入可见文本，API 每 250ms 检查快照变化；终态与最终回复在同一事务中提交。SSE 连接先发当前快照，随后发送更高 revision，终态后关闭。客户端替换完整快照，不依赖逐条日志重放。

`GET /api/health` 表示 API 存活，不表示 Worker 或 Redis 可用。

## 存储与恢复

- `ConversationRepository` 管理业务会话及随机分配的 runtime session ID。
- `MessageRepository` 管理用户可见消息。
- `RunRepository` 管理执行状态、顺序约束和结果写入权限，不轮询领取任务。
- `OutboxRepository` 保存未发送的通知。消息、run 与通知原子提交；API 补投成功后删除通知。使用 runId 作为 Redis jobId，处理发送成功但确认丢失时的重复投递。
- `sessions / session_events / session_writers` 由 Worker 的 DSH 持久化适配器管理；API 不读取原始 Agent 事件。

API 重启或 SSE 断开不取消任务。Worker 正常停机停止消费并取消当前执行；异常退出后，BullMQ 在锁过期后重新投递。Handler 发现该 run 已进入 running 时将其标记中断，不再调用模型或工具。已完成的 run 重投也不会再次执行。排在后面的消息会继续处理。

同一会话尚有前序任务时，后续 Redis job 延迟后再投递。Redis 连接或任务锁丢失会取消当前执行；业务结果写入还会校验执行 token。外部工具副作用与数据库不具备跨系统事务保证。

Compose 中的 Redis 开启 AOF、同步刷盘和 noeviction。待投递通知在 Redis 确认后删除，因此 Redis 已确认的数据需要持久化；清空 Redis 数据并不等同于正常重启。

BullMQ 行为参考：[stalled jobs](https://docs.bullmq.io/guide/jobs/stalled)、[延迟当前任务](https://docs.bullmq.io/patterns/process-step-jobs)。

## 目录

```text
apps/
  api/                     # HTTP、ChatService、OutboxDispatcher
  agent-worker/            # 任务 Handler、DSH、模型配置
    skills/                # Worker 自带技能
    storage/               # DSH SQLite 适配器与 schema.sql
  web/                     # React
packages/
  contracts/               # 业务协议、执行器接口
  database/                # 连接、仓储、schema.sql
  queue/                   # Redis / BullMQ producer 和 consumer
  config/                  # 环境与路径
```

## 验证

```bash
npm run check
npm test
npm run build:web
```

`npm test` 包含真实 Redis 容器及 API / Worker 子进程集成测试，需要 Docker 可用。测试自行创建并删除 Redis 容器、临时数据库，模型接口使用本机模拟服务。
