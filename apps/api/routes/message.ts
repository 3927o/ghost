/** Submit durable commands and observe replayable run events; no request owns Agent execution. */
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
interface RunEventsRequest { Params: { runId: string }; Querystring: ConversationContext & { after?: number } }
const runEventsSchema = { ...runSchema, querystring: { ...identityQuery,
  properties: { ...identityProperties, after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
} }

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
      return reply.code(202).send(await chat.submit(userId, conversationId, request.body.content, request.body.requestId))
    } catch (error) {
      if (error instanceof SubmissionConflictError) return reply.code(409).send({ error: error.message })
      throw error
    }
  })

  server.get<RunRequest>('/api/runs/:runId', { schema: runSchema }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.query)
    const run = await chat.getRun(userId, conversationId, request.params.runId)
    reply.header('Cache-Control', 'no-store')
    return run ?? reply.code(404).send({ error: 'Run not found' })
  })

  server.get<RunEventsRequest>('/api/runs/:runId/events', { schema: runEventsSchema }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.query)
    const read = () => chat.getRun(userId, conversationId, request.params.runId)
    const initial = await read()
    if (!initial) return reply.code(404).send({ error: 'Run not found' })
    const header = request.headers['last-event-id']
    const rawCursor = request.query.after ?? header
    const resume = rawCursor !== undefined
    let cursor = resume ? Number(rawCursor) : initial.lastEventSeq
    if ((typeof rawCursor === 'string' && !/^\d+$/.test(rawCursor)) || Array.isArray(rawCursor)
      || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > initial.lastEventSeq) {
      return reply.code(400).send({ error: 'Invalid run event cursor' })
    }

    reply.hijack()
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value)
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    })
    let reading = false
    let closed = false
    let timer: NodeJS.Timeout | undefined
    let heartbeat: NodeJS.Timeout | undefined
    const close = () => {
      closed = true
      clearInterval(timer)
      clearInterval(heartbeat)
      streams.delete(close)
      reply.raw.off('close', close)
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end()
    }
    const send = async (event: RunStreamEvent, sequence: number) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return close()
      const writable = reply.raw.write(`id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`)
      if (!writable) await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(deadline)
          reply.raw.off('drain', done)
          reply.raw.off('close', done)
          resolve()
        }
        const deadline = setTimeout(() => { close(); done() }, 15_000)
        reply.raw.once('drain', done)
        reply.raw.once('close', done)
      })
    }
    streams.add(close)
    reply.raw.on('close', close)
    const poll = async () => {
      if (reading || closed) return
      reading = true
      try {
        // Drain bounded batches before waiting again, including a terminal run's complete backlog.
        while (!closed) {
          const observation = await chat.getRunEvents(userId, conversationId, request.params.runId, cursor)
          if (closed) return
          if (!observation) return close()
          for (const event of observation.events) {
            if (closed) return
            if (event.sequence !== cursor + 1) throw new Error('Run event sequence gap')
            await send(event, event.sequence)
            cursor = event.sequence
          }
          if (cursor >= observation.lastEventSeq) {
            if (isTerminalRun(observation.status)) close()
            return
          }
          if (!observation.events.length) throw new Error('Run event replay is incomplete')
        }
      } catch (error) {
        server.log.error(error, 'Failed to observe run')
        close()
      } finally { reading = false }
    }
    if (!resume || (initial.lastEventSeq === 0 && isTerminalRun(initial.status))) {
      await send({ type: 'snapshot', run: initial }, initial.lastEventSeq)
      if (isTerminalRun(initial.status)) return close()
    }
    if (closed) return
    timer = setInterval(poll, 250)
    heartbeat = setInterval(() => {
      if (!reading && !reply.raw.write(': heartbeat\n\n')) close()
    }, 15_000)
    void poll()
  })

  server.get('/api/health', async () => ({ status: 'ok', service: 'api' }))
}
