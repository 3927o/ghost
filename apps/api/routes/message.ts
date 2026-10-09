/** Submit durable commands and observe snapshots; no request owns Agent execution. */
import type { FastifyInstance } from 'fastify'
import { SubmissionConflictError, type ChatService } from '../chat-service.ts'
import { isTerminalRun, type ConversationContext, type MessageRequest, type RunStreamEvent } from '@ghost/contracts'
import { resolveConversation } from '../conversation-routing.ts'

const identityProperties = {
  userId: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' },
  channel: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_-]*$' },
}
const identityQuery = {
  type: 'object', required: ['userId', 'channel'], additionalProperties: false, properties: identityProperties,
}
const runSchema = {
  querystring: identityQuery,
  params: { type: 'object', required: ['runId'], properties: { runId: { type: 'string', format: 'uuid' } } },
}
interface RunRequest { Params: { runId: string }; Querystring: ConversationContext }

export async function messageRoutes(server: FastifyInstance, { chat }: { chat: ChatService }) {
  const streams = new Set<() => void>()
  // Close observations before Fastify waits for active connections during shutdown.
  server.addHook('preClose', async () => { for (const close of streams) close() })

  server.get<{ Querystring: ConversationContext }>('/api/conversation', {
    schema: { querystring: identityQuery },
  }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.query)
    reply.header('Cache-Control', 'no-store')
    return chat.getConversation(userId, conversationId)
  })

  server.post<{ Body: MessageRequest }>('/api/message', {
    schema: {
      body: {
        type: 'object', required: ['userId', 'channel', 'content', 'requestId'], additionalProperties: false,
        properties: {
          ...identityProperties,
          content: { type: 'string', minLength: 1, maxLength: 100000, pattern: '\\S' },
          requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' },
        },
      },
    },
  }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.body)
    try {
      return reply.code(202).send(chat.submit(userId, conversationId, request.body.content, request.body.requestId))
    } catch (error) {
      if (error instanceof SubmissionConflictError) return reply.code(409).send({ error: error.message })
      throw error
    }
  })

  server.get<RunRequest>('/api/runs/:runId', { schema: runSchema }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.query)
    const run = chat.getRun(userId, conversationId, request.params.runId)
    reply.header('Cache-Control', 'no-store')
    return run ?? reply.code(404).send({ error: 'Run not found' })
  })

  server.get<RunRequest>('/api/runs/:runId/events', { schema: runSchema }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.query)
    const read = () => chat.getRun(userId, conversationId, request.params.runId)
    const initial = read()
    if (!initial) return reply.code(404).send({ error: 'Run not found' })

    reply.hijack()
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value)
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    })
    let revision = -1
    let timer: NodeJS.Timeout | undefined
    let heartbeat: NodeJS.Timeout | undefined
    const close = () => {
      clearInterval(timer)
      clearInterval(heartbeat)
      streams.delete(close)
      reply.raw.off('close', close)
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end()
    }
    const send = (run: typeof initial) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return close()
      if (run.revision !== revision) {
        revision = run.revision
        const event: RunStreamEvent = { type: 'snapshot', run }
        const writable = reply.raw.write(`id: ${revision}\ndata: ${JSON.stringify(event)}\n\n`)
        // Bound memory for slow clients; reconnect always receives the current full snapshot.
        if (!writable) return close()
      }
      if (isTerminalRun(run.status)) close()
    }
    streams.add(close)
    reply.raw.on('close', close)
    timer = setInterval(() => {
      try {
        const run = read()
        if (run) send(run)
        else close()
      } catch (error) {
        server.log.error(error, 'Failed to observe run')
        close()
      }
    }, 250)
    heartbeat = setInterval(() => {
      if (!reply.raw.write(': heartbeat\n\n')) close()
    }, 15_000)
    // Polling durable snapshots has no subscribe/read race and does not require event replay.
    send(initial)
  })

  server.get('/api/health', async () => ({ status: 'ok', service: 'api' }))
}
