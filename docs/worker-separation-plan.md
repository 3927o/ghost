# API 与 Agent Worker 架构

参考 ReadTailor 的 agent-run 结构。API 与 Worker 独立进程，Redis/BullMQ 负责投递，SQLite 保存业务状态与 Agent 上下文。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `apps/api` | HTTP、ChatService、事务提交、OutboxDispatcher、快照和 SSE |
| `apps/agent-worker` | Redis 任务 Handler、DSH 执行、业务结果提交、skills |
| `apps/web` | 提交消息、观察进度、刷新与断线恢复 |
| `packages/contracts` | 业务 JSON 协议和 AgentExecutor 接口 |
| `packages/database` | Database、ConversationRepository、MessageRepository、RunRepository、OutboxRepository |
| `packages/queue` | 泛型 RedisQueue<T> 与 QueueWorker<T>，仅依赖 BullMQ / ioredis；任务协议和策略由应用传入 |
| `packages/config` | 环境、数据库路径和 Redis 配置 |

## 事务和执行边界

1. ChatService 在 SQLite 事务中写入用户消息、回复占位、queued run 和 outbox 通知；API 返回 202。
2. OutboxDispatcher 将 runId 发送到 Redis，确认成功才删除通知。重复投递使用同一 jobId。
3. Worker 接收任务，Handler 在业务事务中检查前序任务并将 run 标为 running。前序未结束则延迟 Redis job。
4. AgentCore 恢复上下文并执行，Handler 合并保存文本，最终回复与终态原子提交。
5. API 从业务数据读取快照，通过 SSE 返回；HTTP 生命周期不拥有执行。

## 失败恢复

- Redis 短暂不可用时保留 outbox，恢复后补投。API 重启不丢待投递记录。
- Worker 异常退出后，BullMQ 在锁过期后重投。running run 被标记中断，completed / failed run 直接确认，均不重新执行 Agent。
- 同一会话顺序由业务状态约束，跨会话可并行；执行 token 防止旧执行覆盖结果。
- Worker 停机或 Redis 所有权丢失时取消 Agent。工具副作用不具有 exactly-once 保证。
- SQLite 当前限定同机本地磁盘。Redis 持久化配置由 compose.yaml 提供。

## 范围

采用当前 schema 初始化数据库，不保留历史 JSONL 导入、聊天投影迁移、兼容 ID 或 schema 版本升级逻辑。skills 位于 Worker 目录。暂不增加用户认证、用户取消按钮或跨主机 SQLite 部署。

## 验收

- [x] ApplicationStore 拆为连接、实体仓储和应用服务。
- [x] Redis/BullMQ 独立队列，事务 outbox 保证可补投。
- [x] skills 移入 Worker，移除历史迁移实现与相关依赖。
- [x] 类型检查、前端构建及自动测试通过。
- [x] 验证 Redis 离线接单 / 恢复补投、API 重启、双 Worker 顺序执行、Worker 异常退出及 Redis 重投防重复执行。

验证使用临时 SQLite、真实 Redis Docker 容器和本机模拟模型；9 项自动测试、类型检查、前端生产构建及 Compose 配置校验通过。
