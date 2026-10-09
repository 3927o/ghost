# Ghost

个人 Agent 应用，采用 npm monorepo。业务 API 与 Agent Worker 独立运行，使用 Redis/BullMQ 传递任务，通过 TypeORM 保存业务记录与 DSH 上下文，支持 PostgreSQL、MySQL 和 SQLite。

## 架构

```text
Web → API / ChatService → 会话、消息、run、outbox（同一数据库事务）
                              ↓
                       OutboxDispatcher → Redis / BullMQ
                                               ↓
                                         Agent Worker
                                               ↓
                                         DSH / 模型 / 工具
                                               ↓
                         数据库：业务回复、run 快照、DSH 上下文
                              ↓
                         API / SSE → Web
```

- **API** 处理会话和消息用例，查询历史与任务快照。`ChatService` 协调仓储与事务，`OutboxDispatcher` 将待投递记录发送至 Redis。
- **Worker** 接收 Redis 任务，`AgentRunHandler` 校验执行顺序、更新业务状态，`AgentCore` 负责 DSH、模型、工具及上下文恢复。
- **Web** 提交消息获得 runId，再观察快照。刷新恢复未结束的任务，断线自动重新连接。
- **database-client** 负责 ORM 驱动、连接、事务和关闭；**database** 定义实体、仓储和版本化表结构，两者都不依赖 Cordis 或 Agent SDK。
- **database-provider** 定义 `ctx.database` 契约，具体 Provider 管理 Agent 插件共享的连接；**session-persistence-database** 使用仓储实现 DSH 持久化。
- **queue** 只负责 Redis/BullMQ 传输，不依赖数据库和 Agent SDK。

队列使用 `RedisQueue<T>` 和 `QueueWorker<T>`，payload、job 名称、处理器及重试 / 并发配置由应用传入。队列包仅依赖 BullMQ 和 ioredis；会话顺序、outbox 和执行结果提交由 API / Worker 的应用代码负责。

同一会话按提交顺序执行，不同会话可并行处理。API 与 Worker 使用同一个业务数据库；选择 PostgreSQL 或 MySQL 时可分别部署，选择 SQLite 时必须访问同一台机器上的同一个文件。

连接的归属明确分开：API 启动时创建业务 client；Worker 启动时另建业务 client 给 `RunHandler`；Worker 的 Cordis Provider 再创建 Agent 插件共享的 client。PostgreSQL / MySQL 每个 client 拥有独立连接池，SQLite 每个 client 拥有独立连接。Worker 只 boot 一次，默认并发三个 Agent，不会每个 Agent 新建连接池。`RunHandler` 通过构造函数接收业务数据库，不访问 `ctx.database`。

插件消费者只有 `read()` / `transaction()`，不能关闭共享连接。Provider 卸载时先等待依赖插件保存、释放 Session，再关闭自己的 client；Worker 先停止任务，再释放 Cordis，最后关闭业务 client。

## 启动

要求 Node.js 24+ 和 Redis 7+。仓库提供本地 PostgreSQL 和 Redis 的 Docker Compose 配置，`.env.example` 使用 PostgreSQL；MySQL 实现使用 MySQL 8 的 `utf8mb4_0900_bin` 排序规则，测试版本为 8.4。

```bash
npm install
cp .env.example .env
# 配置 Worker 的模型接口和密钥
docker compose up -d postgres redis
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

打开 http://localhost:5173 使用。数据库和 Redis 需要提前启动。

直接运行使用 `npm run start:api`、`npm run start:worker`。`npm start` 仅启动 API。前端通过 `npm run build:web` 输出到 `dist/web/`，静态服务需将 `/api` 转发至 API。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `DATABASE_TYPE` | `sqlite` | `postgres`、`mysql` 或 `sqlite`；示例环境配置为 `postgres` |
| `DATABASE_URL` | 无 | PostgreSQL / MySQL 连接地址 |
| `DATABASE_POOL_SIZE` | `10` | 每个业务 client 的连接池上限，SQLite 不使用 |
| `DATABASE_PATH` | `data/ghost-orm.sqlite` | SQLite 业务数据库文件 |
| `AGENT_DATABASE_TYPE` | 继承 `DATABASE_TYPE` | Agent 插件使用的数据库类型 |
| `AGENT_DATABASE_URL` / `AGENT_DATABASE_PATH` | 继承对应 `DATABASE_*` | Agent 插件数据库，可以与业务库不同 |
| `AGENT_DATABASE_POOL_SIZE` | 继承 `DATABASE_POOL_SIZE` | Agent Provider 连接池上限 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis 连接 |
| `REDIS_QUEUE_NAME` | `ghost-agent-runs` | 两个进程使用相同队列名 |
| `WORKER_LOCK_MS` | `30000` | BullMQ 执行锁时长，自动续期 |
| `WORKER_CONCURRENCY` | `3` | 单个 Worker 同时执行的任务数，与连接池大小分别配置 |
| `AGENT_SKILLS_DIR` | `apps/agent-worker/skills` | Worker 技能目录 |

API 不需要模型配置。进程默认读取根目录 `.env`，外部环境变量优先；`GHOST_ENV_FILE` 可选择其他文件，空字符串跳过加载。

启动时通过 TypeORM 的表结构 API 初始化数据库，使用 `ghost_schema_versions` 分别记录业务与 Session 的版本；不启用 `synchronize`。当前只提供初始版本，不自动转换旧 SQLite 数据或未知版本。旧的 `data/ghost.sqlite` 保留不变，若 `.env` 仍指向它，请备份后改用新的数据库地址或 `DATABASE_PATH`。切换数据库类型不会自动搬迁已有记录。

例如保留业务数据在 PostgreSQL，仅把 Agent Session 存到 MySQL：

```dotenv
DATABASE_TYPE=postgres
DATABASE_URL=postgres://ghost:ghost@127.0.0.1:5432/ghost
AGENT_DATABASE_TYPE=mysql
AGENT_DATABASE_URL=mysql://ghost:ghost@127.0.0.1:3306/ghost_agent
```

这会选择 `database-provider-mysql`，Session 插件与仓储代码不用修改。使用 SQLite 则设置对应的 `*_DATABASE_TYPE=sqlite` 和文件路径；多个 Worker 的 Agent Provider 必须指向同一个 Session 数据库，才能恢复会话并协调写入权。

仓储接收当前操作的 `EntityManager`，跨仓储操作放在同一个事务回调内：

```ts
await database.transaction(async manager => {
  const runs = new RunRepository(manager)
  const messages = new MessageRepository(manager)
  await runs.updateOwned(id, token, 'completed', text, null)
  await messages.updateReply(id, text, null)
})
```

查询使用 `database.read(async manager => ...)` 获得一致快照。回调内只能使用传入的 manager，不嵌套调用 client 的 `read()` / `transaction()`，不跨模型或工具调用持有事务。ORM 统一查询与参数绑定；长文本类型、标识符大小写、锁和建表差异由实体映射及 client 处理。SQLite 对同一进程内同文件的访问串行化，服务端数据库使用连接池。

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
- `sessions / session_events / session_writers` 的实体和仓储位于 `database/session`；Worker 的 `session-persistence-database` 负责 DSH 事件校验、缓冲、写入租约与恢复，API 不读取原始 Agent 事件。

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
    runtime/               # boot、AgentCore 与 Cordis 配置
    plugins/
      database-provider/   # ctx.database 契约与 Provider 装配
      database-provider-pg/
      database-provider-mysql/
      database-provider-sqlite/
      session-persistence-database/  # DSH Session 消费者
  web/                     # React
packages/
  contracts/               # 业务协议、执行器接口
  database-client/         # TypeORM client、驱动、事务与资源生命周期
    drivers/               # postgres / mysql / sqlite
  database/
    business/              # Conversation / Message / Run / Outbox
    session/               # Session / Event / Writer
    migrations/            # 版本化初始化，ORM 按驱动生成 DDL
  queue/                   # Redis / BullMQ producer 和 consumer
  config/                  # 环境与路径
```

## 验证

```bash
npm run check
npm test
npm run build:web
```

`npm test` 需要 Docker，会创建并清理独立的 PostgreSQL 17、MySQL 8.4、Redis 7 容器以及临时 SQLite 文件，首次运行会拉取镜像。三种数据库运行同一组并发提交、回滚、会话顺序、Session 写入权和 Provider 释放测试；API / Worker 子进程测试覆盖重启、崩溃恢复、Redis 中断，模型接口使用本机模拟服务。
